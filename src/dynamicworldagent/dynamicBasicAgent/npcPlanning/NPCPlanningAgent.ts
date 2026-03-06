import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { generateText, ModelClass } from "../../../models/index.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  buildGenerateLongTermIntentPrompt,
  buildGenerateDailyPlanPrompt,
  buildRevisePlansPrompt,
  buildImpactGatePrompt,
  buildRelationshipUpdatePrompt,
} from "./NPCPlanningTemplate.js";
import type {
  PlanNode,
  RevisePlansContext,
  CharacterAction,
} from "./types.js";

function parseJsonResponse<T>(raw: string): T {
  let text = raw.trim();
  // Strip markdown fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  return JSON.parse(text) as T;
}

export class NPCPlanningAgent {
  constructor(
    private prisma: PrismaClient,
    private runtime: any
  ) {}

  async generateLongTermIntents(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    moduleId: string,
    language: string = "en"
  ): Promise<void> {
    const state = dgsm.getState();
    const npcs = state.npcCharacters;
    const moduleBackground = state.moduleDigest?.moduleNotes ?? state.moduleDigest?.introduction ?? "";
    const truthTimelineRaw = state.truthTimeline ?? [];
    const truthTimeline = truthTimelineRaw
      .map((t) => `- ${t.time ?? ""}: ${t.event}`)
      .join("\n");

    await Promise.all(
      npcs.map(async (npc) => {
        const npcProfile = this.formatNpcProfile(npc);
        const prompt = buildGenerateLongTermIntentPrompt({
          npcName: npc.name,
          npcProfile,
          truthTimeline,
          moduleBackground,
          language,
        });

        const response = await generateText({
          runtime: this.runtime,
          context: prompt,
          modelClass: ModelClass.SMALL,
        });

        const parsed = parseJsonResponse<{ intent: string }>(response);

        await this.prisma.npcLongTermIntent.upsert({
          where: {
            id: `${sessionId}_${npc.id}`,
          },
          create: {
            id: `${sessionId}_${npc.id}`,
            sessionId,
            moduleId,
            npcId: npc.id,
            npcName: npc.name,
            intent: parsed.intent,
          },
          update: {
            intent: parsed.intent,
          },
        });
      })
    );
  }

  async generateDailyPlans(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    moduleId: string,
    gameDay: number,
    language: string = "en"
  ): Promise<void> {
    const state = dgsm.getState();
    const npcs = state.npcCharacters;

    await Promise.all(
      npcs.map(async (npc) => {
        const longTermIntent = await this.getLongTermIntent(sessionId, npc.id);
        const memoryLog = await this.getMemoryLog(sessionId, npc.id);
        const npcProfile = this.formatNpcProfile(npc);
        const relationships = this.formatRelationships(dgsm, npc.id);
        const sceneMap = this.formatSceneMap(dgsm);
        const scenarioConditions = this.formatScenarioConditions(dgsm);

        const prompt = buildGenerateDailyPlanPrompt({
          npcName: npc.name,
          npcId: npc.id,
          npcProfile,
          longTermIntent,
          memoryLog: memoryLog.join("\n"),
          relationships,
          sceneMap,
          scenarioConditions,
          gameDay,
          currentTime: state.timeOfDay,
          language,
        });

        const response = await generateText({
          runtime: this.runtime,
          context: prompt,
          modelClass: ModelClass.SMALL,
        });

        const nodes = parseJsonResponse<any[]>(response);
        // Inject characterId + characterName into each node
        const enrichedNodes: PlanNode[] = nodes.map((node) => ({
          ...node,
          nodeId: node.nodeId || randomUUID(),
          characterId: npc.id,
          characterName: npc.name,
          status: "pending" as const,
        }));

        await this.prisma.npcDailyPlan.upsert({
          where: {
            sessionId_npcId_gameDay: { sessionId, npcId: npc.id, gameDay },
          },
          create: {
            sessionId,
            moduleId,
            npcId: npc.id,
            npcName: npc.name,
            gameDay,
            nodes: enrichedNodes as any,
          },
          update: {
            nodes: enrichedNodes as any,
          },
        });
      })
    );
  }

  async revisePlans(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    npcId: string,
    context: RevisePlansContext,
    language: string = "en"
  ): Promise<void> {
    const state = dgsm.getState();
    const npc = state.npcCharacters.find((n) => n.id === npcId);
    if (!npc) return;

    const triggerDescription =
      context.trigger.type === "failure"
        ? `Action "${context.trigger.action}" at ${context.trigger.gameTime} failed: ${context.trigger.failureReason}`
        : `Witnessed: ${context.trigger.triggeringAction.action} by ${context.trigger.triggeringAction.characterName} (${context.trigger.triggeringAction.outcome})`;

    const prompt = buildRevisePlansPrompt({
      npcName: npc.name,
      npcProfile: this.formatNpcProfile(npc),
      longTermIntent: context.longTermIntent,
      memoryLog: context.memoryLog.join("\n"),
      pendingNodes: JSON.stringify(context.pendingNodes, null, 2),
      triggerDescription,
      language,
    });

    const response = await generateText({
      runtime: this.runtime,
      context: prompt,
      modelClass: ModelClass.SMALL,
    });

    const parsed = parseJsonResponse<{
      revisedNodes: PlanNode[];
      shouldUpdateLongTermIntent: boolean;
      updatedLongTermIntent?: string;
    }>(response);

    // Inject characterId + characterName
    const revisedNodes = parsed.revisedNodes.map((node) => ({
      ...node,
      characterId: npcId,
      characterName: npc.name,
      status: "pending" as const,
    }));

    // Update daily plan with revised nodes
    const gameDay = state.gameDay;
    await this.prisma.npcDailyPlan.updateMany({
      where: { sessionId, npcId, gameDay },
      data: { nodes: revisedNodes as any },
    });

    // Optionally update long-term intent
    if (parsed.shouldUpdateLongTermIntent && parsed.updatedLongTermIntent) {
      await this.prisma.npcLongTermIntent.updateMany({
        where: { sessionId, npcId },
        data: { intent: parsed.updatedLongTermIntent },
      });
    }
  }

  async runImpactGateForNpc(
    candidate: {
      npcId: string;
      npcName: string;
      currentLocation: string;
      longTermIntent: string;
      pendingNodesSummary: string;
      triggeringEvents: string;
    },
    bucketTime: string,
    language: string = "en"
  ): Promise<{ shouldRevise: boolean; witnessEntry: string }> {
    const prompt = buildImpactGatePrompt({ bucketTime, candidate, language });

    const response = await generateText({
      runtime: this.runtime,
      context: prompt,
      modelClass: ModelClass.SMALL,
    });

    return parseJsonResponse<{ shouldRevise: boolean; witnessEntry: string }>(response);
  }

  async updateRelationshipViaLLM(
    dgsm: DynamicGameStateManager,
    characterAId: string,
    characterBId: string,
    interactionOutcome: string,
    language: string = "en"
  ): Promise<{ scoreDelta: number; newScore: number; note: string } | null> {
    const state = dgsm.getState();

    // Look up both characters — could be NPC or player
    const findCharacter = (id: string) => {
      if (state.playerCharacter?.id === id) return state.playerCharacter;
      return state.npcCharacters.find((n) => n.id === id);
    };
    const charA = findCharacter(characterAId);
    const charB = findCharacter(characterBId);
    if (!charA || !charB) return null;

    const current = dgsm.getRelationship(characterAId, characterBId) ?? {
      score: 0,
      note: "",
    };

    const prompt = buildRelationshipUpdatePrompt({
      npcAName: charA.name,
      npcAProfile: this.formatRelationshipProfile(charA),
      npcBName: charB.name,
      npcBProfile: this.formatRelationshipProfile(charB),
      currentScore: current.score,
      currentNote: current.note,
      interactionOutcome,
      language,
    });

    const response = await generateText({
      runtime: this.runtime,
      context: prompt,
      modelClass: ModelClass.SMALL,
    });

    const parsed = parseJsonResponse<{ scoreDelta: number; note: string }>(
      response
    );
    dgsm.updateRelationship(characterAId, characterBId, parsed.scoreDelta, parsed.note);
    const updated = dgsm.getRelationship(characterAId, characterBId);
    return { scoreDelta: parsed.scoreDelta, newScore: updated?.score ?? 0, note: parsed.note };
  }

  async appendMemoryLog(
    sessionId: string,
    npcId: string,
    entry: string,
    gameDay: number,
    gameTime: string,
    location: string
  ): Promise<void> {
    await this.prisma.npcMemoryLog.create({
      data: {
        sessionId,
        npcId,
        gameDay,
        gameTime,
        location,
        entry,
      },
    });
  }

  async getMemoryLog(sessionId: string, npcId: string, gameDay?: number): Promise<string[]> {
    const where: any = { sessionId, npcId };
    if (gameDay !== undefined) where.gameDay = gameDay;
    const logs = await this.prisma.npcMemoryLog.findMany({
      where,
      orderBy: { createdAt: "asc" },
      select: { entry: true },
    });
    return logs.map((l) => l.entry);
  }

  async getPendingNodes(
    sessionId: string,
    npcId: string,
    gameDay: number
  ): Promise<PlanNode[]> {
    const plan = await this.prisma.npcDailyPlan.findUnique({
      where: {
        sessionId_npcId_gameDay: { sessionId, npcId, gameDay },
      },
    });
    if (!plan) return [];
    const nodes = plan.nodes as unknown as PlanNode[];
    return nodes.filter((n) => n.status === "pending");
  }

  async getLongTermIntent(
    sessionId: string,
    npcId: string
  ): Promise<string> {
    const record = await this.prisma.npcLongTermIntent.findFirst({
      where: { sessionId, npcId },
    });
    return record?.intent ?? "";
  }

  async getDueNpcNodes(
    sessionId: string,
    gameDay: number,
    upToTime: string,
    dgsm: DynamicGameStateManager
  ): Promise<PlanNode[]> {
    const plans = await this.prisma.npcDailyPlan.findMany({
      where: { sessionId, gameDay },
    });

    const dueNodes: PlanNode[] = [];
    for (const plan of plans) {
      const nodes = plan.nodes as unknown as PlanNode[];
      for (const node of nodes) {
        if (node.status === "pending" && node.gameTime <= upToTime) {
          dueNodes.push(node);
        }
      }
    }
    return dueNodes;
  }

  async markNodeCompleted(
    sessionId: string,
    npcId: string,
    gameDay: number,
    nodeId: string,
    outcome: string
  ): Promise<void> {
    const plan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    if (!plan) return;
    const nodes = plan.nodes as unknown as PlanNode[];
    // Remove completed node from pending list
    const remaining = nodes.filter((n) => n.nodeId !== nodeId);
    await this.prisma.npcDailyPlan.update({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
      data: { nodes: remaining as any },
    });
  }

  // === Private helpers ===

  private formatNpcProfile(npc: any): string {
    const parts = [`Name: ${npc.name}`];
    if (npc.occupation) parts.push(`Occupation: ${npc.occupation}`);
    if (npc.personality) parts.push(`Personality: ${npc.personality}`);
    if (npc.background) parts.push(`Background: ${npc.background}`);
    if (npc.goals?.length) parts.push(`Goals: ${npc.goals.join(", ")}`);
    if (npc.secrets?.length) parts.push(`Secrets: ${npc.secrets.join(", ")}`);
    return parts.join("\n");
  }

  private formatRelationshipProfile(character: any): string {
    const parts = [`Name: ${character.name}`];
    if (character.occupation) parts.push(`Occupation: ${character.occupation}`);
    if (character.personality) parts.push(`Personality: ${character.personality}`);
    if (character.background) parts.push(`Background: ${character.background}`);
    if (character.backstory) parts.push(`Backstory: ${character.backstory}`);
    return parts.join("\n");
  }

  private formatRelationships(
    dgsm: DynamicGameStateManager,
    npcId: string
  ): string {
    const graph = dgsm.getState().npcRelationshipGraph[npcId];
    if (!graph || Object.keys(graph).length === 0) return "No known relationships.";
    return Object.entries(graph)
      .map(([targetId, rel]) => {
        const targetNpc = dgsm.getState().npcCharacters.find((n) => n.id === targetId);
        const targetName = targetNpc?.name ?? targetId;
        return `- ${targetName}: score=${rel.score} (${rel.note})`;
      })
      .join("\n");
  }

  private formatSceneMap(dgsm: DynamicGameStateManager): string {
    const state = dgsm.getState();
    const outlines = state.scenarioOutlines ?? [];
    const connections = state.connectionStates;

    // Scene directory: id → name + short description
    const sceneParts: string[] = [];
    const nameById = new Map<string, string>();
    for (const s of outlines) {
      nameById.set(s.id, s.name);
      sceneParts.push(`- ${s.id} "${s.name}": ${s.description}`);
    }

    // Connection graph with names
    const connParts: string[] = [];
    for (const c of connections) {
      const fromName = nameById.get(c.fromScenarioId) ?? c.fromScenarioId;
      const toName = nameById.get(c.toScenarioId) ?? c.toScenarioId;
      let line = `${fromName} (${c.fromScenarioId}) ↔ ${toName} (${c.toScenarioId})`;
      if (c.blocked) line += " [BLOCKED]";
      if (c.conditions.length > 0) line += ` (${c.conditions[c.conditions.length - 1]})`;
      connParts.push(line);
    }

    if (sceneParts.length === 0 && connParts.length === 0) return "No scene data.";
    const parts: string[] = [];
    if (sceneParts.length > 0) parts.push("Scenes:\n" + sceneParts.join("\n"));
    if (connParts.length > 0) parts.push("Connections:\n" + connParts.join("\n"));
    return parts.join("\n\n");
  }

  private formatScenarioConditions(dgsm: DynamicGameStateManager): string {
    const conds = dgsm.getState().scenarioConditions;
    if (Object.keys(conds).length === 0) return "";
    return Object.entries(conds)
      .map(
        ([scenarioId, conditions]) =>
          `${scenarioId}: ${conditions.map((c) => c.description).join("; ")}`
      )
      .join("\n");
  }
}
