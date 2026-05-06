// src/roleSim/npcActionController.ts
//
// Phase F TickReport-driven controller. Subscribes to a single
// `tickCompleted` channel; per tick the controller computes (a) NPCs whose
// action ended this tick, (b) NPCs whose currently-running action received a
// revise-relevant FeatureEvent (per impactPropagation), (c) alive idle NPCs
// candidate for first decide(). Each affected NPC gets ONE decide() call with
// all this-tick triggers batched into ctx.reviseTriggers.
//
// Engine handles never appear in agent-facing types — the engine is the
// source of truth for in-flight state; the controller queries it on demand
// instead of mirroring it.

import type { TickEngine } from "../engine/core/tickEngine.js";
import type {
  CharacterAction,
  FeatureEvent,
  TickReport,
} from "../engine/core/types.js";
import { findAffectedCharacters } from "../engine/shared/impactPropagation.js";
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { RoleSimAgent, RoleSimContext } from "./agent.js";
import { buildPerceptionNarrative } from "./perceptionRenderer.js";

interface ReviseTrigger {
  description: string;
  sourceEvent?: FeatureEvent | CharacterAction;
}

export interface NpcActionControllerDeps {
  engine: TickEngine;
  agent: RoleSimAgent;
  memory: NpcMemoryManager;
  dgsm: DynamicGameStateManager;
  sessionId: string;
  /** Module id required by NpcMemoryManager.add when writing memories. */
  moduleId: string;
}

export class NpcActionController {
  private readonly engine: TickEngine;
  private readonly agent: RoleSimAgent;
  private readonly memory: NpcMemoryManager;
  private readonly dgsm: DynamicGameStateManager;
  private readonly sessionId: string;
  private readonly moduleId: string;

  constructor(deps: NpcActionControllerDeps) {
    this.engine = deps.engine;
    this.agent = deps.agent;
    this.memory = deps.memory;
    this.dgsm = deps.dgsm;
    this.sessionId = deps.sessionId;
    this.moduleId = deps.moduleId;

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
    // 1. Build per-NPC trigger lists from this tick's FeatureEvents
    //    (Decision 15). FeatureEvent is now self-describing — read impact +
    //    description directly off the event.
    const triggersByNpc = new Map<string, ReviseTrigger[]>();

    for (const event of report.featureEvents) {
      if (!event.characterId && !event.sceneId) continue;
      const action = {
        characterId: event.characterId ?? "system",
        targetCharacterIds: [] as string[],
        location: event.sceneId ?? "",
      };
      const affected = findAffectedCharacters(action, event.impact, this.dgsm);
      for (const [npcId] of affected) {
        const list = triggersByNpc.get(npcId) ?? [];
        list.push({ description: event.description, sourceEvent: event });
        triggersByNpc.set(npcId, list);
      }
    }

    // 2. NPCs whose action ended this tick.
    const npcsWithEndedAction = new Set<string>([
      ...report.commits.map((a) => a.characterId),
      ...report.interruptions.map((i) => i.action.characterId),
      ...report.cancellations.map((a) => a.characterId),
    ]);

    // 3. Alive idle NPCs (no in-flight action). Replaces the per-tick
    //    polling that used to live in SimulationRunner.executeTick.
    const idleAlive = this.dgsm
      .getState()
      .npcCharacters.filter((n) => this.dgsm.isNpcAlive(n.id))
      .filter((n) => !this.npcHasActiveStep(n.id))
      .map((n) => n.id);

    // 4. Union of all NPCs that need decide() this tick.
    const allTargets = new Set<string>([
      ...triggersByNpc.keys(),
      ...npcsWithEndedAction,
      ...idleAlive,
    ]);

    // 5. Sequential decide() — no concurrency, no race.
    for (const npcId of allTargets) {
      if (!this.dgsm.isNpcAlive(npcId)) continue;
      const triggers = triggersByNpc.get(npcId);
      await this.decide(
        npcId,
        triggers && triggers.length > 0
          ? { reviseTriggers: triggers }
          : undefined
      );
    }
  }

  async decide(
    npcId: string,
    opts?: { reviseTriggers?: ReadonlyArray<ReviseTrigger> }
  ): Promise<void> {
    if (!this.dgsm.isNpcAlive(npcId)) return;

    // Skip if NPC is busy AND has no triggers — its action is already running.
    // With reviseTriggers present, the agent gets a chance to switch action
    // mid-flight (Decision 14 — `act` absorbs cancellation).
    if (
      this.npcHasActiveStep(npcId) &&
      !(opts?.reviseTriggers && opts.reviseTriggers.length > 0)
    ) {
      return;
    }

    const ctx = await this.buildContext(npcId, opts);
    if (!ctx) return;

    const decision = await this.agent.decideNext(ctx);
    switch (decision.tool) {
      case "act": {
        // Decision 14: cancel current action first if any. Engine is the
        // source of truth for in-flight state — query it, do not mirror.
        const queue = this.engine.getActorQueue(npcId);
        const live = queue.find(
          (s) => s.status === "active" || s.status === "queued"
        );
        if (live) this.engine.cancelAction(live.handle);

        await this.engine.submitAction({
          characterId: npcId,
          actionText: decision.input.actionText,
          targetCharacterIds: decision.input.targetCharacterIds,
          sceneId: this.resolveCurrentSceneId(npcId),
        });
        return;
      }
      case "continue":
        return;
      // writeMemory / recallMemory / getMapSnapshot are instant tools —
      // dispatched inside agent.decideNext() and never reach this switch.
      default:
        return;
    }
  }

  private npcHasActiveStep(npcId: string): boolean {
    return this.engine
      .getActorQueue(npcId)
      .some((s) => s.status === "active" || s.status === "queued");
  }

  private resolveCurrentSceneId(npcId: string): string {
    const position = this.dgsm.getCharacterPosition(npcId);
    return position ? this.dgsm.resolveLocationId(position) : "";
  }

  private async buildContext(
    npcId: string,
    opts?: { reviseTriggers?: ReadonlyArray<ReviseTrigger> }
  ): Promise<RoleSimContext | undefined> {
    const profile = this.dgsm.getNpcProfile(npcId);
    if (!profile) return undefined;

    const day = this.dgsm.getGameDay();
    const tickTime = this.dgsm.getTickTime();
    const position = this.dgsm.getCharacterPosition(npcId);
    const currentScene = position ? this.dgsm.resolveLocationId(position) : "";

    const longTermIntent = await this.loadLongTermIntent(npcId);
    const recentMemory = await this.loadTodayMemories(npcId, day);

    const queue = this.engine.getActorQueue(npcId);
    const active = queue.find((s) => s.status === "active");
    const currentAction = active
      ? { actionText: active.actionText }
      : undefined;

    const perception = {
      narrative: buildPerceptionNarrative(npcId, this.dgsm),
    };

    return {
      npcId,
      currentTime: { day, tickTime },
      npcProfile: profile,
      currentScene,
      recentMemory,
      longTermIntent,
      reviseTriggers: opts?.reviseTriggers,
      currentAction,
      perception,
    };
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
    gameDay: number
  ): Promise<RoleSimContext["recentMemory"]> {
    const rows = await this.memory.getForDayByTypes(
      npcId,
      this.sessionId,
      gameDay,
      ["event", "witness"],
      20
    );
    return rows.map((r) => ({
      type: r.type,
      content: r.content,
      gameDay: r.gameDay,
      gameTime: r.gameTime,
    }));
  }
}
