import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { generateText, ModelClass } from "../../../models/index.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import {
  buildDailySchedulePrompt,
  buildDetailedNodesPrompt,
  buildReviseSchedulePrompt,
  buildRevisePlansPrompt,
  buildImpactGatePrompt,
  buildRelationshipUpdatePrompt,
  buildSummarizeDayMemoryPrompt,
} from "./npcPlanningTemplates.js";
import type {
  PlanNode,
  RevisePlansContext,
  CharacterAction,
  ScheduleEntry,
} from "./types.js";
import { formatSceneItems, formatItemList } from "./itemFormatHelpers.js";
import { formatSceneMap } from "./sceneMapFormatter.js";
import type { GameEngineRegistry } from "../../engine/registry.js";
import { getTopologyNeighbors } from "../../engine/shared/topologyHelpers.js";

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
    private runtime: any,
    private memoryManager?: NpcMemoryManager,
  ) {}

  getMemoryManager(): NpcMemoryManager | undefined {
    return this.memoryManager;
  }

  getRuntime(): any {
    return this.runtime;
  }

  async seedLongTermIntents(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    moduleId: string,
  ): Promise<void> {
    const state = dgsm.getState();
    const npcs = state.npcCharacters;

    await Promise.all(
      npcs.map(async (npc) => {
        const intent = npc.goals?.length
          ? npc.goals.join("; ")
          : npc.background ?? "No specific goal.";

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
            intent,
          },
          update: {
            intent,
          },
        });

        if (this.memoryManager) {
          await this.memoryManager.add({
            npcId: npc.id,
            sessionId,
            moduleId,
            type: "plan",
            content: intent,
            gameDay: 1,
            gameTime: "00:00",
            metadata: { planType: "long_term" as const },
          });
        }
      })
    );
  }

  async generateDailyPlans(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    moduleId: string,
    gameDay: number,
    language: string = "en",
    registry?: GameEngineRegistry
  ): Promise<void> {
    // Delegate to two-tier schedule generation
    await this.generateDailySchedule(dgsm, sessionId, moduleId, gameDay, language, registry);
  }

  async generateDailySchedule(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    moduleId: string,
    gameDay: number,
    language: string = "en",
    registry?: GameEngineRegistry
  ): Promise<void> {
    const state = dgsm.getState();
    const npcs = state.npcCharacters;

    await Promise.all(
      npcs.map(async (npc) => {
        await this.generateSingleNpcSchedule(dgsm, sessionId, moduleId, npc.id, gameDay, language, registry);
      })
    );
  }

  async generateSingleNpcSchedule(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    moduleId: string,
    npcId: string,
    gameDay: number,
    language: string = "en",
    registry?: GameEngineRegistry
  ): Promise<void> {
    const state = dgsm.getState();
    const npc = state.npcCharacters.find((n) => n.id === npcId);
    if (!npc) return;

    // Get memory context from unified memory system
    let memoryContext: string | undefined;
    if (this.memoryManager) {
      memoryContext = await this.memoryManager.getContext({
        npcId: npc.id,
        sessionId,
        purpose: "scheduling",
        currentGameDay: gameDay,
      });
    }
    const longTermIntent = await this.getLongTermIntent(sessionId, npc.id);

    const npcProfile = this.formatNpcProfile(npc);
    const relationships = this.formatRelationships(dgsm, npc.id);
    const sceneMap = this.formatSceneMap(dgsm, npc.id);
    const npcLocation = state.npcLocations[npc.id];
    const scenarioConditions = this.formatNpcLocalConditions(dgsm, npcLocation);
    const worldStatePrompt = this.buildNpcWorldStatePrompt(dgsm, npc.id, npcLocation, registry);

    const { systemPrompt, userPrompt } = buildDailySchedulePrompt({
      npcName: npc.name,
      npcId: npc.id,
      npcProfile,
      longTermIntent,
      relationships,
      sceneMap,
      scenarioConditions,
      worldStatePrompt,
      gameDay,
      currentTime: state.timeOfDay,
      language,
      memoryContext,
    });

    const response = await generateText({
      runtime: this.runtime,
      context: userPrompt,
      customSystemPrompt: systemPrompt,
      modelClass: ModelClass.MEDIUM,
    });

    const schedule = parseJsonResponse<ScheduleEntry[]>(response);

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
        nodes: [] as any,
        schedule: schedule as any,
      },
      update: {
        schedule: schedule as any,
      },
    });

    // Write daily plan to unified memory
    if (this.memoryManager) {
      const scheduleDescription = schedule
        .map((s: any, i: number) => `${i + 1}. ${s.activity} at ${s.location}`)
        .join("; ");
      await this.memoryManager.add({
        npcId: npc.id,
        sessionId,
        moduleId,
        type: "plan",
        content: `Today's plan: ${scheduleDescription}`,
        gameDay,
        gameTime: state.timeOfDay,
        metadata: { planType: "daily" as const },
      });
    }
  }

  async generateDetailedNodes(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    npcId: string,
    gameDay: number,
    language: string = "en",
    registry?: GameEngineRegistry
  ): Promise<PlanNode[]> {
    const state = dgsm.getState();
    const npc = state.npcCharacters.find((n) => n.id === npcId);
    if (!npc) return [];

    const plan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    const schedule = (plan?.schedule as unknown as ScheduleEntry[]) ?? [];
    if (schedule.length === 0) return [];

    const longTermIntent = await this.getLongTermIntent(sessionId, npcId);
    const memoryLog = await this.getNpcDayMemoryLog(sessionId, npcId, gameDay);

    const currentLocation = state.npcLocations[npcId] ?? "";
    const currentScene = currentLocation ? state.scenes.get(currentLocation) ?? null : null;
    const sceneDescription = currentScene?.description ?? "";
    const sceneItems = formatSceneItems(currentScene);
    const sceneConditions = currentScene
      ? dgsm.getSceneConditions(currentScene.id).map((c) => `- ${c.description}`).join("\n")
      : "";
    const worldStatePrompt = this.buildNpcWorldStatePrompt(dgsm, npcId, currentLocation, registry);

    // NPCs at current location with relationship info
    const relationshipGraph = state.npcRelationshipGraph[npcId] ?? {};
    const npcsAtLocation = state.npcCharacters
      .filter((n) => n.id !== npcId && state.npcLocations[n.id] === currentLocation)
      .map((n) => {
        const parts = [`- ${n.name} (${n.id})`];
        if (n.appearance) parts.push(`appearance: ${n.appearance}`);
        const rel = relationshipGraph[n.id];
        if (rel) parts.push(`relationship: score=${rel.score} (${rel.note})`);
        return parts.join(" | ");
      })
      .join("\n");

    const npcInventory = formatItemList(dgsm.getNpcInventory(npcId));

    const { systemPrompt, userPrompt } = buildDetailedNodesPrompt({
      npcName: npc.name,
      npcId: npc.id,
      npcProfile: this.formatNpcProfile(npc),
      longTermIntent,
      memoryLog,
      todayPlan: schedule,
      currentLocation,
      sceneDescription,
      sceneItems,
      sceneNpcs: npcsAtLocation,
      sceneConditions,
      worldStatePrompt,
      npcInventory,
      currentTime: state.timeOfDay,
      gameDay,
      language,
      handlerPrompt: registry?.buildHandlerPrompt(),
      planningPrompt: registry?.buildPlanningPrompt(),
      outputSchemaPrompt: registry?.buildOutputSchemaPrompt({
        isPlayer: false,
        extraInstructions: "Use the current time as the starting gameTime.",
      }),
    });

    const response = await generateText({
      runtime: this.runtime,
      context: userPrompt,
      customSystemPrompt: systemPrompt,
      modelClass: ModelClass.MEDIUM,
    });

    const rawNodes = parseJsonResponse<any[]>(response);
    const enrichedNodes: PlanNode[] = rawNodes.map((node) => ({
      ...node,
      nodeId: node.nodeId || randomUUID(),
      characterId: npcId,
      characterName: npc.name,
      status: "pending" as const,
    }));

    // Append new nodes to existing nodes in DB
    const existingPlan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    const existingNodes = (existingPlan?.nodes as unknown as PlanNode[]) ?? [];
    const mergedNodes = [...existingNodes, ...enrichedNodes];

    await this.prisma.npcDailyPlan.update({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
      data: { nodes: mergedNodes as any },
    });

    return enrichedNodes;
  }

  async ensureNpcNodesAvailable(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    npcId: string,
    gameDay: number,
    currentTime: string,
    language: string = "en",
    registry?: GameEngineRegistry
  ): Promise<void> {
    const pendingNodes = await this.getPendingNodes(sessionId, npcId, gameDay);
    if (pendingNodes.length > 0) return; // Already has nodes, nothing to do

    // Check if schedule exists for today — generate one if missing
    const plan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    if (!plan?.schedule || (plan.schedule as unknown as any[]).length === 0) {
      // Need moduleId — look it up from an existing plan or long-term intent
      const existingPlan = await this.prisma.npcDailyPlan.findFirst({
        where: { sessionId },
        select: { moduleId: true },
      });
      const moduleId = existingPlan?.moduleId ?? (await this.prisma.npcLongTermIntent.findFirst({
        where: { sessionId },
        select: { moduleId: true },
      }))?.moduleId;
      if (moduleId) {
        // Seed long-term intent from module data if missing
        const hasIntent = await this.getLongTermIntent(sessionId, npcId);
        if (!hasIntent) {
          await this.seedLongTermIntents(dgsm, sessionId, moduleId);
        }
        await this.generateSingleNpcSchedule(dgsm, sessionId, moduleId, npcId, gameDay, language, registry);
      }
    }

    const refreshedPlan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
      select: { schedule: true },
    });
    const schedule = (refreshedPlan?.schedule as unknown as ScheduleEntry[]) ?? [];
    if (schedule.length === 0) return; // No more schedule entries for today

    await this.generateDetailedNodes(dgsm, sessionId, npcId, gameDay, language, registry);
  }

  async reviseSchedule(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    npcId: string,
    triggerDescription: string,
    language: string = "en",
    registry?: GameEngineRegistry
  ): Promise<void> {
    const state = dgsm.getState();
    const npc = state.npcCharacters.find((n) => n.id === npcId);
    if (!npc) return;

    const gameDay = state.gameDay;
    const plan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    if (!plan?.schedule) return;

    const schedule = plan.schedule as unknown as ScheduleEntry[];
    if (schedule.length === 0) return;

    // Always fetch longTermIntent (same as normal Layer 1)
    const longTermIntent = await this.getLongTermIntent(sessionId, npcId);

    // Use unified memory with reaction purpose (event-focused retrieval)
    let memoryContext: string | undefined;
    if (this.memoryManager) {
      memoryContext = await this.memoryManager.getContext({
        npcId,
        sessionId,
        purpose: "reaction",
        query: triggerDescription,
        currentGameDay: gameDay,
      });
    }

    const npcLocation = state.npcLocations[npcId];

    const { systemPrompt, userPrompt } = buildReviseSchedulePrompt({
      npcName: npc.name,
      npcId: npc.id,
      npcProfile: this.formatNpcProfile(npc),
      longTermIntent,
      memoryContext: memoryContext ?? "",
      relationships: this.formatRelationships(dgsm, npcId),
      sceneMap: this.formatSceneMap(dgsm, npcId),
      scenarioConditions: this.formatNpcLocalConditions(dgsm, npcLocation),
      worldStatePrompt: this.buildNpcWorldStatePrompt(dgsm, npcId, npcLocation, registry),
      remainingSchedule: JSON.stringify(schedule, null, 2),
      triggerDescription,
      gameDay,
      currentTime: state.timeOfDay,
      language,
    });

    const response = await generateText({
      runtime: this.runtime,
      context: userPrompt,
      customSystemPrompt: systemPrompt,
      modelClass: ModelClass.MEDIUM,
    });

    const parsed = parseJsonResponse<{
      revisedSchedule: ScheduleEntry[];
      shouldUpdateLongTermIntent: boolean;
      updatedLongTermIntent?: string;
    }>(response);

    await this.prisma.npcDailyPlan.update({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
      data: { schedule: parsed.revisedSchedule as any },
    });

    if (parsed.shouldUpdateLongTermIntent && parsed.updatedLongTermIntent) {
      await this.prisma.npcLongTermIntent.updateMany({
        where: { sessionId, npcId },
        data: { intent: parsed.updatedLongTermIntent },
      });
    }
  }

  async revisePlans(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    npcId: string,
    context: RevisePlansContext,
    language: string = "en",
    registry?: GameEngineRegistry
  ): Promise<void> {
    const state = dgsm.getState();
    const npc = state.npcCharacters.find((n) => n.id === npcId);
    if (!npc) return;

    const triggerDescription =
      context.trigger.type === "failure"
        ? `Action "${context.trigger.action}" at ${context.trigger.gameTime} failed: ${context.trigger.failureReason}`
        : `Witnessed: ${context.trigger.triggeringAction.action} by ${context.trigger.triggeringAction.characterName} (${context.trigger.triggeringAction.outcome})`;

    const currentLocation = state.npcLocations[npcId] ?? "";
    const currentScene = currentLocation ? state.scenes.get(currentLocation) ?? null : null;
    const plan = await this.getDailyPlan(sessionId, npcId, state.gameDay);
    const schedule = (plan?.schedule as unknown as ScheduleEntry[]) ?? [];

    const relationshipGraph = state.npcRelationshipGraph[npcId] ?? {};
    const npcsAtLocation = state.npcCharacters
      .filter((n) => n.id !== npcId && state.npcLocations[n.id] === currentLocation)
      .map((n) => {
        const parts = [`- ${n.name} (${n.id})`];
        if (n.appearance) parts.push(`appearance: ${n.appearance}`);
        const rel = relationshipGraph[n.id];
        if (rel) parts.push(`relationship: score=${rel.score} (${rel.note})`);
        return parts.join(" | ");
      })
      .join("\n");

    const { systemPrompt, userPrompt } = buildRevisePlansPrompt({
      npcName: npc.name,
      npcId: npc.id,
      npcProfile: this.formatNpcProfile(npc),
      longTermIntent: context.longTermIntent,
      memoryLog: context.memoryLog.join("\n"),
      todayPlan: schedule,
      pendingNodes: JSON.stringify(context.pendingNodes, null, 2),
      triggerDescription,
      currentLocation,
      sceneDescription: currentScene?.description ?? "",
      sceneItems: formatSceneItems(currentScene),
      sceneNpcs: npcsAtLocation,
      sceneConditions: currentScene
        ? dgsm.getSceneConditions(currentScene.id).map((c) => `- ${c.description}`).join("\n")
        : "",
      worldStatePrompt: this.buildNpcWorldStatePrompt(dgsm, npcId, currentLocation, registry),
      npcInventory: formatItemList(dgsm.getNpcInventory(npcId)),
      currentTime: state.timeOfDay,
      gameDay: state.gameDay,
      language,
      handlerPrompt: registry?.buildHandlerPrompt(),
      planningPrompt: registry?.buildPlanningPrompt(),
      outputSchemaPrompt: registry?.buildOutputSchemaPrompt({
        isPlayer: false,
        extraInstructions: "Revise pending actions. Only change what the event actually affects.",
      }),
    });

    const response = await generateText({
      runtime: this.runtime,
      context: userPrompt,
      customSystemPrompt: systemPrompt,
      modelClass: ModelClass.MEDIUM,
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
      todayScheduleSummary: string;
      currentDetailedPlan: string;
      triggeringEvents: string;
      memoryContext?: string;
    },
    bucketTime: string,
    language: string = "en"
  ): Promise<{ shouldRevise: boolean; shouldReviseSchedule: boolean; witnessEntry: string }> {
    const { systemPrompt, userPrompt } = buildImpactGatePrompt({
      bucketTime,
      candidate,
      language,
    });

    const response = await generateText({
      runtime: this.runtime,
      context: userPrompt,
      customSystemPrompt: systemPrompt,
      modelClass: ModelClass.SMALL,
    });

    return parseJsonResponse<{ shouldRevise: boolean; shouldReviseSchedule: boolean; witnessEntry: string }>(response);
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


  async getDailyPlan(sessionId: string, npcId: string, gameDay: number) {
    return this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
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

  // === Day transition lifecycle ===

  async onNewDay(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    moduleId: string,
    gameDay: number,
    language: string = "en",
    registry?: GameEngineRegistry
  ): Promise<void> {
    const previousDay = gameDay - 1;

    // 1. Summarize previous day's memory for all NPCs (parallel)
    if (previousDay >= 1) {
      await this.summarizeAllNpcDayMemory(dgsm, sessionId, previousDay, language);
    }

    // 1b. After summarization, trigger day_transition reasoning for all NPCs
    if (this.memoryManager && previousDay >= 1) {
      const generateTextFn = (prompt: string) =>
        generateText({ runtime: this.runtime, context: prompt, modelClass: ModelClass.SMALL });

      const npcCharacters = dgsm.getState().npcCharacters;
      const reasoningPromises = npcCharacters.map((npc) =>
        this.memoryManager!.triggerReasoning(
          {
            npcId: npc.id,
            sessionId,
            moduleId,
            trigger: "day_transition" as const,
            context: "End of day review",
            gameDay: previousDay,
            gameTime: "23:59",
          },
          npc.name,
          npc.background ?? npc.backstory ?? "",
          generateTextFn,
          language,
        ),
      );
      await Promise.all(reasoningPromises);
    }

    // 2. Generate daily schedules for all NPCs (includes long-term intent check via ensureNpc path)
    await this.generateDailySchedule(dgsm, sessionId, moduleId, gameDay, language, registry);

    console.log(`[NPCPlanning] Day ${gameDay} lifecycle complete: summarized day ${previousDay}, generated schedules`);
  }

  private async summarizeAllNpcDayMemory(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    gameDay: number,
    language: string
  ): Promise<void> {
    const npcs = dgsm.getState().npcCharacters;
    await Promise.all(
      npcs.map((npc) => this.summarizeDayMemory(dgsm, sessionId, npc.id, gameDay, language))
    );
  }

  private async summarizeDayMemory(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    npcId: string,
    gameDay: number,
    language: string
  ): Promise<void> {
    // Requires memoryManager — skip summarization if absent
    if (!this.memoryManager) return;

    // Fetch ALL memories from this day — no semantic filtering, no type restriction
    const dayMemories = await this.memoryManager.getAllForDay(npcId, sessionId, gameDay);
    if (dayMemories.length === 0) return;

    const { getAllHandlers } = await import("../../memory/handlers/index.js");
    const handlers = getAllHandlers();
    const state = dgsm.getState();

    // Format events
    const eventLog = dayMemories.map((m) => handlers[m.type].format(m)).join("\n");

    // Collect knowledge received today (resolve relatedKnowledgeIds from sender NPCs)
    const receivedKnowledge: Array<{ id: string; text: string; category: string; from: string }> = [];
    for (const m of dayMemories) {
      const meta = m.metadata as Record<string, any> | null;
      if (!meta?.relatedKnowledgeIds?.length || !meta?.sourceCharacterId) continue;
      const senderNpc = state.npcCharacters.find(n => n.id === meta.sourceCharacterId);
      if (!senderNpc?.knowledge) continue;
      for (const kid of meta.relatedKnowledgeIds as string[]) {
        const k = senderNpc.knowledge.find(k => k.id === kid);
        if (k && !receivedKnowledge.some(r => r.id === k.id)) {
          receivedKnowledge.push({ id: k.id, text: k.text, category: k.category ?? "knowledge", from: senderNpc.name });
        }
      }
    }

    const npc = state.npcCharacters.find((n) => n.id === npcId);
    if (!npc) return;

    const existingKnowledgeIds = (npc.knowledge ?? []).map((k) => k.id);

    const { systemPrompt, userPrompt } = buildSummarizeDayMemoryPrompt({
      npcName: npc.name,
      npcProfile: this.formatNpcProfile(npc),
      gameDay,
      eventLog,
      receivedKnowledge,
      existingKnowledgeIds,
      language,
    });

    const response = await generateText({
      runtime: this.runtime,
      context: userPrompt,
      customSystemPrompt: systemPrompt,
      modelClass: ModelClass.SMALL,
    });

    const parsed = parseJsonResponse<{
      memories: Array<{ content: string; importance: number }>;
      newKnowledge?: Array<{ id: string; text: string; category?: string; difficulty?: string; relatedTo?: string[] }>;
    }>(response);

    const moduleId = await this.resolveModuleId(sessionId) ?? "";

    // Write each summary memory as a separate record with its own importance
    await Promise.all(
      parsed.memories.map((m) =>
        this.memoryManager!.add({
          npcId,
          sessionId,
          moduleId,
          type: "summary",
          content: m.content,
          gameDay,
          gameTime: "23:59",
          metadata: { gameDay, importance: m.importance },
        })
      )
    );

    // Add extracted knowledge and secrets to NPC profile
    if (parsed.newKnowledge?.length) {
      const npcRef = state.npcCharacters.find((n) => n.id === npcId);
      for (const k of parsed.newKnowledge) {
        if (k.category === "secret") {
          if (npcRef) {
            if (!npcRef.secrets) npcRef.secrets = [];
            if (!npcRef.secrets.includes(k.text)) npcRef.secrets.push(k.text);
          }
        } else {
          dgsm.addNpcKnowledge(npcId, {
            id: k.id,
            text: k.text,
            category: "knowledge",
            difficulty: (k.difficulty as "automatic" | "regular" | "hard" | "extreme") ?? "automatic",
            revealed: false,
            relatedTo: k.relatedTo,
          });
        }
      }
    }
  }

  private async getNpcDayMemoryLog(
    sessionId: string,
    npcId: string,
    gameDay: number,
  ): Promise<string> {
    if (!this.memoryManager) return "";

    const dayMemories = await this.memoryManager.getAllForDay(npcId, sessionId, gameDay);
    const memories = [...dayMemories]
      // Daily plan memories duplicate todayPlan and can confuse completion inference.
      .filter((memory) => memory.type !== "plan")
      .sort((a, b) => {
        const timeCompare = (a.gameTime ?? "").localeCompare(b.gameTime ?? "");
        if (timeCompare !== 0) return timeCompare;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

    if (memories.length === 0) return "";

    const { getAllHandlers } = await import("../../memory/handlers/index.js");
    const handlers = getAllHandlers();
    return memories.map((memory) => handlers[memory.type].format(memory)).join("\n");
  }

  async resolveModuleId(sessionId: string): Promise<string | null> {
    const plan = await this.prisma.npcDailyPlan.findFirst({
      where: { sessionId },
      select: { moduleId: true },
    });
    if (plan) return plan.moduleId;
    const intent = await this.prisma.npcLongTermIntent.findFirst({
      where: { sessionId },
      select: { moduleId: true },
    });
    return intent?.moduleId ?? null;
  }


  // === Private helpers ===

  private formatNpcProfile(npc: any): string {
    const parts = [`Name: ${npc.name}`];
    if (npc.occupation) parts.push(`Occupation: ${npc.occupation}`);
    if (npc.personality) parts.push(`Personality: ${npc.personality}`);
    if (npc.background) parts.push(`Background: ${npc.background}`);
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

  private formatSceneMap(dgsm: DynamicGameStateManager, npcId: string): string {
    return formatSceneMap(dgsm, npcId);
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

  /**
   * Format scenario conditions for only the NPC's current scene
   * (and sibling scenes under the same macro location).
   */
  private formatNpcLocalConditions(dgsm: DynamicGameStateManager, npcLocation?: string): string {
    if (!npcLocation) return "";
    const state = dgsm.getState();
    const conds = state.scenarioConditions;
    const currentScene = state.scenes.get(npcLocation);
    if (!currentScene) return "";

    // Collect current scene + sibling scenes under same parent location
    const relevantSceneIds = new Set<string>([currentScene.id]);
    for (const [id, scene] of state.scenes) {
      if (scene.parentLocationId === currentScene.parentLocationId) {
        relevantSceneIds.add(id);
      }
    }

    const entries = Object.entries(conds)
      .filter(([scenarioId]) => relevantSceneIds.has(scenarioId));
    if (entries.length === 0) return "";
    return entries
      .map(([scenarioId, conditions]) =>
        `${scenarioId}: ${conditions.map((c) => c.description).join("; ")}`)
      .join("\n");
  }

  /**
   * Build a filtered world state prompt for a specific NPC.
   * - Weather: always included (global)
   * - Fire: only fires whose light reaches the NPC's current scene
   * - Stamina/Sanity: only this NPC's state
   */
  private buildNpcWorldStatePrompt(
    dgsm: DynamicGameStateManager,
    npcId: string,
    npcLocation?: string,
    registry?: GameEngineRegistry
  ): string {
    if (!registry) return "";
    const sections: string[] = [];

    // Weather — global, always include
    const weatherFeature = registry.getFeature("weather");
    if (weatherFeature) {
      const weatherState = weatherFeature.stateDescription(dgsm);
      if (weatherState) sections.push(weatherState);
    }

    // Fire — only fires the NPC can perceive (fire light reach)
    if (npcLocation) {
      const fireDesc = this.buildPerceivedFireState(dgsm, npcLocation);
      if (fireDesc) sections.push(fireDesc);
    }

    // Stamina — only this NPC's fatigue
    const staminaStates = dgsm.getFeatureState("stamina") as Record<string, { fatigueLevel?: number; minutesSinceLastRest?: number }> | undefined;
    if (staminaStates?.[npcId]) {
      const stamina = staminaStates[npcId];
      if (stamina.fatigueLevel && stamina.fatigueLevel > 0) {
        const hours = ((stamina.minutesSinceLastRest ?? 0) / 60).toFixed(1);
        const label = stamina.fatigueLevel === 1 ? "Tired" : "Exhausted";
        sections.push(`Fatigue: ${label} (${hours}h active)`);
      }
    }

    // Sanity — only this NPC's active insanity
    const sanityStates = dgsm.getFeatureState("sanity") as Record<string, { activeInsanity?: { isActive?: boolean; insanityType?: string; boutType?: string; description?: string; actionRestriction?: string } }> | undefined;
    if (sanityStates?.[npcId]) {
      const sanity = sanityStates[npcId];
      if (sanity.activeInsanity?.isActive) {
        const ai = sanity.activeInsanity;
        sections.push(`Active insanity: ${ai.insanityType} (${ai.boutType}) — ${ai.description} | restriction: ${ai.actionRestriction}`);
      }
    }

    if (sections.length === 0) return "";
    return "## World Conditions\n\n" + sections.join("\n") + "\n";
  }

  /**
   * Determine which fires the NPC can perceive based on fire light coverage.
   * A fire is perceivable if its light reaches the NPC's current scene:
   * - Fire is at the NPC's scene → directly perceivable
   * - Fire intensity >= 3 and NPC is at an adjacent scene (topology neighbor or connection) → perceivable via light
   */
  private buildPerceivedFireState(dgsm: DynamicGameStateManager, npcLocation: string): string {
    const fireStates = dgsm.getFeatureState("fire");
    if (!fireStates || Object.keys(fireStates).length === 0) return "";

    const topology = dgsm.getTopology();

    // Build set of scenes whose fire light reaches the NPC
    const perceivedFires: Array<{ sceneId: string; intensity: number; label: string }> = [];
    const INTENSITY_LABELS = ["", "Smoldering", "Small Fire", "Burning", "Blazing", "Inferno"];

    for (const [fireSceneId, state] of Object.entries(fireStates)) {
      const fs = state as { intensity: number; phase?: string } | undefined;
      if (!fs || fs.intensity <= 0) continue;

      // Direct: fire is at NPC's scene
      if (fireSceneId === npcLocation) {
        perceivedFires.push({
          sceneId: fireSceneId,
          intensity: fs.intensity,
          label: INTENSITY_LABELS[fs.intensity] ?? INTENSITY_LABELS[5],
        });
        continue;
      }

      // Adjacent: fire intense enough (>=3) to cast light to neighbors
      if (fs.intensity >= 3) {
        let isAdjacent = false;
        if (topology) {
          const neighbors = getTopologyNeighbors(fireSceneId, topology);
          isAdjacent = neighbors.includes(npcLocation);
        } else {
          const fireScene = dgsm.getScene(fireSceneId);
          isAdjacent = fireScene?.connections.includes(npcLocation) ?? false;
        }
        if (isAdjacent) {
          perceivedFires.push({
            sceneId: fireSceneId,
            intensity: fs.intensity,
            label: INTENSITY_LABELS[fs.intensity] ?? INTENSITY_LABELS[5],
          });
        }
      }
    }

    if (perceivedFires.length === 0) return "";
    const lines = perceivedFires.map((f) =>
      f.sceneId === npcLocation
        ? `- ${f.sceneId}: intensity ${f.intensity}/5 (${f.label}) — HERE`
        : `- ${f.sceneId}: intensity ${f.intensity}/5 (${f.label}) — visible from current location`
    );
    return "Nearby fires:\n" + lines.join("\n");
  }
}
