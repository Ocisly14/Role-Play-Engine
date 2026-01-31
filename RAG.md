下面是一份完整的 RAG + CoC 知识图架构说明（偏“交给 coding agent 直接开工”的规格文档）。我按你现有的 GameState/ScenarioSnapshot/NPCProfile 来设计，核心目标：
	•	既能做 混合召回（BM25 + 向量 + 图扩散）
	•	又能保证 不剧透（player/keeper 可见性隔离）
	•	支持 增量更新（场景永久变化、线索发现、NPC移动）
	•	输出 结构化 Evidence Pack，直接写回 temporaryInfo.ragResults

0. 系统边界与目标

输入
	•	GameState（你提供的接口）
	•	模组静态资源（场景/NPC/线索/规则文本等，来自你 extractor 的 JSON 或解析后的结构化数据）

输出
	•	temporaryInfo.ragResults: Evidence[]（结构化、可引用、可解释、可写回）
	•	可选：temporaryInfo.rules（回合相关规则片段）
	•	可选：temporaryInfo.contextualData（图扩散中间结果/调试信息）

关键约束
	•	同一份知识库同时服务两种模式：
	•	mode="player"：只能召回玩家可见信息
	•	mode="keeper"：可以召回 keeperNotes / secrets / keeperGuidance 等
	•	RAG 是“证据供应链”，叙事决策仍由 Director/GM 模块做。

1. 数据模型与索引单位

1.1 核心概念：Node vs Chunk
	•	Node（知识图节点）：Scenario / NPC / Clue / Item / Thread（少而强，负责“推理拓扑”）
	•	Chunk（可检索文本块）：从 Node 衍生出来的文本片段（负责“召回内容”）

推荐：Node 为主，Chunk 为辅。Chunk 一定要带回 nodeId 以便图扩散与解释。

1.2 可见性（必须实现）
type Visibility = "player" | "keeper";
每个 Node/Chunk 都有 visibility 字段（或 minVisibility），检索时按模式过滤。

1.3 Chunk Schema（最小可用）
type ChunkType = "scenario" | "npc" | "clue" | "item" | "rule";

type KnowledgeChunk = {
  id: string;
  type: ChunkType;
  nodeId: string;                 // 关联的图节点（强制）
  visibility: Visibility;          // player/keeper
  title: string;
  text: string;                   // 用于 embedding & BM25
  tags: string[];                 // 实体名/地点名/线程名/时间等
  source: {                       // 溯源（可选，但强烈建议）
    module: string;               // 模组名/文件名
    ref?: string;                 // 页码/段落id/原文hash
  };
  anchors: Record<string, any>;   // scenarioId/npcName/location/clueId...
  updatedAt: number;
};

2. CoC 知识图（Graph）结构

2.1 节点类型
type NodeType = "scenario" | "npc" | "clue" | "item" | "thread";

type GraphNode = {
  id: string;
  type: NodeType;
  title: string;
  visibility: Visibility;
  meta: Record<string, any>;     // scenario.name/location, npc.currentLocation...
  chunkIds: string[];            // 该节点下有哪些 chunk（1~n）
  embeddingKey?: string;         // 可选：向量库里“节点级向量”的 id
  updatedAt: number;
};

2.2 边类型（显式 + 语义）
type EdgeType =
  | "CONNECTED_TO"   // Scenario <-> Scenario (exits)
  | "APPEARS_IN"     // NPC -> Scenario
  | "HAS_CLUE"       // Scenario -> Clue
  | "KNOWS"          // NPC -> Clue
  | "POINTS_TO"      // Clue -> (NPC/Scenario/Item/Thread)
  | "OWNS"           // NPC -> Item
  | "RELATED_TO"     // NPC <-> NPC
  | "SIMILAR_TO";    // Node/Chunk 语义近邻（KNN）

type GraphEdge = {
  from: string;
  to: string;
  type: EdgeType;
  weight?: number;              // SIMILAR_TO 用 cosine，相似度
  visibility: Visibility;       // 边也要有可见性（避免“秘密边”泄漏）
  meta?: Record<string, any>;   // exits: direction/condition/locked 等
};
2.3 图存储结构（邻接表）
type KnowledgeGraph = {
  nodes: Record<string, GraphNode>;
  adj: Record<string, GraphEdge[]>;  // fromId -> edges
};

3. 存储与服务模块划分（Coding Agent 可按此拆包）

3.1 模块分层
	1.	Ingestion 层：把模组/State 数据转为 Node+Chunk
	2.	Index 层：BM25 索引 + 向量索引 + 图存储
	3.	Retrieval 层：QueryBuilder + 多路召回 + 图扩散
	4.	Ranking 层：融合打分/重排
	5.	Packaging 层：EvidencePack + 写回 GameState
	6.	Observability 层：日志、调试信息、召回解释

4. 接口契约（必须给 coding agent 的“可实现 API”）

4.1 Vector Store 抽象（不绑定具体库）
type VectorHit = { id: string; score: number; payload?: any };

interface VectorStore {
  upsert(vectors: { id: string; embedding: number[]; payload?: any }[]): Promise<void>;
  delete(ids: string[]): Promise<void>;
  search(queryEmbedding: number[], topK: number, filter?: Record<string, any>): Promise<VectorHit[]>;
  knnById(id: string, topK: number, filter?: Record<string, any>): Promise<VectorHit[]>;
}

4.2 BM25/Keyword Store 抽象
type LexHit = { id: string; score: number };

interface LexicalStore {
  upsert(docs: { id: string; text: string; tags?: string[]; payload?: any }[]): Promise<void>;
  delete(ids: string[]): Promise<void>;
  search(query: string, topK: number, filter?: Record<string, any>): Promise<LexHit[]>;
}

4.3 Graph Store（可先内存）
interface GraphStore {
  getGraph(): KnowledgeGraph;
  upsertNodes(nodes: GraphNode[]): void;
  upsertEdges(edges: GraphEdge[]): void;
  removeNodes(nodeIds: string[]): void;
  removeEdges(match: Partial<GraphEdge>): void;
  neighbors(nodeId: string, opts?: { types?: EdgeType[]; visibility?: Visibility }): GraphEdge[];
}

5. Ingestion：从 GameState / 模组数据建库

5.1 建库入口
type BuildOptions = {
  moduleName: string;
  mode: Visibility;  // 构建时可建两套索引或单套带 visibility
  enableNodeEmbeddings?: boolean;
  enableKnnEdges?: boolean;
  knnK?: number;             // e.g. 15
  knnThreshold?: number;     // e.g. 0.75
};

async function buildKnowledgeBase(
  moduleData: {
    scenarios: ScenarioSnapshot[];
    npcs: NPCProfile[];
    clues: { id: string; text: string; visibility: Visibility; links?: any }[];
    rules?: { id: string; text: string; visibility: Visibility }[];
  },
  stores: { vector: VectorStore; lex: LexicalStore; graph: GraphStore },
  opts: BuildOptions
): Promise<void>;
5.2 Chunk 生成策略（coding agent 必须实现）
	•	Scenario → 1~3 chunks：
	•	scenario.overview（name/location/description/exits/events）
	•	scenario.keeper（keeperNotes/permanentChanges/暗线提示）keeper-only
	•	NPC → 1~3 chunks：
	•	npc.public（外观/性格/公开背景/可见目标）
	•	npc.keeper（secrets/隐藏动机/操控方式）keeper-only
	•	Clue → 1 chunk（必要时拆成短句）
	•	Rules → 按八类型拆 chunk（“战斗/追逐/探索/潜行”等）
5.3 显式边构建规则（从你的 schema 直接推）
	•	ScenarioSnapshot.exits[] ⇒ CONNECTED_TO
	•	ScenarioSnapshot.characters[] ⇒ APPEARS_IN
	•	ScenarioSnapshot.clues[] ⇒ HAS_CLUE
	•	NPCProfile.clues[] ⇒ KNOWS
	•	NPCProfile.relationships[] ⇒ RELATED_TO
	•	Clue.links（如果你做了） ⇒ POINTS_TO

6. 向量图（KNN）怎么搭建

6.1 实现方式
预计算 KNN 边
	•	对所有 节点级向量 或 chunk 级向量 做 KNN
	•	满足阈值 ⇒ 写 SIMILAR_TO 边（带 weight=cosine）
	•	优点：图扩散很快、可解释、稳定
	•	缺点：建库/更新时有额外成本
6.2 推荐参数（可配置）
	•	knnK = 15
	•	threshold = 0.75（初始）
	•	类型约束：
	•	NPC 只连接 NPC/Clue
	•	Scenario 只连接 Scenario/Clue
	•	避免“全连噪声”

7. Retrieval：回合级查询构建与多路召回

7.1 Query Builder（从 GameState 自动组装）
type RagQuery = {
  mode: Visibility;               // player/keeper
  intent: string;                 // 玩家行动描述
  actionType: ActionType;
  entities: {
    targetName?: string;
    currentScenarioName?: string;
    currentScenarioId?: string;
    location?: string;
    npcsInScene: string[];
    openThreads: string[];
    discoveredClues: string[];
    recentScenes: string[];
  };
  constraints: {
    timeOfDay: string;
    gameDay: number;
    tension: number;
    phase: Phase;
  };
  queryText: string;              // 用于 lex/vector
};

function buildRagQuery(state: GameState, mode: Visibility): RagQuery;
7.2 多路召回（必须）
type RetrievalOptions = {
  topKSemantic: number;    // 20
  topKLexical: number;     // 20
  topKGraph: number;       // 20
  graphHops: 1 | 2;
};

type Candidate = {
  chunkId: string;
  semanticScore?: number;
  lexicalScore?: number;
  graphScore?: number;
  nodeId: string;
};

async function retrieveCandidates(
  q: RagQuery,
  stores: { vector: VectorStore; lex: LexicalStore; graph: GraphStore },
  opts: RetrievalOptions
): Promise<Candidate[]>;
Graph Expansion 规则（落地版）
	•	seeds：
	•	当前场景节点
	•	action target 节点（NPC/场景/线索）
	•	openThreads / discoveredClues 对应线索节点（若能映射）
	•	扩散：
	•	hop1：显式边（CONNECTED_TO / HAS_CLUE / KNOWS / APPEARS_IN / RELATED_TO）
	•	hop2：再扩散一次（但权重衰减）
	•	语义补边：SIMILAR_TO 或动态 KNN（可选）

8. Ranking：融合打分与重排

8.1 融合打分（可解释、可调参）
type RankWeights = {
  semantic: number;   // 0.45
  lexical: number;    // 0.25
  graph: number;      // 0.20
  state: number;      // 0.10
};

function scoreCandidate(
  c: Candidate,
  q: RagQuery,
  state: GameState,
  chunk: KnowledgeChunk,
  weights: RankWeights
): number;
8.2 stateFitness（你项目的“剧情正确性”核心）

建议加分项：
	•	chunk.nodeId 属于 currentScenario +0.15
	•	chunk.tags 命中 openThreads +0.10
	•	chunk.tags 命中 discoveredClues +0.10
	•	chunk 涉及最近访问场景（visitedScenarios 越近越高）+0.05
	•	tension 高：对 combat/chase/threat 标签 +0.05~0.10（由 actionType 决定）

8.3 输出 TopN
	•	TopN = 8~12 chunks
	•	同一 node 最多 2 个 chunk（防止全是同一个 NPC）

9. Evidence Pack：写回 GameState 的结构（建议强制）
type Evidence = {
  chunkId: string;
  nodeId: string;
  type: ChunkType;
  title: string;
  snippet: string;         // text 截断 200~400 chars
  anchors: Record<string, any>;
  confidence: number;      // 0~1（可用归一化 score）
  whyThis: string;         // 解释：命中实体/线程/图 hop/关键词
  visibility: Visibility;
};

async function buildEvidencePack(
  rankedChunkIds: string[],
  chunkStore: { get: (id: string) => KnowledgeChunk },
  q: RagQuery
): Promise<Evidence[]>;
写回：
state.temporaryInfo.ragResults = evidencePack;
10. 增量更新（运行时必须支持）

你这个游戏会不断变化，所以 KB 也要更新：

10.1 需要触发更新的事件
	•	新发现线索：discoveredClues 增加
	•	场景永久变化：currentScenario.permanentChanges 增加
	•	NPC 移动：NPCProfile.currentLocation 改变
	•	openThreads 变化（新增/关闭）
10.2 更新接口
type KBDelta =
  | { type: "ADD_CLUE"; clue: { id: string; text: string; visibility: Visibility; links?: any } }
  | { type: "UPDATE_SCENARIO"; scenarioId: string; patch: Partial<ScenarioSnapshot> }
  | { type: "UPDATE_NPC"; npcId: string; patch: Partial<NPCProfile> }
  | { type: "THREAD_UPDATE"; openThreads: string[] };

async function applyKbDelta(
  delta: KBDelta,
  stores: { vector: VectorStore; lex: LexicalStore; graph: GraphStore },
  opts: BuildOptions
): Promise<void>;
更新策略：
	•	只重算受影响 Node 的 chunks embedding（不要全库重建）
	•	KNN 边可：
	•	方案A：只对变更节点重算邻居并更新 SIMILAR_TO

11. 回合执行总流程（coding agent 的主入口）
type RagRunOptions = {
  mode: Visibility;                  // player/keeper
  retrieval: RetrievalOptions;
  weights: RankWeights;
  topN: number;
};

async function runRagForTurn(
  state: GameState,
  stores: {
    vector: VectorStore;
    lex: LexicalStore;
    graph: GraphStore;
    chunkStore: { get: (id: string) => KnowledgeChunk };
  },
  opts: RagRunOptions
): Promise<{ evidence: Evidence[]; debug?: any }>;
流程：
	1.	q = buildRagQuery(state, mode)
	2.	cands = retrieveCandidates(q, stores, opts.retrieval)
	3.	rank -> topN
	4.	evidence = buildEvidencePack(topIds)
	5.	写回 state.temporaryInfo.ragResults

12. 工程建议（让 coding agent 少踩坑）

12.1 ID 规范
	•	nodeId：scenario:<scenarioId> / npc:<npcId> / clue:<clueId>
	•	chunkId：chunk:<nodeId>:<variant>（variant 如 overview/public/keeper）

12.2 过滤与防剧透（必须写单测）
	•	player mode 绝不能返回 keeper chunk
	•	SIMILAR_TO 边也要按 visibility 过滤（否则会通过图扩散“绕过”）

12.3 可观察性（强烈建议）

每次 runRag 输出 debug：
	•	seeds 是哪些
	•	每一路召回各自 top hits
	•	为什么某条证据入选（whyThis 生成逻辑）