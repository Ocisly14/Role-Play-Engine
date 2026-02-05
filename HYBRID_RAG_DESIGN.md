# 混合检索设计（BM25 + Vector）

## 为什么需要混合检索？

当前纯向量检索的局限性：
1. 专有名词匹配弱（如"克苏鲁"、"R'lyeh"、"奈亚拉托提普"）
2. 精确关键词查询效果差（如"红色日记本在哪？"）
3. 无法处理简短查询（如"雕像"）

混合检索的优势：
- BM25: 精确关键词 + TF-IDF权重
- Vector: 语义理解 + 同义词匹配
- 融合: 互补，提升召回和准确率

## 实现方案

### 1. 添加FTS5索引到历史表

```sql
-- Turn对话全文索引
CREATE VIRTUAL TABLE turn_embeddings_fts USING fts5(
    turn_id UNINDEXED,
    user_input,
    narrative,
    content='turn_embeddings',
    content_rowid='rowid'
);

-- Action log全文索引
CREATE VIRTUAL TABLE action_log_embeddings_fts USING fts5(
    action_log_id UNINDEXED,
    character,
    summary,
    location,
    content='action_log_embeddings',
    content_rowid='rowid'
);

-- 自动同步触发器（INSERT/UPDATE/DELETE）
CREATE TRIGGER turn_fts_insert AFTER INSERT ON turn_embeddings BEGIN
    INSERT INTO turn_embeddings_fts(turn_id, user_input, narrative)
    VALUES (new.id, new.user_input, new.narrative);
END;
```

### 2. BM25检索方法

```typescript
// 在schema.ts中添加
searchTurnsByKeywords(params: {
  sessionId: string;
  query: string;
  topK?: number;
}): Array<{ turnId: string; userInput: string; narrative: string; bm25Score: number }> {
  const { sessionId, query, topK = 10 } = params;

  // FTS5查询语法
  const stmt = this.db.prepare(`
    SELECT
      te.id as turn_id,
      te.user_input,
      te.narrative,
      fts.rank as bm25_score
    FROM turn_embeddings te
    JOIN turn_embeddings_fts fts ON te.id = fts.turn_id
    WHERE te.session_id = ?
      AND fts.turn_embeddings_fts MATCH ?
    ORDER BY fts.rank
    LIMIT ?
  `);

  return stmt.all(sessionId, query, topK).map(row => ({
    turnId: row.turn_id,
    userInput: row.user_input,
    narrative: row.narrative,
    bm25Score: -row.bm25_score, // FTS5 rank是负数，取反为正分数
  }));
}
```

### 3. 混合检索融合算法

```typescript
// 在gameHistoryRag.ts中添加
async searchRelevantHistoryHybrid(
  sessionId: string,
  query: string,
  options: {
    topK?: number;
    alpha?: number; // BM25权重，默认0.3
  } = {}
): Promise<HistorySearchResult> {
  const { topK = 5, alpha = 0.3 } = options;

  // 1. 向量检索（topK * 2 用于融合）
  const vectorResults = await this.searchRelevantHistory(sessionId, query, {
    topK: topK * 2,
  });

  // 2. BM25检索（topK * 2 用于融合）
  const bm25Results = this.db.searchTurnsByKeywords({
    sessionId,
    query,
    topK: topK * 2,
  });

  // 3. 归一化分数到[0, 1]
  const normalizeScores = (results: any[], scoreKey: string) => {
    const maxScore = Math.max(...results.map(r => r[scoreKey]));
    const minScore = Math.min(...results.map(r => r[scoreKey]));
    const range = maxScore - minScore || 1;
    return results.map(r => ({
      ...r,
      normalizedScore: (r[scoreKey] - minScore) / range,
    }));
  };

  const vectorNormalized = normalizeScores(
    vectorResults.items.map(item => ({
      turnId: item.metadata.turnId,
      content: item.content,
      score: item.score,
      type: item.type,
    })),
    'score'
  );

  const bm25Normalized = normalizeScores(
    bm25Results.map(item => ({
      turnId: item.turnId,
      content: this.formatTurn(item.userInput, item.narrative),
      score: item.bm25Score,
      type: 'turn' as const,
    })),
    'score'
  );

  // 4. 融合分数：Hybrid = α * BM25 + (1-α) * Vector
  const fusedMap = new Map<string, any>();

  for (const item of vectorNormalized) {
    fusedMap.set(item.turnId, {
      ...item,
      hybridScore: (1 - alpha) * item.normalizedScore,
    });
  }

  for (const item of bm25Normalized) {
    const existing = fusedMap.get(item.turnId);
    if (existing) {
      existing.hybridScore += alpha * item.normalizedScore;
    } else {
      fusedMap.set(item.turnId, {
        ...item,
        hybridScore: alpha * item.normalizedScore,
      });
    }
  }

  // 5. 排序并返回Top-K
  const fusedResults = Array.from(fusedMap.values())
    .sort((a, b) => b.hybridScore - a.hybridScore)
    .slice(0, topK);

  return {
    items: fusedResults.map(r => ({
      type: r.type,
      content: r.content,
      score: r.hybridScore,
      metadata: { turnId: r.turnId },
    })),
    totalResults: fusedMap.size,
  };
}
```

### 4. 调用混合检索

```typescript
// 在memoryAgent.ts中修改
export const retrieveRelevantHistory = async (
  db: CoCDatabase | undefined,
  sessionId: string,
  query: string,
  topK = 5
): Promise<RelevantHistoryItem[]> => {
  if (!db || !query.trim()) return [];

  try {
    const ragManager = new GameHistoryRag(db);

    // 使用混合检索替代纯向量检索
    const searchResult = await ragManager.searchRelevantHistoryHybrid(
      sessionId,
      query,
      {
        topK,
        alpha: 0.3, // 30% BM25, 70% Vector
      }
    );

    return searchResult.items;
  } catch (error) {
    console.warn("[Memory Agent] Failed to retrieve relevant history:", error);
    return [];
  }
};
```

## 对比效果

### 查询: "那本红色的日记在哪里？"

**纯向量检索**:
1. "你在书架上找到了一本泛黄的笔记本" (0.78)
2. "书房里堆满了各种文献和手稿" (0.72)
3. "桌上摆着一摞旧书和羊皮纸" (0.68)

**纯BM25检索**:
1. "你在抽屉里发现了一本**红色日记**" (精确匹配！)
2. "那本深红色的账本被藏在夹层中" (关键词部分匹配)
3. "书架上有几本红色封面的书" (关键词匹配但不相关)

**混合检索 (α=0.3)**:
1. "你在抽屉里发现了一本**红色日记**" (0.92) ← 最佳！
2. "那本深红色的账本被藏在夹层中" (0.85)
3. "你在书架上找到了一本泛黄的笔记本" (0.74)

## 实现优先级

### 高优先级（推荐实现）
- ✅ 添加FTS5索引
- ✅ 实现BM25检索方法
- ✅ 实现混合融合算法

### 中优先级（可选优化）
- 中文分词（jieba）支持
- Query expansion（同义词扩展）
- Reciprocal Rank Fusion（RRF）替代简单加权

### 低优先级（未来考虑）
- 时间衰减（最近的对话权重更高）
- 角色过滤（只搜索特定NPC的对话）
- 跨session检索（跨游戏档案搜索）

## 参考资料

- [SQLite FTS5文档](https://www.sqlite.org/fts5.html)
- [BM25算法详解](https://en.wikipedia.org/wiki/Okapi_BM25)
- [Hybrid Search论文](https://arxiv.org/abs/2104.08663)
