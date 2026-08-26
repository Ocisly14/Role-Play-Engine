// scripts/lib/decisionSim.ts
//
// Stage a scene, drop a few NPCs into it with their own goals, then let the
// REAL tick pipeline run for a few in-world minutes and record everything
// that happened.
//
// This is the engine half of scripts/test-agent-decisions.ts. Every layer is
// production code:
//
//   createTickEngine (queue · applier · scriptedEventRunner · 8 subsystems)
//     ├─ interpretAction   (LLM: narrative → ActionDefinition steps)
//     ├─ executeSkillCheck (real dice against the NPC's real skills)
//     └─ resolveState      (LLM: step → StateChange[])
//   NpcActionController  (tickCompleted → perception → decide → submitAction)
//     └─ LLMRoleSimAgent (the agent loop under test)
//
// Only the memory store is stubbed: an in-memory implementation that honours
// the same contract (long_term_intent is how a staged goal reaches the NPC —
// exactly the production path — and today's event/witness rows written by the
// controller feed the next tick's prompt).
//
// Each call gets its OWN DynamicGameState, deep-cloned from a serialized base
// snapshot, so ticks in one case can never leak into another and cases can run
// concurrently.

import { createTickEngine } from "../../src/engine/core/tickEngine.js";
import type {
  ActionStep,
  CharacterCondition,
  FeatureEvent,
  PlannedOutcome,
  TickReport,
} from "../../src/engine/core/types.js";
import {
  currentLocationOf,
  interpretAction,
} from "../../src/engine/interpreter/gameInterpreter.js";
import type { KnownLocation } from "../../src/engine/interpreter/gameInterpreter.js";
import { createDefaultSubsystemRegistry } from "../../src/engine/registerDefaults.js";
import { buildCancelResolverAction } from "../../src/engine/resolver/cancelPrompt.js";
import { buildStateContext } from "../../src/engine/resolver/stateContextBuilder.js";
import { resolveState } from "../../src/engine/resolver/stateResolver.js";
import type {
  Effect,
  ScriptedEvent,
} from "../../src/engine/scriptedEvents/types.js";
import { executeSkillCheck } from "../../src/engine/tools/skillCheckTool.js";
import type { ActionDefinition, ToolResult } from "../../src/engine/types.js";
import type { NpcMemoryManager } from "../../src/memory/NpcMemoryManager.js";
import type { RoleSimAgent, RoleSimDecision } from "../../src/roleSim/agent.js";
import { LLMRoleSimAgent } from "../../src/roleSim/llmAgent.js";
import { NpcActionController } from "../../src/roleSim/npcActionController.js";
import { DynamicGameStateManager } from "../../src/state/DynamicGameState.js";
import { datePart } from "../../src/state/gameClock.js";
import type { Item } from "../../src/state/types.js";

import type { NpcMemory, NpcMemoryType } from "@prisma/client";

// =========================================================================
// Stage description
// =========================================================================

export interface StagedItem {
  id: string;
  name: string;
  description?: string;
}

export interface StagedActor {
  npcId: string;
  /** Seeded as a `long_term_intent` memory — the production path a goal takes
   *  into the agent prompt (NpcActionController.loadLongTermIntent). */
  goal?: string;
  /** Absolute HP / SAN to start at (defaults: whatever the profile says). */
  hp?: number;
  san?: number;
  /** Character conditions, e.g. "左腿动脉出血，正在快速失血". */
  conditions?: string[];
  /** Items placed in this actor's inventory. */
  items?: StagedItem[];
  /** Memories only reachable through recallMemory (older days). */
  recallSeeds?: Array<{ type: NpcMemoryType; content: string; date: string }>;
  /** Rows that show up in "## Today's memories" from tick one. */
  todayMemories?: Array<{ type: "event" | "witness"; content: string }>;
}

export interface StageSpec {
  /** Scene every actor is placed in. */
  sceneId: string;
  actors: StagedActor[];
  /** Items on the floor / table of the staged scene. */
  sceneItems?: StagedItem[];
  /** Scene conditions, e.g. "橱窗碎了一地，冷风灌进来". */
  sceneConditions?: string[];
  /** Perceptible trigger injected on tick 1 through a ScriptedEvent, so it
   *  reaches NPCs the same way any world event does (impactPropagation →
   *  witness memory → renderer). Use for stimuli no static state can express
   *  ("货架塌下来了", "他扑了上来"). */
  openingEvent?: {
    description: string;
    /** 1=targeted · 2=same scene · 3=macro location · 4=neighborhood · 5=global */
    impact?: 0 | 1 | 2 | 3 | 4 | 5;
    /** Attributed actor, when the trigger is someone's doing. */
    characterId?: string;
    type?: string;
    /** Ticks to wait before the trigger lands (default 0 = tick 1). Give an
     *  inertia case a delay so the NPC has actually started something by the
     *  time the distraction arrives. */
    afterTicks?: number;
    /** Real state damage applied when the event lands (deltas negative for
     *  harm), expanded into scripted-event effects — the same path a module's
     *  own hazards take through the runner and applier. */
    harm?: {
      targetNpcId: string;
      hp?: number;
      san?: number;
      conditions?: string[];
    };
  };
  /** In-world minutes to run (one tick = one minute). */
  ticks: number;
  /** Run the production start-of-session decide pass before tick 1.
   *  Default true; turn off for pure-reaction cases to save LLM calls. */
  bootstrap?: boolean;
}

// =========================================================================
// Observation
// =========================================================================

/** What `decideNext` actually returned — one row per completed decision. */
export interface DecisionRecord {
  tick: number;
  npcId: string;
  /** In practice always a terminal tool; typed off the decision union so a
   *  future non-terminal return would not silently mis-record. */
  tool: RoleSimDecision["tool"];
  actionText?: string;
  reason?: string;
}

/** Raw agent-loop iterations, including tool calls the loop then rejected. */
export interface IterationRecord {
  tick: number;
  npcId: string;
  tool: string;
  args?: Record<string, unknown>;
}

export interface InterpretRecord {
  tick: number;
  npcId: string;
  actionText: string;
  definitionIds: string[];
  destinations: string[];
}

export interface TickRecord {
  tick: number;
  gameDateTime: string;
  commits: Array<{
    npcId: string;
    definitionId: string;
    actionText: string;
    impact: number;
  }>;
  cancellations: Array<{
    npcId: string;
    definitionId: string;
    actionText: string;
  }>;
  featureEvents: Array<{ type: string; impact: number; description: string }>;
  positionChanges: Array<{ npcId: string; to: string; via: string }>;
  /** Scene-state mutations this tick (conditions added/removed, items damaged,
   *  modified or destroyed, connections blocked) — the observable trace of
   *  "the NPC changed the world", which positions and vitals cannot show. */
  sceneChanges: Array<{ kind: string; description: string }>;
}

export interface SimObservation {
  ticks: TickRecord[];
  decisions: DecisionRecord[];
  iterations: IterationRecord[];
  interpreted: InterpretRecord[];
  skillChecks: Array<{
    npcId: string;
    definitionId: string;
    skill: string;
    status: string;
    successLevel?: string;
    rollDetail?: string;
  }>;
  memoryWrites: Array<{ npcId: string; type: string; content: string }>;
  /** Per NPC: where they started and where they ended. */
  positions: Record<string, { from: string; to: string }>;
  /** Per NPC: HP / SAN before and after. */
  vitals: Record<string, { hp: [number, number]; san: [number, number] }>;
  /** Per staged item: owner before and after ("scene:<id>" or an npc id). */
  itemOwners: Record<string, { from: string; to: string }>;
  /** Conditions each NPC still carries at the end. */
  conditionsAtEnd: Record<string, string[]>;
  /** Conditions on the staged scene at the end (staged ones included). */
  sceneConditionsAtEnd: string[];
  /** Steps still queued or active when the run ended. Without this, "the agent
   *  decided correctly but the action had not finished yet" is indistinguishable
   *  from "the agent never did anything". */
  queueAtEnd: Array<{
    npcId: string;
    definitionId: string;
    status: string;
    actionText: string;
  }>;
  /** Failures the controller swallows (renderer returned null, submitAction
   *  dropped) — otherwise they reach the grader as "the agent chose not to
   *  act", billing an infrastructure fault to the agent. */
  silentFailures: string[];
  llmErrors: string[];
  elapsedMs: number;
}

// =========================================================================
// Stub memory store
// =========================================================================

interface Row {
  npcId: string;
  type: NpcMemoryType;
  content: string;
  gameDateTime: string;
}

function toNpcMemory(row: Row, i: number, sessionId: string): NpcMemory {
  return {
    id: `sim-${i}`,
    npcId: row.npcId,
    sessionId,
    moduleId: "sim-module",
    type: row.type,
    content: row.content,
    gameDateTime: row.gameDateTime,
    location: null,
    metadata: null,
    baseImportance: 0.7,
    accessCount: 0,
    lastAccessedAt: new Date(),
    createdAt: new Date(),
    embedding: null,
  } as unknown as NpcMemory;
}

function makeStubMemory(
  sessionId: string,
  rows: Row[],
  mapSnapshot: unknown,
  onWrite: (npcId: string, type: string, content: string) => void
): NpcMemoryManager {
  const stub = {
    async add(params: {
      npcId: string;
      type: NpcMemoryType;
      content: string;
      gameDateTime: string;
    }) {
      const row: Row = {
        npcId: params.npcId,
        type: params.type,
        content: params.content,
        gameDateTime: params.gameDateTime,
      };
      rows.push(row);
      onWrite(params.npcId, params.type, params.content);
      return toNpcMemory(row, rows.length, sessionId);
    },
    async query(params: {
      npcId: string;
      filters?: { types?: NpcMemoryType[] };
      limit?: number;
    }) {
      // Retrieval quality is not what this harness measures: the seeds are the
      // only memories this NPC has, so any query returns the type-matching set.
      return rows
        .filter((r) => r.npcId === params.npcId)
        .filter(
          (r) => !params.filters?.types || params.filters.types.includes(r.type)
        )
        .slice(0, params.limit ?? 5)
        .map((r, i) => ({ ...toNpcMemory(r, i, sessionId), score: 0.8 }));
    },
    async findLatestByType(
      _sessionId: string,
      npcId: string,
      type: NpcMemoryType
    ) {
      const hits = rows.filter((r) => r.npcId === npcId && r.type === type);
      return hits.length > 0
        ? toNpcMemory(hits[hits.length - 1], hits.length, sessionId)
        : null;
    },
    async getForDateByTypes(
      npcId: string,
      _sessionId: string,
      gameDate: string,
      types: NpcMemoryType[],
      limit?: number
    ) {
      return rows
        .filter(
          (r) =>
            r.npcId === npcId &&
            types.includes(r.type) &&
            datePart(r.gameDateTime) === gameDate
        )
        .slice(-(limit ?? 20))
        .map((r, i) => toNpcMemory(r, i, sessionId));
    },
    async getMapSnapshot() {
      return mapSnapshot;
    },
  };
  return stub as unknown as NpcMemoryManager;
}

// =========================================================================
// Shared console.warn interception
//
// Cases run CONCURRENTLY in one process, so a per-case monkey-patch of
// console.warn both mis-restores (last finish wins) and mis-attributes:
// observed live as one Philip submitAction failure filing an ERROR into two
// unrelated cases. Patch once, keep a registry of active sinks, and let each
// case's sink filter by its own staged actor names.
// =========================================================================

const warnSinks = new Set<(line: string) => void>();
let realConsoleWarn: typeof console.warn | null = null;

function pushWarnSink(sink: (line: string) => void): () => void {
  if (warnSinks.size === 0) {
    realConsoleWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const line = args
        .map((a) => (a instanceof Error ? a.message : String(a)))
        .join(" ");
      for (const s of warnSinks) s(line);
      realConsoleWarn?.(...args);
    };
  }
  warnSinks.add(sink);
  return () => {
    warnSinks.delete(sink);
    if (warnSinks.size === 0 && realConsoleWarn) {
      console.warn = realConsoleWarn;
      realConsoleWarn = null;
    }
  };
}

// =========================================================================
// Runner
// =========================================================================

export interface RunStagedCaseInput {
  /** Serialized base state (DynamicGameStateManager.serialize()), deep-cloned
   *  per case so runs never share mutable world state. */
  baseState: unknown;
  stage: StageSpec;
  definitions: ActionDefinition[];
  knownLocations: KnownLocation[];
  lang: string;
  sessionId: string;
  moduleId: string;
  /** Per-line trace sink (console when running a single case). */
  log?: (line: string) => void;
}

function locationOf(dgsm: DynamicGameStateManager, npcId: string): string {
  const p = dgsm.getCharacterPosition(npcId);
  return p ? dgsm.resolveLocationId(p) : "(unknown)";
}

function itemOwner(dgsm: DynamicGameStateManager, itemId: string): string {
  const state = dgsm.getState();
  for (const [sceneId, scene] of state.scenes) {
    if (scene.items?.some((i) => i.id === itemId)) return `scene:${sceneId}`;
  }
  for (const [npcId, inv] of Object.entries(state.npcInventories ?? {})) {
    if (inv.some((i) => i.id === itemId)) return npcId;
  }
  return "(gone)";
}

export async function runStagedCase(
  input: RunStagedCaseInput
): Promise<SimObservation> {
  const started = Date.now();
  const { stage, definitions, knownLocations, lang, sessionId, moduleId } =
    input;
  const log = input.log ?? (() => {});
  if (stage.actors.length === 0) {
    throw new Error("StageSpec.actors is empty — a case needs a protagonist");
  }

  // ---- fresh, isolated world ------------------------------------------
  const dgsm = new DynamicGameStateManager(
    DynamicGameStateManager.deserialize(
      JSON.parse(JSON.stringify(input.baseState))
    )
  );
  const state = dgsm.getState();
  const scene = dgsm.getScene(stage.sceneId);
  if (!scene) throw new Error(`Staged scene ${stage.sceneId} not in module`);

  const memoryRows: Row[] = [];
  const observation: SimObservation = {
    ticks: [],
    decisions: [],
    iterations: [],
    interpreted: [],
    skillChecks: [],
    memoryWrites: [],
    positions: {},
    vitals: {},
    itemOwners: {},
    conditionsAtEnd: {},
    sceneConditionsAtEnd: [],
    queueAtEnd: [],
    silentFailures: [],
    llmErrors: [],
    elapsedMs: 0,
  };

  // ---- stage the scene -------------------------------------------------
  // Two readers, two homes: the renderer (what the agent perceives) reads
  // `scene.conditions`, while the resolver's state context reads
  // `dgsm.getSceneConditions(locationId)`. A staged condition has to land in
  // both or half the pipeline is blind to it.
  for (const desc of stage.sceneConditions ?? []) {
    const condition = { featureId: "sim_stage", description: desc };
    if (!scene.conditions) scene.conditions = [];
    scene.conditions.push(condition);
    dgsm.appendSceneCondition(stage.sceneId, condition);
  }
  // `DynamicScene.items` is typed as required, but scenes come straight out of
  // module JSON with no normalize step, and production reads it everywhere as
  // `scene?.items ?? []` — so don't trust it.
  if (!scene.items) scene.items = [];
  for (const item of stage.sceneItems ?? []) {
    scene.items.push({ ...item } as Item);
  }

  const gameDateTime = dgsm.getGameDateTime();

  for (const actor of stage.actors) {
    const profile = dgsm.getNpcProfile(actor.npcId);
    if (!profile) throw new Error(`Staged NPC ${actor.npcId} not in module`);
    dgsm.setCharacterPosition(actor.npcId, {
      type: "scene",
      sceneId: stage.sceneId,
    });

    if (typeof actor.hp === "number") {
      const cur = dgsm.getNpcStats(actor.npcId)?.hp ?? profile.status.hp;
      dgsm.updateNpcHp(actor.npcId, actor.hp - cur);
    }
    if (typeof actor.san === "number") {
      const cur = dgsm.getNpcStats(actor.npcId)?.san ?? profile.status.san;
      dgsm.updateNpcSan(actor.npcId, actor.san - cur);
    }
    (actor.conditions ?? []).forEach((description, i) => {
      const condition: CharacterCondition = {
        id: `sim_stage_${i + 1}`,
        featureId: "sim_stage",
        description,
      };
      dgsm.addCharacterCondition(actor.npcId, condition);
    });
    for (const item of actor.items ?? []) {
      dgsm.addItemToNpc(actor.npcId, { ...item } as Item);
    }

    // Goal → long_term_intent, the same row the controller reads each tick.
    if (actor.goal) {
      memoryRows.push({
        npcId: actor.npcId,
        type: "long_term_intent" as NpcMemoryType,
        content: actor.goal,
        gameDateTime,
      });
    }
    for (const seed of actor.recallSeeds ?? []) {
      memoryRows.push({
        npcId: actor.npcId,
        type: seed.type,
        content: seed.content,
        gameDateTime: `${seed.date}T09:00:00`,
      });
    }
    for (const m of actor.todayMemories ?? []) {
      memoryRows.push({
        npcId: actor.npcId,
        type: m.type as NpcMemoryType,
        content: m.content,
        gameDateTime,
      });
    }

    observation.positions[actor.npcId] = {
      from: locationOf(dgsm, actor.npcId),
      to: "",
    };
    const stats = dgsm.getNpcStats(actor.npcId);
    observation.vitals[actor.npcId] = {
      hp: [stats?.hp ?? 0, 0],
      san: [stats?.san ?? 0, 0],
    };
  }

  const stagedItemIds = [
    ...(stage.sceneItems ?? []).map((i) => i.id),
    ...stage.actors.flatMap((a) => (a.items ?? []).map((i) => i.id)),
  ];
  for (const id of stagedItemIds) {
    observation.itemOwners[id] = { from: itemOwner(dgsm, id), to: "" };
  }

  // NPCs outside the staged cast must not wander into the case: only staged
  // actors are simulated, so decide() is never called for anyone else.
  // `getState()` hands back the live object, so these writes take effect.
  const stagedIds = new Set(stage.actors.map((a) => a.npcId));
  const mutable = state as unknown as {
    npcCharacters: typeof state.npcCharacters;
    npcRelationshipGraph?: Record<string, Record<string, unknown>>;
  };
  mutable.npcCharacters = state.npcCharacters.filter((n) =>
    stagedIds.has(n.id)
  );

  // profileFormatter.formatRelationshipsBlock renders every row of
  // npcRelationshipGraph[npcId] and falls back to the raw target id when the
  // name cannot be resolved from npcCharacters — which, after pruning, is every
  // off-stage NPC. The model then writes that id into actionText as if it were
  // a person's name. Prune the graph to the staged cast.
  const graph = mutable.npcRelationshipGraph;
  if (graph) {
    const pruned: Record<string, Record<string, unknown>> = {};
    for (const id of stagedIds) {
      const rows = graph[id];
      if (!rows) continue;
      pruned[id] = Object.fromEntries(
        Object.entries(rows).filter(([targetId]) => stagedIds.has(targetId))
      );
    }
    mutable.npcRelationshipGraph = pruned;
  }
  for (const staged of stage.actors) {
    const profile = dgsm.getNpcProfile(staged.npcId);
    if (profile?.relationships) {
      profile.relationships = profile.relationships.filter((r) =>
        stagedIds.has(r.targetId)
      );
    }
  }

  // characterPositions is read by getCharactersInScene, which does NOT consult
  // npcCharacters. Downstream readers all drop ids with no profile, but a
  // leftover position also lets an openingEvent attributed to a pruned NPC
  // resolve to a location outside the staged scene — impactPropagation then
  // sends the event to nobody, silently.
  const positions = state.characterPositions as unknown as Record<
    string,
    unknown
  >;
  for (const id of Object.keys(positions)) {
    if (!stagedIds.has(id)) delete positions[id];
  }

  // ---- opening event ---------------------------------------------------
  const scriptedEvents: ScriptedEvent[] = [];
  if (stage.openingEvent) {
    const ev: FeatureEvent = {
      type: stage.openingEvent.type ?? "sim.opening",
      impact: stage.openingEvent.impact ?? 2,
      description: stage.openingEvent.description,
      sceneId: stage.sceneId,
      ...(stage.openingEvent.characterId
        ? { characterId: stage.openingEvent.characterId }
        : {}),
    };
    const onComplete: Effect[] = [{ kind: "event.emit", event: ev }];
    // Harm rides the same completion: the perceptible description and the
    // state damage land on the same tick, like a module hazard would.
    const harm = stage.openingEvent.harm;
    if (harm) {
      const targetFilter = { op: "is" as const, characterId: harm.targetNpcId };
      if (typeof harm.hp === "number") {
        onComplete.push({ kind: "character.hp", targetFilter, delta: harm.hp });
      }
      if (typeof harm.san === "number") {
        onComplete.push({
          kind: "character.san",
          targetFilter,
          delta: harm.san,
        });
      }
      (harm.conditions ?? []).forEach((description, i) => {
        onComplete.push({
          kind: "character.addCondition",
          targetFilter,
          condition: {
            id: `sim_harm_${i + 1}`,
            featureId: "sim_harm",
            description,
          },
        });
      });
    }
    scriptedEvents.push({
      id: "sim_opening",
      label: "staged opening trigger",
      // True from tick 1 — the anchor actor is alive when the case starts.
      fireWhen: {
        op: "characterAlive",
        characterId: stage.actors[0].npcId,
        expectedAlive: true,
      },
      ...(stage.openingEvent.afterTicks
        ? { fireDelayTicks: stage.openingEvent.afterTicks }
        : {}),
      onComplete,
    });
  }

  // ---- map snapshot for getMapSnapshot ---------------------------------
  const mapSnapshot = {
    schemaVersion: 1,
    updatedAt: gameDateTime,
    knownIds: {
      sceneIds: [...state.scenes.keys()],
      junctionIds: [...state.junctions.keys()],
      roadIds: [...state.roads.keys()],
      scenarioOutlineIds: (state.scenarioOutlines ?? []).map((o) => o.id),
    },
    revealedHiddenConnections: [] as string[],
    scenes: Object.fromEntries([...state.scenes.entries()]),
    junctions: Object.fromEntries([...state.junctions.entries()]),
    roads: Object.fromEntries([...state.roads.entries()]),
  };

  const memory = makeStubMemory(
    sessionId,
    memoryRows,
    mapSnapshot,
    (npcId, type, content) => {
      observation.memoryWrites.push({ npcId, type, content });
    }
  );

  // ---- engine: real interpreter · real dice · real resolver ------------
  let currentTick = 0;
  const defsById = new Map(definitions.map((d) => [d.id, d]));

  const engine = createTickEngine({
    dgsm,
    subsystemRegistry: createDefaultSubsystemRegistry(),
    scriptedEvents,
    interpretAction: async (inputAction, directory) => {
      const result = await interpretAction(
        inputAction.actionText,
        definitions,
        lang,
        directory,
        knownLocations,
        currentLocationOf(dgsm, inputAction.characterId)
      );
      observation.interpreted.push({
        tick: currentTick,
        npcId: inputAction.characterId,
        actionText: inputAction.actionText,
        definitionIds: result.steps.map((s) => s.definitionId),
        destinations: result.steps
          .map(
            (s) => (s.overlayFields as { destination?: string })?.destination
          )
          .filter((d): d is string => !!d),
      });
      log(
        `   [interpreter] ${inputAction.characterId} → ${result.steps.map((s) => s.definitionId).join(",")}`
      );
      return { steps: result.steps };
    },
    resolve: async (
      step: ActionStep,
      _ctx: unknown,
      cancel,
      skillCheckResult
    ): Promise<{ outcome: PlannedOutcome; plannedDuration: number }> => {
      const definition = defsById.get(step.definitionId);
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
      const resolved = await resolveState({
        action: cancel
          ? buildCancelResolverAction(step.actionText, cancel)
          : step.actionText,
        definition,
        outcomeSection: definition.content,
        stateContext,
        skillCheckResult,
        language: lang,
      });
      const elapsedMinutes = cancel
        ? cancel.elapsedMinutes
        : resolved.elapsedMinutes;
      log(
        `   [resolver] ${step.characterId} def=${step.definitionId} ` +
          `elapsed=${elapsedMinutes}min changes=[${resolved.stateChanges.map((s) => s.kind).join(",")}]`
      );
      return {
        outcome: { stateChanges: resolved.stateChanges, elapsedMinutes },
        plannedDuration: elapsedMinutes,
      };
    },
    runSkillCheck: (step: ActionStep): ToolResult | undefined => {
      const definition = defsById.get(step.definitionId);
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
      observation.skillChecks.push({
        npcId: step.characterId,
        definitionId: step.definitionId,
        skill: definition.skillCheck.skill ?? "",
        status: result.status,
        successLevel: result.successLevel,
        rollDetail: result.rollDetail,
      });
      log(
        `   [skillCheck] ${step.characterId} ${definition.skillCheck.skill} → ` +
          `${result.status}/${result.successLevel ?? "?"}${result.rollDetail ? ` (${result.rollDetail})` : ""}`
      );
      return result;
    },
    getActorDex: (id) => dgsm.getNpcProfile(id)?.attributes?.DEX ?? 50,
    tickDurationMinutes: 1,
    lang,
  });

  // Register the observation listener BEFORE the controller. EventBus awaits
  // listeners in registration order and the controller runs its entire decide
  // round inside its own listener; if a decide throws (an LLM 429, say), a
  // listener registered after it never records the tick — yet the applier has
  // already flushed that tick's state changes, so the report would claim
  // "nothing happened" while positions and HP had visibly moved.
  engine.on("tickCompleted", (report: TickReport) => {
    observation.ticks.push({
      tick: currentTick,
      gameDateTime: dgsm.getGameDateTime(),
      commits: report.commits.map((a) => ({
        npcId: a.characterId,
        definitionId: a.definitionId,
        actionText: a.actionText,
        impact: a.impact,
      })),
      cancellations: report.cancellations.map((c) => ({
        npcId: c.characterId,
        definitionId: c.definitionId,
        actionText: c.actionText,
      })),
      featureEvents: report.featureEvents.map((e) => ({
        type: e.type,
        impact: e.impact,
        description: e.description,
      })),
      sceneChanges: report.stateChanges.flatMap(
        (s): Array<{ kind: string; description: string }> => {
          switch (s.kind) {
            case "scene.addCondition":
              return [{ kind: s.kind, description: s.condition.description }];
            case "scene.removeCondition":
              return [
                {
                  kind: s.kind,
                  description: `removed condition (${JSON.stringify(s.predicate)})`,
                },
              ];
            case "scene.damageItem":
              return [
                {
                  kind: s.kind,
                  description: `${s.itemId} damaged by ${s.damagedBy}: ${s.reason}`,
                },
              ];
            case "item.modify":
              return [
                { kind: s.kind, description: `${s.itemId}: ${s.description}` },
              ];
            case "item.destroy":
              return [{ kind: s.kind, description: `${s.itemId} destroyed` }];
            case "connection.setBlock":
              return [
                {
                  kind: s.kind,
                  description: `${s.connectionId} ${s.blocked ? "blocked" : "unblocked"}: ${s.reason}`,
                },
              ];
            default:
              return [];
          }
        }
      ),
      positionChanges: report.stateChanges
        .filter((s) => s.kind === "character.position")
        .map((s) => {
          const c = s as {
            characterId: string;
            position: {
              type: string;
              sceneId?: string;
              junctionId?: string;
              roadId?: string;
            };
            sourceSubsystem?: string;
          };
          const p = c.position;
          return {
            npcId: c.characterId,
            to:
              p.type === "scene"
                ? `scene:${p.sceneId}`
                : p.type === "junction"
                  ? `junction:${p.junctionId}`
                  : `road:${p.roadId}`,
            via: c.sourceSubsystem ?? "?",
          };
        }),
    });
  });

  const agent = new LLMRoleSimAgent({
    memory,
    dgsm,
    sessionId,
    moduleId,
    language: lang,
    onIteration: (ev) => {
      const tool = ev.parsed?.tool ?? "(none)";
      observation.iterations.push({
        tick: currentTick,
        npcId: ev.npcId,
        tool,
        args: ev.parsed,
      });
      log(`   [agent] t${currentTick} ${ev.npcId} → ${tool}`);
    },
  });

  // `onIteration` fires for EVERY tool call the model emits, including a
  // terminal one it illegally mixed with an instant tool — llmAgent rejects
  // that call ("was NOT executed") and keeps looping. Grading off those raw
  // iterations counts an `act` that never reached the engine. So record what
  // `decideNext` actually returned, and keep the raw stream separately.
  const recordingAgent: RoleSimAgent = {
    decideNext: async (ctx) => {
      const decision = await agent.decideNext(ctx);
      observation.decisions.push({
        tick: currentTick,
        npcId: ctx.npcId,
        tool: decision.tool,
        ...(decision.tool === "act" ? { actionText: decision.actionText } : {}),
        ...(decision.tool === "continue" && decision.reason
          ? { reason: decision.reason }
          : {}),
      });
      return decision;
    },
  };

  const controller = new NpcActionController({
    engine,
    agent: recordingAgent,
    memory,
    dgsm,
    sessionId,
    moduleId,
    language: lang,
  });
  void controller; // subscribes to tickCompleted in its constructor

  // ---- drive ------------------------------------------------------------
  // NpcActionController and the renderer swallow their own failures with a
  // console.warn and carry on (renderer returned null → the NPC perceives
  // nothing and never decides; submitAction threw → the decision is dropped).
  // Both reach the reader as "the agent chose not to act", so intercept those
  // warnings and file them as what they are: infrastructure faults. The sink
  // only files lines naming one of THIS case's actors — concurrent cases
  // share the console, and an unfiltered sink bills every case for one
  // case's fault. (A warning naming no actor is intentionally not filed:
  // it cannot be attributed.)
  const stagedNames = stage.actors.map((a) => a.npcId);
  const popWarnSink = pushWarnSink((line) => {
    if (!/\[NpcActionController\]|\[renderer\]|\[roleSim/.test(line)) return;
    // Match the name ONLY in the controller's own message, never in the
    // echoed actionText that follows it: an NPC's narrative routinely names
    // other people (a debtor pleading with his creditor cites the creditor),
    // and matching the whole line filed that failure under the creditor's
    // unrelated concurrent case.
    const attribution = line.split("actionText:")[0];
    if (!stagedNames.some((name) => attribution.includes(name))) return;
    observation.silentFailures.push(line.slice(0, 300));
  });

  try {
    if (stage.bootstrap !== false) {
      log("   [bootstrap] initial decide pass");
      await controller.bootstrap();
    }
    for (let i = 1; i <= stage.ticks; i++) {
      currentTick = i;
      log(`   [tick ${i}/${stage.ticks}]`);
      await engine.tick();
    }
  } catch (err) {
    observation.llmErrors.push(
      err instanceof Error ? err.message : String(err)
    );
  } finally {
    popWarnSink();
  }

  // ---- final readings ---------------------------------------------------
  for (const actor of stage.actors) {
    observation.positions[actor.npcId].to = locationOf(dgsm, actor.npcId);
    const stats = dgsm.getNpcStats(actor.npcId);
    observation.vitals[actor.npcId].hp[1] = stats?.hp ?? 0;
    observation.vitals[actor.npcId].san[1] = stats?.san ?? 0;
    observation.conditionsAtEnd[actor.npcId] = (
      dgsm.getNpcProfile(actor.npcId)?.status.conditions ?? []
    ).map((c) => (typeof c === "string" ? c : c.description));
  }
  for (const id of stagedItemIds) {
    observation.itemOwners[id].to = itemOwner(dgsm, id);
  }
  observation.sceneConditionsAtEnd = (
    dgsm.getScene(stage.sceneId)?.conditions ?? []
  ).map((c) => c.description);
  // A step still queued/active at the end means the agent decided but the
  // resolver's elapsedMinutes outlasted the run — a different thing entirely
  // from the agent never acting.
  for (const actor of stage.actors) {
    for (const step of engine.getActorQueue(actor.npcId)) {
      if (step.status === "queued" || step.status === "active") {
        observation.queueAtEnd.push({
          npcId: actor.npcId,
          definitionId: step.definitionId,
          status: step.status,
          actionText: (step.actionText ?? "")
            .replace(/\s+/g, " ")
            .slice(0, 120),
        });
      }
    }
  }

  observation.elapsedMs = Date.now() - started;
  return observation;
}
