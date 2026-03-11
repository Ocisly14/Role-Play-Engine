import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { generateText, ModelClass } from "../../../models/index.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  buildGenerateLongTermIntentPrompt,
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

    const longTermIntent = await this.getLongTermIntent(sessionId, npc.id);
    const daySummaries = await this.getDaySummaries(sessionId, npc.id);
    const todayLog = await this.getMemoryLog(sessionId, npc.id, gameDay);
    const npcProfile = this.formatNpcProfile(npc);
    const relationships = this.formatRelationships(dgsm, npc.id);
    const sceneMap = this.formatSceneMap(dgsm, npc.id);
    const npcLocation = state.npcLocations[npc.id];
    const scenarioConditions = this.formatNpcLocalConditions(dgsm, npcLocation);
    const worldStatePrompt = this.buildNpcWorldStatePrompt(dgsm, npc.id, npcLocation, registry);

    const prompt = buildDailySchedulePrompt({
      npcName: npc.name,
      npcId: npc.id,
      npcProfile,
      longTermIntent,
      memorySummary: daySummaries.join("\n"),
      todayLog: todayLog.join("\n"),
      relationships,
      sceneMap,
      scenarioConditions,
      worldStatePrompt,
      gameDay,
      currentTime: state.timeOfDay,
      language,
    });

    const response = await generateText({
      runtime: this.runtime,
      context: prompt,
      modelClass: ModelClass.SMALL,
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
  }

  async consumeNextScheduleEntry(
    sessionId: string,
    npcId: string,
    gameDay: number,
    currentTime: string
  ): Promise<ScheduleEntry | null> {
    const plan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    if (!plan?.schedule) return null;

    const schedule = plan.schedule as unknown as ScheduleEntry[];
    // Find next entry at or after current time
    const idx = schedule.findIndex((e) => e.time >= currentTime);
    if (idx === -1) return null;

    const entry = schedule[idx];
    // Remove consumed entry
    const remaining = [...schedule.slice(0, idx), ...schedule.slice(idx + 1)];
    await this.prisma.npcDailyPlan.update({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
      data: { schedule: remaining as any },
    });

    return entry;
  }

  async generateDetailedNodes(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    npcId: string,
    entry: ScheduleEntry,
    gameDay: number,
    language: string = "en",
    registry?: GameEngineRegistry
  ): Promise<PlanNode[]> {
    const state = dgsm.getState();
    const npc = state.npcCharacters.find((n) => n.id === npcId);
    if (!npc) return [];

    const longTermIntent = await this.getLongTermIntent(sessionId, npcId);
    const memoryLog = await this.getMemoryLog(sessionId, npcId, gameDay);

    // Get scene context for the target location
    const targetScene = state.scenes.get(entry.location) ?? null;
    const sceneDescription = targetScene?.description ?? "";
    const sceneItems = formatSceneItems(targetScene);
    const sceneConditions = targetScene
      ? dgsm.getSceneConditions(targetScene.id).map((c) => `- ${c.description}`).join("\n")
      : "";
    const worldStatePrompt = this.buildNpcWorldStatePrompt(dgsm, npcId, entry.location, registry);

    // NPCs at target location
    const npcsAtLocation = state.npcCharacters
      .filter((n) => n.id !== npcId && state.npcLocations[n.id] === entry.location)
      .map((n) => `- ${n.name} (${n.id})`)
      .join("\n");

    const npcInventory = formatItemList(dgsm.getNpcInventory(npcId));

    const prompt = buildDetailedNodesPrompt({
      npcName: npc.name,
      npcId: npc.id,
      npcProfile: this.formatNpcProfile(npc),
      longTermIntent,
      memoryLog: memoryLog.join("\n"),
      scheduleEntry: entry,
      sceneDescription,
      sceneItems,
      sceneNpcs: npcsAtLocation,
      sceneConditions,
      worldStatePrompt,
      npcInventory,
      currentTime: entry.time,
      gameDay,
      language,
      handlerPrompt: registry?.buildHandlerPrompt(),
      planningPrompt: registry?.buildPlanningPrompt(),
      outputSchemaPrompt: registry?.buildOutputSchemaPrompt({
        isPlayer: false,
        extraInstructions: "Use the schedule entry time as the starting gameTime.",
      }),
    });

    const response = await generateText({
      runtime: this.runtime,
      context: prompt,
      modelClass: ModelClass.SMALL,
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
    const plan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    const existingNodes = (plan?.nodes as unknown as PlanNode[]) ?? [];
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
        // Generate long-term intent if missing
        const hasIntent = await this.getLongTermIntent(sessionId, npcId);
        if (!hasIntent) {
          await this.generateLongTermIntents(dgsm, sessionId, moduleId, language);
        }
        await this.generateSingleNpcSchedule(dgsm, sessionId, moduleId, npcId, gameDay, language, registry);
      }
    }

    const entry = await this.consumeNextScheduleEntry(sessionId, npcId, gameDay, currentTime);
    if (!entry) return; // No more schedule entries for today

    await this.generateDetailedNodes(dgsm, sessionId, npcId, entry, gameDay, language, registry);
  }

  async reviseSchedule(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    npcId: string,
    triggerDescription: string,
    language: string = "en"
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

    const longTermIntent = await this.getLongTermIntent(sessionId, npcId);
    const memoryLog = await this.getMemoryLog(sessionId, npcId, gameDay);

    const prompt = buildReviseSchedulePrompt({
      npcName: npc.name,
      npcProfile: this.formatNpcProfile(npc),
      longTermIntent,
      memoryLog: memoryLog.join("\n"),
      remainingSchedule: JSON.stringify(schedule, null, 2),
      triggerDescription,
      language,
    });

    const response = await generateText({
      runtime: this.runtime,
      context: prompt,
      modelClass: ModelClass.SMALL,
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
  ): Promise<{ shouldRevise: boolean; shouldReviseSchedule: boolean; witnessEntry: string }> {
    const prompt = buildImpactGatePrompt({ bucketTime, candidate, language });

    const response = await generateText({
      runtime: this.runtime,
      context: prompt,
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
    // Check if already summarized
    const existing = await this.prisma.npcMemorySummary.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    if (existing) return;

    const rawLogs = await this.getMemoryLog(sessionId, npcId, gameDay);
    if (rawLogs.length === 0) return;

    const npc = dgsm.getState().npcCharacters.find((n) => n.id === npcId);
    if (!npc) return;

    const prompt = buildSummarizeDayMemoryPrompt({
      npcName: npc.name,
      npcProfile: this.formatNpcProfile(npc),
      gameDay,
      rawMemoryLog: rawLogs.join("\n"),
      language,
    });

    const response = await generateText({
      runtime: this.runtime,
      context: prompt,
      modelClass: ModelClass.SMALL,
    });

    const parsed = parseJsonResponse<{ summary: string }>(response);

    await this.prisma.npcMemorySummary.create({
      data: { sessionId, npcId, gameDay, summary: parsed.summary },
    });
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

  async getDaySummaries(sessionId: string, npcId: string): Promise<string[]> {
    const summaries = await this.prisma.npcMemorySummary.findMany({
      where: { sessionId, npcId },
      orderBy: { gameDay: "asc" },
    });
    return summaries.map((s) => `Day ${s.gameDay}: ${s.summary}`);
  }

  // === Private helpers ===

  private formatNpcProfile(npc: any): string {
    const parts = [`Name: ${npc.name}`];
    if (npc.occupation) parts.push(`Occupation: ${npc.occupation}`);
    if (npc.personality) parts.push(`Personality: ${npc.personality}`);
    if (npc.background) parts.push(`Background: ${npc.background}`);
    if (npc.goals?.length) parts.push(`Goals: ${npc.goals.join(", ")}`);
    if (npc.secrets?.length) parts.push(`Secrets: ${npc.secrets.join(", ")}`);
    if (npc.inventory?.length) {
      parts.push(`Inventory:\n${formatItemList(npc.inventory)}`);
    }
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
