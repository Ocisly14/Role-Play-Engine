import { randomUUID } from "crypto";
import { generateText, ModelClass } from "../../../models/index.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { buildPlayerPlanPrompt, type PlayerPlanParams } from "./PlayerPlanTemplate.js";
import type { PlanNode } from "./types.js";

function parseJsonResponse<T>(raw: string): T {
  let text = raw.trim();
  // Strip markdown fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  return JSON.parse(text) as T;
}

/**
 * Add minutes to a time string in HH:MM format.
 * Handles overflow past 24:00 by clamping to 23:59.
 */
function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const totalMinutes = h * 60 + m + minutes;
  const clampedMinutes = Math.min(totalMinutes, 23 * 60 + 59);
  const newH = Math.floor(clampedMinutes / 60);
  const newM = clampedMinutes % 60;
  return `${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}`;
}

export class PlayerPlanAgent {
  constructor(private runtime: any) {}

  async generatePlayerNodes(
    playerInput: string,
    dgsm: DynamicGameStateManager,
    orchestratorOutput: {
      targetScenarioName?: string | null;
      targetNpcId?: string | null;
      impact: 0 | 1 | 2 | 3;
    },
    selectedSkill?: string | null,
    language?: string
  ): Promise<PlanNode[]> {
    const state = dgsm.getState();
    const lang = language ?? "en";
    const player = state.playerCharacter;
    const currentScenario = state.scenes.get(state.currentSceneId ?? "") ?? null;

    // Build player profile string
    const playerProfile = this.formatPlayerProfile(player);

    // Build scenario clues string (undiscovered clues available in current scene)
    const scenarioClues = this.formatScenarioClues(currentScenario);

    // Build scene conditions
    const sceneConditions = currentScenario
      ? dgsm
          .getSceneConditions(currentScenario.id)
          .map((c) => `- ${c.description}`)
          .join("\n")
      : "";

    // Build connections from scenarioOutlines matching current scenario
    const connections = this.formatConnections(state, currentScenario?.id);

    // Build target NPC profile
    const targetNpc = orchestratorOutput.targetNpcId
      ? state.npcCharacters.find(
          (n) => n.id === orchestratorOutput.targetNpcId
        )
      : null;
    const targetNpcProfile = targetNpc
      ? this.formatNpcProfile(targetNpc)
      : "";

    // Build target NPC relationship
    const targetNpcRelationship =
      targetNpc && player
        ? this.formatRelationship(dgsm, player.id, targetNpc.id, targetNpc.name)
        : "";

    // Build scene NPCs list
    const sceneNpcs = this.formatSceneNpcs(state, currentScenario);

    // Build conversation history
    const conversationHistory =
      (state.temporaryInfo.contextualData?.conversationHistory as string) ?? "";

    // Build orchestrator hints
    const orchestratorHints = this.formatOrchestratorHints(orchestratorOutput, selectedSkill);

    const params: PlayerPlanParams = {
      playerInput,
      playerName: player.name,
      playerProfile,
      currentScenarioId: currentScenario?.id ?? "",
      currentScenarioName: currentScenario?.name ?? "",
      currentScenarioDescription: currentScenario?.description ?? "",
      scenarioClues,
      sceneConditions,
      connections,
      targetNpcProfile,
      targetNpcRelationship,
      sceneNpcs,
      conversationHistory,
      orchestratorHints,
      currentGameTime: state.timeOfDay,
      gameDay: state.gameDay,
      language: lang,
    };

    const prompt = buildPlayerPlanPrompt(params);

    const response = await generateText({
      runtime: this.runtime,
      context: prompt,
      modelClass: ModelClass.SMALL,
    });

    const rawNodes = parseJsonResponse<any[]>(response);

    // Enrich each node with player metadata and computed gameTime
    let cumulativeMinutes = 0;
    const nodes: PlanNode[] = rawNodes.map((node) => {
      const enriched: PlanNode = {
        ...node,
        nodeId: node.nodeId || randomUUID(),
        isPlayer: true,
        characterId: player.id,
        characterName: player.name,
        location: node.location || currentScenario?.id || "",
        status: "pending" as const,
        gameTime: addMinutes(state.timeOfDay, cumulativeMinutes),
        impact: node.impact ?? orchestratorOutput.impact ?? 0,
        timeAdvanceMinutes: node.timeAdvanceMinutes ?? 15,
      };
      cumulativeMinutes += enriched.timeAdvanceMinutes;
      return enriched;
    });

    return nodes;
  }

  // === Private helpers ===

  private formatPlayerProfile(player: any): string {
    const parts = [`Name: ${player.name}`];
    if (player.occupation) parts.push(`Occupation: ${player.occupation}`);
    if (player.personality) parts.push(`Personality: ${player.personality}`);
    if (player.backstory) parts.push(`Backstory: ${player.backstory}`);

    // Attributes
    if (player.attributes) {
      const attrs = player.attributes;
      const attrStr = Object.entries(attrs)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      parts.push(`Attributes: ${attrStr}`);
    }

    // Status
    if (player.status) {
      const status = player.status;
      const statusStr = Object.entries(status)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      parts.push(`Status: ${statusStr}`);
    }

    // Top skills
    if (player.skills) {
      const topSkills = Object.entries(player.skills as Record<string, number>)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 15)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      parts.push(`Key Skills: ${topSkills}`);
    }

    // Inventory
    if (player.inventory?.length) {
      const items = player.inventory
        .map((item: any) => item.name || item)
        .join(", ");
      parts.push(`Inventory: ${items}`);
    }

    return parts.join("\n");
  }

  private formatScenarioClues(
    scenario: { clues?: Array<{ id: string; clueText: string; category?: string; difficulty?: string; discovered?: boolean; discoveryMethod?: string }> } | null
  ): string {
    if (!scenario?.clues?.length) return "";
    // Show undiscovered clues only (keeper-side info for LLM to decide if player's action targets them)
    const undiscovered = scenario.clues.filter((c) => !c.discovered);
    if (undiscovered.length === 0) return "All clues in this scene have been discovered.";
    return undiscovered
      .map(
        (c) =>
          `- [${c.id}] (${c.category ?? "info"}, difficulty: ${c.difficulty ?? "regular"}) ${c.clueText}${c.discoveryMethod ? ` | method: ${c.discoveryMethod}` : ""}`
      )
      .join("\n");
  }

  private formatConnections(
    state: any,
    currentScenarioId?: string
  ): string {
    if (!currentScenarioId) return "";

    // Find the scenario outline for the current scene
    const outline = state.scenarioOutlines?.find(
      (o: any) => o.id === currentScenarioId
    );
    if (!outline?.connections?.length) return "";

    // Also check connectionStates for blocked status
    const connectionStates = state.connectionStates ?? [];

    return outline.connections
      .map((conn: any) => {
        const blocked = connectionStates.some(
          (cs: any) =>
            cs.blocked &&
            ((cs.fromScenarioId === currentScenarioId &&
              cs.toScenarioId === (conn.scenarioId ?? conn.scenarioName)) ||
              (cs.toScenarioId === currentScenarioId &&
                cs.fromScenarioId === (conn.scenarioId ?? conn.scenarioName)))
        );
        return `- ${conn.scenarioName}${conn.scenarioId ? ` (${conn.scenarioId})` : ""}: ${conn.relationshipType}${conn.description ? ` — ${conn.description}` : ""}${blocked ? " [BLOCKED]" : ""}${conn.blocked ? " [BLOCKED]" : ""}`;
      })
      .join("\n");
  }

  private formatNpcProfile(npc: any): string {
    const parts = [`Name: ${npc.name} (ID: ${npc.id})`];
    if (npc.occupation) parts.push(`Occupation: ${npc.occupation}`);
    if (npc.personality) parts.push(`Personality: ${npc.personality}`);
    if (npc.background) parts.push(`Background: ${npc.background}`);
    if (npc.goals?.length) parts.push(`Goals: ${npc.goals.join(", ")}`);
    return parts.join("\n");
  }

  private formatRelationship(
    dgsm: DynamicGameStateManager,
    playerId: string,
    npcId: string,
    npcName: string
  ): string {
    const rel = dgsm.getRelationship(playerId, npcId);
    if (!rel) return `No prior relationship with ${npcName}.`;
    return `Relationship with ${npcName}: score=${rel.score} (${rel.note})`;
  }

  private formatSceneNpcs(state: any, currentScenario: any): string {
    if (!currentScenario) return "";

    // NPCs present via scenario characters
    const scenarioCharIds = new Set(
      (currentScenario.characters ?? []).map((c: any) => c.id ?? c.name)
    );

    // Also check npcLocations for NPCs at the current scene
    const npcLocationIds = Object.entries(state.npcLocations ?? {})
      .filter(([_, loc]) => loc === currentScenario.id)
      .map(([npcId]) => npcId);

    const allNpcIds = new Set([...scenarioCharIds, ...npcLocationIds]);
    if (allNpcIds.size === 0) return "";

    return state.npcCharacters
      .filter((npc: any) => allNpcIds.has(npc.id))
      .map(
        (npc: any) =>
          `- ${npc.name} (ID: ${npc.id})${npc.occupation ? `, ${npc.occupation}` : ""}`
      )
      .join("\n");
  }

  private formatOrchestratorHints(
    output: {
      targetScenarioName?: string | null;
      targetNpcId?: string | null;
      impact: 0 | 1 | 2 | 3;
    },
    selectedSkill?: string | null
  ): string {
    const hints: string[] = [];
    if (output.targetScenarioName)
      hints.push(`Target scene: ${output.targetScenarioName}`);
    if (output.targetNpcId)
      hints.push(`Target NPC ID: ${output.targetNpcId}`);
    hints.push(`Suggested impact: ${output.impact}`);
    if (selectedSkill)
      hints.push(`Player selected skill: ${selectedSkill}`);
    return hints.join("\n");
  }
}
