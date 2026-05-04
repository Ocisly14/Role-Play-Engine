// src/roleSim/npcAgentAdapter.ts
//
// Phase E adapter — wraps the legacy `NPCPlanningAgent` so it satisfies the
// new `RoleSimAgent` interface. Translates a planned `PlanNode` into an
// `ActionInput` for the engine, or returns `wait` when the agent has nothing
// queued for the NPC. Phase F replaces this with a true tool-driven LLM
// agent that can also emit `plan` and `interrupt`.

import type { ActionDefinitionRegistry } from "../engine/definitions/registry.js";
import type { NPCPlanningAgent } from "../planning/NPCPlanningAgent.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type {
  RoleSimAgent,
  RoleSimContext,
  RoleSimDecision,
} from "./agent.js";

export class NpcAgentAdapter implements RoleSimAgent {
  constructor(
    private agent: NPCPlanningAgent,
    private dgsm: DynamicGameStateManager,
    private definitions: ActionDefinitionRegistry,
    private sessionId: string,
    private language: string
  ) {}

  async decideNext(ctx: RoleSimContext): Promise<RoleSimDecision> {
    await this.agent.ensureNpcNodesAvailable(
      this.dgsm,
      this.sessionId,
      ctx.npcId,
      ctx.currentTime.day,
      ctx.currentTime.tickTime,
      this.language,
      this.definitions
    );

    const inProgress = await this.agent.getInProgressNodes(
      this.sessionId,
      ctx.currentTime.day,
      this.dgsm
    );
    const due = await this.agent.getDueNpcNodes(
      this.sessionId,
      ctx.currentTime.day,
      ctx.currentTime.tickTime,
      this.dgsm
    );

    const node =
      inProgress.find((n) => n.characterId === ctx.npcId) ??
      due.find((n) => n.characterId === ctx.npcId);
    if (!node) return { tool: "wait" };

    const overlayFields: Record<string, unknown> | undefined = node.destination
      ? { destination: node.destination }
      : undefined;

    return {
      tool: "act",
      input: {
        characterId: ctx.npcId,
        actionText: node.action,
        targetCharacterIds: node.targetCharacterIds,
        sceneId: ctx.currentScene,
        overlayFields,
      },
    };
  }
}
