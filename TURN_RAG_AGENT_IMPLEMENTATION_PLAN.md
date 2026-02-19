# 回合 RAG Agent 实施文档

## 1. 目标

新增一个 `Turn RAG Agent`，在每轮结束后把以下内容写入会话级知识库（RAG）：

1. 每轮主 chunk（按轮切片）：玩家输入 + 行动日志 + Keeper 叙事
2. reveal clue 增量 chunk（仅本轮有线索更新时写入）

并在前端 `Sidebar` 用“RAG 问答”替代当前“已发现线索”tab，让玩家可以提问，LLM 基于该局会话的 RAG 内容回答。

线索写入规则补充：仅当“本轮有线索更新”时，才写入 reveal clue chunk。

---

## 2. 当前代码现状（与本方案相关）

已存在能力：

1. `TurnManager.completeTurn()` 会异步做 embedding（`src/dynamicworldagent/dynamicBasicAgent/memory/turnManager.ts`）
2. 已有 `GameHistoryRag`，可写入 turn/action embedding（`src/rag/gameHistoryRag.ts`）
3. 侧边栏线索在 `GameSidebar` 的 `clues` tab 渲染（`client/src/components/GameSidebar.tsx`）

关键缺口：

1. 目前只 embedding 了 turn + action，不包含“统一线索索引”
2. 没有面向玩家问答的 RAG API
3. `CoCDatabaseAdapter` 的同步检索方法对 embedding 搜索基本返回空（`searchTurnEmbeddings/searchActionLogEmbeddings`），不能直接作为新问答链路的检索入口（`src/shared/agents/memory/database/CoCDatabaseAdapter.ts`）
4. 侧边栏只有静态线索展示，没有问答交互

---

## 3. 方案总览

### 3.1 新增 Agent 的职责

新增 `TurnRagAgent`（推荐放在 `src/dynamicworldagent/dynamicBasicAgent/knowledge/`）：

1. 在回合完成后收集当前 turn 的结构化材料
2. 统一切片为 RAG 文档并做 embedding
3. 写入会话级 `session_rag_chunks`
4. 保证幂等（重复执行不产生重复 chunk）

### 3.2 挂载位置

主图 + 监听图都要接入：

1. `keeper -> ragRecorder -> END`
2. `epilogueKeeper -> ragRecorder -> END`

对应文件：`src/dynamicworldagent/graph/dynamicGraph.ts`

说明：节点会经过真实回合和模拟回合，但 `TurnRagAgent` 必须硬性过滤 `turn.isSimulated === true`，仅记录玩家真实回合。

### 3.3 问答链路

新增后端接口：

1. `POST /api/rag/ask`
2. （可选）`GET /api/rag/clues?sessionId=...` 用于侧边栏展示“已索引线索”

问答流程：

1. 权限校验（session 归属）
2. 先用 Query Template 重写检索词（注入 NPC 名称 + 场景名称）
3. 检索会话 RAG chunk（semantic + BM25）
4. 将 topK chunk 作为上下文交给 LLM
5. 返回 `answer + citations`

---

## 4. 数据模型设计

## 4.1 新表（建议）

在 `prisma/schema.prisma` 新增 `SessionRagChunk`：

```prisma
model SessionRagChunk {
  id          String   @id
  sessionId   String   @map("session_id")
  turnId      String?  @map("turn_id")
  turnNumber  Int?     @map("turn_number")
  chunkType   String   @map("chunk_type") // turn|clue
  role        String?  // character|keeper|system
  content     String
  metadata    Json?    @db.JsonB
  sourceKey   String   @map("source_key") // 幂等键
  embedding   Bytes
  language    String?  // en|zh
  createdAt   DateTime @default(now()) @map("created_at")
  emailId     String?  @map("email_id")

  @@index([sessionId, createdAt])
  @@index([sessionId, chunkType])
  @@index([sessionId, turnNumber])
  @@unique([sessionId, sourceKey])
  @@map("session_rag_chunks")
}
```

`sourceKey` 规则建议：

1. turn: `turn:${turnId}`
2. clue: `clue:${turnId}:${hash(text + sourceName + type)}`

---

## 5. TurnRagAgent 详细流程

每次回合完成后执行：

1. 读取 turn（`characterInput`, `actionResults`, `keeperNarrative`, `turnNumber`, `isSimulated`）
   1. 若 `isSimulated === true`，立即跳过本轮写入
2. 解析本轮 `clueRevelations`，仅提取“本轮新揭示”的 clue/secret
3. 仅当本轮存在 clue 更新时，生成并写入 `clue` chunk（无更新则跳过）
4. 生成 chunk 文本：
   1. `turn`（每轮一个主 chunk）: 原始玩家输入 + 标准化 action logs + Keeper 叙事正文
   2. `clue`: 线索文本 + 来源 + 发现方式 + 发现时间（仅在本轮有更新时）
5. embedding（沿用 `EmbeddingClient`）
6. 批量写入 `session_rag_chunks`

本轮 clue 更新判定建议：

1. `scenarioClues.length > 0` 或
2. `npcClues.length > 0` 或
3. `npcSecrets.length > 0`

`damagedScenarioClues` 不算 reveal clue，不写入 clue chunk。

建议：

1. 不阻塞主回合响应（异步 fire-and-forget）
2. 单条写入失败不影响回合完成
3. 日志要带 `sessionId/turnId/chunkCount/failureCount`

---

## 6. 检索与回答设计

## 6.1 Query Template（先做 Query Rewrite）

在检索前新增一步 Query Rewrite，使用 `SMALL` class model。

输入：

1. 玩家原始问题 `question`
2. 当前场景名 `currentScenario.name`
3. 当前场景 location `currentScenario.location`
4. 当前场景相关 NPC 名单（优先场景内 NPC）

模板输出（严格 JSON）：

```json
{
  "ragQuery": "用于检索的重写 query",
  "keywords": ["关键词1", "关键词2"],
  "entities": {
    "sceneNames": ["场景名"],
    "npcNames": ["NPC A", "NPC B"]
  }
}
```

模型要求：

1. 必须使用 `generateText(..., modelClass: ModelClass.SMALL)`
2. 只做检索意图改写，不回答问题
3. 不得引入上下文中不存在的 NPC/场景

失败回退：

1. 若模板解析失败，回退为原始 `question` 作为 `ragQuery`

## 6.2 检索

实现新的异步检索服务（不要复用当前同步空实现）：

1. 先对 `ragQuery` 做 Semantic 检索：对会话内 chunk 做向量相似度（cosine）排序
2. 再对 `ragQuery` 做 BM25 检索：对 `content` 做关键词相关性排序
3. 融合：`hybrid = 0.7 * semantic + 0.3 * bm25`
4. 类型加权：`clue > turn`（例如 +10% / 0%）

## 6.3 回答生成

LLM 输入：

1. 玩家问题
2. topK 证据块（含 turnNumber/type/source）

Prompt 约束：

1. 只能基于证据回答
2. 证据不足必须明确说“不确定”
3. 不允许编造未出现事实

返回结构：

```json
{
  "success": true,
  "answer": "...",
  "citations": [
    { "chunkId": "...", "turnNumber": 12, "chunkType": "clue", "snippet": "..." }
  ]
}
```

---

## 7. API 设计

## 7.1 `POST /api/rag/ask`

Request:

```json
{
  "sessionId": "xxx",
  "question": "我们现在掌握的祭仪地点证据是什么？",
  "topK": 8,
  "language": "zh"
}
```

Response:

```json
{
  "success": true,
  "answer": "...",
  "citations": [...],
  "retrievedCount": 8
}
```

错误返回保持现有风格：`{ success: false, error }`

## 7.2 `GET /api/rag/clues?sessionId=...`（可选）

用于 sidebar 显示“索引过的线索时间线”，不是必须项；若只保留问答可不做。

---

## 8. 前端 Sidebar 改造

目标：用“RAG 问答”替换当前 `clues` tab。

涉及文件：

1. `client/src/components/GameSidebar.tsx`
2. `client/src/i18n/locales/en/game.json`
3. `client/src/i18n/locales/zh/game.json`

改造点：

1. tab 名称从 `clues` 改为 `knowledge`（或保留 key，文案改为 Q&A）
2. 内容区改为：
   1. 问题输入框 + 提交按钮
   2. 回答展示区（显示 citations）
   3. 加载中与错误态
3. 保留原线索列表作为可折叠“证据参考”（可选）

---

## 9. 实施阶段（建议）

### Phase 1: 后端存储链路（最小可用）

1. Prisma 新增 `session_rag_chunks` + migration
2. 新建 `TurnRagAgent` + `SessionRagService`
3. 在主图/监听图接入 `ragRecorder` 节点
4. 完成回合后自动写入 2 类 chunk（`turn` + 条件性的 `clue`）

验收：

1. 打完 3 轮后，DB 中存在 `chunkType=turn` 数据，且有线索更新的轮次存在 `chunkType=clue`
2. 重复执行同回合不会产生重复 clue（幂等生效）
3. 若某轮没有 clue 更新，该轮不新增 `chunkType=clue` 记录
4. 模拟回合（`isSimulated=true`）不会写入任何 `session_rag_chunks` 记录

### Phase 2: RAG 问答 API

1. 新增 Query Rewriter Template（SMALL model）
2. 新增 `client/server/rag/controller.ts` 与 `routes.ts`
3. 接入 `POST /api/rag/ask`（链路：rewrite -> retrieve -> answer）
4. 返回答案 + citations

验收：

1. 问题命中时能给出带引用回答
2. Query Rewrite 结果包含传入的场景名/NPC名（或其子集）并可解析
3. 无证据时明确返回“证据不足”

### Phase 3: Sidebar 替换

1. `GameSidebar` 增加问答 UI
2. i18n 文案补齐（EN/中文）
3. 交互联调

验收：

1. 可以在 sidebar 直接提问并收到回答
2. 旧 `Discovered Clues` 被新 UI 替代

---

## 10. 风险与对策

1. 检索为空风险
   1. 原因：沿用同步空实现
   2. 对策：新问答链路仅用异步检索服务

2. 写入量增长风险
   1. 对策：限制单个 turn chunk 的 action_log 合并长度（超长时截断并记录日志）

3. 中文检索效果不稳定
   1. 对策：中文默认提高向量权重，关键词权重降低

4. 模拟回合污染玩家问答
   1. 对策：实现层强制过滤 `isSimulated=true`，模拟回合不入库、不参与检索

5. Query Rewrite 偏离用户问题
   1. 对策：模板只做“检索改写”；解析失败直接回退原始问题

---

## 11. 手工测试清单

1. `pnpm build`
2. `cd client && pnpm build`
3. `pnpm chat:dev` 后执行：
   1. 连续进行 3-5 轮对话并触发至少 2 条线索揭示
   2. 在 sidebar 提问“我目前掌握了哪些线索？”
   3. 验证回答包含当前局内容且引用正确 turn
   4. 验证非本局信息不会被引用

---

## 12. 建议的文件落点

后端：

1. `src/dynamicworldagent/dynamicBasicAgent/knowledge/turnRagAgent.ts`
2. `src/rag/sessionRagService.ts`
3. `src/rag/templates/buildRagQueryTemplate.ts`
4. `src/rag/ragQueryRewriter.ts`
5. `src/rag/sessionRagQaService.ts`
6. `client/server/rag/controller.ts`
7. `client/server/rag/routes.ts`
8. `client/server.ts`（挂载新路由）
9. `src/dynamicworldagent/graph/dynamicGraph.ts`（主图 + 监听图接入）
10. `prisma/schema.prisma` + 对应 migration

前端：

1. `client/src/components/GameSidebar.tsx`
2. `client/src/i18n/locales/en/game.json`
3. `client/src/i18n/locales/zh/game.json`

---

## 13. 待你确认的策略项

1. 问答回答风格：只摘要事实，还是允许带轻度推理
2. 侧边栏是否保留“线索列表折叠区”（默认推荐：保留，便于可视化核对）
