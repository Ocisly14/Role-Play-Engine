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

import { buildActionCommand } from "../engine/actions/commandBuilder.js";
import type { EngineAction, Occurrence } from "../engine/actions/types.js";
import type { TickEngine } from "../engine/core/tickEngine.js";
import type { FeatureEvent, TickReport } from "../engine/core/types.js";
import { findAffectedCharacters } from "../engine/shared/impactPropagation.js";
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { RoleSimAgent, RoleSimContext } from "./agent.js";
import {
  consolidateMemories,
  needsConsolidation,
} from "./memoryConsolidator.js";
import { compactPerceptions, needsCompaction } from "./perceptionCompactor.js";
import { buildPerceivedBundle, render } from "./renderer/index.js";

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
}

interface DecideOpts {
  /** TickReport for this round (omit for bootstrap / pre-tick). */
  report?: TickReport;
  /** Occurrences this NPC was listed as perceiver of (plan Phase 9). */
  occurrencesForNpc?: Occurrence[];
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

  constructor(deps: NpcActionControllerDeps) {
    this.engine = deps.engine;
    this.agent = deps.agent;
    this.memory = deps.memory;
    this.dgsm = deps.dgsm;
    this.sessionId = deps.sessionId;
    this.moduleId = deps.moduleId;
    this.onPerception = deps.onPerception;
    this.onPerceptionCompacted = deps.onPerceptionCompacted;
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
    //    The Engine already decided WHO can perceive each occurrence; the
    //    renderer downstream decides WHAT each perceiver makes of it.
    const occByNpc = new Map<string, Occurrence[]>();
    const route = (npcId: string, occ: Occurrence): void => {
      const list = occByNpc.get(npcId) ?? [];
      list.push(occ);
      occByNpc.set(npcId, list);
    };
    for (const occ of report.occurrences) {
      for (const npcId of occ.perceiverCharacterIds) route(npcId, occ);
    }

    // 1b. Migration shim: subsystem/scripted FeatureEvents are adapted into
    //     occurrence form via the legacy impact propagation, so the renderer
    //     has ONE event intake. Dies when subsystems emit occurrences
    //     natively (plan Phase 8 follow-up).
    let syntheticCounter = 0;
    for (const event of report.featureEvents) {
      if (!event.characterId && !event.sceneId) continue;
      const affected = findAffectedCharacters(
        {
          characterId: event.characterId ?? "system",
          referencedEntities: [],
          location: event.sceneId ?? "",
        },
        event.impact,
        this.dgsm
      );
      const perceivers = [...affected.keys()];
      if (perceivers.length === 0) continue;
      const occ = this.featureEventToOccurrence(
        event,
        perceivers,
        report.gameDateTime,
        syntheticCounter++
      );
      for (const npcId of perceivers) route(npcId, occ);
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

    // 3. Alive idle NPCs (no in-flight action).
    const idleAlive = this.dgsm
      .getState()
      .npcCharacters.filter((n) => this.dgsm.isNpcAlive(n.id))
      .filter((n) => !this.npcHasActiveStep(n.id))
      .map((n) => n.id);

    // 4. Union of all NPCs that need decide() this tick. Perceivers, ended
    //    actors and idle characters, deduplicated.
    const allTargets = new Set<string>([
      ...occByNpc.keys(),
      ...endedActors,
      ...idleAlive,
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
      await this.decide(npcId, {
        report,
        occurrencesForNpc:
          occurrencesForNpc && occurrencesForNpc.length > 0
            ? occurrencesForNpc
            : undefined,
      });
    });
  }

  /** Adapt one legacy FeatureEvent into occurrence form (migration shim). */
  private featureEventToOccurrence(
    event: FeatureEvent,
    perceivers: string[],
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
      perceiverCharacterIds: perceivers,
      signals: [{ factIds: [`${id}#f0`], channel: "visual" }],
    };
  }

  async decide(npcId: string, opts?: DecideOpts): Promise<void> {
    if (!this.dgsm.isNpcAlive(npcId)) return;

    // Skip if NPC is busy AND perceived nothing this tick — their action is
    // already running and nothing has happened that warrants a wake-up. With
    // occurrences present, the agent gets a chance to replace its in-flight
    // action (the engine resolves the interruption, D4).
    const hasOccurrences = !!(
      opts?.occurrencesForNpc && opts.occurrencesForNpc.length > 0
    );
    if (this.npcHasActiveStep(npcId) && !hasOccurrences) {
      return;
    }

    const ctx = await this.buildContext(npcId, opts);
    if (!ctx) return;

    let decision = await this.agent.decideNext(ctx);
    const maxRejectionRetries = 1;
    for (let attempt = 0; ; attempt++) {
      // continue / (instant tools never reach here) — nothing to submit.
      if (decision.tool !== "act") return;

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
        },
        {
          dgsm: this.dgsm,
          ...(live ? { replacesActionId: live.id } : {}),
        }
      );

      let rejectionReason: string | undefined;
      if (built.ok) {
        try {
          const receipt = await this.engine.submitCommand(built.command);
          if (receipt.accepted) return;
          rejectionReason = receipt.reason ?? "command rejected";
        } catch (err) {
          console.warn(
            `[NpcActionController] ${npcId} submitCommand failed; dropping this decision:`,
            err instanceof Error ? err.message : err
          );
          return;
        }
      } else {
        rejectionReason = built.reason;
      }

      if (attempt < maxRejectionRetries) {
        console.warn(
          `[NpcActionController] ${npcId} act command rejected; retrying with feedback:`,
          rejectionReason
        );
        decision = await this.agent.decideNext({
          ...ctx,
          rejectionFeedback: rejectionReason,
        });
        continue;
      }
      console.warn(
        `[NpcActionController] ${npcId} act command rejected after retry; dropping this decision:`,
        rejectionReason
      );
      return;
    }
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

    // Intent, progress and timing only — never engine runtime internals.
    const live = this.liveActionFor(npcId);
    const currentAction = live
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

    const bundle = buildPerceivedBundle({
      npcId,
      report: opts?.report,
      occurrencesForNpc: opts?.occurrencesForNpc,
      dgsm: this.dgsm,
      engine: this.engine,
    });

    // Snapshot BEFORE this tick's paragraph is recorded: the renderer is being
    // told what it has already said, which cannot include what it is about to
    // say. The same buffer feeds the character's own prompt below.
    const priorPerceptions = this.perceptionHistory.get(npcId)?.slice() ?? [];

    const rendered = await render({
      npcId,
      bundle,
      dgsm: this.dgsm,
      language: this.language,
      recentPerceptions: priorPerceptions,
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

    return { ...baseCtx, recentPerceptions };
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
