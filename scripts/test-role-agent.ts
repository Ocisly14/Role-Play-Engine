#!/usr/bin/env tsx
//
// scripts/test-role-agent.ts
//
// FULL END-TO-END test for the roleSim layer through the real engine
// pipeline. This is the integration script — every layer between agent and
// engine runs production code, with the only stub being the memory store
// (Prisma + embeddings would otherwise require a live DB).
//
// Real components driven:
//   - DynamicGameStateManager
//   - createTickEngine (queue, applier, scriptedRunner, all 8 subsystems)
//   - NpcActionController (subscribes to tickCompleted; per-NPC perception
//     ring buffer; LLM render → agent decide → engine.submitAction)
//   - LLMRoleSimAgent loop (instant tools + terminal tools)
//   - PerceivableDirectory + parseActionText (citation contract)
//   - interpretAction (LLM definition matcher)
//   - resolveState (LLM action resolver per ActionDefinition)
//   - All 8 default subsystems (weather/sun/stamina/itemDamage/fire/movement/
//     conditionExpiry x2)
//
// Stubbed:
//   - NpcMemoryManager: in-memory; query() does substring match against a
//     long-term seed so recallMemory can hit a few canned beliefs.
//
// Drives N ticks via engine.tick() and observes via tickCompleted events.
// Each tick can cost up to 4-5 LLM calls per active NPC (renderer + agent
// loop iterations + interpreter + resolver), so 3 ticks × 2 NPCs ≈ 25-40
// LLM calls. Expect ~3-6 minutes wall time.
//
// Run: pnpm tsx scripts/test-role-agent.ts
// Requires the relevant *_API_KEY in .env for the configured MODEL_PROVIDER.

import "dotenv/config";

import { mkdirSync, createWriteStream, writeFileSync, readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

// === Engine ===
import { createTickEngine } from "../src/engine/core/tickEngine.js";
import {
  createDefaultDefinitions,
  createDefaultSubsystemRegistry,
} from "../src/engine/registerDefaults.js";
import { interpretAction } from "../src/engine/interpreter/gameInterpreter.js";
import { resolveState } from "../src/engine/resolver/stateResolver.js";
import { buildStateContext } from "../src/engine/resolver/stateContextBuilder.js";
import { executeSkillCheck } from "../src/engine/tools/skillCheckTool.js";
import type {
  ActionStep,
  PlannedOutcome,
  TickReport,
} from "../src/engine/core/types.js";
import type { ToolResult } from "../src/engine/types.js";

// === RoleSim (real controller + agent) ===
import { LLMRoleSimAgent } from "../src/roleSim/llmAgent.js";
import { NpcActionController } from "../src/roleSim/npcActionController.js";

// === State ===
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../src/state/DynamicGameState.js";
import { buildTopology } from "../src/state/topologyTypes.js";
import type {
  DynamicNPCProfile,
  DynamicScene,
} from "../src/state/types.js";
import type { CharacterPosition } from "../src/state/topologyTypes.js";

// === Memory (stubbed) ===
import type { NpcMemoryManager } from "../src/memory/NpcMemoryManager.js";
import type { NpcMemory, NpcMemoryType } from "@prisma/client";

// =========================================================================
// 0. TEE LOG — mirror all console output into logs/role-agent-test-<ts>.log
// =========================================================================

const LOG_DIR = pathResolve(process.cwd(), "logs");
mkdirSync(LOG_DIR, { recursive: true });
const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_PATH = pathResolve(LOG_DIR, `role-agent-test-${RUN_TS}.log`);
const JSON_PATH = pathResolve(LOG_DIR, `role-agent-test-${RUN_TS}.json`);
const logStream = createWriteStream(LOG_PATH, { flags: "a" });

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}
function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a, null, 2);
  } catch {
    return String(a);
  }
}
function tee(orig: (...args: unknown[]) => void, label: string) {
  return (...args: unknown[]) => {
    orig(...args);
    const line = args.map(formatArg).join(" ");
    logStream.write(`${label}${stripAnsi(line)}\n`);
  };
}
console.log = tee(console.log.bind(console), "");
console.warn = tee(console.warn.bind(console), "[warn] ");
console.error = tee(console.error.bind(console), "[err]  ");

process.on("exit", () => logStream.end());

console.log(`(logging to ${LOG_PATH})`);
console.log(`(structured run record → ${JSON_PATH})`);

// =========================================================================
// 1. WORLD: two NPCs from the Cassandra_zh module, placed in the police
//    station lobby (SCN_3_SUB_1). Picked for natural tension:
//      - Bruno Galilei (warden) — straight-arrow detective working a stalled
//        case; trusts Lux loosely.
//      - Lux Lynch     (warden) — corrupt cop secretly helping Bruno but
//        terrified of being found out.
// =========================================================================

const MOD_DIR = pathResolve(
  process.cwd(),
  "data/Mods/Cassandra_zh/Cassandra_Scenarios"
);
const NPC_DIR = pathResolve(
  process.cwd(),
  "data/Mods/Cassandra_zh/Cassandra's_npc"
);

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** Convert Cassandra `[{skill, delta}]` form into the engine's
 *  `Record<skill, delta>` shape. Idempotent on already-record input. */
function adaptSkillPenalty(
  raw: unknown
): Record<string, number> | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) {
    const out: Record<string, number> = {};
    for (const p of raw as Array<{ skill?: string; delta?: number }>) {
      if (p?.skill) out[p.skill] = p.delta ?? 0;
    }
    return out;
  }
  return raw as Record<string, number>;
}

function loadCassandraScene(fileName: string): DynamicScene {
  const raw = readJson<any>(pathResolve(MOD_DIR, fileName));
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? "",
    parentLocationId: raw.parentLocationId ?? raw.id,
    items: raw.items ?? [],
    itemContexts: raw.itemContexts,
    conditions: (raw.conditions ?? []).map((c: any) => ({
      description: c.description ?? "",
      featureId: c.featureId,
      data: c.data,
      mechanicalEffect: c.mechanicalEffect
        ? {
            skillPenalty: adaptSkillPenalty(c.mechanicalEffect.skillPenalty),
            blockConnections: c.mechanicalEffect.blockConnections,
          }
        : undefined,
    })),
    connections: raw.connections ?? [],
    indoor: raw.indoor,
  };
}

function loadCassandraNpc(fileName: string): DynamicNPCProfile {
  const raw = readJson<any>(pathResolve(NPC_DIR, fileName));
  const s = raw.status ?? {};
  return {
    id: raw.id,
    name: raw.name,
    age: raw.age,
    gender: raw.gender,
    occupation: raw.occupation,
    appearance: raw.appearance,
    personality: raw.personality,
    background: raw.background,
    backstory: raw.backstory,
    residence: raw.residence,
    currentLocation: raw.currentLocation,
    longTermIntent: raw.longTermIntent ?? "",
    attributes: raw.attributes ?? {},
    // Cassandra JSON uses `sanity` / `maxSanity` and omits fatigue; engine
    // type expects `san` / `maxSan` / `fatigue` / `maxFatigue`.
    status: {
      hp: s.hp ?? 10,
      maxHp: s.maxHp ?? s.hp ?? 10,
      san: s.san ?? s.sanity ?? 50,
      maxSan: s.maxSan ?? s.maxSanity ?? 99,
      fatigue: s.fatigue ?? 0,
      maxFatigue: s.maxFatigue ?? 10,
      luck: s.luck ?? 50,
      mp: s.mp,
      conditions: s.conditions ?? [],
    },
    // Cassandra inventory entries omit `id`; synthesize one per slot.
    inventory: (raw.inventory ?? []).map((it: any, i: number) => ({
      id: it.id ?? `${raw.id}_inv_${i}`,
      name: it.name,
      quantity: it.quantity,
      properties: it.properties,
    })),
    skills: raw.skills ?? {},
    relationships: raw.relationships ?? [],
    memory: raw.memory ?? [],
    knownMapSeed: raw.knownMapSeed,
  };
}

// Police-station-lobby + the two adjacent sub-scenes so PerceivableDirectory's
// 1-hop adjacency resolves (its consumer is renderer/scene-listing).
const sceneLobby = loadCassandraScene("SCN_3_SUB_1.json");
const sceneAdj2 = loadCassandraScene("SCN_3_SUB_2.json");
const sceneAdj3 = loadCassandraScene("SCN_3_SUB_3.json");
const scene = sceneLobby; // primary scene where both NPCs are placed

const npc = loadCassandraNpc("Bruno Galilei.json");
const visitor = loadCassandraNpc("Lux Lynch.json");

// Override Lux's long-term intent for THIS test only, with a concrete
// short-term goal that points at a real adjacent sub-scene (SCN_3_SUB_2 =
// 法医工作室). This biases her toward cross-scene movement so we can verify
// the movement subsystem fires through the same-building shortcut.
visitor.longTermIntent =
  "今晚必须把布鲁诺单独拉到法医工作室 (SCN_3_SUB_2)，避开大厅里其他人，让他亲眼看到尸检报告里关于 2003 年驯鹿酒吧案的几行被划掉的字。在前台说话太危险——必须先把他带走。";

const initialState = initialDynamicGameState({
  sessionId: "test-session",
  moduleName: "cassandra_zh",
  // Cassandra_zh setup: 2003-12-01 Day 1, 19:00 (see module_setup.json).
  gameDateTime: "2003-12-01T19:00:00",
});
for (const sc of [sceneLobby, sceneAdj2, sceneAdj3]) {
  initialState.scenes.set(sc.id, sc);
}
initialState.npcCharacters.push(npc, visitor);
initialState.npcStats[npc.id] = { hp: npc.status.hp, san: npc.status.san };
initialState.npcStats[visitor.id] = {
  hp: visitor.status.hp,
  san: visitor.status.san,
};
if (npc.residence) initialState.npcResidences[npc.id] = npc.residence;
if (visitor.residence)
  initialState.npcResidences[visitor.id] = visitor.residence;
// Force both NPCs into SCN_3_SUB_1 at session start (overrides each profile's
// own currentLocation so we get them in the same scene).
initialState.characterPositions[npc.id] = {
  type: "scene",
  sceneId: scene.id,
} satisfies CharacterPosition;
initialState.characterPositions[visitor.id] = {
  type: "scene",
  sceneId: scene.id,
} satisfies CharacterPosition;
// Empty topology — no roads/junctions loaded; both NPCs stay inside the
// police-station building during the test.
initialState.topology = buildTopology(new Map(), new Map());

const dgsm = new DynamicGameStateManager(initialState);

// =========================================================================
// 2. STUB MEMORY MANAGER
// =========================================================================
// Substring-match query so recallMemory can find seed entries. The two seed
// memories are Marsh-specific and intentionally NOT in his "today's memories"
// section so the only path to surface them is recallMemory.

interface SeedEntry {
  npcId: string;
  type: NpcMemoryType;
  content: string;
  gameDateTime: string;
}

// Seed memories pulled from each NPC profile's structured `memory[]` field.
// Cassandra entries have type ∈ {information, secret, belief, event} which
// matches the Prisma NpcMemoryType enum directly. Anchored a week before the
// session start so they show up as `recallMemory` hits, not "today's events".
const SEED_DATETIME = "2003-11-24T08:00:00";
function profileSeed(profile: DynamicNPCProfile): SeedEntry[] {
  return (profile.memory ?? []).map((m) => ({
    npcId: profile.id,
    type: m.type as NpcMemoryType,
    content: m.content,
    gameDateTime: SEED_DATETIME,
  }));
}
const seedMemories: SeedEntry[] = [
  ...profileSeed(npc),
  ...profileSeed(visitor),
];

const writtenMemories: SeedEntry[] = [];

function toFakeNpcMemory(seed: SeedEntry, idx: number): NpcMemory {
  return {
    id: `stub-${idx}`,
    npcId: seed.npcId,
    sessionId: "test-session",
    moduleId: "test-module",
    type: seed.type,
    content: seed.content,
    gameDateTime: seed.gameDateTime,
    location: null,
    metadata: null,
    baseImportance: 0.7,
    accessCount: 0,
    lastAccessedAt: new Date(),
    createdAt: new Date(),
    embedding: null,
  } as unknown as NpcMemory;
}

const stubMemory: Pick<
  NpcMemoryManager,
  | "add"
  | "query"
  | "getMapSnapshot"
  | "findLatestByType"
  | "getForDateByTypes"
> = {
  async add(params) {
    const entry: SeedEntry = {
      npcId: params.npcId,
      type: params.type,
      content: params.content,
      gameDateTime: params.gameDateTime,
    };
    writtenMemories.push(entry);
    runRecord.memoryWrites.push({
      npcId: params.npcId,
      type: params.type,
      content: params.content,
      gameDateTime: params.gameDateTime,
    });
    console.log(
      `   [memory.add] npc=${params.npcId} type=${params.type} content="${params.content.slice(0, 70)}${params.content.length > 70 ? "…" : ""}"`
    );
    return toFakeNpcMemory(entry, writtenMemories.length + 1000);
  },
  async query(params) {
    const all = [...seedMemories, ...writtenMemories].filter(
      (m) => m.npcId === params.npcId
    );
    const q = (params.query ?? "").toLowerCase().trim();
    const types = params.filters?.types;
    const matches = all
      .filter((m) => !types || types.includes(m.type))
      .filter((m) => {
        if (!q) return true;
        const haystack = `${m.content} ${m.type}`.toLowerCase();
        return q
          .split(/\s+/)
          .filter((w) => w.length >= 3)
          .some((w) => haystack.includes(w));
      })
      .slice(0, params.limit ?? 10);
    return matches.map((m, i) => ({
      ...toFakeNpcMemory(m, i),
      score: 0.7,
    })) as unknown as Awaited<ReturnType<NpcMemoryManager["query"]>>;
  },
  async getMapSnapshot() {
    return null;
  },
  async findLatestByType() {
    return null;
  },
  async getForDateByTypes(npcId, _sessionId, _gameDate, types) {
    return [...seedMemories, ...writtenMemories]
      .filter((m) => m.npcId === npcId && types.includes(m.type))
      .map((m, i) => toFakeNpcMemory(m, i));
  },
};

// =========================================================================
// 3. REAL ENGINE WIRING
// =========================================================================

const subsystemRegistry = createDefaultSubsystemRegistry();
const definitions = createDefaultDefinitions();
const definitionList = definitions.getAll();
console.log(
  `(loaded ${definitionList.length} action definitions, ${subsystemRegistry.getAll().length} subsystems)`
);

const engine = createTickEngine({
  dgsm,
  subsystemRegistry,
  scriptedEvents: [],
  interpretAction: async (input, directory) => {
    const result = await interpretAction(
      input.actionText,
      definitionList,
      "zh",
      directory
    );
    // Surface the LLM interpreter's per-step verdict (definitionId + impact
    // + engine route) so we can audit propagation behavior without digging
    // into engine internals.
    const verdict = result.steps
      .map((s, i) => {
        const dest =
          s.overlayFields &&
          typeof (s.overlayFields as { destination?: unknown }).destination ===
            "string"
            ? ` destination="${(s.overlayFields as { destination: string }).destination}"`
            : "";
        const txt = s.actionText
          ? ` text="${s.actionText.replace(/\n/g, " ").slice(0, 60)}${s.actionText.length > 60 ? "…" : ""}"`
          : "";
        return `      step${i}: definitionId="${s.definitionId}" impact=${s.impact} engine=${s.engine}${s.codeSubsystem ? ` codeSubsystem=${s.codeSubsystem}` : ""}${dest}${txt}`;
      })
      .join("\n");
    console.log(
      `   [interpreter] ${input.characterId} actionText="${input.actionText.slice(0, 80)}${input.actionText.length > 80 ? "…" : ""}"\n${verdict}`
    );
    runRecord.interpreterCalls.push({
      characterId: input.characterId,
      actionText: input.actionText,
      steps: result.steps.map((s) => ({
        definitionId: s.definitionId,
        impact: s.impact,
        engine: s.engine,
        codeSubsystem: s.codeSubsystem,
        actionText: s.actionText,
        overlayFields: s.overlayFields,
      })),
    });
    return { steps: result.steps };
  },
  resolve: async (
    step: ActionStep,
    ctx: unknown,
    cancel,
    skillCheckResult
  ): Promise<{ outcome: PlannedOutcome; plannedDuration: number }> => {
    const definition = definitions.get(step.definitionId);
    if (!definition) {
      return {
        outcome: { stateChanges: [], elapsedMinutes: 0 },
        plannedDuration: 0,
      };
    }
    const stateContext = buildStateContext(
      definition,
      {
        characterId: step.characterId,
        referencedEntities: step.referencedEntities,
      },
      dgsm,
      step.executionSceneId
    );
    const actionForResolver = cancel
      ? [
          `[CANCELLED at minute ${cancel.elapsedMinutes.toFixed(1)} of planned ${cancel.plannedDuration.toFixed(1)} due to: ${cancel.reason}]`,
          `Original intent: "${step.actionText}"`,
          cancel.plannedNarrative
            ? `Original planned outcome (had it completed): ${cancel.plannedNarrative}`
            : "",
          `Produce a SHORT memory.event reflecting ONLY what actually happened in those ${cancel.elapsedMinutes.toFixed(1)} minutes before cancellation.`,
        ]
          .filter(Boolean)
          .join("\n")
      : step.actionText;
    const resolved = await resolveState({
      action: actionForResolver,
      definition,
      outcomeSection: definition.content,
      stateContext,
      skillCheckResult,
      language: "zh",
    });
    void ctx;
    const elapsedMinutes = cancel ? cancel.elapsedMinutes : resolved.elapsedMinutes;
    // Audit every resolver round-trip so we can correlate (stepId, definition,
    // cancelled?, elapsedMinutes, kinds of stateChanges emitted) — useful for
    // diagnosing time inflation and movement-subsystem vs resolver-emitted
    // position changes.
    const stateChangeKinds = resolved.stateChanges.map((sc) => sc.kind);
    console.log(
      `   [resolver] ${step.characterId} step=${step.id} def=${step.definitionId} ` +
        `cancel=${cancel ? "yes" : "no"} elapsed=${elapsedMinutes}min ` +
        `stateChanges=[${stateChangeKinds.join(", ")}]`
    );
    runRecord.resolverCalls.push({
      stepId: step.id,
      characterId: step.characterId,
      definitionId: step.definitionId,
      cancelled: !!cancel,
      cancelReason: cancel?.reason,
      elapsedMinutes,
      stateChanges: resolved.stateChanges.map((sc) => ({ ...sc })),
      skillCheckStatus: skillCheckResult?.status,
      skillCheckLevel: skillCheckResult?.successLevel,
    });
    return {
      outcome: { stateChanges: resolved.stateChanges, elapsedMinutes },
      plannedDuration: elapsedMinutes,
    };
  },
  runSkillCheck: (step: ActionStep): ToolResult | undefined => {
    const definition = definitions.get(step.definitionId);
    if (!definition?.skillCheck) return undefined;
    const targetIds = step.referencedEntities
      .filter((r) => r.kind === "character")
      .map((r) => r.id);
    const result = executeSkillCheck(
      definition.skillCheck,
      step.characterId,
      undefined,
      dgsm,
      step.executionSceneId,
      targetIds.length > 0 ? targetIds : undefined
    );
    // Surface dice roll outcomes so we can audit whether skill checks actually
    // gate the resolver's narrative (e.g. brawling hits vs misses, intimidate
    // succeeds vs fails).
    console.log(
      `   [skillCheck] ${step.characterId} skill=${definition.skillCheck.skill} ` +
        `difficulty=${definition.skillCheck.difficulty ?? "regular"} ` +
        `type=${definition.skillCheck.type ?? "action"} ` +
        `→ status=${result.status} level=${result.successLevel ?? "?"}` +
        (result.rollDetail ? `  (${result.rollDetail})` : "")
    );
    runRecord.skillChecks.push({
      stepId: step.id,
      characterId: step.characterId,
      definitionId: step.definitionId,
      skill: definition.skillCheck.skill ?? "",
      difficulty: definition.skillCheck.difficulty ?? "regular",
      type: definition.skillCheck.type ?? "action",
      status: result.status,
      successLevel: result.successLevel,
      rollDetail: result.rollDetail,
      perTargetResults: result.perTargetResults,
    });
    return result;
  },
  getActorDex: (id) => dgsm.getNpcProfile(id)?.attributes?.DEX ?? 50,
  tickDurationMinutes: 1,
  lang: "zh",
});

const agent = new LLMRoleSimAgent({
  memory: stubMemory as unknown as NpcMemoryManager,
  dgsm,
  sessionId: "test-session",
  moduleId: "cassandra_zh",
  language: "zh",
  // Capture every LLM iteration of the agent loop — full raw output + parsed
  // tool call. Lets us trace recall→write→act chains without coupling to the
  // model wrapper. Console prints one line per iteration; JSON keeps full
  // responseText so we can replay reasoning offline.
  onIteration: (ev) => {
    const summary = ev.parsed
      ? `tool=${ev.parsed.tool}`
      : `parseError=${ev.parseError}`;
    console.log(
      `   [agent] ${ev.npcId} iter=${ev.iteration} ${summary}  (raw ${ev.responseText.length} chars)`
    );
    runRecord.agentIterations.push({
      npcId: ev.npcId,
      iteration: ev.iteration,
      responseText: ev.responseText,
      parsed: ev.parsed,
      parseError: ev.parseError,
    });
  },
});

const controller = new NpcActionController({
  engine,
  agent,
  memory: stubMemory as unknown as NpcMemoryManager,
  dgsm,
  sessionId: "test-session",
  moduleId: "cassandra_zh",
  language: "zh",
});

// =========================================================================
// 4. OBSERVERS — log everything that flows out of the engine
// =========================================================================
//
// Two parallel sinks per tick: (a) human-readable console line via the tee
// log, (b) structured entry in the run record that ends up in JSON_PATH.

interface TickRecord {
  tick: number;
  gameDateTime: string;
  commits: Array<{
    characterId: string;
    actionText: string;
    /** Interpreter-assigned perceptibility level. Drives impactPropagation
     *  on commit so co-located NPCs get woken into decide() this tick. */
    impact: number;
    definitionId: string;
  }>;
  cancellations: Array<{
    characterId: string;
    actionText: string;
    impact: number;
    definitionId: string;
  }>;
  featureEvents: Array<{
    type: string;
    impact: number;
    description: string;
    characterId?: string;
    sceneId?: string;
  }>;
  /** Raw typed stateChanges that flowed through this tick's applier. Lets
   *  e2e verification confirm resolver actually emitted memory.event +
   *  item.modify entries. */
  stateChanges: Array<{ kind: string; [k: string]: unknown }>;
}

interface RunRecord {
  meta: {
    startedAt: string;
    endedAt?: string;
    durationMs?: number;
    provider: string;
    npcs: Array<{ id: string; name: string }>;
    scene: { id: string; name: string };
    definitionsCount: number;
    subsystemsCount: number;
    nTicks: number;
    logPath: string;
    jsonPath: string;
  };
  ticks: TickRecord[];
  memoryWrites: Array<{
    npcId: string;
    type: string;
    content: string;
    gameDateTime: string;
  }>;
  /** Every interpreter call that ran during this session, with the LLM's
   *  per-step verdict. Records what was sent in (actionText) and what the
   *  interpreter judged (definitionId, impact, engine route) so we can audit
   *  impact propagation behavior without re-running the LLM. */
  interpreterCalls: Array<{
    characterId: string;
    actionText: string;
    steps: Array<{
      definitionId: string;
      impact: number;
      engine: "code" | "llm";
      codeSubsystem?: string;
      /** Per-step localized actionText fragment (from interpreter's `text`
       *  field). Useful to verify fold-trivial-beat shaped output. */
      actionText?: string;
      /** Subsystem-specific inputs the interpreter parsed out (notably
       *  `destination` for movement steps — central for diagnosing why
       *  cross-scene movement may not have fired). */
      overlayFields?: Record<string, unknown>;
    }>;
  }>;
  /** One entry per resolver round-trip (activation OR cancel re-resolve).
   *  Records duration + emitted state-change kinds + which skill check (if
   *  any) gated it. Lets us audit time inflation and resolver-vs-movement
   *  position writes without re-running the LLM. */
  resolverCalls: Array<{
    stepId: string;
    characterId: string;
    definitionId: string;
    cancelled: boolean;
    cancelReason?: string;
    elapsedMinutes: number;
    stateChanges: Array<{ kind: string; [k: string]: unknown }>;
    skillCheckStatus?: string;
    skillCheckLevel?: string;
  }>;
  /** Every skill-check roll executed before resolver activation. Lets us see
   *  whether the resolver's narrative actually respects the dice (e.g. did
   *  the brawling attempt that hit really win, did the intimidate that
   *  cowed the target really succeed). */
  skillChecks: Array<{
    stepId: string;
    characterId: string;
    definitionId: string;
    skill: string;
    difficulty: string;
    type: string;
    status: string;
    successLevel?: string;
    rollDetail?: string;
    perTargetResults?: Record<string, unknown>;
  }>;
  /** One entry per agent decide()-loop iteration: raw LLM output + parsed
   *  tool call. Captures the full reasoning chain (recallMemory →
   *  writeMemory → act/continue) for every NPC, every tick. */
  agentIterations: Array<{
    npcId: string;
    iteration: number;
    responseText: string;
    parsed?: { tool: string; [k: string]: unknown };
    parseError?: string;
  }>;
  exitCode: number;
  error?: { message: string; stack?: string };
}

const N_TICKS = 20;

const runRecord: RunRecord = {
  meta: {
    startedAt: new Date().toISOString(),
    provider: process.env.MODEL_PROVIDER ?? "(unset)",
    npcs: [
      { id: npc.id, name: npc.name },
      { id: visitor.id, name: visitor.name },
    ],
    scene: { id: scene.id, name: scene.name },
    definitionsCount: definitionList.length,
    subsystemsCount: subsystemRegistry.getAll().length,
    nTicks: N_TICKS,
    logPath: LOG_PATH,
    jsonPath: JSON_PATH,
  },
  ticks: [],
  memoryWrites: [],
  interpreterCalls: [],
  resolverCalls: [],
  skillChecks: [],
  agentIterations: [],
  exitCode: 0,
};

let tickCount = 0;
engine.on("tickCompleted", (report: TickReport) => {
  tickCount += 1;
  console.log(`\n${"=".repeat(72)}`);
  console.log(
    `=== Tick ${tickCount} completed @ ${dgsm.getGameDateTime()} ===`
  );
  console.log("=".repeat(72));
  console.log(
    `commits: ${report.commits.length}, ` +
      `cancellations: ${report.cancellations.length}, featureEvents: ${report.featureEvents.length}`
  );
  for (const a of report.commits) {
    console.log(
      `  ✓ COMMITTED  [impact=${a.impact}, def=${a.definitionId}]  ${a.characterId}: ${a.actionText}`
    );
  }
  for (const c of report.cancellations) {
    console.log(
      `  ✗ CANCELLED  [impact=${c.impact}, def=${c.definitionId}]  ${c.characterId}: ${c.actionText}`
    );
  }
  for (const e of report.featureEvents) {
    const tag = `(${e.type}, impact=${e.impact}${e.characterId ? `, actor=${e.characterId}` : ""})`;
    console.log(`  · EVENT ${tag}  ${e.description}`);
  }
  // Surface character.position changes so we can see cross-scene movement
  // actually firing (vs the agent merely narrating a destination).
  for (const sc of report.stateChanges) {
    if (sc.kind === "character.position") {
      const pos = sc.position;
      const where =
        pos.type === "scene"
          ? `scene:${pos.sceneId}`
          : pos.type === "junction"
            ? `junction:${pos.junctionId}`
            : `road:${pos.roadId}`;
      console.log(
        `  → POSITION  ${sc.characterId} now at ${where}  (via ${sc.sourceSubsystem})`
      );
    }
  }

  runRecord.ticks.push({
    tick: tickCount,
    gameDateTime: dgsm.getGameDateTime(),
    commits: report.commits.map((a) => ({
      characterId: a.characterId,
      actionText: a.actionText,
      impact: a.impact,
      definitionId: a.definitionId,
    })),
    cancellations: report.cancellations.map((c) => ({
      characterId: c.characterId,
      actionText: c.actionText,
      impact: c.impact,
      definitionId: c.definitionId,
    })),
    featureEvents: report.featureEvents.map((e) => ({
      type: e.type,
      impact: e.impact,
      description: e.description,
      characterId: e.characterId,
      sceneId: e.sceneId,
    })),
    stateChanges: report.stateChanges.map((s) => ({ ...s })),
  });
});

// =========================================================================
// 5. DRIVE — bootstrap + N ticks
// =========================================================================

function recordError(err: unknown) {
  runRecord.exitCode = 1;
  runRecord.error = {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  };
}

function flushRunRecord(t0: number) {
  runRecord.meta.endedAt = new Date().toISOString();
  runRecord.meta.durationMs = Date.now() - t0;
  try {
    writeFileSync(JSON_PATH, JSON.stringify(runRecord, null, 2));
    console.log(`\n(wrote run record → ${JSON_PATH})`);
  } catch (writeErr) {
    console.error(`Failed to write run record JSON:`, writeErr);
  }
}

async function main() {
  console.log("\n=== test-role-agent (FULL E2E) ===");
  console.log(`NPCs: ${npc.name} (${npc.id}) + ${visitor.name} (${visitor.id})`);
  console.log(`Scene: ${scene.name} (${scene.id})`);
  console.log(
    `Provider: ${process.env.MODEL_PROVIDER ?? "(unset — generator falls back)"}`
  );

  const t0 = Date.now();

  try {
    console.log("\n--- Bootstrap (initial decide pass for all alive NPCs) ---");
    await controller.bootstrap();

    for (let i = 0; i < N_TICKS; i++) {
      console.log(`\n--- Driving tick ${i + 1}/${N_TICKS} ---`);
      await engine.tick();
    }
  } catch (err) {
    console.error("\nRun aborted:", err);
    recordError(err);
    process.exitCode = 1;
  } finally {
    const ms = Date.now() - t0;
    console.log(`\n=== Done in ${(ms / 1000).toFixed(1)}s ===`);
    console.log(`Ticks observed: ${tickCount}`);
    console.log(`Final game time: ${dgsm.getGameDateTime()}`);
    console.log(`Memory writes during run: ${writtenMemories.length}`);
    for (const m of writtenMemories) {
      console.log(`  - npc=${m.npcId} (${m.type}) ${m.content.slice(0, 100)}`);
    }
    // Final positions — confirm whether cross-scene movement actually fired.
    console.log("\nFinal positions:");
    for (const n of [npc, visitor]) {
      const pos = dgsm.getCharacterPosition(n.id);
      const where = pos
        ? pos.type === "scene"
          ? `scene:${pos.sceneId}`
          : pos.type === "junction"
            ? `junction:${pos.junctionId}`
            : `road:${pos.roadId}`
        : "(unknown)";
      console.log(`  ${n.name} (${n.id}) → ${where}`);
    }
    flushRunRecord(t0);
  }
}

main();
