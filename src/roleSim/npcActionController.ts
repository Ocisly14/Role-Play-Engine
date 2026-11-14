// src/roleSim/npcActionController.ts
//
// Phase F + G TickReport-driven controller. Subscribes to a single
// `tickCompleted` channel; per tick the controller computes (a) NPCs whose
// action ended this tick, (b) NPCs whose currently-running action received a
// revise-relevant FeatureEvent (per impactPropagation), (c) alive idle NPCs
// candidate for first decide(). Each affected NPC gets ONE decide() call;
// inside decide() the renderer (G6) turns the per-NPC PerceivedBundle into
// a first-person narrative that lands in ctx.perception.narrative.
//
// Engine handles never appear in agent-facing types — the engine is the
// source of truth for in-flight state; the controller queries it on demand
// instead of mirroring it.
//
// The player's character takes the same route up to the render, then
// branches (`decidePlayer`): in manual mode the player decides and the world
// pauses when the wake classifier says they are needed; delegated, the same
// agent as every NPC decides and may ask the player for advice, which also
// pauses. The pause is recorded through the PlayerPort as data — never a
// suspended promise — and answered later through `resolvePlayer`.

import { buildActionCommand } from "../engine/actions/commandBuilder.js";
import type {
  ActionTransition,
  EngineAction,
  Occurrence,
  OccurrencePerceiver,
} from "../engine/actions/types.js";
import type { TickEngine } from "../engine/core/tickEngine.js";
import type { FeatureEvent, TickReport } from "../engine/core/types.js";
import { fastPathMode, recordShadow } from "../engine/shared/fastPath.js";
import { findAffectedCharacters } from "../engine/shared/impactPropagation.js";
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import { decide as askDecisions } from "../models/decisions.js";
import type { PlayerPort, PlayerStepTranslator } from "../player/playerPort.js";
import {
  type PlayerPending,
  type PlayerState,
  type QueueStep,
  dropRunning,
  markDone,
  markRunning,
  nextPendingStep,
  runningStep,
} from "../player/playerState.js";
import {
  ENDED_IN_FAILURE,
  classifyManualWake,
} from "../player/wakeClassifier.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import { type CitationScope, tagsIn } from "../state/perceivableDirectory.js";
import {
  type NoticedThisMinute,
  unnoticedCandidates,
} from "../state/perceivedLocation.js";
import type { SceneConnection } from "../state/types.js";
import type { RoleSimAgent, RoleSimContext, RoleSimDecision } from "./agent.js";
import {
  consolidateMemories,
  needsConsolidation,
} from "./memoryConsolidator.js";
import { compactPerceptions, needsCompaction } from "./perceptionCompactor.js";
import { buildPerceivedBundle, render } from "./renderer/index.js";
import { idsCarriedBy } from "./renderer/llmRenderer.js";
import { buildUserPromptSegments } from "./userPromptBuilder.js";
import {
  ACT_QUESTION,
  type NoticeCandidate,
  PendingDelivery,
  buildGateRequest,
  gateSaysSkip,
  hardWakeReason,
  noticedFrom,
} from "./wakeGate.js";

export interface NpcActionControllerDeps {
  engine: TickEngine;
  agent: RoleSimAgent;
  memory: NpcMemoryManager;
  dgsm: DynamicGameStateManager;
  sessionId: string;
  /** Stamped onto memories the character writes while consolidating. */
  moduleId: string;
  /** Module language ("en" | "zh"). Drives renderer output language. */
  language?: string;
  /** Maximum per-character render/decide pipelines in flight. Defaults to
   *  NPC_DECIDE_CONCURRENCY (8 when unset); injectable for deterministic tests. */
  decideConcurrency?: number;
  /** Called for every paragraph rendered, in order. The controller keeps the
   *  stream in memory because both prompts need all of it; whoever owns
   *  durability subscribes here rather than reaching into the buffer. Left
   *  unset (the harness) the stream simply stays in memory for the run. */
  onPerception?: (entry: {
    npcId: string;
    gameDateTime: string;
    location: string;
    narrative: string;
  }) => void;
  /** Called when a character has condensed their own stream. The summary
   *  speaks for every paragraph up to and including
   *  `coversThroughGameDateTime`, so a subscriber that stores it can serve the
   *  short stream back on reload without deleting the long one — the event log
   *  keeps every paragraph; only the prompt gets the shorter view. */
  onPerceptionCompacted?: (entry: {
    npcId: string;
    gameDateTime: string;
    location: string;
    narrative: string;
    coversThroughGameDateTime: string;
  }) => void;
  /** The player's state, when this session has a player character. Absent,
   *  every character is an NPC and nothing below changes. */
  player?: PlayerPort;
  /** Manual mode: turns the player's next queued step into a decision.
   *  Absent, a step that comes up pauses for the player with a rejection. */
  playerTranslator?: PlayerStepTranslator;
}

interface DecideOpts {
  /** TickReport for this round (omit for bootstrap / pre-tick). */
  report?: TickReport;
  /** Occurrences this NPC was listed as perceiver of (plan Phase 9). */
  occurrencesForNpc?: Occurrence[];
  /** This character's own action transitions this tick. Only the player's
   *  branch reads them. */
  transitions?: ActionTransition[];
  /** What the character noticed this minute beyond plain view (concealment
   *  design §5.3). Set by the noticing judgement before the render. */
  noticed?: NoticedThisMinute;
}

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled"]);

/** What became of one decision at the trust boundary. */
type SubmitOutcome =
  | { kind: "submitted"; actionId: string }
  /** The (re)decision was not an `act` — continue, askFriend, … */
  | { kind: "declined"; decision: Exclude<RoleSimDecision, { tool: "act" }> }
  /** Refused by the boundary or the intake, after the one retry. */
  | { kind: "rejected"; reason: string }
  /** `submitCommand` threw. */
  | { kind: "failed"; reason: string };

type DecisionReason = Extract<PlayerPending, { kind: "decision" }>["reason"];

const TRANSLATION_MISSING = "player input translation is not implemented yet";
const STEP_NOT_AN_ACTION = "this step did not turn into an action";
const WORLD_REFUSED = "the world could not take this action right now";

function withoutStep(s: PlayerState, stepId: string): PlayerState {
  return { ...s, queue: s.queue.filter((q) => q.id !== stepId) };
}

/** Max NPC pipelines deciding concurrently. Overridable for tuning. */
const DEFAULT_DECIDE_CONCURRENCY = (() => {
  const raw = Number(process.env.NPC_DECIDE_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0 ? raw : 8;
})();

/** Run `worker` over `items` with at most `limit` in flight. Rejections
 *  propagate after all in-flight workers settle. */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const item = items[next++];
        await worker(item);
      }
    }
  );
  const settled = await Promise.allSettled(lanes);
  const failed = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failed) throw failed.reason;
}

interface PerceptionHistoryEntry {
  gameDateTime: string;
  /** Scene id the character was in when this reached them. */
  location: string;
  narrative: string;
}

export class NpcActionController {
  private readonly engine: TickEngine;
  private readonly agent: RoleSimAgent;
  private readonly memory: NpcMemoryManager;
  private readonly dgsm: DynamicGameStateManager;
  private readonly sessionId: string;
  private readonly moduleId: string;
  private readonly language: string;
  private readonly decideConcurrency: number;
  /** Per-NPC log of every renderer narrative this session, oldest first —
   *  injected whole, so nothing the character perceived scrolls out of reach.
   *  Only successful renders enter; failed renders leave the log untouched.
   *  In memory only: a process restart starts the log over. */
  private readonly perceptionHistory = new Map<
    string,
    PerceptionHistoryEntry[]
  >();
  private readonly onPerception?: NpcActionControllerDeps["onPerception"];
  private readonly onPerceptionCompacted?: NpcActionControllerDeps["onPerceptionCompacted"];
  private readonly player?: PlayerPort;
  private readonly playerTranslator?: PlayerStepTranslator;
  /** Occurrences held for characters the wake gate let sleep; delivered
   *  whole on their next wake (design §6.1). Saved with the runtime. */
  private readonly pending = new PendingDelivery();
  /** What each character may point at in the decision being made now: the
   *  same scope the renderer was given, plus this minute's paragraph. Read
   *  by the trust boundary in `submitDecision`. */
  private readonly citationScopes = new Map<string, CitationScope>();
  /** DECISIONS_WAKE_GATE=shadow: what the gate would have done, kept until
   *  the character's real decision is known. */
  private readonly gateShadow = new Map<string, boolean>();

  constructor(deps: NpcActionControllerDeps) {
    this.engine = deps.engine;
    this.agent = deps.agent;
    this.memory = deps.memory;
    this.dgsm = deps.dgsm;
    this.sessionId = deps.sessionId;
    this.moduleId = deps.moduleId;
    this.onPerception = deps.onPerception;
    this.onPerceptionCompacted = deps.onPerceptionCompacted;
    this.player = deps.player;
    this.playerTranslator = deps.playerTranslator;
    this.language = deps.language ?? "en";
    this.decideConcurrency =
      deps.decideConcurrency !== undefined &&
      Number.isInteger(deps.decideConcurrency) &&
      deps.decideConcurrency > 0
        ? deps.decideConcurrency
        : DEFAULT_DECIDE_CONCURRENCY;

    this.engine.on("tickCompleted", (report: TickReport) =>
      this.processTickReport(report)
    );
  }

  /** Seed first decide() pass for every alive NPC. Called once at session
   *  start (SimulationRunner.executeTick uses tickCompleted thereafter). */
  async bootstrap(): Promise<void> {
    const alive = this.dgsm
      .getState()
      .npcCharacters.filter((n) => this.dgsm.isNpcAlive(n.id));
    await runWithConcurrency(alive, this.decideConcurrency, (npc) =>
      this.decide(npc.id)
    );
  }

  private async processTickReport(report: TickReport): Promise<void> {
    // 1. Route occurrences by the Engine's perceiver lists (plan Phase 9).
    //    The Engine already decided WHO perceives each occurrence and HOW
    //    CLEARLY (the per-perceiver `clarity`); the same row object goes to
    //    every listed character, and the renderer downstream degrades its
    //    facts to that viewer's grade.
    const occByNpc = new Map<string, Occurrence[]>();
    const route = (npcId: string, occ: Occurrence): void => {
      const list = occByNpc.get(npcId) ?? [];
      list.push(occ);
      occByNpc.set(npcId, list);
    };
    for (const occ of report.occurrences) {
      for (const { characterId } of occ.perceivers) route(characterId, occ);
    }

    // 1b. Migration shim: subsystem/scripted FeatureEvents are adapted into
    //     occurrence form via the legacy impact propagation, so the renderer
    //     has ONE event intake. Dies when subsystems emit occurrences
    //     natively (plan Phase 8 follow-up).
    let syntheticCounter = 0;
    for (const event of report.featureEvents) {
      if (!event.characterId && !event.sceneId) continue;
      const action = {
        characterId: event.characterId ?? "system",
        referencedEntities: [],
        location: event.sceneId ?? "",
      };
      // Two rings, not the map's level. `findAffectedCharacters` returns
      // Map<id, level>, but its `addChar` keeps the HIGHEST ring that admits
      // a character (1 targeted, 2 same scene, 3 same macro location, 4
      // neighbourhood, 5 global), so at impact 5 everyone — the person in the
      // room included — reads 5. The value is "widest ring admitting them",
      // not distance, and cannot grade anyone. So: ask once capped at ring 2
      // (targeted or co-located = `full`), once at the event's own impact
      // (everyone it reaches), and anyone in the second set but not the first
      // is `trace`. The shim never emits `limited`; that grade is the World
      // Action Engine's judgement and this path has none to offer.
      const near = findAffectedCharacters(
        action,
        Math.min(event.impact, 2),
        this.dgsm
      );
      const all = findAffectedCharacters(action, event.impact, this.dgsm);
      const perceivers: OccurrencePerceiver[] = [...all.keys()].map((id) => ({
        characterId: id,
        clarity: near.has(id) ? "full" : "trace",
      }));
      if (perceivers.length === 0) continue;
      const occ = this.featureEventToOccurrence(
        event,
        perceivers,
        report.gameDateTime,
        syntheticCounter++
      );
      for (const { characterId } of perceivers) route(characterId, occ);
    }

    // 2. NPCs whose action reached a terminal status this tick.
    const endedActors = new Set(
      report.transitions
        .filter(
          (t) =>
            t.to === "completed" ||
            t.to === "failed" ||
            t.to === "interrupted" ||
            t.to === "cancelled"
        )
        .map((t) => t.actorId)
    );

    // 2b. Each character's own transitions, for the player's branch: it
    //     settles the queue and the wake classifier from them.
    const transitionsByActor = new Map<string, ActionTransition[]>();
    for (const t of report.transitions) {
      const list = transitionsByActor.get(t.actorId) ?? [];
      list.push(t);
      transitionsByActor.set(t.actorId, list);
    }

    // 3. Alive idle NPCs (no in-flight action).
    const idleAlive = this.dgsm
      .getState()
      .npcCharacters.filter((n) => this.dgsm.isNpcAlive(n.id))
      .filter((n) => !this.npcHasActiveStep(n.id))
      .map((n) => n.id);

    // 4. Union of all NPCs that need decide() this tick. Perceivers, ended
    //    actors and idle characters, deduplicated — plus
    //    a delegated player whose friend has spoken unprompted.
    const allTargets = new Set<string>([
      ...occByNpc.keys(),
      ...endedActors,
      ...idleAlive,
      ...this.forcedPlayerWake(),
    ]);

    // 5. Every target decides independently from the same completed-tick
    //    snapshot. A submitted command is intent, not an observable event, so
    //    even co-located characters must not learn it through process order.
    //    The next Engine tick resolves every submitted command together.
    const targets = [...allTargets].filter((npcId) =>
      this.dgsm.isNpcAlive(npcId)
    );
    await runWithConcurrency(targets, this.decideConcurrency, async (npcId) => {
      if (!this.dgsm.isNpcAlive(npcId)) return;
      const occurrencesForNpc = occByNpc.get(npcId);
      const transitions = transitionsByActor.get(npcId);
      await this.decide(npcId, {
        report,
        occurrencesForNpc:
          occurrencesForNpc && occurrencesForNpc.length > 0
            ? occurrencesForNpc
            : undefined,
        ...(transitions ? { transitions } : {}),
      });
    });
  }

  /** The player's id when they are delegated and the friend's unprompted
   *  words are waiting to be read; empty otherwise. */
  private forcedPlayerWake(): string[] {
    const playerId = this.player?.playerId();
    if (!this.player || !playerId) return [];
    const state = this.player.get();
    return state.mode === "delegated" && state.forceWake ? [playerId] : [];
  }

  private isPlayer(npcId: string): boolean {
    return this.player !== undefined && this.player.playerId() === npcId;
  }

  /** Adapt one legacy FeatureEvent into occurrence form (migration shim). */
  private featureEventToOccurrence(
    event: FeatureEvent,
    perceivers: OccurrencePerceiver[],
    tickId: string,
    n: number
  ): Occurrence {
    const id = `occ_evt_${tickId}_${n}`;
    return {
      id,
      tickId,
      sourceActionIds: [],
      ...(event.sceneId !== undefined ? { locationId: event.sceneId } : {}),
      facts: [
        {
          id: `${id}#f0`,
          type: event.type,
          content: event.description,
          entityRefs: event.characterId
            ? [{ kind: "character", id: event.characterId }]
            : [],
        },
      ],
      participants: event.characterId
        ? [{ characterId: event.characterId, role: "actor" }]
        : [],
      perceivers,
      signals: [{ factIds: [`${id}#f0`], channel: "visual" }],
    };
  }

  async decide(npcId: string, opts?: DecideOpts): Promise<void> {
    // A dead player is the runner's business, like a dead NPC.
    if (!this.dgsm.isNpcAlive(npcId)) return;
    if (this.isPlayer(npcId)) return this.decidePlayer(npcId, opts);

    // Skip if NPC is busy AND nothing reached them this tick — their action
    // is already running and nothing has happened that warrants a wake-up.
    // With occurrences present, the agent gets a chance to replace its
    // in-flight action (the engine resolves the interruption, D4). A full
    // pending buffer is delivered now rather than grown further.
    const fresh = opts?.occurrencesForNpc ?? [];
    if (
      this.npcHasActiveStep(npcId) &&
      fresh.length === 0 &&
      !this.pending.isFull(npcId)
    ) {
      return;
    }

    // The wake gate and the noticing judgement (Decisions), before anything
    // is rendered. A character the gate lets sleep keeps this minute's
    // occurrences for their next wake.
    const gate = await this.consultGate(npcId, opts, [
      ...this.pending.peek(npcId),
      ...fresh,
    ]);
    if (gate.skip) {
      this.pending.hold(npcId, fresh);
      return;
    }
    const held = this.pending.take(npcId);
    const heldIds = new Set(held.map((o) => o.id));
    const occurrences = [...held, ...fresh.filter((o) => !heldIds.has(o.id))];

    const ctx = await this.buildContext(npcId, {
      ...opts,
      occurrencesForNpc: occurrences.length > 0 ? occurrences : undefined,
      ...(gate.noticed ? { noticed: gate.noticed } : {}),
    });
    if (!ctx) return;

    const decision = await this.agent.decideNext(ctx);
    const wouldSkip = this.gateShadow.get(npcId);
    if (wouldSkip !== undefined) {
      this.gateShadow.delete(npcId);
      const acted = decision.tool === "act";
      recordShadow("DECISIONS_WAKE_GATE", {
        tick: ctx.currentTime,
        npcId,
        wouldSkip,
        acted,
        agree: wouldSkip === !acted,
      });
    }
    await this.submitDecision(npcId, ctx, decision, (retryCtx) =>
      this.agent.decideNext(retryCtx)
    );
  }

  /**
   * DECISIONS_WAKE_GATE / DECISIONS_NOTICING. Hard-wake cases are never asked
   * (their action ended, they were addressed, no history yet, a full buffer). The gate request is the character's own
   * decision prompt minus this minute's paragraph, plus the structured
   * perception; notice questions ride along. A failed request wakes them and
   * notices nothing.
   */
  private async consultGate(
    npcId: string,
    opts: DecideOpts | undefined,
    occurrences: Occurrence[]
  ): Promise<{ skip: boolean; noticed?: NoticedThisMinute }> {
    const gateMode = fastPathMode("DECISIONS_WAKE_GATE");
    const noticeMode = fastPathMode("DECISIONS_NOTICING");
    if (gateMode === "off" && noticeMode === "off") return { skip: false };
    const profile = this.dgsm.getNpcProfile(npcId);
    if (!profile) return { skip: false };

    const history = this.perceptionHistory.get(npcId) ?? [];
    const reason =
      hardWakeReason({
        npcId,
        ownActionEnded: (opts?.report?.transitions ?? []).some(
          (t) => t.actorId === npcId && TERMINAL.has(t.to)
        ),
        occurrences,
        hasHistory: history.length > 0,
      }) ?? (this.pending.isFull(npcId) ? "pending buffer full" : null);
    const askAct = gateMode !== "off" && reason === null;

    const memories = await this.loadAllMemories(npcId);
    const known = tagsIn([
      ...history.map((h) => h.narrative),
      ...memories.map((m) => m.content),
    ]);
    const position = this.dgsm.getCharacterPosition(npcId);
    const unseen =
      noticeMode === "off"
        ? { items: [], connectionIds: [] }
        : unnoticedCandidates(position, this.dgsm);
    const candidates: NoticeCandidate[] =
      noticeMode === "off"
        ? []
        : [
            ...unseen.items
              .filter((i) => !known.has(i.id))
              .map((i) => ({
                kind: "item" as const,
                id: i.id,
                description: `${i.name}${i.description ? `: ${i.description}` : ""}`,
              })),
            ...unseen.connectionIds.map((id) => ({
              kind: "connection" as const,
              id,
              description: this.connectionDescription(id),
            })),
          ];
    if (!askAct && candidates.length === 0) return { skip: false };

    const currentScene = position ? this.dgsm.resolveLocationId(position) : "";
    const gateCtx: RoleSimContext = {
      npcId,
      currentTime: this.dgsm.getGameDateTime(),
      npcProfile: profile,
      currentScene,
      memories,
      currentAction: this.currentActionFor(npcId),
      perception: { narrative: "", location: currentScene },
      recentPerceptions: history,
    };
    const result = await askDecisions(
      buildGateRequest({
        npcId,
        agentSegments: buildUserPromptSegments(gateCtx, {
          language: this.language,
          dgsm: this.dgsm,
        }),
        bundle: buildPerceivedBundle({
          npcId,
          report: opts?.report,
          occurrencesForNpc: occurrences,
          dgsm: this.dgsm,
          engine: this.engine,
        }),
        ask: { act: askAct, notice: candidates },
      })
    );
    const answers = result.ok ? result.answers : null;

    let skip = false;
    if (askAct && answers?.has(ACT_QUESTION)) {
      const wouldSkip = gateSaysSkip(answers);
      if (gateMode === "on") skip = wouldSkip;
      else this.gateShadow.set(npcId, wouldSkip);
    }
    let noticed: NoticedThisMinute | undefined;
    if (candidates.length > 0) {
      const found = noticedFrom(answers, candidates);
      if (noticeMode === "on") {
        noticed = found;
      } else {
        recordShadow("DECISIONS_NOTICING", {
          tick: gateCtx.currentTime,
          npcId,
          candidates: candidates.map((c) => c.id),
          noticed: [...found.itemIds, ...found.connectionIds],
        });
      }
    }
    return { skip, ...(noticed ? { noticed } : {}) };
  }

  /** What a concealed passage looks like, for the noticing question. */
  private connectionDescription(connectionId: string): string {
    for (const place of [
      ...this.dgsm.getState().scenes.values(),
      ...(this.dgsm.getTopology()?.roads?.values() ?? []),
    ]) {
      const c = (place.connections as SceneConnection[] | undefined)?.find(
        (x) => x.id === connectionId
      );
      if (c) return c.description ?? c.name ?? `a way to ${c.targetId}`;
    }
    return connectionId;
  }

  /** The pending buffer, for the runtime snapshot. */
  serializePendingDelivery(): Record<string, Occurrence[]> {
    return this.pending.serialize();
  }

  /** Restore the pending buffer from a runtime snapshot. */
  restorePendingDelivery(data: unknown): void {
    if (data && typeof data === "object") {
      this.pending.rehydrate(data as Record<string, Occurrence[]>);
    }
  }

  /** build → submit → one retry on rejection. Shared by NPCs and the player;
   *  `redecide` is whoever made the first decision, asked again with the
   *  rejection as feedback. */
  private async submitDecision(
    npcId: string,
    ctx: RoleSimContext,
    first: RoleSimDecision,
    redecide: (retryCtx: RoleSimContext) => Promise<RoleSimDecision>
  ): Promise<SubmitOutcome> {
    let decision = first;
    const maxRejectionRetries = 1;
    for (let attempt = 0; ; attempt++) {
      // continue / askFriend (instant tools never reach here) — nothing to
      // submit.
      if (decision.tool !== "act") return { kind: "declined", decision };

      // D4: never pre-cancel. A live action becomes `replacesActionId`; the
      // engine resolves the interruption and the new start together on the
      // next tick's snapshot.
      const live = this.liveActionFor(npcId);

      // A rejected command must not crash the tick's NPC loop: the intake
      // returns a structured reason, the agent gets ONE retry with that
      // reason as factual feedback, then the decision is dropped (the agent
      // decides again next tick).
      const built = buildActionCommand(
        npcId,
        {
          description: decision.description,
          objectRefs: decision.objectRefs,
          proposedDurationTicks: decision.proposedDurationTicks,
          ...(decision.skillId !== undefined
            ? { skillId: decision.skillId }
            : {}),
          ...(decision.language !== undefined
            ? { language: decision.language }
            : {}),
          ...(decision.utterance !== undefined
            ? { utterance: decision.utterance }
            : {}),
          // Only the player is ever offered `sleep`; an NPC's raw args keep
          // exactly the shape they always had.
          ...(decision.sleep === true && this.isPlayer(npcId)
            ? { sleep: true }
            : {}),
        },
        {
          dgsm: this.dgsm,
          ...(live ? { replacesActionId: live.id } : {}),
          ...(this.citationScopes.has(npcId)
            ? { citationScope: this.citationScopes.get(npcId) }
            : {}),
        }
      );

      let rejectionReason: string | undefined;
      if (built.ok) {
        try {
          const receipt = await this.engine.submitCommand(built.command);
          if (receipt.accepted) {
            return {
              kind: "submitted",
              actionId: receipt.actionId ?? `action_${built.command.commandId}`,
            };
          }
          rejectionReason = receipt.reason ?? "command rejected";
        } catch (err) {
          console.warn(
            `[NpcActionController] ${npcId} submitCommand failed; dropping this decision:`,
            err instanceof Error ? err.message : err
          );
          return {
            kind: "failed",
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      } else {
        rejectionReason = built.reason;
      }

      if (attempt < maxRejectionRetries) {
        console.warn(
          `[NpcActionController] ${npcId} act command rejected; retrying with feedback:`,
          rejectionReason
        );
        decision = await redecide({
          ...ctx,
          rejectionFeedback: rejectionReason,
        });
        continue;
      }
      console.warn(
        `[NpcActionController] ${npcId} act command rejected after retry; dropping this decision:`,
        rejectionReason
      );
      return {
        kind: "rejected",
        reason: rejectionReason ?? "command rejected",
      };
    }
  }

  // ==================== The player's character ====================

  /** The player's branch of `decide()`. Same render, same skip rule as an
   *  NPC; what follows the render depends on the mode. */
  private async decidePlayer(
    playerId: string,
    opts?: DecideOpts
  ): Promise<void> {
    const port = this.player;
    if (!port) return;
    const transitions = (opts?.transitions ?? []).filter(
      (t) => t.actorId === playerId
    );

    // Queue bookkeeping first: it rests only on what the engine reported,
    // not on whether the render below succeeds.
    this.settlePlayerQueue(transitions);

    // The NPC skip rule — busy and perceived nothing — holds for the player
    // too, except that a delegated player whose friend spoke unprompted is
    // woken to read it.
    const before = port.get();
    const forced = before.mode === "delegated" && before.forceWake;
    const hasOccurrences = !!(
      opts?.occurrencesForNpc && opts.occurrencesForNpc.length > 0
    );
    if (this.npcHasActiveStep(playerId) && !hasOccurrences && !forced) {
      return;
    }

    // Renders and records the paragraph whatever the verdict: a moment the
    // player is not paused for still belongs in their stream.
    const ctx = await this.buildContext(playerId, opts);
    if (!ctx) return;

    if (port.get().mode === "delegated") {
      await this.runDelegated(playerId, ctx);
      return;
    }

    const own = this.engine.getActorActions(playerId);
    // The action a player's own new command replaced ends `interrupted`;
    // that is the player changing course, not a failure to stop them for.
    const replacedByOwn = new Set(
      own
        .map((a) => a.command.replacesActionId)
        .filter((id): id is string => id !== undefined)
    );
    const verdict = classifyManualWake({
      playerId,
      occurrences: opts?.occurrencesForNpc ?? [],
      transitions: transitions.filter((t) => !replacedByOwn.has(t.actionId)),
      ownActionIds: new Set([
        ...transitions.map((t) => t.actionId),
        ...own.map((a) => a.id),
      ]),
      hasLiveAction: this.npcHasActiveStep(playerId),
      hasPendingStep: nextPendingStep(port.get()) !== undefined,
    });
    switch (verdict.kind) {
      case "none":
        return;
      case "pause":
        this.requestPlayerDecision(ctx, verdict.reason);
        return;
      case "advanceQueue":
        await this.advancePlayerQueue(playerId, this.asManual(ctx));
        return;
    }
  }

  /** Called by the runner while paused, after the player answered. Never
   *  renders while the stream has something to show: the context reads the
   *  last paragraph the player already saw.
   *
   *  Contract with the runner: clear `pending` only AFTER this returns. */
  async resolvePlayer(
    input:
      | { kind: "continue" }
      // The queue was already replaced through PlayerPort.set.
      | { kind: "steps" }
      // Delegated: friendLog already appended.
      | { kind: "advice" }
  ): Promise<void> {
    const port = this.player;
    const playerId = port?.playerId();
    if (!port || !playerId || !this.dgsm.isNpcAlive(playerId)) return;
    const mode = port.get().mode;

    if (input.kind === "advice") {
      if (mode !== "delegated") return;
      const ctx = await this.buildContextFromHistory(playerId);
      if (!ctx) return;
      await this.runDelegated(playerId, ctx);
      return;
    }

    if (mode !== "manual") return;
    // "Continue" while busy lets the current action run on; idle, it takes
    // the queue's next step. New steps go in at once, replacing whatever is
    // running (the engine interrupts it, D4).
    if (input.kind === "continue" && this.npcHasActiveStep(playerId)) return;
    if (!nextPendingStep(port.get())) return;
    const ctx = await this.buildContextFromHistory(playerId);
    if (!ctx) return;
    await this.advancePlayerQueue(playerId, this.asManual(ctx));
  }

  /** A completed step is done; the running step whose action failed, was
   *  interrupted or cancelled is dropped. */
  private settlePlayerQueue(
    transitions: ReadonlyArray<ActionTransition>
  ): void {
    const port = this.player;
    if (!port || transitions.length === 0) return;
    const before = port.get();
    let next = before;
    for (const t of transitions) {
      if (t.to === "completed") next = markDone(next, t.actionId);
    }
    const running = runningStep(next);
    if (
      running?.actionId !== undefined &&
      transitions.some(
        (t) => ENDED_IN_FAILURE.has(t.to) && t.actionId === running.actionId
      )
    ) {
      next = dropRunning(next);
    }
    if (next !== before) port.set(next);
  }

  /** Delegated: the agent decides as an NPC would, with the friend's words
   *  in view and `askFriend` on offer. */
  private async runDelegated(
    playerId: string,
    ctx: RoleSimContext
  ): Promise<void> {
    const port = this.player;
    if (!port) return;
    const playerCtx: RoleSimContext = {
      ...ctx,
      player: { mode: "delegated", friendLog: port.get().friendLog },
    };
    const decision = await this.agent.decideNext(playerCtx);
    // The friend's words have been read — only now, so a decision that threw
    // leaves the wake standing for the next tick.
    const read = port.get();
    if (read.forceWake) port.set({ ...read, forceWake: false });
    const outcome = await this.submitDecision(
      playerId,
      playerCtx,
      decision,
      (retryCtx) => this.agent.decideNext(retryCtx)
    );
    if (outcome.kind !== "declined") return;
    const declined = outcome.decision;
    if (declined.tool !== "askFriend") return;
    // A question with nothing in it asks nothing: the same as `continue`.
    const question = declined.question.trim();
    if (question === "") return;
    port.requestPause({
      kind: "consult",
      since: this.dgsm.getGameDateTime(),
      question,
    });
  }

  /** Manual: submit the queue's next step (`submitPlayerStep` pauses
   *  instead when no translator is wired). */
  private async advancePlayerQueue(
    playerId: string,
    ctx: RoleSimContext
  ): Promise<void> {
    const port = this.player;
    if (!port) return;
    const step = nextPendingStep(port.get());
    if (!step) return;
    await this.submitPlayerStep(playerId, ctx, step);
  }

  private async submitPlayerStep(
    playerId: string,
    ctx: RoleSimContext,
    step: QueueStep
  ): Promise<void> {
    const port = this.player;
    if (!port) return;
    const translator = this.playerTranslator;
    if (!translator) {
      this.requestPlayerDecision(ctx, "rejected", TRANSLATION_MISSING);
      return;
    }

    const decision = await translator.translateStep(ctx, step);
    const outcome = await this.submitDecision(
      playerId,
      ctx,
      decision,
      (retryCtx) => translator.translateStep(retryCtx, step)
    );
    switch (outcome.kind) {
      case "submitted":
        port.set(markRunning(port.get(), step.id, outcome.actionId));
        return;
      case "rejected":
        // The player sees why, instead of the step vanishing silently.
        port.set(withoutStep(port.get(), step.id));
        this.requestPlayerDecision(ctx, "rejected", outcome.reason);
        return;
      case "declined":
        port.set(withoutStep(port.get(), step.id));
        this.requestPlayerDecision(ctx, "rejected", STEP_NOT_AN_ACTION);
        return;
      case "failed":
        // Not the step's fault: it stays queued for the next "continue".
        // The real error is already in the log (submitDecision warns it);
        // the player reads a sentence, not a stack message.
        this.requestPlayerDecision(ctx, "rejected", WORLD_REFUSED);
        return;
    }
  }

  private requestPlayerDecision(
    _ctx: RoleSimContext,
    reason: DecisionReason,
    rejection?: string
  ): void {
    this.player?.requestPause({
      kind: "decision",
      since: this.dgsm.getGameDateTime(),
      reason,
      ...(rejection !== undefined ? { rejection } : {}),
    });
  }

  private asManual(ctx: RoleSimContext): RoleSimContext {
    return { ...ctx, player: { mode: "manual" } };
  }

  /** The NPC's single live (active preferred, else queued) EngineAction. */
  private liveActionFor(npcId: string): EngineAction | undefined {
    const actions = this.engine.getActorActions(npcId);
    return (
      actions.find((a) => a.status === "active") ??
      actions.find((a) => a.status === "queued")
    );
  }

  private npcHasActiveStep(npcId: string): boolean {
    return this.liveActionFor(npcId) !== undefined;
  }

  private async buildContext(
    npcId: string,
    opts?: DecideOpts
  ): Promise<RoleSimContext | undefined> {
    const profile = this.dgsm.getNpcProfile(npcId);
    if (!profile) return undefined;

    const gameDateTime = this.dgsm.getGameDateTime();
    const position = this.dgsm.getCharacterPosition(npcId);
    const currentScene = position ? this.dgsm.resolveLocationId(position) : "";

    let memories = await this.loadAllMemories(npcId);

    const currentAction = this.currentActionFor(npcId);

    const bundle = buildPerceivedBundle({
      npcId,
      report: opts?.report,
      occurrencesForNpc: opts?.occurrencesForNpc,
      dgsm: this.dgsm,
      engine: this.engine,
      ...(opts?.noticed ? { noticed: opts.noticed } : {}),
    });

    // Snapshot BEFORE this tick's paragraph is recorded: the renderer is being
    // told what it has already said, which cannot include what it is about to
    // say. The same buffer feeds the character's own prompt below.
    const priorPerceptions = this.perceptionHistory.get(npcId)?.slice() ?? [];

    // What they may point at: what they were shown before (every tag in their
    // stream and memories) and what they noticed this minute. The renderer
    // adds what this minute's occurrences carry; the boundary below gets the
    // same scope plus the paragraph itself.
    const renderScope: CitationScope = {
      knownIds: tagsIn([
        ...priorPerceptions.map((p) => p.narrative),
        ...memories.map((m) => m.content),
      ]),
      ...(opts?.noticed ? { noticed: opts.noticed } : {}),
    };

    const rendered = await render({
      npcId,
      bundle,
      dgsm: this.dgsm,
      language: this.language,
      recentPerceptions: priorPerceptions,
      citationScope: renderScope,
    });

    if (rendered === null) {
      // Phase H D6: LLM render failed → NPC perceives nothing this tick.
      // Skip decide() entirely; in-flight action continues. Occurrences for
      // this NPC are dropped (acceptable — render fail rate << 0.1%).
      return undefined;
    }

    // No memory is written here. Perception is injected raw (below, as
    // `perception` + `recentPerceptions`); the character decides what — if
    // anything — is worth keeping and writes it with `writeMemory`, which
    // rides along with its terminal call at no extra round trip.

    // Snapshot every prior perception (excludes current tick); push current
    // after.
    const baseCtx: RoleSimContext = {
      npcId,
      currentTime: gameDateTime,
      npcProfile: profile,
      currentScene,
      memories,
      currentAction,
      perception: { narrative: rendered.narrative, location: currentScene },
      recentPerceptions: priorPerceptions,
    };

    // Over the ceiling, the character brings their own memories down before
    // they decide under them. The list is reloaded afterwards so the decision
    // reads the rows that now exist — and so its `ref`s cannot name a line
    // this pass just deleted.
    if (needsConsolidation(memories)) {
      const result = await consolidateMemories({
        ctx: baseCtx,
        dgsm: this.dgsm,
        memory: this.memory,
        sessionId: this.sessionId,
        moduleId: this.moduleId,
        language: this.language,
      });
      if (result) {
        memories = await this.loadAllMemories(npcId);
        baseCtx.memories = memories;
        console.log(
          `[NpcActionController] ${npcId}: consolidated memories — ${result.applied} applied, ${result.skipped} skipped, ${memories.length} rows remain`
        );
      }
    }

    // Over the ceiling, the character condenses their own stream before they
    // decide under it — with this same context, so what they keep is judged
    // from where they are standing. Ordered before `recordPerception` so the
    // paragraph they have not yet been told about does not land inside the
    // part they are summarizing.
    const recentPerceptions = await this.compactIfOverBudget(
      npcId,
      baseCtx,
      priorPerceptions
    );

    this.recordPerception(
      npcId,
      gameDateTime,
      currentScene,
      rendered.narrative
    );
    this.citationScopes.set(npcId, {
      knownIds: new Set([
        ...renderScope.knownIds,
        ...tagsIn([rendered.narrative, ...memories.map((m) => m.content)]),
      ]),
      shownIds: idsCarriedBy(bundle, npcId),
      ...(opts?.noticed ? { noticed: opts.noticed } : {}),
    });

    return { ...baseCtx, recentPerceptions };
  }

  /** Intent, progress and timing only — never engine runtime internals. */
  private currentActionFor(npcId: string): RoleSimContext["currentAction"] {
    const live = this.liveActionFor(npcId);
    return live
      ? {
          description: live.command.description,
          ...(live.startedAt !== undefined
            ? { startedAt: live.startedAt }
            : {}),
          progressMinutes: live.progressMinutes,
          ...(live.resolvedDurationTicks !== undefined
            ? { resolvedDurationTicks: live.resolvedDurationTicks }
            : {}),
        }
      : undefined;
  }

  /** `buildContext` for a decision made while the world is paused: the
   *  perception is the last paragraph already rendered — the one the player
   *  answered — so nothing is rendered or recorded again. Consolidation and
   *  compaction are left to the next rendered tick. An empty stream falls
   *  back to `buildContext`. */
  private async buildContextFromHistory(
    npcId: string
  ): Promise<RoleSimContext | undefined> {
    const history = this.perceptionHistory.get(npcId);
    if (!history || history.length === 0) {
      return this.buildContext(npcId);
    }

    const profile = this.dgsm.getNpcProfile(npcId);
    if (!profile) return undefined;
    const position = this.dgsm.getCharacterPosition(npcId);
    const currentScene = position ? this.dgsm.resolveLocationId(position) : "";
    const last = history[history.length - 1];
    const memories = await this.loadAllMemories(npcId);
    this.citationScopes.set(npcId, {
      knownIds: tagsIn([
        ...history.map((h) => h.narrative),
        ...memories.map((m) => m.content),
      ]),
    });

    return {
      npcId,
      currentTime: this.dgsm.getGameDateTime(),
      npcProfile: profile,
      currentScene,
      memories,
      currentAction: this.currentActionFor(npcId),
      perception: { narrative: last.narrative, location: last.location },
      recentPerceptions: history.slice(0, -1),
    };
  }

  /** Returns the stream the decision should read: the compacted one when the
   *  ceiling was passed and the call produced something, the original
   *  otherwise. A failed compaction is not a failed tick — the long stream is
   *  still correct, and the attempt simply repeats next decision. */
  private async compactIfOverBudget(
    npcId: string,
    ctx: RoleSimContext,
    priorPerceptions: PerceptionHistoryEntry[]
  ): Promise<PerceptionHistoryEntry[]> {
    if (!needsCompaction(priorPerceptions)) return priorPerceptions;

    const compacted = await compactPerceptions({
      ctx,
      dgsm: this.dgsm,
      language: this.language,
    });
    if (!compacted) return priorPerceptions;

    this.perceptionHistory.set(npcId, [...compacted.entries]);
    const summaryEntry = compacted.entries[0];
    this.onPerceptionCompacted?.({
      npcId,
      gameDateTime: summaryEntry.gameDateTime,
      location: summaryEntry.location,
      narrative: summaryEntry.narrative,
      coversThroughGameDateTime: compacted.coversThroughGameDateTime,
    });
    console.log(
      `[NpcActionController] ${npcId}: condensed ${priorPerceptions.length} paragraphs into a summary + ${compacted.entries.length - 1}`
    );
    return compacted.entries;
  }

  private recordPerception(
    npcId: string,
    gameDateTime: string,
    location: string,
    narrative: string
  ): void {
    const buf = this.perceptionHistory.get(npcId) ?? [];
    buf.push({ gameDateTime, location, narrative });
    this.perceptionHistory.set(npcId, buf);
    this.onPerception?.({ npcId, gameDateTime, location, narrative });
  }

  /** Seed the stream from storage when a session resumes. Replaces whatever is
   *  buffered for those characters, so it must run before the first decide():
   *  a character who resumes with an empty stream reintroduces the room as if
   *  they had just walked in, and their own prompt loses the day they lived. */
  restorePerceptionHistory(
    entries: ReadonlyArray<{
      npcId: string;
      gameDateTime: string;
      location: string;
      narrative: string;
    }>
  ): void {
    const byNpc = new Map<string, PerceptionHistoryEntry[]>();
    for (const e of entries) {
      const buf = byNpc.get(e.npcId) ?? [];
      buf.push({
        gameDateTime: e.gameDateTime,
        location: e.location,
        narrative: e.narrative,
      });
      byNpc.set(e.npcId, buf);
    }
    for (const [npcId, buf] of byNpc) this.perceptionHistory.set(npcId, buf);
  }

  /** Every memory this character holds, injected whole — there is no recall
   *  tool, so what is not in the prompt does not exist for them. `limit` is a
   *  runaway guard, not a curation policy. */
  private async loadAllMemories(
    npcId: string
  ): Promise<RoleSimContext["memories"]> {
    const rows = await this.memory.getAllByTypes(
      npcId,
      this.sessionId,
      [
        "general",
        "plan",
        "secret",
        "relationship",
        "map",
        // The life goal is a memory like any other, not a separate prompt
        // field fetched by its own query. Writing a new one does not erase
        // the old: the character remembers what they used to want, and the
        // timestamps say which one is current.
        "long_term_intent",
      ],
      2000
    );
    return rows.map((r) => ({
      id: r.id,
      handle: r.handle,
      type: r.type,
      content: r.content,
      gameDateTime: r.gameDateTime,
      ...(r.location
        ? { location: this.dgsm.getScene(r.location)?.name ?? r.location }
        : {}),
    }));
  }
}
