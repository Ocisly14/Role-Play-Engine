import type { GameState, ActionType, Phase } from "../../state/index.js";
import type { ScenarioSnapshot } from "../models/scenarioTypes.js";
import type { NPCProfile, InventoryItem } from "../models/gameTypes.js";
import type { CoCDatabase } from "./database/schema.js";
import { EmbeddingClient } from "../../../rag/embedding.js";
import { ModelProviderName } from "../../../models/types.js";

export type Visibility = "player" | "keeper";

export type ChunkType = "scenario" | "npc" | "clue" | "item" | "rule";

export type NodeType = "scenario" | "npc" | "clue" | "item" | "rule";

export interface KnowledgeChunk {
  id: string;
  type: ChunkType;
  nodeId: string;
  visibility: Visibility;
  title: string;
  text: string;
  tags: string[];
  source?: {
    module: string;
    ref?: string;
  };
  anchors: Record<string, any>;
  updatedAt: number;
}

export interface GraphNode {
  id: string;
  type: NodeType;
  title: string;
  visibility: Visibility;
  meta: Record<string, any>;
  chunkIds: string[];
  embeddingKey?: string;
  updatedAt: number;
}

export type EdgeType =
  | "CONNECTED_TO"
  | "APPEARS_IN"
  | "HAS_CLUE"
  | "KNOWS"
  | "POINTS_TO"
  | "OWNS"
  | "RELATED_TO"
  | "APPLIES_TO"
  | "SIMILAR_TO";

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  weight?: number;
  visibility: Visibility;
  meta?: Record<string, any>;
}

export interface KnowledgeGraph {
  nodes: Record<string, GraphNode>;
  adj: Record<string, GraphEdge[]>;
}

export type VectorHit = { id: string; score: number; payload?: any };

export interface VectorStore {
  upsert(vectors: { id: string; embedding: number[]; payload?: any }[]): Promise<void>;
  delete(ids: string[]): Promise<void>;
  search(queryEmbedding: number[], topK: number, filter?: Record<string, any>): Promise<VectorHit[]>;
  knnById(id: string, topK: number, filter?: Record<string, any>): Promise<VectorHit[]>;
}

export type LexHit = { id: string; score: number };

export interface LexicalStore {
  upsert(docs: { id: string; text: string; tags?: string[]; payload?: any }[]): Promise<void>;
  delete(ids: string[]): Promise<void>;
  search(query: string, topK: number, filter?: Record<string, any>): Promise<LexHit[]>;
}

export interface GraphStore {
  getGraph(): KnowledgeGraph;
  upsertNodes(nodes: GraphNode[]): void;
  upsertEdges(edges: GraphEdge[]): void;
  removeNodes(nodeIds: string[]): void;
  removeEdges(match: Partial<GraphEdge>): void;
  neighbors(nodeId: string, opts?: { types?: EdgeType[]; visibility?: Visibility }): GraphEdge[];
}

export type BuildOptions = {
  moduleName: string;
  mode: Visibility;
  enableNodeEmbeddings?: boolean;
  enableKnnEdges?: boolean;
  knnK?: number;
  knnThreshold?: number;
};

export type ModuleData = {
  scenarios: ScenarioSnapshot[];
  npcs: NPCProfile[];
  clues?: { id: string; text: string; visibility: Visibility; links?: any }[];
  rules?: { id: string; text: string; visibility: Visibility }[];
  playerInventory?: InventoryItem[];
  playerId?: string;
  playerName?: string;
};

export type KBDelta =
  | { type: "ADD_CLUE"; clue: { id: string; text: string; visibility: Visibility; links?: any } }
  | { type: "UPDATE_SCENARIO"; scenarioId: string; patch: Partial<ScenarioSnapshot> }
  | { type: "UPDATE_NPC"; npcId: string; patch: Partial<NPCProfile> };

export type RagQuery = {
  mode: Visibility;
  intent: string;
  actionType: ActionType;
  entities: {
    targetName?: string;
    currentScenarioName?: string;
    currentScenarioId?: string;
    location?: string;
    npcsInScene: string[];
    discoveredClues: string[];
    recentScenes: string[];
  };
  constraints: {
    timeOfDay: string;
    gameDay: number;
    tension: number;
    phase: Phase;
  };
  queryText: string;
};

export type RetrievalOptions = {
  topKSemantic: number;
  topKLexical: number;
  topKGraph: number;
  graphHops: 1 | 2;
};

export type Candidate = {
  chunkId: string;
  semanticScore?: number;
  lexicalScore?: number;
  graphScore?: number;
  nodeId: string;
  // 增强字段：图扩散路径和命中关键词
  graphPath?: string[];           // 图扩散路径: ["scenario:carnival", "npc:helen", ...]
  matchedKeywords?: string[];     // 命中的关键词
};

export type RankWeights = {
  semantic: number;
  lexical: number;
  graph: number;
  state: number;
};

export type Evidence = {
  chunkId: string;
  nodeId: string;
  type: ChunkType;
  title: string;
  snippet: string;
  anchors: Record<string, any>;
  confidence: number;
  whyThis: string;
  visibility: Visibility;
};

type RankedCandidate = Candidate & { finalScore: number; reasons: string[] };

interface ChunkStore {
  set(chunk: KnowledgeChunk): void;
  remove(ids: string[]): void;
  get(id: string): KnowledgeChunk | undefined;
  values(): KnowledgeChunk[];
}

type ChunkStoreShape = { get: (id: string) => KnowledgeChunk | undefined };

const DEFAULT_RANK_WEIGHTS: RankWeights = {
  semantic: 0.45,
  lexical: 0.25,
  graph: 0.2,
  state: 0.1,
};

/**
 * 根据 actionType 动态调整权重
 * 不同类型的行动需要不同的检索策略
 */
const ACTION_TYPE_WEIGHTS: Record<ActionType, RankWeights> = {
  // 社交行动：重视语义理解（理解对话意图）
  social: {
    semantic: 0.50,
    lexical: 0.20,
    graph: 0.20,
    state: 0.10,
  },
  // 探索行动：重视关键词匹配（具体线索、物品名称）
  exploration: {
    semantic: 0.35,
    lexical: 0.35,
    graph: 0.20,
    state: 0.10,
  },
  // 战斗行动：重视图关联（NPC关系、位置）
  combat: {
    semantic: 0.30,
    lexical: 0.20,
    graph: 0.35,
    state: 0.15,
  },
  // 追逐行动：重视图关联（场景连接、出口）
  chase: {
    semantic: 0.25,
    lexical: 0.25,
    graph: 0.35,
    state: 0.15,
  },
  // 潜行行动：均衡但略重视状态（环境条件）
  stealth: {
    semantic: 0.35,
    lexical: 0.30,
    graph: 0.20,
    state: 0.15,
  },
  // 心理对抗：重视语义（理解恐惧来源）
  mental: {
    semantic: 0.50,
    lexical: 0.20,
    graph: 0.15,
    state: 0.15,
  },
  // 环境挑战：重视关键词（具体环境描述）
  environmental: {
    semantic: 0.35,
    lexical: 0.35,
    graph: 0.15,
    state: 0.15,
  },
  // 叙事选择：均衡策略
  narrative: {
    semantic: 0.40,
    lexical: 0.25,
    graph: 0.25,
    state: 0.10,
  },
};

/**
 * 根据 actionType 获取动态权重
 * 如果用户提供了自定义权重，则与 actionType 权重合并
 */
export const getWeightsByActionType = (
  actionType: ActionType,
  customWeights?: Partial<RankWeights>
): RankWeights => {
  const baseWeights = ACTION_TYPE_WEIGHTS[actionType] ?? DEFAULT_RANK_WEIGHTS;
  if (!customWeights) return baseWeights;
  return { ...baseWeights, ...customWeights };
};

const DEFAULT_RETRIEVAL_OPTIONS: RetrievalOptions = {
  topKSemantic: 20,
  topKLexical: 20,
  topKGraph: 20,
  graphHops: 1,
};

const DEFAULT_TOP_N = 10;

const EMBEDDING_DIM = 96;

const EMBEDDING_SEED = 17;

const normalizeText = (text: string): string =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const tokenize = (text: string): string[] =>
  normalizeText(text)
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);

const simpleHash = (value: string): number => {
  let hash = EMBEDDING_SEED;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) % 4294967291;
  }
  return hash;
};

const hashEmbedText = (text: string): number[] => {
  const vector = new Array<number>(EMBEDDING_DIM).fill(0);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vector;

  for (const token of tokens) {
    const bucket = simpleHash(token) % EMBEDDING_DIM;
    vector[bucket] += 1;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
};

const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
};

const matchesFilter = (payload: any, filter?: Record<string, any>): boolean => {
  if (!filter) return true;
  return Object.entries(filter).every(([key, value]) => {
    if (value === undefined || value === null) return true;
    if (!payload) return false;
    return payload[key] === value;
  });
};

const truncate = (text: string, max = 320): string =>
  text.length <= max ? text : `${text.slice(0, max)}...`;

const uniq = <T>(values: T[]): T[] => Array.from(new Set(values));

interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

class HashEmbeddingProvider implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    return hashEmbedText(text);
  }
}

class EmbeddingClientProvider implements EmbeddingProvider {
  private client: EmbeddingClient;

  constructor(provider: ModelProviderName = ModelProviderName.OPENAI) {
    this.client = new EmbeddingClient(provider);
  }

  async embed(text: string): Promise<number[]> {
    return this.client.embed(text);
  }
}

class CompositeEmbeddingProvider implements EmbeddingProvider {
  private primary: EmbeddingProvider;
  private fallback: EmbeddingProvider;

  constructor(primary: EmbeddingProvider, fallback: EmbeddingProvider) {
    this.primary = primary;
    this.fallback = fallback;
  }

  async embed(text: string): Promise<number[]> {
    try {
      const res = await this.primary.embed(text);
      if (Array.isArray(res) && res.length) return res;
    } catch (_) {
      // fallthrough
    }
    return this.fallback.embed(text);
  }
}

class InMemoryVectorStore implements VectorStore {
  private vectors = new Map<string, { embedding: number[]; payload?: any }>();

  async upsert(
    vectors: { id: string; embedding: number[]; payload?: any }[]
  ): Promise<void> {
    for (const vector of vectors) {
      this.vectors.set(vector.id, { embedding: vector.embedding, payload: vector.payload });
    }
  }

  async delete(ids: string[]): Promise<void> {
    ids.forEach((id) => this.vectors.delete(id));
  }

  async search(
    queryEmbedding: number[],
    topK: number,
    filter?: Record<string, any>
  ): Promise<VectorHit[]> {
    const hits: VectorHit[] = [];
    for (const [id, record] of this.vectors.entries()) {
      if (!matchesFilter(record.payload, filter)) continue;
      const score = cosineSimilarity(queryEmbedding, record.embedding);
      hits.push({ id, score, payload: record.payload });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async knnById(id: string, topK: number, filter?: Record<string, any>): Promise<VectorHit[]> {
    const source = this.vectors.get(id);
    if (!source) return [];
    const hits: VectorHit[] = [];
    for (const [otherId, record] of this.vectors.entries()) {
      if (otherId === id) continue;
      if (!matchesFilter(record.payload, filter)) continue;
      const score = cosineSimilarity(source.embedding, record.embedding);
      hits.push({ id: otherId, score, payload: record.payload });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}

class InMemoryLexicalStore implements LexicalStore {
  private docs = new Map<
    string,
    {
      text: string;
      tags?: string[];
      payload?: any;
      tokens: Map<string, number>;
      length: number;
    }
  >();
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  async upsert(
    docs: { id: string; text: string; tags?: string[]; payload?: any }[]
  ): Promise<void> {
    docs.forEach((doc) => {
      const allText = [doc.text, ...(doc.tags ?? [])].join(" ");
      const tokens = tokenize(allText);
      const freq = new Map<string, number>();
      tokens.forEach((t) => freq.set(t, (freq.get(t) ?? 0) + 1));
      this.docs.set(doc.id, {
        text: doc.text,
        tags: doc.tags,
        payload: doc.payload,
        tokens: freq,
        length: tokens.length || 1,
      });
    });
  }

  async delete(ids: string[]): Promise<void> {
    ids.forEach((id) => this.docs.delete(id));
  }

  async search(query: string, topK: number, filter?: Record<string, any>): Promise<LexHit[]> {
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const docs = Array.from(this.docs.entries()).filter(([_, doc]) =>
      matchesFilter(doc.payload, filter)
    );
    const N = docs.length || 1;
    const avgdl = docs.reduce((sum, [, doc]) => sum + doc.length, 0) / N;

    const df = new Map<string, number>();
    for (const term of terms) {
      let count = 0;
      for (const [, doc] of docs) {
        if (doc.tokens.has(term)) count += 1;
      }
      df.set(term, count);
    }

    const hits: LexHit[] = [];
    for (const [id, doc] of docs) {
      let score = 0;
      for (const term of terms) {
        const tf = doc.tokens.get(term) ?? 0;
        if (tf === 0) continue;
        const dfTerm = df.get(term) ?? 0;
        const idf = Math.log((N - dfTerm + 0.5) / (dfTerm + 0.5) + 1);
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + (this.b * doc.length) / avgdl);
        score += idf * (numerator / denominator);
      }
      if (score > 0) hits.push({ id, score });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}

class InMemoryGraphStore implements GraphStore {
  private nodes: Record<string, GraphNode> = {};
  private adj: Record<string, GraphEdge[]> = {};

  getGraph(): KnowledgeGraph {
    return { nodes: this.nodes, adj: this.adj };
  }

  upsertNodes(nodes: GraphNode[]): void {
    for (const node of nodes) {
      this.nodes[node.id] = node;
      if (!this.adj[node.id]) this.adj[node.id] = [];
    }
  }

  upsertEdges(edges: GraphEdge[]): void {
    for (const edge of edges) {
      const list = this.adj[edge.from] ?? [];
      const key = `${edge.from}|${edge.to}|${edge.type}`;
      const existingIndex = list.findIndex(
        (item) => `${item.from}|${item.to}|${item.type}` === key
      );
      if (existingIndex >= 0) {
        list[existingIndex] = edge;
      } else {
        list.push(edge);
      }
      this.adj[edge.from] = list;
    }
  }

  removeNodes(nodeIds: string[]): void {
    for (const nodeId of nodeIds) {
      delete this.nodes[nodeId];
      delete this.adj[nodeId];
      for (const edges of Object.values(this.adj)) {
        for (let i = edges.length - 1; i >= 0; i--) {
          if (edges[i].to === nodeId) {
            edges.splice(i, 1);
          }
        }
      }
    }
  }

  removeEdges(match: Partial<GraphEdge>): void {
    Object.keys(this.adj).forEach((from) => {
      const edges = this.adj[from];
      this.adj[from] = edges.filter((edge) => {
        if (match.from && edge.from !== match.from) return true;
        if (match.to && edge.to !== match.to) return true;
        if (match.type && edge.type !== match.type) return true;
        if (match.visibility && edge.visibility !== match.visibility) return true;
        return false;
      });
    });
  }

  neighbors(nodeId: string, opts?: { types?: EdgeType[]; visibility?: Visibility }): GraphEdge[] {
    const edges = this.adj[nodeId] ?? [];
    return edges.filter((edge) => {
      if (opts?.types && !opts.types.includes(edge.type)) return false;
      if (opts?.visibility && edge.visibility !== opts.visibility) return false;
      return true;
    });
  }
}

class InMemoryChunkStore implements ChunkStore {
  private chunks = new Map<string, KnowledgeChunk>();

  set(chunk: KnowledgeChunk): void {
    this.chunks.set(chunk.id, chunk);
  }

  remove(ids: string[]): void {
    ids.forEach((id) => this.chunks.delete(id));
  }

  get(id: string): KnowledgeChunk | undefined {
    return this.chunks.get(id);
  }

  values(): KnowledgeChunk[] {
    return Array.from(this.chunks.values());
  }
}

class SqliteChunkStore implements ChunkStore {
  private db;
  private checkpointId: string | null;

  constructor(db: CoCDatabase, checkpointId: string | null = null) {
    this.checkpointId = checkpointId;
    this.db = db.getDatabase();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rag_chunks (
        id TEXT PRIMARY KEY,
        type TEXT,
        node_id TEXT,
        visibility TEXT,
        title TEXT,
        text TEXT,
        tags TEXT,
        source_module TEXT,
        source_ref TEXT,
        anchors TEXT,
        updated_at INTEGER,
        checkpoint_id TEXT
      );
    `);
    // Add checkpoint_id column if it doesn't exist (for existing databases)
    try {
      this.db.exec(`ALTER TABLE rag_chunks ADD COLUMN checkpoint_id TEXT`);
    } catch (_) {
      // Column already exists, ignore
    }
    // Create index for checkpoint_id lookups
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_rag_chunks_checkpoint ON rag_chunks(checkpoint_id)`);
    } catch (_) {
      // Index already exists, ignore
    }
  }

  set(chunk: KnowledgeChunk): void {
    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO rag_chunks
        (id, type, node_id, visibility, title, text, tags, source_module, source_ref, anchors, updated_at, checkpoint_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        chunk.id,
        chunk.type,
        chunk.nodeId,
        chunk.visibility,
        chunk.title,
        chunk.text,
        JSON.stringify(chunk.tags ?? []),
        chunk.source?.module ?? null,
        chunk.source?.ref ?? null,
        JSON.stringify(chunk.anchors ?? {}),
        chunk.updatedAt,
        this.checkpointId
      );
  }

  remove(ids: string[]): void {
    const stmt = this.db.prepare(`DELETE FROM rag_chunks WHERE id = ?`);
    ids.forEach((id) => stmt.run(id));
  }

  get(id: string): KnowledgeChunk | undefined {
    const row = this.db
      .prepare(
        `SELECT id, type, node_id, visibility, title, text, tags, source_module, source_ref, anchors, updated_at
         FROM rag_chunks WHERE id = ? AND (checkpoint_id = ? OR checkpoint_id IS NULL)`
      )
      .get(id, this.checkpointId) as
      | {
          id: string;
          type: ChunkType;
          node_id: string;
          visibility: Visibility;
          title: string;
          text: string;
          tags: string | null;
          source_module: string | null;
          source_ref: string | null;
          anchors: string | null;
          updated_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      type: row.type,
      nodeId: row.node_id,
      visibility: row.visibility,
      title: row.title,
      text: row.text,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
      source: row.source_module ? { module: row.source_module, ref: row.source_ref ?? undefined } : undefined,
      anchors: row.anchors ? (JSON.parse(row.anchors) as Record<string, any>) : {},
      updatedAt: row.updated_at,
    };
  }

  values(): KnowledgeChunk[] {
    const rows = this.db
      .prepare(
        `SELECT id, type, node_id, visibility, title, text, tags, source_module, source_ref, anchors, updated_at 
         FROM rag_chunks WHERE checkpoint_id = ? OR checkpoint_id IS NULL`
      )
      .all(this.checkpointId) as Array<{
        id: string;
        type: ChunkType;
        node_id: string;
        visibility: Visibility;
        title: string;
        text: string;
        tags: string | null;
        source_module: string | null;
        source_ref: string | null;
        anchors: string | null;
        updated_at: number;
      }>;
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      nodeId: row.node_id,
      visibility: row.visibility,
      title: row.title,
      text: row.text,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
      source: row.source_module ? { module: row.source_module, ref: row.source_ref ?? undefined } : undefined,
      anchors: row.anchors ? (JSON.parse(row.anchors) as Record<string, any>) : {},
      updatedAt: row.updated_at,
    }));
  }
}

class SqliteVectorStore implements VectorStore {
  private db;
  private checkpointId: string | null;

  constructor(db: CoCDatabase, checkpointId: string | null = null) {
    this.checkpointId = checkpointId;
    this.db = db.getDatabase();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rag_vectors (
        id TEXT PRIMARY KEY,
        embedding TEXT NOT NULL,
        payload TEXT,
        updated_at INTEGER,
        checkpoint_id TEXT
      );
    `);
    // Add checkpoint_id column if it doesn't exist
    try {
      this.db.exec(`ALTER TABLE rag_vectors ADD COLUMN checkpoint_id TEXT`);
    } catch (_) {}
    // Create index for checkpoint_id lookups
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_rag_vectors_checkpoint ON rag_vectors(checkpoint_id)`);
    } catch (_) {}
  }

  async upsert(vectors: { id: string; embedding: number[]; payload?: any }[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO rag_vectors (id, embedding, payload, updated_at, checkpoint_id) VALUES (?, ?, ?, ?, ?)`
    );
    const now = Date.now();
    this.db.transaction(() => {
      vectors.forEach((v) => {
        stmt.run(v.id, JSON.stringify(v.embedding), v.payload ? JSON.stringify(v.payload) : null, now, this.checkpointId);
      });
    })();
  }

  async delete(ids: string[]): Promise<void> {
    const stmt = this.db.prepare(`DELETE FROM rag_vectors WHERE id = ?`);
    this.db.transaction(() => ids.forEach((id) => stmt.run(id)))();
  }

  async search(queryEmbedding: number[], topK: number, filter?: Record<string, any>): Promise<VectorHit[]> {
    const rows = this.db
      .prepare(`SELECT id, embedding, payload FROM rag_vectors WHERE checkpoint_id = ? OR checkpoint_id IS NULL`)
      .all(this.checkpointId) as Array<{ id: string; embedding: string; payload: string | null }>;
    const hits: VectorHit[] = [];
    for (const row of rows) {
      const payload = row.payload ? JSON.parse(row.payload) : undefined;
      if (!matchesFilter(payload, filter)) continue;
      const score = cosineSimilarity(queryEmbedding, JSON.parse(row.embedding) as number[]);
      hits.push({ id: row.id, score, payload });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async knnById(id: string, topK: number, filter?: Record<string, any>): Promise<VectorHit[]> {
    const row = this.db
      .prepare(`SELECT id, embedding, payload FROM rag_vectors WHERE id = ? AND (checkpoint_id = ? OR checkpoint_id IS NULL)`)
      .get(id, this.checkpointId) as { id: string; embedding: string; payload: string | null } | undefined;
    if (!row) return [];
    const sourceEmbedding = JSON.parse(row.embedding) as number[];
    const rows = this.db
      .prepare(`SELECT id, embedding, payload FROM rag_vectors WHERE id != ? AND (checkpoint_id = ? OR checkpoint_id IS NULL)`)
      .all(id, this.checkpointId) as Array<{ id: string; embedding: string; payload: string | null }>;
    const hits: VectorHit[] = [];
    for (const other of rows) {
      const payload = other.payload ? JSON.parse(other.payload) : undefined;
      if (!matchesFilter(payload, filter)) continue;
      const score = cosineSimilarity(sourceEmbedding, JSON.parse(other.embedding) as number[]);
      hits.push({ id: other.id, score, payload });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}

class SqliteLexicalStore implements LexicalStore {
  private db;
  private checkpointId: string | null;
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  constructor(db: CoCDatabase, checkpointId: string | null = null) {
    this.checkpointId = checkpointId;
    this.db = db.getDatabase();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rag_lexical (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        tags TEXT,
        payload TEXT,
        tokens TEXT,
        length INTEGER,
        updated_at INTEGER,
        checkpoint_id TEXT
      );
    `);
    try {
      this.db.exec(`ALTER TABLE rag_lexical ADD COLUMN tokens TEXT`);
    } catch (_) {}
    try {
      this.db.exec(`ALTER TABLE rag_lexical ADD COLUMN length INTEGER`);
    } catch (_) {}
    try {
      this.db.exec(`ALTER TABLE rag_lexical ADD COLUMN checkpoint_id TEXT`);
    } catch (_) {}
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_rag_lexical_checkpoint ON rag_lexical(checkpoint_id)`);
    } catch (_) {}
  }

  async upsert(docs: { id: string; text: string; tags?: string[]; payload?: any }[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO rag_lexical (id, text, tags, payload, tokens, length, updated_at, checkpoint_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const now = Date.now();
    this.db.transaction(() => {
      docs.forEach((doc) => {
        const allText = [doc.text, ...(doc.tags ?? [])].join(" ");
        const tokensArr = tokenize(allText);
        const freq: Record<string, number> = {};
        tokensArr.forEach((t) => {
          freq[t] = (freq[t] ?? 0) + 1;
        });
        stmt.run(
          doc.id,
          doc.text,
          doc.tags ? JSON.stringify(doc.tags) : null,
          doc.payload ? JSON.stringify(doc.payload) : null,
          JSON.stringify(freq),
          tokensArr.length || 1,
          now,
          this.checkpointId
        );
      });
    })();
  }

  async delete(ids: string[]): Promise<void> {
    const stmt = this.db.prepare(`DELETE FROM rag_lexical WHERE id = ?`);
    this.db.transaction(() => ids.forEach((id) => stmt.run(id)))();
  }

  async search(query: string, topK: number, filter?: Record<string, any>): Promise<LexHit[]> {
    const rows = this.db
      .prepare(`SELECT id, text, tags, payload, tokens, length FROM rag_lexical WHERE checkpoint_id = ? OR checkpoint_id IS NULL`)
      .all(this.checkpointId) as Array<{
        id: string;
        text: string;
        tags: string | null;
        payload: string | null;
        tokens: string | null;
        length: number | null;
      }>;
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const docs = rows
      .map((row) => {
        const payload = row.payload ? JSON.parse(row.payload) : undefined;
        if (!matchesFilter(payload, filter)) return null;
        const freq = row.tokens ? (JSON.parse(row.tokens) as Record<string, number>) : {};
        return {
          id: row.id,
          payload,
          tokens: freq,
          length: row.length || Object.values(freq).reduce((s, v) => s + v, 0) || 1,
        };
      })
      .filter(Boolean) as Array<{ id: string; payload?: any; tokens: Record<string, number>; length: number }>;

    const N = docs.length || 1;
    const avgdl = docs.reduce((sum, doc) => sum + doc.length, 0) / N;

    const df = new Map<string, number>();
    for (const term of terms) {
      let count = 0;
      for (const doc of docs) {
        if (doc.tokens[term]) count += 1;
      }
      df.set(term, count);
    }

    const hits: LexHit[] = [];
    for (const doc of docs) {
      let score = 0;
      for (const term of terms) {
        const tf = doc.tokens[term] ?? 0;
        if (tf === 0) continue;
        const dfTerm = df.get(term) ?? 0;
        const idf = Math.log((N - dfTerm + 0.5) / (dfTerm + 0.5) + 1);
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + (this.b * doc.length) / avgdl);
        score += idf * (numerator / denominator);
      }
      if (score > 0) hits.push({ id: doc.id, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}

class SqliteGraphStore implements GraphStore {
  private db;
  private checkpointId: string | null;

  constructor(db: CoCDatabase, checkpointId: string | null = null) {
    this.checkpointId = checkpointId;
    this.db = db.getDatabase();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rag_nodes (
        id TEXT PRIMARY KEY,
        type TEXT,
        title TEXT,
        visibility TEXT,
        meta TEXT,
        chunk_ids TEXT,
        embedding_key TEXT,
        updated_at INTEGER,
        checkpoint_id TEXT
      );
      CREATE TABLE IF NOT EXISTS rag_edges (
        from_id TEXT,
        to_id TEXT,
        type TEXT,
        weight REAL,
        visibility TEXT,
        meta TEXT,
        updated_at INTEGER,
        checkpoint_id TEXT,
        PRIMARY KEY (from_id, to_id, type, checkpoint_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rag_edges_from ON rag_edges(from_id);
    `);
    // Add checkpoint_id column if it doesn't exist
    try {
      this.db.exec(`ALTER TABLE rag_nodes ADD COLUMN checkpoint_id TEXT`);
    } catch (_) {}
    try {
      this.db.exec(`ALTER TABLE rag_edges ADD COLUMN checkpoint_id TEXT`);
    } catch (_) {}
    // Create indexes for checkpoint_id lookups
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_rag_nodes_checkpoint ON rag_nodes(checkpoint_id)`);
    } catch (_) {}
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_rag_edges_checkpoint ON rag_edges(checkpoint_id)`);
    } catch (_) {}
  }

  private loadGraph(): KnowledgeGraph {
    const nodesRows = this.db
      .prepare(`SELECT id, type, title, visibility, meta, chunk_ids, embedding_key, updated_at FROM rag_nodes WHERE checkpoint_id = ? OR checkpoint_id IS NULL`)
      .all(this.checkpointId) as Array<{
        id: string;
        type: NodeType;
        title: string;
        visibility: Visibility;
        meta: string | null;
        chunk_ids: string | null;
        embedding_key: string | null;
        updated_at: number;
      }>;
    const nodes: Record<string, GraphNode> = {};
    nodesRows.forEach((row) => {
      nodes[row.id] = {
        id: row.id,
        type: row.type,
        title: row.title,
        visibility: row.visibility,
        meta: row.meta ? (JSON.parse(row.meta) as Record<string, any>) : {},
        chunkIds: row.chunk_ids ? (JSON.parse(row.chunk_ids) as string[]) : [],
        embeddingKey: row.embedding_key ?? undefined,
        updatedAt: row.updated_at,
      };
    });

    const edgesRows = this.db
      .prepare(`SELECT from_id, to_id, type, weight, visibility, meta FROM rag_edges WHERE checkpoint_id = ? OR checkpoint_id IS NULL`)
      .all(this.checkpointId) as Array<{
        from_id: string;
        to_id: string;
        type: EdgeType;
        weight: number | null;
        visibility: Visibility;
        meta: string | null;
      }>;

    const adj: Record<string, GraphEdge[]> = {};
    edgesRows.forEach((row) => {
      if (!adj[row.from_id]) adj[row.from_id] = [];
      adj[row.from_id].push({
        from: row.from_id,
        to: row.to_id,
        type: row.type,
        weight: row.weight ?? undefined,
        visibility: row.visibility,
        meta: row.meta ? (JSON.parse(row.meta) as Record<string, any>) : undefined,
      });
    });

    return { nodes, adj };
  }

  getGraph(): KnowledgeGraph {
    return this.loadGraph();
  }

  upsertNodes(nodes: GraphNode[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO rag_nodes (id, type, title, visibility, meta, chunk_ids, embedding_key, updated_at, checkpoint_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = this.db.transaction(() => {
      nodes.forEach((node) =>
        stmt.run(
          node.id,
          node.type,
          node.title,
          node.visibility,
          JSON.stringify(node.meta ?? {}),
          JSON.stringify(node.chunkIds ?? []),
          node.embeddingKey ?? null,
          node.updatedAt ?? Date.now(),
          this.checkpointId
        )
      );
    });
    tx();
  }

  upsertEdges(edges: GraphEdge[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO rag_edges (from_id, to_id, type, weight, visibility, meta, updated_at, checkpoint_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const now = Date.now();
    this.db.transaction(() => {
      edges.forEach((edge) =>
        stmt.run(
          edge.from,
          edge.to,
          edge.type,
          edge.weight ?? null,
          edge.visibility,
          edge.meta ? JSON.stringify(edge.meta) : null,
          now,
          this.checkpointId
        )
      );
    })();
  }

  removeNodes(nodeIds: string[]): void {
    const deleteNode = this.db.prepare(`DELETE FROM rag_nodes WHERE id = ?`);
    const deleteEdges = this.db.prepare(`DELETE FROM rag_edges WHERE from_id = ? OR to_id = ?`);
    this.db.transaction(() => {
      nodeIds.forEach((id) => {
        deleteNode.run(id);
        deleteEdges.run(id, id);
      });
    })();
  }

  removeEdges(match: Partial<GraphEdge>): void {
    const conditions: string[] = [];
    const params: any[] = [];
    if (match.from) {
      conditions.push("from_id = ?");
      params.push(match.from);
    }
    if (match.to) {
      conditions.push("to_id = ?");
      params.push(match.to);
    }
    if (match.type) {
      conditions.push("type = ?");
      params.push(match.type);
    }
    if (match.visibility) {
      conditions.push("visibility = ?");
      params.push(match.visibility);
    }
    if (conditions.length === 0) return;
    const where = conditions.join(" AND ");
    this.db.prepare(`DELETE FROM rag_edges WHERE ${where}`).run(...params);
  }

  neighbors(nodeId: string, opts?: { types?: EdgeType[]; visibility?: Visibility }): GraphEdge[] {
    const rows = this.db
      .prepare(`SELECT from_id, to_id, type, weight, visibility, meta FROM rag_edges WHERE from_id = ? AND (checkpoint_id = ? OR checkpoint_id IS NULL)`)
      .all(nodeId, this.checkpointId) as Array<{
        from_id: string;
        to_id: string;
        type: EdgeType;
        weight: number | null;
        visibility: Visibility;
        meta: string | null;
      }>;
    return rows
      .map((row) => ({
        from: row.from_id,
        to: row.to_id,
        type: row.type,
        weight: row.weight ?? undefined,
        visibility: row.visibility,
        meta: row.meta ? (JSON.parse(row.meta) as Record<string, any>) : undefined,
      }))
      .filter((edge) => {
        if (opts?.types && !opts.types.includes(edge.type)) return false;
        if (opts?.visibility && edge.visibility !== opts.visibility) return false;
        return true;
      });
  }
}

/**
 * RAG 查询日志记录器
 * 可选功能：记录每次 RAG 查询的详细信息，用于调试和分析检索质量
 */
export interface RagQueryLogEntry {
  id: string;
  sessionId: string;
  turnNumber?: number;
  timestamp: number;
  mode: Visibility;
  actionType: ActionType;
  queryText: string;
  seeds: string[];
  weights: RankWeights;
  semanticHitsCount: number;
  lexicalHitsCount: number;
  graphHitsCount: number;
  totalCandidates: number;
  finalResultsCount: number;
  topResults: Array<{ chunkId: string; score: number; type: ChunkType }>;
  executionTimeMs: number;
}

export class RagQueryLogger {
  private db: ReturnType<CoCDatabase["getDatabase"]> | null = null;
  private enabled: boolean = false;

  constructor(db?: CoCDatabase, enabled = true) {
    this.enabled = enabled && !!db;
    if (db) {
      this.db = db.getDatabase();
      this.initTable();
    }
  }

  private initTable(): void {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rag_query_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        turn_number INTEGER,
        timestamp INTEGER NOT NULL,
        mode TEXT NOT NULL,
        action_type TEXT NOT NULL,
        query_text TEXT,
        seeds TEXT,
        weights TEXT,
        semantic_hits_count INTEGER,
        lexical_hits_count INTEGER,
        graph_hits_count INTEGER,
        total_candidates INTEGER,
        final_results_count INTEGER,
        top_results TEXT,
        execution_time_ms INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_rag_logs_session ON rag_query_logs(session_id);
      CREATE INDEX IF NOT EXISTS idx_rag_logs_timestamp ON rag_query_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_rag_logs_action ON rag_query_logs(action_type);
    `);
  }

  log(entry: RagQueryLogEntry): void {
    if (!this.enabled || !this.db) return;
    try {
      this.db
        .prepare(`
          INSERT INTO rag_query_logs
          (id, session_id, turn_number, timestamp, mode, action_type, query_text,
           seeds, weights, semantic_hits_count, lexical_hits_count, graph_hits_count,
           total_candidates, final_results_count, top_results, execution_time_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          entry.id,
          entry.sessionId,
          entry.turnNumber ?? null,
          entry.timestamp,
          entry.mode,
          entry.actionType,
          entry.queryText,
          JSON.stringify(entry.seeds),
          JSON.stringify(entry.weights),
          entry.semanticHitsCount,
          entry.lexicalHitsCount,
          entry.graphHitsCount,
          entry.totalCandidates,
          entry.finalResultsCount,
          JSON.stringify(entry.topResults),
          entry.executionTimeMs
        );
    } catch (error) {
      console.warn("[RagQueryLogger] Failed to log query:", error);
    }
  }

  getRecentLogs(sessionId: string, limit = 20): RagQueryLogEntry[] {
    if (!this.db) return [];
    try {
      const rows = this.db
        .prepare(`
          SELECT * FROM rag_query_logs
          WHERE session_id = ?
          ORDER BY timestamp DESC
          LIMIT ?
        `)
        .all(sessionId, limit) as any[];
      return rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        turnNumber: row.turn_number,
        timestamp: row.timestamp,
        mode: row.mode as Visibility,
        actionType: row.action_type as ActionType,
        queryText: row.query_text,
        seeds: JSON.parse(row.seeds || "[]"),
        weights: JSON.parse(row.weights || "{}"),
        semanticHitsCount: row.semantic_hits_count,
        lexicalHitsCount: row.lexical_hits_count,
        graphHitsCount: row.graph_hits_count,
        totalCandidates: row.total_candidates,
        finalResultsCount: row.final_results_count,
        topResults: JSON.parse(row.top_results || "[]"),
        executionTimeMs: row.execution_time_ms,
      }));
    } catch {
      return [];
    }
  }

  getStatsByActionType(sessionId: string): Record<ActionType, { count: number; avgTimeMs: number }> {
    if (!this.db) return {} as any;
    try {
      const rows = this.db
        .prepare(`
          SELECT action_type, COUNT(*) as count, AVG(execution_time_ms) as avg_time
          FROM rag_query_logs
          WHERE session_id = ?
          GROUP BY action_type
        `)
        .all(sessionId) as Array<{ action_type: string; count: number; avg_time: number }>;
      const result: Record<string, { count: number; avgTimeMs: number }> = {};
      for (const row of rows) {
        result[row.action_type] = {
          count: row.count,
          avgTimeMs: Math.round(row.avg_time),
        };
      }
      return result as Record<ActionType, { count: number; avgTimeMs: number }>;
    } catch {
      return {} as any;
    }
  }
}

const chunkFilter = (mode: Visibility) => ({ visibility: mode });

const buildChunkId = (nodeId: string, variant: string): string =>
  `chunk:${nodeId}:${variant}`;

const buildNodeId = (type: NodeType, id: string): string => `${type}:${id}`;

const createScenarioChunks = (
  scenario: ScenarioSnapshot,
  nodeId: string,
  moduleName: string,
  timestamp: number
): KnowledgeChunk[] => {
  const anchors = {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    location: scenario.location,
  };

  const overviewText = [
    scenario.name,
    scenario.location,
    scenario.description,
    scenario.conditions?.map((c) => `${c.type}:${c.description}`).join("; "),
    scenario.events?.join("; "),
    scenario.exits?.map((exit) => `${exit.direction}->${exit.destination}`).join("; "),
  ]
    .filter(Boolean)
    .join(" | ");

  const overview: KnowledgeChunk = {
    id: buildChunkId(nodeId, "overview"),
    type: "scenario",
    nodeId,
    visibility: "player",
    title: `${scenario.name} overview`,
    text: overviewText,
    tags: uniq([
      scenario.name,
      scenario.location,
      ...(scenario.events ?? []),
      ...(scenario.exits?.map((exit) => exit.destination) ?? []),
    ]).filter(Boolean) as string[],
    source: { module: moduleName },
    anchors,
    updatedAt: timestamp,
  };

  const keeperTextParts = [
    scenario.keeperNotes,
    (scenario.permanentChanges ?? []).length > 0
      ? `permanent changes: ${(scenario.permanentChanges ?? []).join("; ")}`
      : undefined,
  ].filter(Boolean);

  const keeperChunks: KnowledgeChunk[] =
    keeperTextParts.length === 0
      ? []
      : [
          {
            id: buildChunkId(nodeId, "keeper"),
            type: "scenario",
            nodeId,
            visibility: "keeper",
            title: `${scenario.name} keeper`,
            text: keeperTextParts.join(" | "),
            tags: [scenario.name, scenario.location],
            source: { module: moduleName },
            anchors,
            updatedAt: timestamp,
          },
        ];

  return [overview, ...keeperChunks];
};

const createNpcChunks = (
  npc: NPCProfile,
  nodeId: string,
  moduleName: string,
  timestamp: number
): KnowledgeChunk[] => {
  const anchors = {
    npcId: npc.id,
    npcName: npc.name,
    location: npc.currentLocation,
  };
  const publicText = [
    npc.name,
    npc.occupation,
    npc.personality,
    npc.background,
    npc.goals?.join("; "),
    npc.currentLocation ? `location:${npc.currentLocation}` : null,
    npc.notes,
  ]
    .filter(Boolean)
    .join(" | ");

  const publicChunk: KnowledgeChunk = {
    id: buildChunkId(nodeId, "public"),
    type: "npc",
    nodeId,
    visibility: "player",
    title: `${npc.name} profile`,
    text: publicText,
    tags: uniq([
      npc.name,
      npc.occupation,
      npc.currentLocation,
      ...(npc.goals ?? []),
      ...(npc.relationships ?? []).map((rel) => rel.targetName),
    ]).filter(Boolean) as string[],
    source: { module: moduleName },
    anchors,
    updatedAt: timestamp,
  };

  const secretTextParts = [
    npc.secrets?.join("; "),
    npc.clues?.filter((clue) => !clue.revealed).map((clue) => clue.clueText).join("; "),
    npc.relationships?.length
      ? `relationships:${npc.relationships.map((rel) => `${rel.relationshipType}:${rel.targetName}`).join(", ")}`
      : undefined,
  ].filter(Boolean);

  const keeperChunks: KnowledgeChunk[] =
    secretTextParts.length === 0
      ? []
      : [
          {
            id: buildChunkId(nodeId, "keeper"),
            type: "npc",
            nodeId,
            visibility: "keeper",
            title: `${npc.name} keeper`,
            text: secretTextParts.join(" | "),
            tags: uniq([npc.name, ...(npc.secrets ?? [])]).filter(Boolean) as string[],
            source: { module: moduleName },
            anchors,
            updatedAt: timestamp,
          },
        ];

  return [publicChunk, ...keeperChunks];
};

const createClueChunk = (
  clue: { id: string; text: string; visibility: Visibility; links?: any },
  nodeId: string,
  moduleName: string,
  timestamp: number,
  anchors: Record<string, any> = {}
): KnowledgeChunk => ({
  id: buildChunkId(nodeId, "main"),
  type: "clue",
  nodeId,
  visibility: clue.visibility,
  title: `Clue ${clue.id}`,
  text: clue.text,
  tags: uniq([
    anchors.scenarioName,
    anchors.location,
    ...(Array.isArray(clue.links) ? clue.links : []),
  ]).filter(Boolean) as string[],
  source: { module: moduleName },
  anchors: { ...anchors, clueId: clue.id },
  updatedAt: timestamp,
});

const createRuleChunk = (
  rule: { id: string; text: string; visibility: Visibility },
  nodeId: string,
  moduleName: string,
  timestamp: number
): KnowledgeChunk => ({
  id: buildChunkId(nodeId, "rule"),
  type: "rule",
  nodeId,
  visibility: rule.visibility,
  title: `Rule ${rule.id}`,
  text: rule.text,
  tags: ["rule"],
  source: { module: moduleName },
  anchors: { ruleId: rule.id },
  updatedAt: timestamp,
});

const createItemChunk = (
  item: InventoryItem,
  nodeId: string,
  moduleName: string,
  timestamp: number,
  anchors: Record<string, any>,
  visibility: Visibility
): KnowledgeChunk => ({
  id: buildChunkId(nodeId, "item"),
  type: "item",
  nodeId,
  visibility,
  title: `Item: ${item.name}`,
  text: `${item.name}${item.properties ? ` | ${JSON.stringify(item.properties)}` : ""}`,
  tags: uniq([item.name, anchors.ownerName, anchors.location]).filter(Boolean) as string[],
  source: { module: moduleName },
  anchors,
  updatedAt: timestamp,
});

const allowedKnnTargets = (from: GraphNode, to: GraphNode): boolean => {
  if (from.type === "npc") return to.type === "npc" || to.type === "clue";
  if (from.type === "scenario") return to.type === "scenario" || to.type === "clue";
  return true;
};

const ensureArray = <T>(value: T[] | undefined | null): T[] => (Array.isArray(value) ? value : []);

export const buildRagQuery = (state: GameState, mode: Visibility): RagQuery => {
  const action = state.temporaryInfo.currentActionAnalysis;
  const intent =
    action?.target.intent ||
    action?.action ||
    "investigate surroundings";

  const npcsInScene =
    state.currentScenario?.characters?.map((char) => char.name).filter(Boolean) ?? [];

  const queryParts = [
    state.currentScenario?.name,
    state.currentScenario?.location,
    action?.target.name,
    intent,
    state.discoveredClues?.map(c => c.text).join(" "),
  ]
    .filter(Boolean)
    .join(" ");

  return {
    mode,
    intent,
    actionType: action?.actionType ?? "narrative",
    entities: {
      targetName: action?.target.name ?? undefined,
      currentScenarioName: state.currentScenario?.name,
      currentScenarioId: state.currentScenario?.id,
      location: state.currentScenario?.location,
      npcsInScene,
      discoveredClues: state.discoveredClues?.map(c => c.text) ?? [],
      recentScenes: state.visitedScenarios?.map((scene) => scene.name) ?? [],
    },
    constraints: {
      timeOfDay: state.timeOfDay,
      gameDay: state.gameDay,
      tension: state.tension,
      phase: state.phase,
    },
    queryText: queryParts,
  };
};

const computeStateFitness = (
  chunk: KnowledgeChunk,
  q: RagQuery,
  state: GameState
): number => {
  let score = 0;

  if (
    chunk.anchors.scenarioId &&
    chunk.anchors.scenarioId === q.entities.currentScenarioId
  ) {
    score += 0.15;
  } else if (
    chunk.tags.includes(q.entities.currentScenarioName ?? "") ||
    chunk.anchors.location === q.entities.location
  ) {
    score += 0.1;
  }

  if (q.entities.discoveredClues.some((clue) => chunk.tags.includes(clue))) {
    score += 0.1;
  }

  const recent = state.visitedScenarios.at(-1);
  if (recent && chunk.tags.includes(recent.name)) {
    score += 0.05;
  }

  if (q.constraints.tension >= 7) {
    if (q.actionType === "combat" || q.actionType === "chase") {
      score += 0.05;
    }
  }

  return Math.min(score, 1);
};

export const scoreCandidate = (
  candidate: Candidate,
  q: RagQuery,
  state: GameState,
  chunk: KnowledgeChunk,
  weights: RankWeights
): number => {
  const stateFitness = computeStateFitness(chunk, q, state);
  const semanticScore = candidate.semanticScore ?? 0;
  const lexicalScore = candidate.lexicalScore ?? 0;
  const graphScore = candidate.graphScore ?? 0;

  return (
    semanticScore * weights.semantic +
    lexicalScore * weights.lexical +
    graphScore * weights.graph +
    stateFitness * weights.state
  );
};

export const buildEvidencePack = async (
  rankedChunkIds: string[],
  chunkStore: { get: (id: string) => KnowledgeChunk | undefined },
  q: RagQuery,
  scores?: Record<string, number>,
  reasons?: Record<string, string[]>
): Promise<Evidence[]> => {
  const maxScore =
    scores && Object.values(scores).length > 0
      ? Math.max(...Object.values(scores))
      : rankedChunkIds.length;

  return rankedChunkIds
    .map((chunkId, index) => {
      const chunk = chunkStore.get(chunkId);
      if (!chunk) return undefined;

      const confidenceRaw = scores?.[chunkId] ?? (rankedChunkIds.length - index) / rankedChunkIds.length;
      const confidence =
        maxScore > 0 ? Math.min(1, Math.max(0, confidenceRaw / maxScore)) : confidenceRaw;

      const why =
        reasons?.[chunkId]?.join("; ") ??
        `Matches ${q.intent} in ${q.entities.currentScenarioName ?? "scene"}`;

      return {
        chunkId: chunk.id,
        nodeId: chunk.nodeId,
        type: chunk.type,
        title: chunk.title,
        snippet: truncate(chunk.text, 360),
        anchors: chunk.anchors,
        confidence,
        whyThis: why,
        visibility: chunk.visibility,
      };
    })
    .filter((evidence): evidence is Evidence => Boolean(evidence));
};

const buildEvidencePackFromCandidates = async (
  ranked: RankedCandidate[],
  chunkStore: ChunkStoreShape,
  q: RagQuery
): Promise<Evidence[]> => {
  const scores: Record<string, number> = {};
  const reasons: Record<string, string[]> = {};

  for (const candidate of ranked) {
    scores[candidate.chunkId] = candidate.finalScore;
    reasons[candidate.chunkId] = candidate.reasons;
  }

  return buildEvidencePack(
    ranked.map((c) => c.chunkId),
    chunkStore,
    q,
    scores,
    reasons
  );
};

/**
 * 增强版 whyThis 生成器
 * 提供更详细的解释：具体命中词、图扩散路径、得分分解
 */
const generateWhyThis = (
  candidate: Candidate,
  chunk: KnowledgeChunk,
  q: RagQuery,
  weights?: RankWeights
): string[] => {
  const reasons: string[] = [];
  const w = weights ?? DEFAULT_RANK_WEIGHTS;

  // 1. 语义匹配 - 显示得分贡献
  if (candidate.semanticScore) {
    const contribution = (candidate.semanticScore * w.semantic * 100).toFixed(0);
    reasons.push(`语义相似 (${contribution}%贡献)`);
  }

  // 2. 关键词命中 - 显示具体命中的词
  if (candidate.lexicalScore) {
    if (candidate.matchedKeywords && candidate.matchedKeywords.length > 0) {
      const keywords = candidate.matchedKeywords.slice(0, 3).join(", ");
      const more = candidate.matchedKeywords.length > 3 ? "..." : "";
      reasons.push(`关键词命中: ${keywords}${more}`);
    } else {
      reasons.push("关键词匹配");
    }
  }

  // 3. 图扩散关联 - 显示路径
  if (candidate.graphScore) {
    if (candidate.graphPath && candidate.graphPath.length > 1) {
      // 格式化路径: scenario:carnival -> npc:helen -> clue:xxx
      const formattedPath = candidate.graphPath
        .map((nodeId) => {
          const parts = nodeId.split(":");
          if (parts.length >= 2) {
            // 提取类型和简短名称
            const type = parts[0];
            const name = parts.slice(1).join(":").split(":")[0]; // 取第一部分作为名称
            return `${type}:${name.slice(0, 12)}`;
          }
          return nodeId.slice(0, 15);
        })
        .join(" → ");
      reasons.push(`图关联: ${formattedPath}`);
    } else {
      reasons.push("图扩散关联");
    }
  }

  // 4. 场景相关性
  if (chunk.tags.includes(q.entities.currentScenarioName ?? "")) {
    reasons.push(`当前场景: ${q.entities.currentScenarioName}`);
  }

  // 5. 目标相关性
  if (q.entities.targetName && chunk.tags.includes(q.entities.targetName)) {
    reasons.push(`涉及目标: ${q.entities.targetName}`);
  }

  // 6. NPC 相关性
  const matchedNpcs = q.entities.npcsInScene.filter((npc) =>
    chunk.tags.includes(npc) || chunk.text.toLowerCase().includes(npc.toLowerCase())
  );
  if (matchedNpcs.length > 0) {
    reasons.push(`相关NPC: ${matchedNpcs.slice(0, 2).join(", ")}`);
  }

  // 7. 线索相关性
  const matchedClues = q.entities.discoveredClues.filter((clue) =>
    chunk.tags.includes(clue) || chunk.anchors.clueId === clue
  );
  if (matchedClues.length > 0) {
    reasons.push(`关联已知线索`);
  }

  // 8. chunk 类型标注
  if (chunk.type === "clue") {
    reasons.push("线索信息");
  } else if (chunk.type === "npc" && chunk.visibility === "keeper") {
    reasons.push("NPC秘密信息");
  }

  return reasons.length ? reasons : ["相关上下文"];
};

export class RagManager {
  private vector: VectorStore;
  private lex: LexicalStore;
  private graph: GraphStore;
  private chunkStore: ChunkStore;
  private embedder: EmbeddingProvider;
  private scenarioIndex = new Map<string, string>();
  private npcIndex = new Map<string, string>();
  private clueIndex = new Map<string, string>();
  private logger: RagQueryLogger | null = null;
  private currentCheckpointId: string | null = null; // null = current/active RAG
  private db: CoCDatabase | null = null;

  constructor(
    options?: {
      stores?: {
        vector?: VectorStore;
        lex?: LexicalStore;
        graph?: GraphStore;
        chunkStore?: ChunkStore;
      };
      db?: CoCDatabase;
      embedder?: EmbeddingProvider;
      enableQueryLogging?: boolean;  // 启用查询日志（默认 false）
      checkpointId?: string | null;  // 指定要使用的 checkpoint_id (null = current)
    }
  ) {
    const defaultEmbedder = new CompositeEmbeddingProvider(
      new EmbeddingClientProvider(ModelProviderName.OPENAI),
      new HashEmbeddingProvider()
    );
    this.embedder = options?.embedder ?? defaultEmbedder;
    this.currentCheckpointId = options?.checkpointId ?? null;
    if (options?.db) {
      this.db = options.db;
      this.chunkStore =
        options.stores?.chunkStore ?? new SqliteChunkStore(options.db, this.currentCheckpointId);
      this.vector =
        options.stores?.vector ?? new SqliteVectorStore(options.db, this.currentCheckpointId);
      this.lex = options.stores?.lex ?? new SqliteLexicalStore(options.db, this.currentCheckpointId);
      this.graph =
        options.stores?.graph ?? new SqliteGraphStore(options.db, this.currentCheckpointId);
      // 初始化查询日志器（如果启用）
      if (options.enableQueryLogging) {
        this.logger = new RagQueryLogger(options.db, true);
      }
    } else {
      this.chunkStore =
        options?.stores?.chunkStore ?? new InMemoryChunkStore();
      this.vector = options?.stores?.vector ?? new InMemoryVectorStore();
      this.lex = options?.stores?.lex ?? new InMemoryLexicalStore();
      this.graph = options?.stores?.graph ?? new InMemoryGraphStore();
    }

    // 如果知识库已构建但索引为空，从图中重建索引
    // 这通常发生在从数据库恢复 RagManager 时
    if (this.isKnowledgeBaseBuilt() && 
        this.scenarioIndex.size === 0 && 
        this.npcIndex.size === 0 && 
        this.clueIndex.size === 0) {
      this.rebuildIndices();
    }
  }

  /**
   * 获取查询日志器（用于外部分析）
   */
  getLogger(): RagQueryLogger | null {
    return this.logger;
  }

  getStores(): {
    vector: VectorStore;
    lex: LexicalStore;
    graph: GraphStore;
    chunkStore: ChunkStoreShape;
  } {
    return { vector: this.vector, lex: this.lex, graph: this.graph, chunkStore: this.chunkStore };
  }

  /**
   * Check if knowledge base is already built (has nodes in database)
   * Checks for base RAG (checkpoint_id IS NULL) or specific checkpoint
   */
  isKnowledgeBaseBuilt(): boolean {
    try {
      const graph = this.graph.getGraph();
      const nodeCount = Object.keys(graph.nodes).length;
      return nodeCount > 0;
    } catch (error) {
      console.warn("Failed to check knowledge base status:", error);
      return false;
    }
  }

  /**
   * Check if base RAG knowledge base exists (checkpoint_id IS NULL)
   * This is the original/base knowledge base that can be reused for new games
   */
  static isBaseKnowledgeBaseBuilt(db: CoCDatabase): boolean {
    try {
      const database = db.getDatabase();
      const result = database
        .prepare(`SELECT COUNT(*) as count FROM rag_nodes WHERE checkpoint_id IS NULL`)
        .get() as { count: number } | undefined;
      return result ? result.count > 0 : false;
    } catch (error) {
      console.warn("Failed to check base knowledge base status:", error);
      return false;
    }
  }

  /**
   * 从图中重建索引（scenarioIndex, npcIndex, clueIndex）
   * 当从数据库恢复 RagManager 时，索引是空的，需要从图中重建
   */
  private rebuildIndices(): void {
    const graph = this.graph.getGraph();
    this.scenarioIndex.clear();
    this.npcIndex.clear();
    this.clueIndex.clear();

    for (const [nodeId, node] of Object.entries(graph.nodes)) {
      const normalizedTitle = normalizeText(node.title);
      
      if (node.type === "scenario") {
        // 从 nodeId 提取场景ID（格式：scenario:xxx）
        const scenarioId = nodeId.replace(/^scenario:/, "");
        this.scenarioIndex.set(normalizedTitle, nodeId);
        // 如果 meta 中有 scenarioId，也建立索引
        if (node.meta?.scenarioId) {
          this.scenarioIndex.set(normalizeText(node.meta.scenarioId), nodeId);
        }
      } else if (node.type === "npc") {
        // 从 nodeId 提取NPC ID（格式：npc:xxx）
        const npcId = nodeId.replace(/^npc:/, "");
        this.npcIndex.set(normalizedTitle, nodeId);
        // 如果 meta 中有 npcId，也建立索引
        if (node.meta?.npcId) {
          this.npcIndex.set(normalizeText(node.meta.npcId), nodeId);
        }
      } else if (node.type === "clue") {
        // 从 nodeId 提取线索ID（格式：clue:xxx）
        const clueId = nodeId.replace(/^clue:/, "");
        this.clueIndex.set(clueId, nodeId);
        // 如果 meta 中有 clueId，也建立索引
        if (node.meta?.clueId) {
          this.clueIndex.set(node.meta.clueId, nodeId);
        }
      }
    }

    console.log(`[RAG] 索引重建完成: 场景 ${this.scenarioIndex.size} 个, NPC ${this.npcIndex.size} 个, 线索 ${this.clueIndex.size} 个`);
  }

  /**
   * Save current RAG state to a checkpoint
   * Copies all RAG data (chunks, nodes, edges, vectors, lexical) and marks them with checkpoint_id
   */
  async saveToCheckpoint(checkpointId: string): Promise<void> {
    if (!this.db) {
      throw new Error("Cannot save RAG checkpoint: database not available");
    }

    const database = this.db.getDatabase();
    console.log(`[RAG] Saving RAG state to checkpoint: ${checkpointId}`);

    // Copy chunks (from current/active RAG where checkpoint_id IS NULL)
    const copyChunks = database.prepare(`
      INSERT INTO rag_chunks (id, type, node_id, visibility, title, text, tags, source_module, source_ref, anchors, updated_at, checkpoint_id)
      SELECT id, type, node_id, visibility, title, text, tags, source_module, source_ref, anchors, updated_at, ? as checkpoint_id
      FROM rag_chunks WHERE checkpoint_id IS NULL
    `);
    copyChunks.run(checkpointId);

    // Copy nodes
    const copyNodes = database.prepare(`
      INSERT INTO rag_nodes (id, type, title, visibility, meta, chunk_ids, embedding_key, updated_at, checkpoint_id)
      SELECT id, type, title, visibility, meta, chunk_ids, embedding_key, updated_at, ? as checkpoint_id
      FROM rag_nodes WHERE checkpoint_id IS NULL
    `);
    copyNodes.run(checkpointId);

    // Copy edges
    const copyEdges = database.prepare(`
      INSERT INTO rag_edges (from_id, to_id, type, weight, visibility, meta, updated_at, checkpoint_id)
      SELECT from_id, to_id, type, weight, visibility, meta, updated_at, ? as checkpoint_id
      FROM rag_edges WHERE checkpoint_id IS NULL
    `);
    copyEdges.run(checkpointId);

    // Copy vectors
    const copyVectors = database.prepare(`
      INSERT INTO rag_vectors (id, embedding, payload, updated_at, checkpoint_id)
      SELECT id, embedding, payload, updated_at, ? as checkpoint_id
      FROM rag_vectors WHERE checkpoint_id IS NULL
    `);
    copyVectors.run(checkpointId);

    // Copy lexical
    const copyLexical = database.prepare(`
      INSERT INTO rag_lexical (id, text, tags, payload, tokens, length, updated_at, checkpoint_id)
      SELECT id, text, tags, payload, tokens, length, updated_at, ? as checkpoint_id
      FROM rag_lexical WHERE checkpoint_id IS NULL
    `);
    copyLexical.run(checkpointId);

    console.log(`[RAG] RAG state saved to checkpoint: ${checkpointId}`);
  }

  /**
   * Restore RAG state from a checkpoint
   * This creates a new RagManager instance with the checkpoint's data
   */
  static async restoreFromCheckpoint(
    db: CoCDatabase,
    checkpointId: string,
    embedder?: EmbeddingProvider
  ): Promise<RagManager> {
    console.log(`[RAG] Restoring RAG state from checkpoint: ${checkpointId}`);
    
    // Create a new RagManager with checkpoint_id filter
    const ragManager = new RagManager({
      db,
      embedder,
      checkpointId: checkpointId,
    });

    // Verify that checkpoint data exists
    const database = db.getDatabase();
    const nodeCount = database
      .prepare(`SELECT COUNT(*) as count FROM rag_nodes WHERE checkpoint_id = ?`)
      .get(checkpointId) as { count: number } | undefined;

    if (!nodeCount || nodeCount.count === 0) {
      console.warn(`[RAG] No RAG data found for checkpoint: ${checkpointId}, using current/active RAG`);
      // Fall back to current RAG (checkpoint_id IS NULL)
      return new RagManager({ db, embedder, checkpointId: null });
    }

    console.log(`[RAG] Restored ${nodeCount.count} nodes from checkpoint: ${checkpointId}`);
    return ragManager;
  }

  private async computeNodeEmbedding(node: GraphNode): Promise<number[]> {
    const texts = node.chunkIds
      .map((id) => this.chunkStore.get(id)?.text)
      .filter(Boolean)
      .join(" ");
    return this.embedder.embed(texts);
  }

  private async rebuildKnnEdges(targetNodeIds: string[], opts: BuildOptions): Promise<void> {
    if (!opts.enableKnnEdges) return;
    const graph = this.graph.getGraph();
    const allNodes = Object.values(graph.nodes);
    const cache = new Map<string, number[]>();
    const getEmbedding = async (id: string): Promise<number[]> => {
      if (cache.has(id)) return cache.get(id) as number[];
      const node = graph.nodes[id];
      if (!node) return [];
      const emb = await this.computeNodeEmbedding(node);
      cache.set(id, emb);
      return emb;
    };

    const edges: GraphEdge[] = [];
    for (const targetId of targetNodeIds) {
      const sourceNode = graph.nodes[targetId];
      if (!sourceNode) continue;
      this.graph.removeEdges({ from: targetId, type: "SIMILAR_TO" });
      this.graph.removeEdges({ to: targetId, type: "SIMILAR_TO" });

      const sourceEmbedding = await getEmbedding(targetId);
      const sims: { to: string; score: number }[] = [];
      for (const other of allNodes) {
        if (other.id === targetId) continue;
        if (!allowedKnnTargets(sourceNode, other)) continue;
        const score = cosineSimilarity(sourceEmbedding, await getEmbedding(other.id));
        if (score >= (opts.knnThreshold ?? 0.75)) {
          sims.push({ to: other.id, score });
        }
      }

      sims
        .sort((a, b) => b.score - a.score)
        .slice(0, opts.knnK ?? 15)
        .forEach((sim) => {
          edges.push({
            from: targetId,
            to: sim.to,
            type: "SIMILAR_TO",
            weight: sim.score,
            visibility:
              graph.nodes[targetId].visibility === "keeper" ||
              graph.nodes[sim.to]?.visibility === "keeper"
                ? "keeper"
                : "player",
          });
        });
    }

    if (edges.length) {
      this.graph.upsertEdges(edges);
    }
  }

  private async indexChunks(chunks: KnowledgeChunk[]): Promise<void> {
    const vectors = [];
    const docs = [];
    for (const chunk of chunks) {
      const embedding = await this.embedder.embed(chunk.text);
      vectors.push({
        id: chunk.id,
        embedding,
        payload: {
          nodeId: chunk.nodeId,
          visibility: chunk.visibility,
          type: chunk.type,
          tags: chunk.tags,
        },
      });

      docs.push({
        id: chunk.id,
        text: chunk.text,
        tags: chunk.tags,
        payload: {
          nodeId: chunk.nodeId,
          visibility: chunk.visibility,
          type: chunk.type,
        },
      });

      this.chunkStore.set(chunk);
    }

    await this.vector.upsert(vectors);
    await this.lex.upsert(docs);
  }

  async buildKnowledgeBase(moduleData: ModuleData, opts: BuildOptions): Promise<void> {
    const timestamp = Date.now();
    const edges: GraphEdge[] = [];
    const nodes: GraphNode[] = [];
    const nodeEmbeddings: Record<string, number[]> = {};
    const edgeKeys = new Set<string>();

    console.log(`[RAG] 开始构建知识库: ${moduleData.scenarios.length} 个场景, ${moduleData.npcs.length} 个NPC`);

    const registerEdge = (edge: GraphEdge) => {
      const key = `${edge.from}|${edge.to}|${edge.type}`;
      if (edgeKeys.has(key)) return;
      edgeKeys.add(key);
      edges.push(edge);
    };

    const scenarioMap = new Map<string, ScenarioSnapshot>();

    // 处理场景
    console.log(`[RAG] 处理场景中... (0/${moduleData.scenarios.length})`);
    for (let i = 0; i < moduleData.scenarios.length; i++) {
      const scenario = moduleData.scenarios[i];
      if (i % 10 === 0 || i === moduleData.scenarios.length - 1) {
        console.log(`[RAG] 处理场景: ${i + 1}/${moduleData.scenarios.length} - ${scenario.name}`);
      }
      const nodeId = buildNodeId("scenario", scenario.id || normalizeText(scenario.name));
      this.scenarioIndex.set(normalizeText(scenario.name), nodeId);
      const chunks = createScenarioChunks(scenario, nodeId, opts.moduleName, timestamp);

      const node: GraphNode = {
        id: nodeId,
        type: "scenario",
        title: scenario.name,
        visibility: "player",
        meta: {
          scenarioId: scenario.id,
          location: scenario.location,
          snapshot: scenario,
        },
        chunkIds: chunks.map((chunk) => chunk.id),
        updatedAt: timestamp,
      };

      nodes.push(node);
      await this.indexChunks(chunks);
      scenarioMap.set(nodeId, scenario);

      if (opts.enableNodeEmbeddings) {
        const mergedText = chunks.map((chunk) => chunk.text).join(" ");
        nodeEmbeddings[nodeId] = await this.embedder.embed(mergedText);
      }
    }
    console.log(`[RAG] ✓ 场景处理完成`);

    // 处理NPC
    console.log(`[RAG] 处理NPC中... (0/${moduleData.npcs.length})`);
    for (let i = 0; i < moduleData.npcs.length; i++) {
      const npc = moduleData.npcs[i];
      if (i % 20 === 0 || i === moduleData.npcs.length - 1) {
        console.log(`[RAG] 处理NPC: ${i + 1}/${moduleData.npcs.length} - ${npc.name}`);
      }
      const nodeId = buildNodeId("npc", npc.id || normalizeText(npc.name));
      this.npcIndex.set(normalizeText(npc.name), nodeId);
      const chunks = createNpcChunks(npc, nodeId, opts.moduleName, timestamp);
      const node: GraphNode = {
        id: nodeId,
        type: "npc",
        title: npc.name,
        visibility: "player",
        meta: { npcId: npc.id, currentLocation: npc.currentLocation, profile: npc },
        chunkIds: chunks.map((chunk) => chunk.id),
        updatedAt: timestamp,
      };
      nodes.push(node);
      await this.indexChunks(chunks);

      if (opts.enableNodeEmbeddings) {
        const mergedText = chunks.map((chunk) => chunk.text).join(" ");
        nodeEmbeddings[nodeId] = await this.embedder.embed(mergedText);
      }

      // Items owned by this NPC
      for (const item of npc.inventory ?? []) {
        const itemNodeId = this.resolveItemId(npc.id, item.name);
        const itemChunk = createItemChunk(
          item,
          itemNodeId,
          opts.moduleName,
          timestamp,
          { ownerId: npc.id, ownerName: npc.name, location: npc.currentLocation },
          "keeper" // 默认 NPC 私有物品对玩家隐藏，防止剧透
        );
        const itemNode: GraphNode = {
          id: itemNodeId,
          type: "item",
          title: item.name,
          visibility: "keeper",
          meta: { ownerId: npc.id, ownerName: npc.name, location: npc.currentLocation },
          chunkIds: [itemChunk.id],
          updatedAt: timestamp,
        };
        nodes.push(itemNode);
        await this.indexChunks([itemChunk]);
        registerEdge({
          from: nodeId,
          to: itemNodeId,
          type: "OWNS",
          visibility: "keeper",
          meta: { location: npc.currentLocation },
        });
        if (opts.enableNodeEmbeddings) {
          nodeEmbeddings[itemNodeId] = await this.embedder.embed(itemChunk.text);
        }
      }
    }
    console.log(`[RAG] ✓ NPC处理完成`);

    if (moduleData.clues) {
      for (const clue of moduleData.clues) {
        const nodeId = buildNodeId("clue", clue.id);
        this.clueIndex.set(clue.id, nodeId);
        const chunk = createClueChunk(clue, nodeId, opts.moduleName, timestamp);
        const node: GraphNode = {
          id: nodeId,
          type: "clue",
          title: `Clue ${clue.id}`,
          visibility: clue.visibility,
          meta: { clueId: clue.id, links: clue.links },
          chunkIds: [chunk.id],
          updatedAt: timestamp,
        };
        nodes.push(node);
        await this.indexChunks([chunk]);
        if (opts.enableNodeEmbeddings) {
          nodeEmbeddings[nodeId] = await this.embedder.embed(chunk.text);
        }
      }
    }

    if (moduleData.rules) {
      for (const rule of moduleData.rules) {
        const nodeId = buildNodeId("rule", rule.id);
        const chunk = createRuleChunk(rule, nodeId, opts.moduleName, timestamp);
        const node: GraphNode = {
          id: nodeId,
          type: "rule",
          title: `Rule ${rule.id}`,
          visibility: rule.visibility,
          meta: { ruleId: rule.id },
          chunkIds: [chunk.id],
          updatedAt: timestamp,
        };
        nodes.push(node);
        await this.indexChunks([chunk]);
        if (opts.enableNodeEmbeddings) {
          nodeEmbeddings[nodeId] = await this.embedder.embed(chunk.text);
        }
      }
    }

    // Player inventory as items (可见性为 player)
    if (moduleData.playerInventory && moduleData.playerInventory.length > 0) {
      const ownerId = moduleData.playerId ?? "player";
      const ownerName = moduleData.playerName ?? "Player";
      for (const item of moduleData.playerInventory) {
        const itemNodeId = this.resolveItemId(ownerId, item.name);
        const itemChunk = createItemChunk(
          item,
          itemNodeId,
          opts.moduleName,
          timestamp,
          { ownerId, ownerName, location: undefined },
          "player"
        );
        const itemNode: GraphNode = {
          id: itemNodeId,
          type: "item",
          title: item.name,
          visibility: "player",
          meta: { ownerId, ownerName },
          chunkIds: [itemChunk.id],
          updatedAt: timestamp,
        };
        nodes.push(itemNode);
        await this.indexChunks([itemChunk]);
        const ownerNodeId = buildNodeId("npc", ownerId);
        const hasOwnerNode =
          nodes.some((n) => n.id === ownerNodeId) ||
          Boolean(this.graph.getGraph().nodes[ownerNodeId]);
        if (hasOwnerNode) {
          registerEdge({
            from: ownerNodeId,
            to: itemNodeId,
            type: "OWNS",
            visibility: "player",
          });
        }
        if (opts.enableNodeEmbeddings) {
          nodeEmbeddings[itemNodeId] = await this.embedder.embed(itemChunk.text);
        }
      }
    }

    for (const [nodeId, scenario] of scenarioMap.entries()) {
      for (const exit of scenario.exits ?? []) {
        const targetId = this.scenarioIndex.get(normalizeText(exit.destination));
        if (!targetId) continue;
        const visibility: Visibility = "player";
        registerEdge({
          from: nodeId,
          to: targetId,
          type: "CONNECTED_TO",
          meta: { direction: exit.direction, description: exit.description, condition: exit.condition },
          visibility,
        });
        registerEdge({
          from: targetId,
          to: nodeId,
          type: "CONNECTED_TO",
          meta: { direction: exit.direction, description: exit.description, condition: exit.condition },
          visibility,
        });
      }

      for (const character of scenario.characters ?? []) {
        const npcId =
          (character.id && this.npcIndex.get(normalizeText(character.id))) ||
          this.npcIndex.get(normalizeText(character.name));
        if (!npcId) continue;
        registerEdge({
          from: npcId,
          to: nodeId,
          type: "APPEARS_IN",
          visibility: "player",
          meta: { role: character.role, status: character.status },
        });
      }

      for (const clue of scenario.clues ?? []) {
        const clueNodeId =
          this.clueIndex.get(clue.id) ??
          buildNodeId("clue", clue.id || normalizeText(clue.clueText));
        if (!this.clueIndex.has(clue.id)) {
          const visibility: Visibility = clue.discovered ? "player" : "keeper";
          const chunk = createClueChunk(
            { id: clue.id, text: clue.clueText, visibility },
            clueNodeId,
            opts.moduleName,
            timestamp,
            { scenarioId: scenario.id, scenarioName: scenario.name, location: scenario.location }
          );
          const node: GraphNode = {
            id: clueNodeId,
            type: "clue",
            title: clue.clueText.slice(0, 80),
            visibility,
            meta: { clueId: clue.id, category: clue.category },
            chunkIds: [chunk.id],
            updatedAt: timestamp,
          };
          nodes.push(node);
          await this.indexChunks([chunk]);
          if (opts.enableNodeEmbeddings) nodeEmbeddings[clueNodeId] = await this.embedder.embed(chunk.text);
          this.clueIndex.set(clue.id, clueNodeId);
        }

        registerEdge({
          from: nodeId,
          to: clueNodeId,
          type: "HAS_CLUE",
          visibility: "player",
          meta: { location: clue.location, difficulty: clue.difficulty },
        });
      }
    }

    for (const npc of moduleData.npcs) {
      const npcNodeId = this.npcIndex.get(normalizeText(npc.name));
      if (!npcNodeId) continue;

      for (const clue of npc.clues ?? []) {
        const visibility: Visibility = clue.revealed ? "player" : "keeper";
        const clueNodeId =
          this.clueIndex.get(clue.id) ?? buildNodeId("clue", clue.id || normalizeText(clue.clueText));
        if (!this.clueIndex.has(clue.id)) {
          const chunk = createClueChunk(
            { id: clue.id, text: clue.clueText, visibility },
            clueNodeId,
            opts.moduleName,
            timestamp,
            { npcId: npc.id, npcName: npc.name, location: npc.currentLocation }
          );
          const node: GraphNode = {
            id: clueNodeId,
            type: "clue",
            title: clue.clueText.slice(0, 80),
            visibility,
            meta: { clueId: clue.id, category: clue.category },
            chunkIds: [chunk.id],
            updatedAt: timestamp,
          };
          nodes.push(node);
          await this.indexChunks([chunk]);
          if (opts.enableNodeEmbeddings) nodeEmbeddings[clueNodeId] = await this.embedder.embed(chunk.text);
          this.clueIndex.set(clue.id, clueNodeId);
        }
        registerEdge({
          from: npcNodeId,
          to: clueNodeId,
          type: "KNOWS",
          visibility,
          meta: { difficulty: clue.difficulty },
        });
      }

      for (const rel of npc.relationships ?? []) {
        const targetId =
          this.npcIndex.get(normalizeText(rel.targetId)) ??
          this.npcIndex.get(normalizeText(rel.targetName));
        if (!targetId) continue;
        registerEdge({
          from: npcNodeId,
          to: targetId,
          type: "RELATED_TO",
          visibility: "player",
          meta: { relationshipType: rel.relationshipType, attitude: rel.attitude },
        });
        registerEdge({
          from: targetId,
          to: npcNodeId,
          type: "RELATED_TO",
          visibility: "player",
          meta: { relationshipType: rel.relationshipType, attitude: rel.attitude },
        });
      }
    }

    const ruleNodes = nodes.filter((n) => n.type === "rule");
    if (ruleNodes.length) {
      const targetNodes = nodes.filter((n) => n.type === "scenario" || n.type === "npc");
      for (const ruleNode of ruleNodes) {
        for (const target of targetNodes) {
          registerEdge({
            from: ruleNode.id,
            to: target.id,
            type: "APPLIES_TO",
            visibility: ruleNode.visibility,
          });
        }
      }
    }

    this.graph.upsertNodes(nodes);
    this.graph.upsertEdges(edges);

    if (opts.enableKnnEdges) {
      console.log(`[RAG] 生成KNN边中... (${Object.keys(nodeEmbeddings).length} 个节点)`);
      const knnK = opts.knnK ?? 15;
      const threshold = opts.knnThreshold ?? 0.75;
      const knnEdges: GraphEdge[] = [];
      const nodeIds = Object.keys(nodeEmbeddings);
      for (let i = 0; i < nodeIds.length; i++) {
        const fromId = nodeIds[i];
        if (i % 50 === 0 && i > 0) {
          console.log(`[RAG] KNN进度: ${i}/${nodeIds.length}`);
        }
        const fromEmbedding = nodeEmbeddings[fromId];
        const fromNode = this.graph.getGraph().nodes[fromId];
        if (!fromNode) continue;
        const sims: { to: string; score: number }[] = [];
        for (const [toId, toEmbedding] of Object.entries(nodeEmbeddings)) {
          if (fromId === toId) continue;
          const toNode = this.graph.getGraph().nodes[toId];
          if (!toNode || !allowedKnnTargets(fromNode, toNode)) continue;
          const score = cosineSimilarity(fromEmbedding, toEmbedding);
          if (score >= threshold) sims.push({ to: toId, score });
        }
        sims
          .sort((a, b) => b.score - a.score)
          .slice(0, knnK)
          .forEach((sim) => {
            knnEdges.push({
              from: fromId,
              to: sim.to,
              type: "SIMILAR_TO",
              weight: sim.score,
              visibility:
                this.graph.getGraph().nodes[fromId].visibility === "keeper" ||
                this.graph.getGraph().nodes[sim.to].visibility === "keeper"
                  ? "keeper"
                  : "player",
            });
          });
      }
      this.graph.upsertEdges(knnEdges);
      console.log(`[RAG] ✓ KNN边生成完成 (${knnEdges.length} 条边)`);
    }
    
    console.log(`[RAG] ✓ 知识库构建完成: ${nodes.length} 个节点, ${edges.length} 条边`);
  }

  async applyKbDelta(delta: KBDelta, opts: BuildOptions): Promise<void> {
    const timestamp = Date.now();
    if (delta.type === "ADD_CLUE") {
      const nodeId = buildNodeId("clue", delta.clue.id);
      this.clueIndex.set(delta.clue.id, nodeId);
      const chunk = createClueChunk(delta.clue, nodeId, opts.moduleName, timestamp);
      const node: GraphNode = {
        id: nodeId,
        type: "clue",
        title: `Clue ${delta.clue.id}`,
        visibility: delta.clue.visibility,
        meta: { clueId: delta.clue.id, links: delta.clue.links },
        chunkIds: [chunk.id],
        updatedAt: timestamp,
      };
      this.graph.upsertNodes([node]);
      await this.indexChunks([chunk]);
      await this.rebuildKnnEdges([nodeId], opts);
      return;
    }

    if (delta.type === "UPDATE_SCENARIO") {
      const nodeId = buildNodeId("scenario", delta.scenarioId);
      const graphNodes = this.graph.getGraph().nodes;
      const node = graphNodes[nodeId];
      if (!node) return;
      const snapshot: ScenarioSnapshot =
        node.meta.snapshot ?? ({} as ScenarioSnapshot);
      const merged = { ...snapshot, ...delta.patch };
      node.meta.snapshot = merged;
      node.title = merged.name ?? node.title;
      node.updatedAt = timestamp;
      if (merged.name) this.scenarioIndex.set(normalizeText(merged.name), nodeId);
      this.graph.upsertNodes([node]);
      await this.vector.delete(node.chunkIds);
      await this.lex.delete(node.chunkIds);
      this.chunkStore.remove(node.chunkIds);
      const chunks = createScenarioChunks(
        merged,
        nodeId,
        opts.moduleName,
        timestamp
      );
      node.chunkIds = chunks.map((chunk) => chunk.id);
      await this.indexChunks(chunks);
      const newNodeIds = await this.rebuildScenarioEdges(nodeId, merged, opts, timestamp);
      await this.rebuildKnnEdges([nodeId, ...newNodeIds], opts);
      return;
    }

    if (delta.type === "UPDATE_NPC") {
      const nodeId = buildNodeId("npc", delta.npcId);
      const graphNodes = this.graph.getGraph().nodes;
      const node = graphNodes[nodeId];
      if (!node) return;
      const profile: NPCProfile = node.meta.profile ?? ({} as NPCProfile);
      const merged = { ...profile, ...delta.patch };
      node.meta.profile = merged;
      node.title = merged.name ?? node.title;
      node.updatedAt = timestamp;
      if (merged.name) this.npcIndex.set(normalizeText(merged.name), nodeId);
      this.graph.upsertNodes([node]);
      await this.vector.delete(node.chunkIds);
      await this.lex.delete(node.chunkIds);
      this.chunkStore.remove(node.chunkIds);
      const chunks = createNpcChunks(
        merged,
        nodeId,
        opts.moduleName,
        timestamp
      );
      node.chunkIds = chunks.map((chunk) => chunk.id);
      await this.indexChunks(chunks);
      const newNodeIds = await this.rebuildNpcEdges(nodeId, merged, opts, timestamp);
      await this.rebuildKnnEdges([nodeId, ...newNodeIds], opts);
      return;
    }

  }

  private resolveScenarioId(nameOrId?: string): string | undefined {
    if (!nameOrId) return undefined;
    return (
      this.scenarioIndex.get(normalizeText(nameOrId)) ??
      (nameOrId.startsWith("scenario:") ? nameOrId : undefined)
    );
  }

  private resolveNpcId(nameOrId?: string): string | undefined {
    if (!nameOrId) return undefined;
    return (
      this.npcIndex.get(normalizeText(nameOrId)) ??
      (nameOrId.startsWith("npc:") ? nameOrId : undefined)
    );
  }

  private resolveClueId(id?: string): string | undefined {
    if (!id) return undefined;
    return this.clueIndex.get(id) ?? (id.startsWith("clue:") ? id : undefined);
  }

  private resolveItemId(ownerId: string, itemName: string): string {
    const normalized = normalizeText(itemName) || simpleHash(itemName).toString();
    return buildNodeId("item", `${ownerId}:${normalized}`);
  }

  private async rebuildScenarioEdges(
    nodeId: string,
    scenario: ScenarioSnapshot,
    opts: BuildOptions,
    timestamp: number
  ): Promise<string[]> {
    const edges: GraphEdge[] = [];
    const nodes: GraphNode[] = [];
    const newNodeIds: string[] = [];
    const registerEdge = (edge: GraphEdge) => edges.push(edge);

    this.graph.removeEdges({ from: nodeId, type: "CONNECTED_TO" });
    this.graph.removeEdges({ to: nodeId, type: "CONNECTED_TO" });
    this.graph.removeEdges({ from: nodeId, type: "HAS_CLUE" });
    this.graph.removeEdges({ to: nodeId, type: "APPEARS_IN" });

    for (const exit of ensureArray(scenario.exits)) {
      const targetId = this.scenarioIndex.get(normalizeText(exit.destination));
      if (!targetId) continue;
      const visibility: Visibility = "player";
      registerEdge({
        from: nodeId,
        to: targetId,
        type: "CONNECTED_TO",
        meta: { direction: exit.direction, description: exit.description, condition: exit.condition },
        visibility,
      });
      registerEdge({
        from: targetId,
        to: nodeId,
        type: "CONNECTED_TO",
        meta: { direction: exit.direction, description: exit.description, condition: exit.condition },
        visibility,
      });
    }

    for (const character of ensureArray(scenario.characters)) {
      const npcId =
        (character.id && this.npcIndex.get(normalizeText(character.id))) ||
        this.npcIndex.get(normalizeText(character.name));
      if (!npcId) continue;
      registerEdge({
        from: npcId,
        to: nodeId,
        type: "APPEARS_IN",
        visibility: "player",
        meta: { role: character.role, status: character.status },
      });
    }

    for (const clue of ensureArray(scenario.clues)) {
      const visibility: Visibility = clue.discovered ? "player" : "keeper";
      const clueNodeId =
        this.clueIndex.get(clue.id) ??
        buildNodeId("clue", clue.id || normalizeText(clue.clueText));
      if (!this.clueIndex.has(clue.id)) {
        const chunk = createClueChunk(
          { id: clue.id, text: clue.clueText, visibility },
          clueNodeId,
          opts.moduleName,
          timestamp,
          { scenarioId: scenario.id, scenarioName: scenario.name, location: scenario.location }
        );
        const node: GraphNode = {
          id: clueNodeId,
          type: "clue",
          title: clue.clueText.slice(0, 80),
          visibility,
          meta: { clueId: clue.id, category: clue.category },
          chunkIds: [chunk.id],
          updatedAt: timestamp,
        };
        nodes.push(node);
        newNodeIds.push(node.id);
        await this.indexChunks([chunk]);
        this.clueIndex.set(clue.id, clueNodeId);
      }

      registerEdge({
        from: nodeId,
        to: clueNodeId,
        type: "HAS_CLUE",
        visibility: "player",
        meta: { location: clue.location, difficulty: clue.difficulty },
      });
    }

    if (nodes.length) this.graph.upsertNodes(nodes);
    if (edges.length) this.graph.upsertEdges(edges);
    return newNodeIds;
  }

  private async rebuildNpcEdges(
    nodeId: string,
    npc: NPCProfile,
    opts: BuildOptions,
    timestamp: number
  ): Promise<string[]> {
    const edges: GraphEdge[] = [];
    const nodes: GraphNode[] = [];
    const newNodeIds: string[] = [];
    const registerEdge = (edge: GraphEdge) => edges.push(edge);

    this.graph.removeEdges({ from: nodeId, type: "KNOWS" });
    this.graph.removeEdges({ from: nodeId, type: "RELATED_TO" });
    this.graph.removeEdges({ to: nodeId, type: "RELATED_TO" });
    this.graph.removeEdges({ from: nodeId, type: "OWNS" });

    for (const clue of ensureArray(npc.clues)) {
      const visibility: Visibility = clue.revealed ? "player" : "keeper";
      const clueNodeId =
        this.clueIndex.get(clue.id) ??
        buildNodeId("clue", clue.id || normalizeText(clue.clueText));
      if (!this.clueIndex.has(clue.id)) {
        const chunk = createClueChunk(
          { id: clue.id, text: clue.clueText, visibility },
          clueNodeId,
          opts.moduleName,
          timestamp,
          { npcId: npc.id, npcName: npc.name, location: npc.currentLocation }
        );
        const node: GraphNode = {
          id: clueNodeId,
          type: "clue",
          title: clue.clueText.slice(0, 80),
          visibility,
          meta: { clueId: clue.id, category: clue.category },
          chunkIds: [chunk.id],
          updatedAt: timestamp,
        };
        nodes.push(node);
        newNodeIds.push(node.id);
        await this.indexChunks([chunk]);
        this.clueIndex.set(clue.id, clueNodeId);
      }
      registerEdge({
        from: nodeId,
        to: clueNodeId,
        type: "KNOWS",
        visibility,
        meta: { difficulty: clue.difficulty },
      });
    }

    for (const rel of ensureArray(npc.relationships)) {
      const targetId =
        this.npcIndex.get(normalizeText(rel.targetId)) ||
        this.npcIndex.get(normalizeText(rel.targetName));
      if (!targetId) continue;
      registerEdge({
        from: nodeId,
        to: targetId,
        type: "RELATED_TO",
        visibility: "player",
        meta: { relationshipType: rel.relationshipType, attitude: rel.attitude },
      });
      registerEdge({
        from: targetId,
        to: nodeId,
        type: "RELATED_TO",
        visibility: "player",
        meta: { relationshipType: rel.relationshipType, attitude: rel.attitude },
      });
    }

    for (const item of ensureArray(npc.inventory)) {
      const itemNodeId = this.resolveItemId(npc.id, item.name);
      const itemChunk = createItemChunk(
        item,
        itemNodeId,
        opts.moduleName,
        timestamp,
        { ownerId: npc.id, ownerName: npc.name, location: npc.currentLocation },
        "keeper"
      );
      const itemNode: GraphNode = {
        id: itemNodeId,
        type: "item",
        title: item.name,
        visibility: "keeper",
        meta: { ownerId: npc.id, ownerName: npc.name, location: npc.currentLocation },
        chunkIds: [itemChunk.id],
        updatedAt: timestamp,
      };
      nodes.push(itemNode);
      newNodeIds.push(itemNode.id);
      await this.indexChunks([itemChunk]);
      registerEdge({
        from: nodeId,
        to: itemNodeId,
        type: "OWNS",
        visibility: "keeper",
        meta: { location: npc.currentLocation },
      });
    }

    if (nodes.length) this.graph.upsertNodes(nodes);
    if (edges.length) this.graph.upsertEdges(edges);
    return newNodeIds;
  }

  private seedNodesFromQuery(q: RagQuery): string[] {
    const seeds = new Set<string>();
    const scenarioSeed =
      this.resolveScenarioId(q.entities.currentScenarioId) ??
      this.resolveScenarioId(q.entities.currentScenarioName);
    if (scenarioSeed) seeds.add(scenarioSeed);

    const targetSeed = this.resolveNpcId(q.entities.targetName) ?? this.resolveClueId(q.entities.targetName);
    if (targetSeed) seeds.add(targetSeed);

    q.entities.npcsInScene
      .map((name) => this.resolveNpcId(name))
      .filter(Boolean)
      .forEach((id) => seeds.add(id as string));

    q.entities.discoveredClues
      .map((id) => this.resolveClueId(id))
      .filter(Boolean)
      .forEach((id) => seeds.add(id as string));

    return Array.from(seeds);
  }

  private expandGraph(
    seeds: string[],
    opts: RetrievalOptions,
    mode: Visibility
  ): Candidate[] {
    const visited = new Set<string>();
    // 增强：追踪每个节点的到达路径
    const queue: Array<{ nodeId: string; depth: number; path: string[] }> = seeds.map((id) => ({
      nodeId: id,
      depth: 0,
      path: [id],  // 路径从 seed 开始
    }));
    const graphCandidates: Candidate[] = [];
    const graph = this.graph.getGraph();

    while (queue.length > 0) {
      const { nodeId, depth, path } = queue.shift() as { nodeId: string; depth: number; path: string[] };
      if (visited.has(nodeId) || depth > opts.graphHops) continue;
      visited.add(nodeId);

      const node = graph.nodes[nodeId];
      if (!node) continue;

      const score = depth === 0 ? 1 : depth === 1 ? 0.7 : 0.4;
      node.chunkIds.forEach((chunkId) => {
        const chunk = this.chunkStore.get(chunkId);
        if (!chunk || chunk.visibility !== mode) return;
        graphCandidates.push({
          chunkId,
          nodeId,
          graphScore: score,
          graphPath: path,  // 记录到达此节点的路径
        });
      });

      if (depth === opts.graphHops) continue;
      const neighbors = this.graph.neighbors(nodeId, { visibility: mode });
      neighbors.forEach((edge) => queue.push({
        nodeId: edge.to,
        depth: depth + 1,
        path: [...path, edge.to],  // 扩展路径
      }));
    }

    return graphCandidates.sort((a, b) => (b.graphScore ?? 0) - (a.graphScore ?? 0)).slice(0, opts.topKGraph);
  }

  async retrieveCandidates(q: RagQuery, opts: RetrievalOptions): Promise<{
    candidates: Candidate[];
    debug: Record<string, any>;
  }> {
    console.log(`[RAG] 生成查询embedding...`);
    const embedStartTime = Date.now();
    const queryEmbedding = await this.embedder.embed(q.queryText || q.intent);
    console.log(`[RAG] Embedding生成完成 (耗时: ${Date.now() - embedStartTime}ms)`);
    
    console.log(`[RAG] 语义检索中 (topK: ${opts.topKSemantic})...`);
    const semanticStartTime = Date.now();
    const semanticHits = await this.vector.search(
      queryEmbedding,
      opts.topKSemantic,
      chunkFilter(q.mode)
    );
    console.log(`[RAG] 语义检索完成: ${semanticHits.length} 条结果 (耗时: ${Date.now() - semanticStartTime}ms)`);
    
    console.log(`[RAG] 关键词检索中 (topK: ${opts.topKLexical})...`);
    const lexicalStartTime = Date.now();
    const lexicalHits = await this.lex.search(q.queryText || q.intent, opts.topKLexical, chunkFilter(q.mode));
    console.log(`[RAG] 关键词检索完成: ${lexicalHits.length} 条结果 (耗时: ${Date.now() - lexicalStartTime}ms)`);
    
    const seeds = this.seedNodesFromQuery(q);
    console.log(`[RAG] 图检索种子节点: ${seeds.length} 个`);
    const graphStartTime = Date.now();
    const graphHits = this.expandGraph(seeds, opts, q.mode);
    console.log(`[RAG] 图检索完成: ${graphHits.length} 条结果 (耗时: ${Date.now() - graphStartTime}ms)`);

    // 提取查询关键词用于匹配
    const queryTerms = tokenize(q.queryText || q.intent);

    const merged = new Map<string, Candidate>();
    const upsert = (hit: Candidate) => {
      const existing = merged.get(hit.chunkId) ?? { chunkId: hit.chunkId, nodeId: hit.nodeId };
      // 合并数组字段
      const mergedCandidate = { ...existing, ...hit };
      if (existing.graphPath && hit.graphPath) {
        mergedCandidate.graphPath = existing.graphPath;
      }
      if (existing.matchedKeywords || hit.matchedKeywords) {
        mergedCandidate.matchedKeywords = uniq([
          ...(existing.matchedKeywords ?? []),
          ...(hit.matchedKeywords ?? []),
        ]);
      }
      merged.set(hit.chunkId, mergedCandidate);
    };

    semanticHits.forEach((hit) =>
      upsert({
        chunkId: hit.id,
        nodeId: hit.payload?.nodeId,
        semanticScore: hit.score,
      })
    );
    lexicalHits.forEach((hit) => {
      const chunk = this.chunkStore.get(hit.id);
      if (!chunk) return;
      // 计算命中的关键词
      const chunkTokens = new Set(tokenize(chunk.text + " " + chunk.tags.join(" ")));
      const matchedKeywords = queryTerms.filter((term) => chunkTokens.has(term));
      upsert({
        chunkId: hit.id,
        nodeId: chunk.nodeId,
        lexicalScore: hit.score,
        matchedKeywords: matchedKeywords.length > 0 ? matchedKeywords : undefined,
      });
    });
    graphHits.forEach(upsert);

    return {
      candidates: Array.from(merged.values()),
      debug: {
        seeds,
        semanticHits,
        lexicalHits,
        graphHits,
        queryTerms,  // 添加查询词到调试信息
      },
    };
  }

  async runRagForTurn(
    state: GameState,
    opts?: {
      mode?: Visibility;
      retrieval?: Partial<RetrievalOptions>;
      weights?: Partial<RankWeights>;
      topN?: number;
      skipWriteback?: boolean;
      useDynamicWeights?: boolean;  // 是否使用基于 actionType 的动态权重
    }
  ): Promise<{ evidence: Evidence[]; debug: any }> {
    const startTime = Date.now();  // 开始计时

    const mode = opts?.mode ?? "player";
    const retrieval: RetrievalOptions = { ...DEFAULT_RETRIEVAL_OPTIONS, ...(opts?.retrieval ?? {}) };
    const topN = opts?.topN ?? DEFAULT_TOP_N;

    const q = buildRagQuery(state, mode);
    console.log(`[RAG] 构建查询: "${q.queryText || q.intent}" (动作类型: ${q.actionType}, 模式: ${mode})`);

    // 动态权重：根据 actionType 调整权重策略
    const useDynamic = opts?.useDynamicWeights ?? true;  // 默认启用动态权重
    const weights: RankWeights = useDynamic
      ? getWeightsByActionType(q.actionType, opts?.weights)
      : { ...DEFAULT_RANK_WEIGHTS, ...(opts?.weights ?? {}) };

    console.log(`[RAG] 开始检索候选 (语义: ${retrieval.topKSemantic}, 关键词: ${retrieval.topKLexical}, 图: ${retrieval.topKGraph})`);
    const retrieveStartTime = Date.now();
    const { candidates, debug } = await this.retrieveCandidates(q, retrieval);
    const retrieveDuration = Date.now() - retrieveStartTime;
    console.log(`[RAG] 检索完成: 找到 ${candidates.length} 个候选 (耗时: ${retrieveDuration}ms)`);

    const scored: RankedCandidate[] = candidates
      .map((candidate) => {
        const chunk = this.chunkStore.get(candidate.chunkId);
        if (!chunk) return undefined;
        const finalScore = scoreCandidate(candidate, q, state, chunk, weights);
        const reasons = generateWhyThis(candidate, chunk, q, weights);
        return { ...candidate, finalScore, reasons };
      })
      .filter((c): c is RankedCandidate => Boolean(c))
      .sort((a, b) => b.finalScore - a.finalScore);

    const limited: RankedCandidate[] = [];
    const perNodeCount = new Map<string, number>();
    for (const candidate of scored) {
      const count = perNodeCount.get(candidate.nodeId) ?? 0;
      if (count >= 2) continue;
      perNodeCount.set(candidate.nodeId, count + 1);
      limited.push(candidate);
      if (limited.length >= topN) break;
    }

    const evidence = await buildEvidencePackFromCandidates(limited, this.chunkStore, q);
    console.log(`[RAG] 评分和排序完成: 最终选择 ${evidence.length} 条证据 (topN: ${topN})`);

    if (!opts?.skipWriteback && state.temporaryInfo) {
      (state.temporaryInfo as any).ragResults = evidence as any;
    }

    const executionTimeMs = Date.now() - startTime;
    console.log(`[RAG] 总耗时: ${executionTimeMs}ms`);

    // 记录查询日志（如果启用）
    if (this.logger) {
      this.logger.log({
        id: `rag-${state.sessionId}-${Date.now()}`,
        sessionId: state.sessionId,
        timestamp: Date.now(),
        mode,
        actionType: q.actionType,
        queryText: q.queryText || q.intent,
        seeds: debug.seeds || [],
        weights,
        semanticHitsCount: debug.semanticHits?.length ?? 0,
        lexicalHitsCount: debug.lexicalHits?.length ?? 0,
        graphHitsCount: debug.graphHits?.length ?? 0,
        totalCandidates: candidates.length,
        finalResultsCount: evidence.length,
        topResults: limited.slice(0, 5).map((c) => {
          const chunk = this.chunkStore.get(c.chunkId);
          return {
            chunkId: c.chunkId,
            score: c.finalScore,
            type: chunk?.type ?? "scenario",
          };
        }),
        executionTimeMs,
      });
    }

    return {
      evidence,
      debug: {
        ...debug,
        query: q,
        weights,  // 添加实际使用的权重
        usedDynamicWeights: useDynamic,
        actionType: q.actionType,
        executionTimeMs,  // 添加执行时间
      },
    };
  }
}

export const createInMemoryRagManager = (): RagManager => new RagManager();
export const createSqliteRagManager = (db: CoCDatabase): RagManager =>
  new RagManager({ db });
export const createSqliteRagManagerWithLogging = (db: CoCDatabase): RagManager =>
  new RagManager({ db, enableQueryLogging: true });
export const createBgeSqliteRagManager = (db: CoCDatabase): RagManager =>
  new RagManager({
    db,
    embedder: new CompositeEmbeddingProvider(
      new EmbeddingClientProvider(ModelProviderName.OPENAI),
      new HashEmbeddingProvider()
    ),
  });
