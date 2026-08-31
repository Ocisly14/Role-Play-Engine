// scripts/lib/decisionSim.ts
//
// Stage a scene, drop a few NPCs into it with their own goals, then let the
// REAL tick pipeline run for a few in-world minutes and record everything
// that happened.
//
// This is the engine half of scripts/test-agent-decisions.ts. Every layer is
// production code:
//
//   LLMRoleSimAgent        act(description, objectRefs, ticks, skill?)
//     ├─ commandBuilder    trusted envelope + immediate skill roll
//     ↓
//   createTickEngine       inbox · action store · applier · subsystems
//     └─ WorldActionEngine one global resolution per triggered tick
//          ├─ deterministic code tools (pathfinding, opposed rolls, …)
//          └─ transitions + WorldDeltas + Occurrences
//     ↓
//   NpcActionController    occurrence routing → per-character render → decide
//
// The chain this harness exists to observe, stage by stage:
//   act → command → engine resolution → occurrence → render → memory
//
// Only the memory store is stubbed: an in-memory implementation honouring the
// same contract (long_term_intent is how a staged goal reaches the NPC —
// exactly the production path — and rows the CHARACTER writes with
// `writeMemory` feed the next tick's prompt).
//
// Each call gets its OWN DynamicGameState, deep-cloned from a serialized base
// snapshot, so ticks in one case can never leak into another and cases can run
// concurrently.

import type { ActionJudgement } from "../../src/engine/actions/types.js";
import { createTickEngine } from "../../src/engine/core/tickEngine.js";
import type {
  CharacterCondition,
  FeatureEvent,
  TickReport,
} from "../../src/engine/core/types.js";
import { createDefaultSubsystemRegistry } from "../../src/engine/registerDefaults.js";
import type {
  Effect,
  ScriptedEvent,
} from "../../src/engine/scriptedEvents/types.js";
import type { NpcMemoryManager } from "../../src/memory/NpcMemoryManager.js";
import type { RoleSimAgent, RoleSimDecision } from "../../src/roleSim/agent.js";
import { LLMRoleSimAgent } from "../../src/roleSim/llmAgent.js";
import { NpcActionController } from "../../src/roleSim/npcActionController.js";
import { DynamicGameStateManager } from "../../src/state/DynamicGameState.js";
import { datePart } from "../../src/state/gameClock.js";
import type { Item } from "../../src/state/types.js";

import type { NpcMemoryType } from "@prisma/client";

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
  /** Memories written on earlier days. Every memory is injected whole now,
   *  so these reach the prompt like any other — use them to stage what the
   *  character already knows. */
  recallSeeds?: Array<{ type: NpcMemoryType; content: string; date: string }>;
  /** Rows that show up in "## Today's memories" from tick one. */
  todayMemories?: Array<{
    type: "general" | "plan" | "secret" | "relationship";
    content: string;
  }>;
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

/** What `decideNext` actually returned — one row per completed decision.
 *  The agent now emits structured intent, so the record keeps the fields
 *  separately: prose that reads well can still cite a nonexistent id. */
export interface DecisionRecord {
  tick: number;
  npcId: string;
  /** In practice always a terminal tool; typed off the decision union so a
   *  future non-terminal return would not silently mis-record. */
  tool: RoleSimDecision["tool"];
  description?: string;
  objectRefs?: Array<{ kind: string; id: string; role?: string }>;
  proposedDurationTicks?: number;
  skillId?: string;
  utterance?: string;
  reason?: string;
}

/** Raw agent-loop iterations, including tool calls the loop then rejected. */
export interface IterationRecord {
  tick: number;
  npcId: string;
  tool: string;
  args?: Record<string, unknown>;
}

/** The trusted command the intake actually built from a decision — proof the
 *  trust boundary ran, and where a rejection shows up. */
export interface CommandRecord {
  tick: number;
  npcId: string;
  accepted: boolean;
  actionId?: string;
  /** Rejection reason from the validator/intake, when not accepted. */
  reason?: string;
  /** Set when the character declared a skill: the roll made AT INTAKE,
   *  before any semantic assessment ("先骰后审"). */
  roll?: {
    skillId: string;
    skillValue: number;
    roll: number;
    successLevel: string;
  };
}

/** One action's lifecycle step, as decided by the World Action Engine. */
export interface TransitionRecord {
  tick: number;
  npcId: string;
  actionId: string;
  from: string;
  to: string;
  progressDeltaMinutes: number;
  /** Engine-owned authoritative duration + why (never the actor's proposal). */
  resolvedDurationTicks?: number;
  timingReason?: string;
  nextWakeAt?: string;
  reason?: string;
  /** The Engine's post-roll verdict, persisted on the action runtime. */
  judgement?: ActionJudgement;
}

/** An objective occurrence and who the Engine said could perceive it. */
export interface OccurrenceRecord {
  tick: number;
  locationId?: string;
  facts: Array<{ type: string; content: string }>;
  participants: Array<{ characterId: string; role: string }>;
  perceiverCharacterIds: string[];
  signals: Array<{ channel: string; originLocationId?: string }>;
}

export interface TickRecord {
  tick: number;
  gameDateTime: string;
  /** True when this tick had a resolution trigger. An idle tick MUST show
   *  false and cost zero World Action Engine calls. */
  engineRan: boolean;
  completions: Array<{ npcId: string; description: string }>;
  terminations: Array<{ npcId: string; description: string; to: string }>;
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
  commands: CommandRecord[];
  transitions: TransitionRecord[];
  occurrences: OccurrenceRecord[];
  /** Memories the CHARACTER chose to write. Nothing is recorded on its
   *  behalf any more, so an empty list is a real finding, not a plumbing
   *  gap. */
  memoryWrites: Array<{
    npcId: string;
    type: string;
    content: string;
    /** "add" unless the character corrected or retracted an existing memory. */
    op?: "replace" | "delete";
  }>;
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
  /** Actions still queued or active when the run ended. Without this, "the
   *  agent decided correctly but the action had not finished yet" is
   *  indistinguishable from "the agent never did anything". */
  actionsAtEnd: Array<{
    npcId: string;
    actionId: string;
    status: string;
    description: string;
    progressMinutes: number;
    resolvedDurationTicks?: number;
  }>;
  /** Failures the controller swallows (renderer returned null, command
   *  rejected) — otherwise they reach the reader as "the agent chose not to
   *  act", billing an infrastructure fault to the agent. */
  silentFailures: string[];
  llmErrors: string[];
  elapsedMs: number;
}

// =========================================================================
// Memory write observation
//
// The store itself is the production one (Prisma + embeddings, real session
// row): a case is a real session, so what the character writes has to land
// where a real run would put it. Only the *reporting* is added here — the
// wrapper records every `add` as it happens, which is what the per-tick trace
// prints; the rows themselves are in the database afterwards.
// =========================================================================

function observeMemoryWrites(
  real: NpcMemoryManager,
  onWrite: (
    npcId: string,
    type: string,
    content: string,
    op?: "replace" | "delete"
  ) => void
): NpcMemoryManager {
  return new Proxy(real, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;

      if (property === "add") {
        return async (params: {
          npcId: string;
          type: NpcMemoryType;
          content: string;
        }) => {
          const row = await (value as typeof real.add).call(
            target,
            params as never
          );
          onWrite(params.npcId, params.type, params.content);
          return row;
        };
      }

      // A correction or a retraction is a decision the character made, and
      // the case report exists to show those — counting only `add` would
      // report a character who fixed a wrong belief as having done nothing.
      if (property === "reviseOwn" || property === "retractOwn") {
        const op = property === "reviseOwn" ? "replace" : "delete";
        return async (params: {
          npcId: string;
          memoryId: string;
          content?: string;
        }) => {
          const ok = await (value as (p: unknown) => Promise<boolean>).call(
            target,
            params
          );
          if (ok) {
            onWrite(params.npcId, op, params.content ?? params.memoryId, op);
          }
          return ok;
        };
      }

      return value;
    },
  });
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
  /** Production memory store, already bound to this case's session row. The
   *  case seeds its goal and staged memories through it, the bootstrap writes
   *  the character's geography through it, and the character writes its own
   *  memories through it — one store, the real one. */
  memory: NpcMemoryManager;
  /** Serialized base state (DynamicGameStateManager.serialize()), deep-cloned
   *  per case so runs never share mutable world state. */
  baseState: unknown;
  stage: StageSpec;
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
  const { stage, lang, sessionId, moduleId } = input;
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

  const observation: SimObservation = {
    ticks: [],
    decisions: [],
    iterations: [],
    commands: [],
    transitions: [],
    occurrences: [],
    memoryWrites: [],
    positions: {},
    vitals: {},
    itemOwners: {},
    conditionsAtEnd: {},
    sceneConditionsAtEnd: [],
    actionsAtEnd: [],
    silentFailures: [],
    llmErrors: [],
    elapsedMs: 0,
  };

  // Every write — the staged seeds, the geography bootstrap, and whatever the
  // character decides to keep — goes through the production store. The
  // wrapper only mirrors them into the observation record.
  const memory = observeMemoryWrites(input.memory, (npcId, type, content, op) => {
    observation.memoryWrites.push({
      npcId,
      type,
      content,
      ...(op ? { op } : {}),
    });
  });

  // ---- stage the scene -------------------------------------------------
  for (const desc of stage.sceneConditions ?? []) {
    dgsm.appendSceneCondition(stage.sceneId, {
      featureId: "sim_stage",
      description: desc,
    });
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

    // Goal → long_term_intent, which reaches the prompt as one more line in
    // the character's memory block (no separate query since it stopped being
    // its own prompt section).
    if (actor.goal) {
      await memory.add({
        npcId: actor.npcId,
        sessionId,
        moduleId,
        type: "long_term_intent" as NpcMemoryType,
        content: actor.goal,
        gameDateTime,
      });
    }
    for (const seed of actor.recallSeeds ?? []) {
      await memory.add({
        npcId: actor.npcId,
        sessionId,
        moduleId,
        type: seed.type,
        content: seed.content,
        gameDateTime: `${seed.date}T09:00:00`,
      });
    }
    for (const m of actor.todayMemories ?? []) {
      await memory.add({
        npcId: actor.npcId,
        sessionId,
        moduleId,
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
  // off-stage NPC. The model then cites that id in objectRefs as if it were
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

  // Geographic knowledge needs no staging step any more: createSession
  // seeded every actor's authored map memories straight from their profile,
  // the same way a real session gets them.

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

  // ---- engine: real World Action Engine · real dice · real code tools ---
  // Nothing is stubbed. The Engine makes its own LLM call when (and only
  // when) a tick carries an action resolution trigger.
  let currentTick = 0;

  const realEngine = createTickEngine({
    dgsm,
    subsystemRegistry: createDefaultSubsystemRegistry(),
    scriptedEvents,
    tickDurationMinutes: 1,
  });

  // Record what actually crossed the trust boundary. The command carries the
  // envelope the controller stamped and — when the character declared a skill
  // — the roll deterministic code already made at intake, before the Engine
  // has seen the action at all. Wrapping keeps production code untouched.
  const engine: typeof realEngine = {
    ...realEngine,
    on: realEngine.on.bind(realEngine),
    submitCommand: async (command) => {
      const receipt = await realEngine.submitCommand(command);
      observation.commands.push({
        tick: currentTick,
        npcId: command.actorId,
        accepted: receipt.accepted,
        ...(receipt.actionId ? { actionId: receipt.actionId } : {}),
        ...(receipt.reason ? { reason: receipt.reason } : {}),
        ...(command.skillRoll
          ? {
              roll: {
                skillId: command.skillRoll.skillId,
                skillValue: command.skillRoll.skillValue,
                roll: command.skillRoll.roll,
                successLevel: command.skillRoll.successLevel,
              },
            }
          : {}),
      });
      log(
        `   [command] ${command.actorId} ${
          receipt.accepted ? "accepted" : `REJECTED (${receipt.reason})`
        }${
          command.skillRoll
            ? ` roll=${command.skillRoll.roll}/${command.skillRoll.skillValue} ${command.skillRoll.skillId}→${command.skillRoll.successLevel}`
            : ""
        }`
      );
      return receipt;
    },
  };

  // Register the observation listener BEFORE the controller. EventBus awaits
  // listeners in registration order and the controller runs its entire decide
  // round inside its own listener; if a decide throws (an LLM 429, say), a
  // listener registered after it never records the tick — yet the applier has
  // already flushed that tick's state changes, so the report would claim
  // "nothing happened" while positions and HP had visibly moved.
  engine.on("tickCompleted", (report: TickReport) => {
    // Transitions are the authoritative lifecycle record; `commits` /
    // `cancellations` are derived views kept for the migration window.
    for (const t of report.transitions) {
      const action = engine.getAction(t.actionId);
      const judgement = action?.runtime?.judgement as
        | ActionJudgement
        | undefined;
      observation.transitions.push({
        tick: currentTick,
        npcId: t.actorId,
        actionId: t.actionId,
        from: t.from,
        to: t.to,
        progressDeltaMinutes: t.progressDeltaMinutes,
        ...(t.resolvedDurationTicks !== undefined
          ? { resolvedDurationTicks: t.resolvedDurationTicks }
          : {}),
        ...(t.timingReason ? { timingReason: t.timingReason } : {}),
        ...(t.nextWakeAt ? { nextWakeAt: t.nextWakeAt } : {}),
        ...(t.reason ? { reason: t.reason } : {}),
        ...(judgement ? { judgement } : {}),
      });
      log(
        `   [engine] ${t.actorId} ${t.from}→${t.to}${
          t.resolvedDurationTicks !== undefined
            ? ` dur=${t.resolvedDurationTicks}t (${t.timingReason ?? "?"})`
            : ""
        }${judgement ? ` outcome=${judgement.outcome}` : ""}`
      );
    }

    for (const occ of report.occurrences) {
      observation.occurrences.push({
        tick: currentTick,
        ...(occ.locationId ? { locationId: occ.locationId } : {}),
        facts: occ.facts.map((f) => ({ type: f.type, content: f.content })),
        participants: occ.participants.map((p) => ({
          characterId: p.characterId,
          role: p.role,
        })),
        perceiverCharacterIds: [...occ.perceiverCharacterIds],
        signals: occ.signals.map((sig) => ({
          channel: sig.channel,
          ...(sig.originLocationId
            ? { originLocationId: sig.originLocationId }
            : {}),
        })),
      });
      log(
        `   [occurrence] ${occ.facts.map((f) => f.type).join(",")} → ` +
          `perceivers=[${occ.perceiverCharacterIds.join(",")}]`
      );
    }

    const ended = new Set(["completed", "failed", "interrupted", "cancelled"]);
    observation.ticks.push({
      tick: currentTick,
      gameDateTime: dgsm.getGameDateTime(),
      // A tick with no transitions and no occurrences had no resolution
      // trigger — the Engine was never called, which is the intended
      // behaviour and worth showing per tick.
      engineRan: report.transitions.length > 0 || report.occurrences.length > 0,
      completions: report.transitions
        .filter((t) => t.to === "completed")
        .map((t) => ({
          npcId: t.actorId,
          description: engine.getAction(t.actionId)?.command.description ?? "",
        })),
      terminations: report.transitions
        .filter((t) => ended.has(t.to) && t.to !== "completed")
        .map((t) => ({
          npcId: t.actorId,
          description: engine.getAction(t.actionId)?.command.description ?? "",
          to: t.to,
        })),
      featureEvents: report.featureEvents.map((e) => ({
        type: e.type,
        impact: e.impact,
        description: e.description,
      })),
      sceneChanges: report.stateChanges.flatMap(
        (sc): Array<{ kind: string; description: string }> => {
          switch (sc.kind) {
            case "scene.addCondition":
              return [{ kind: sc.kind, description: sc.condition.description }];
            case "scene.removeCondition":
              return [
                {
                  kind: sc.kind,
                  description: `removed condition (${JSON.stringify(sc.predicate)})`,
                },
              ];
            case "scene.setDescription":
              return [
                {
                  kind: sc.kind,
                  description: `${sc.sceneId} description rewritten`,
                },
              ];
            case "item.set":
              return [
                {
                  kind: sc.kind,
                  description: `${sc.itemId}: ${
                    sc.hidden === false
                      ? "revealed"
                      : (sc.description ?? sc.appendDescription ?? "updated")
                  }`,
                },
              ];
            case "item.create":
              return [
                {
                  kind: sc.kind,
                  description: `${sc.name} created at ${sc.location}`,
                },
              ];
            case "item.move":
              return [
                {
                  kind: sc.kind,
                  description: `${sc.itemId}: ${sc.from} → ${sc.to}`,
                },
              ];
            case "item.destroy":
              return [{ kind: sc.kind, description: `${sc.itemId} destroyed` }];
            case "character.hp":
            case "character.san":
            case "character.fatigue":
              return [
                {
                  kind: sc.kind,
                  description: `${sc.characterId} ${sc.delta >= 0 ? "+" : ""}${sc.delta} (${sc.reason})`,
                },
              ];
            case "character.addCondition":
              return [
                {
                  kind: sc.kind,
                  description: `${sc.characterId}: ${sc.condition.description}`,
                },
              ];
            case "connection.setBlock":
              return [
                {
                  kind: sc.kind,
                  description: `${sc.connectionId} ${sc.blocked ? "blocked" : "unblocked"}: ${sc.reason}`,
                },
              ];
            default:
              return [];
          }
        }
      ),
      positionChanges: report.stateChanges
        .filter((sc) => sc.kind === "character.position")
        .map((sc) => {
          const c = sc as {
            characterId: string;
            position: {
              type: string;
              sceneId?: string;
              junctionId?: string;
              roadId?: string;
            };
            sourceSubsystem?: string;
          };
          const pos = c.position;
          return {
            npcId: c.characterId,
            to:
              pos.type === "scene"
                ? `scene:${pos.sceneId}`
                : pos.type === "junction"
                  ? `junction:${pos.junctionId}`
                  : `road:${pos.roadId}`,
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
        ...(decision.tool === "act"
          ? {
              description: decision.description,
              objectRefs: decision.objectRefs.map((r) => ({
                kind: r.kind,
                id: r.id,
                ...(r.role ? { role: r.role } : {}),
              })),
              proposedDurationTicks: decision.proposedDurationTicks,
              ...(decision.skillId ? { skillId: decision.skillId } : {}),
              ...(decision.utterance ? { utterance: decision.utterance } : {}),
            }
          : {}),
        ...(decision.tool === "continue" && decision.reason
          ? { reason: decision.reason }
          : {}),
      });
      if (decision.tool === "act") {
        log(
          `   [decide] ${ctx.npcId} act "${decision.description.slice(0, 60)}" refs=${
            decision.objectRefs.length
          } ticks=${decision.proposedDurationTicks}${
            decision.skillId ? ` skill=${decision.skillId}` : ""
          }`
        );
      }
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
    // echoed description that follows it: an NPC's prose routinely names
    // other people (a debtor pleading with his creditor cites the creditor),
    // and matching the whole line filed that failure under the creditor's
    // unrelated concurrent case.
    const attribution = line.split("description:")[0];
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
  // An action still queued/active at the end means the agent decided but the
  // Engine's resolvedDurationTicks outlasted the run — a different thing
  // entirely from the agent never acting.
  for (const actor of stage.actors) {
    for (const action of engine.getActorActions(actor.npcId)) {
      if (action.status === "queued" || action.status === "active") {
        observation.actionsAtEnd.push({
          npcId: actor.npcId,
          actionId: action.id,
          status: action.status,
          description: action.command.description
            .replace(/\s+/g, " ")
            .slice(0, 120),
          progressMinutes: action.progressMinutes,
          ...(action.resolvedDurationTicks !== undefined
            ? { resolvedDurationTicks: action.resolvedDurationTicks }
            : {}),
        });
      }
    }
  }

  observation.elapsedMs = Date.now() - started;
  return observation;
}
