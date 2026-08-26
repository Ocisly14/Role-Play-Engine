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
import type { EngineAction } from "../engine/actions/types.js";
import type { TickEngine } from "../engine/core/tickEngine.js";
import type {
  CharacterAction,
  FeatureEvent,
  TickReport,
} from "../engine/core/types.js";
import { findAffectedCharacters } from "../engine/shared/impactPropagation.js";
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import { datePart } from "../state/gameClock.js";
import type { RoleSimAgent, RoleSimContext } from "./agent.js";
import { buildPerceivedBundle, render } from "./renderer/index.js";

export interface NpcActionControllerDeps {
  engine: TickEngine;
  agent: RoleSimAgent;
  memory: NpcMemoryManager;
  dgsm: DynamicGameStateManager;
  sessionId: string;
  /** Module id required by NpcMemoryManager.add when writing memories. */
  moduleId: string;
  /** Module language ("en" | "zh"). Drives renderer output language. */
  language?: string;
}

interface DecideOpts {
  /** TickReport for this round (omit for bootstrap / pre-tick). */
  report?: TickReport;
  /** Pre-filtered FeatureEvents that propagated to this NPC. */
  eventsForNpc?: FeatureEvent[];
  /** Committed CharacterActions whose impact reached this NPC this tick. */
  actionsForNpc?: CharacterAction[];
}

/** How many prior renderer narratives each NPC keeps as short-term memory. */
const PERCEPTION_HISTORY_CAP = 5;

/** Max location groups deciding concurrently. Overridable for tuning. */
const DECIDE_GROUP_CONCURRENCY = (() => {
  const raw = Number(process.env.NPC_DECIDE_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0 ? raw : 8;
})();

/**
 * Group ids by resolved location. Ids resolving to the same non-empty
 * location share a group (order preserved); ids with no resolvable location
 * each get their own group. Ids resolving to `null` are dropped (dead NPCs).
 */
export function groupByLocation(
  ids: string[],
  resolve: (id: string) => string | null
): string[][] {
  const byLocation = new Map<string, string[]>();
  for (const id of ids) {
    const location = resolve(id);
    if (location === null) continue;
    const key = location === "" ? `__solo:${id}` : location;
    const group = byLocation.get(key);
    if (group) group.push(id);
    else byLocation.set(key, [id]);
  }
  return [...byLocation.values()];
}

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
  await Promise.all(lanes);
}

interface PerceptionHistoryEntry {
  gameDateTime: string;
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
  /** Per-NPC ring buffer of recent renderer narratives (oldest first). Only
   *  successful renders enter; failed renders leave the buffer untouched. */
  private readonly perceptionHistory = new Map<
    string,
    PerceptionHistoryEntry[]
  >();

  constructor(deps: NpcActionControllerDeps) {
    this.engine = deps.engine;
    this.agent = deps.agent;
    this.memory = deps.memory;
    this.dgsm = deps.dgsm;
    this.sessionId = deps.sessionId;
    this.moduleId = deps.moduleId;
    this.language = deps.language ?? "en";

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
    for (const npc of alive) {
      await this.decide(npc.id);
    }
  }

  private async processTickReport(report: TickReport): Promise<void> {
    // 1. Build per-NPC propagated event list. FeatureEvent already carries
    //    intrinsic impact + description (Phase F1); the renderer turns the
    //    set into per-NPC first-person narrative downstream (Phase G).
    const eventsByNpc = new Map<string, FeatureEvent[]>();
    // 1b. Per-NPC propagated actions — siblings of FeatureEvent on the
    //     wake-up path. Carries the CharacterAction so the renderer can
    //     describe what was perceived (who did what, where).
    const actionsByNpc = new Map<string, CharacterAction[]>();

    for (const event of report.featureEvents) {
      if (!event.characterId && !event.sceneId) continue;
      const synthAction = {
        characterId: event.characterId ?? "system",
        referencedEntities: [],
        location: event.sceneId ?? "",
      };
      const affected = findAffectedCharacters(
        synthAction,
        event.impact,
        this.dgsm
      );
      for (const [npcId] of affected) {
        const list = eventsByNpc.get(npcId) ?? [];
        list.push(event);
        eventsByNpc.set(npcId, list);
      }
    }

    // 1c. Propagate committed actions by their interpreter-assigned impact.
    //     Commits with impact 0 stay private (no propagation). Cancellations
    //     are not propagated — a cancelled action's mid-flight effects are
    //     surfaced via the resolver re-run's StateChanges and any explicit
    //     event.emit it produced, not via the cancel itself.
    for (const action of report.commits) {
      if (action.impact <= 0) continue;
      const affected = findAffectedCharacters(
        {
          characterId: action.characterId,
          referencedEntities: action.referencedEntities,
          location: action.sceneId,
        },
        action.impact,
        this.dgsm
      );
      for (const [npcId] of affected) {
        const list = actionsByNpc.get(npcId) ?? [];
        list.push(action);
        actionsByNpc.set(npcId, list);
      }
    }

    // 2. NPCs whose action ended this tick.
    const npcsWithEndedAction = new Set<string>([
      ...report.commits.map((a) => a.characterId),
      ...report.cancellations.map((a) => a.characterId),
    ]);

    // 3. Alive idle NPCs (no in-flight action). Replaces the per-tick
    //    polling that used to live in SimulationRunner.executeTick.
    const idleAlive = this.dgsm
      .getState()
      .npcCharacters.filter((n) => this.dgsm.isNpcAlive(n.id))
      .filter((n) => !this.npcHasActiveStep(n.id))
      .map((n) => n.id);

    // 4. Auto-write event/witness memories so the next decide() pass sees
    //    them in `recentMemory`. The system prompt promises agents that the
    //    engine logs events automatically; this is the actual writer.
    //    `event`  — the actor remembers what they did (commit / interrupt /
    //               cancel of their own action).
    //    `witness` — bystanders remember what they perceived that they did
    //                NOT cause themselves.
    await this.writeAutoMemories(report, eventsByNpc);

    // 5. Union of all NPCs that need decide() this tick.
    const allTargets = new Set<string>([
      ...eventsByNpc.keys(),
      ...actionsByNpc.keys(),
      ...npcsWithEndedAction,
      ...idleAlive,
    ]);

    // 6. Location-grouped decide(). NPCs at the same location decide
    //    sequentially so later deciders see earlier deciders' submissions
    //    (same-scene interaction continuity, deterministic within a group).
    //    NPCs at different locations cannot perceive each other within this
    //    tick, so their groups run concurrently (capped, to respect provider
    //    rate limits).
    const groups = groupByLocation([...allTargets], (npcId) =>
      this.dgsm.isNpcAlive(npcId) ? this.resolveCurrentSceneId(npcId) : null
    );
    await runWithConcurrency(groups, DECIDE_GROUP_CONCURRENCY, async (npcIds) => {
      for (const npcId of npcIds) {
        if (!this.dgsm.isNpcAlive(npcId)) continue;
        const eventsForNpc = eventsByNpc.get(npcId);
        const actionsForNpc = actionsByNpc.get(npcId);
        await this.decide(npcId, {
          report,
          eventsForNpc:
            eventsForNpc && eventsForNpc.length > 0 ? eventsForNpc : undefined,
          actionsForNpc:
            actionsForNpc && actionsForNpc.length > 0
              ? actionsForNpc
              : undefined,
        });
      }
    });
  }

  private async writeAutoMemories(
    report: TickReport,
    eventsByNpc: Map<string, FeatureEvent[]>
  ): Promise<void> {
    // Memory is past-tense fact only. The resolver emits `memory.event` /
    // `memory.witness` StateChanges at commit (and at cancel re-resolve)
    // with the narrative of what actually happened; we route those below.
    //
    // We deliberately do NOT write a separate `[begin]` intent memory at
    // activation: in-flight actions are surfaced via the action queue
    // (self → userPromptBuilder "Currently doing", co-located peers →
    // renderer.charactersInScene.currentActionText). Writing [begin] in
    // addition produced duplicate "I will X" + "I did X" entries per
    // tick × per step, and agents re-planned the same action after seeing
    // the [begin] entry as if it hadn't happened.
    await this.routeResolverMemories(report);

    // Bystanders' perceived events → `witness` memory.
    // FeatureEvent has no per-event timestamp, so we use the tick's gameDateTime.
    // Location: where the event happened (event.sceneId), falling back to
    // the witness's own scene for global/scene-less events.
    const tickTime = this.dgsm.getGameDateTime();
    for (const [npcId, events] of eventsByNpc) {
      for (const ev of events) {
        if (ev.characterId === npcId) continue;
        await this.writeMemoryEntry(
          npcId,
          "witness",
          ev.description,
          tickTime,
          ev.sceneId ?? this.resolveCurrentSceneId(npcId)
        );
      }
    }
  }

  private async routeResolverMemories(report: TickReport): Promise<void> {
    // Build a quick map: characterId → sceneId where they ran their action this
    // tick (commit / cancellation). Used as `location` for the resolver-emitted
    // memory entries.
    const locByActor = new Map<string, string>();
    for (const a of report.commits) {
      locByActor.set(a.characterId, a.sceneId);
    }
    for (const c of report.cancellations) {
      if (!locByActor.has(c.characterId))
        locByActor.set(c.characterId, c.sceneId);
    }

    // Pick game-times from commits/cancellations; fall back to current tick.
    const completedAtByActor = new Map<string, string>();
    for (const a of report.commits) {
      completedAtByActor.set(a.characterId, a.completedAt);
    }
    for (const c of report.cancellations) {
      if (!completedAtByActor.has(c.characterId)) {
        completedAtByActor.set(c.characterId, c.completedAt);
      }
    }
    const tickTime = this.dgsm.getGameDateTime();

    for (const change of report.stateChanges) {
      if (change.kind !== "memory.event" && change.kind !== "memory.witness") {
        continue;
      }
      const { characterId, content } = change;
      const location =
        locByActor.get(characterId) ?? this.resolveCurrentSceneId(characterId);
      const gameDateTime = completedAtByActor.get(characterId) ?? tickTime;

      await this.writeMemoryEntry(
        characterId,
        change.kind === "memory.event" ? "event" : "witness",
        content,
        gameDateTime,
        location
      );
    }
  }

  private async writeMemoryEntry(
    npcId: string,
    type: "event" | "witness",
    content: string,
    gameDateTime: string,
    location: string | undefined
  ): Promise<void> {
    if (!this.dgsm.isNpcAlive(npcId)) return;
    try {
      await this.memory.add({
        npcId,
        sessionId: this.sessionId,
        moduleId: this.moduleId,
        type,
        content,
        gameDateTime,
        ...(location ? { location } : {}),
      });
    } catch (err) {
      console.warn(
        `[NpcActionController] Failed to write ${type} memory for ${npcId}:`,
        err
      );
    }
  }

  async decide(npcId: string, opts?: DecideOpts): Promise<void> {
    if (!this.dgsm.isNpcAlive(npcId)) return;

    // Skip if NPC is busy AND this tick had no propagated events OR actions
    // for them — their action is already running and nothing has happened
    // that warrants a wake-up. With perceived events OR actions present, the
    // agent gets a chance to switch action mid-flight (Decision 14 — `act`
    // absorbs cancellation).
    const hasEvents = !!(opts?.eventsForNpc && opts.eventsForNpc.length > 0);
    const hasActions = !!(opts?.actionsForNpc && opts.actionsForNpc.length > 0);
    if (this.npcHasActiveStep(npcId) && !hasEvents && !hasActions) {
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

  private resolveCurrentSceneId(npcId: string): string {
    const position = this.dgsm.getCharacterPosition(npcId);
    return position ? this.dgsm.resolveLocationId(position) : "";
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

    const longTermIntent = await this.loadLongTermIntent(npcId);
    const recentMemory = await this.loadTodayMemories(
      npcId,
      datePart(gameDateTime)
    );

    const live = this.liveActionFor(npcId);
    const currentAction = live
      ? { description: live.command.description }
      : undefined;

    const bundle = buildPerceivedBundle({
      npcId,
      report: opts?.report,
      eventsForNpc: opts?.eventsForNpc,
      actionsForNpc: opts?.actionsForNpc,
      dgsm: this.dgsm,
      engine: this.engine,
    });

    const rendered = await render({
      npcId,
      bundle,
      dgsm: this.dgsm,
      language: this.language,
    });

    if (rendered === null) {
      // Phase H D6: LLM render failed → NPC perceives nothing this tick.
      // Skip decide() entirely; in-flight action continues. Events for this NPC
      // are dropped (acceptable — render fail rate << 0.1%).
      return undefined;
    }

    // Snapshot prior perceptions (excludes current tick); push current after.
    const recentPerceptions = this.perceptionHistory.get(npcId)?.slice() ?? [];
    this.recordPerception(npcId, gameDateTime, rendered.narrative);

    return {
      npcId,
      currentTime: gameDateTime,
      npcProfile: profile,
      currentScene,
      recentMemory,
      longTermIntent,
      currentAction,
      perception: { narrative: rendered.narrative },
      recentPerceptions,
    };
  }

  private recordPerception(
    npcId: string,
    gameDateTime: string,
    narrative: string
  ): void {
    const buf = this.perceptionHistory.get(npcId) ?? [];
    buf.push({ gameDateTime, narrative });
    if (buf.length > PERCEPTION_HISTORY_CAP) {
      buf.splice(0, buf.length - PERCEPTION_HISTORY_CAP);
    }
    this.perceptionHistory.set(npcId, buf);
  }

  private async loadLongTermIntent(npcId: string): Promise<string> {
    const entry = await this.memory.findLatestByType(
      this.sessionId,
      npcId,
      "long_term_intent"
    );
    return entry?.content ?? "";
  }

  private async loadTodayMemories(
    npcId: string,
    gameDate: string
  ): Promise<RoleSimContext["recentMemory"]> {
    const rows = await this.memory.getForDateByTypes(
      npcId,
      this.sessionId,
      gameDate,
      ["event", "witness"],
      20
    );
    return rows.map((r) => ({
      type: r.type,
      content: r.content,
      gameDateTime: r.gameDateTime,
      ...(r.location
        ? { location: this.dgsm.getScene(r.location)?.name ?? r.location }
        : {}),
    }));
  }
}
