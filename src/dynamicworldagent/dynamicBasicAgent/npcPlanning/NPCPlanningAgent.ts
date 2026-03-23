import { randomUUID } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { ModelClass, generateText } from "../../../models/index.js";
import type { GameEngineRegistry } from "../../engine/registry.js";
import {
  arePositionsCoLocated,
  describePrecisePosition,
} from "../../engine/shared/locationPresence.js";
import { getTopologyNeighbors } from "../../engine/shared/topologyHelpers.js";
import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { formatItemList, formatSceneItems } from "./itemFormatHelpers.js";
import {
  buildDailySchedulePrompt,
  buildDetailedNodesPrompt,
  buildImpactGatePrompt,
  buildRelationshipUpdatePrompt,
  buildRevisePlansPrompt,
  buildReviseSchedulePrompt,
  buildSummarizeDayMemoryPrompt,
} from "./npcPlanningTemplates.js";
import {
  buildLocationNameMap,
  formatSceneConnections,
  formatSceneMap,
  resolveLocationId as resolveLocationFromName,
  resolveLocationName,
} from "./sceneMapFormatter.js";
import {
  buildInterruptedAction,
  mergeRevisedNodesWithHistory,
} from "./revisionHelpers.js";
import type {
  PlanNode,
  RevisePlansContext,
  RevisePlansResult,
  ScheduleEntry,
} from "./types.js";

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTimeLabel(minutes: number): string {
  const clamped = Math.max(0, Math.min(1439, minutes));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function resolveCurrentNode(
  nodes: PlanNode[],
  currentTime: string
): PlanNode | null {
  const inProgressNode =
    nodes
      .filter((node) => node.status === "in_progress")
      .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime))[0] ??
    null;
  if (inProgressNode) return inProgressNode;

  const duePendingNode =
    nodes
      .filter(
        (node) =>
          node.status === "pending" &&
          timeToMinutes(node.startTime) <= timeToMinutes(currentTime)
      )
      .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime))[0] ??
    null;

  return duePendingNode;
}

function getDefaultNodeDurationMinutes(type: string): number {
  switch (type) {
    case "scene_interaction":
    case "object_interaction":
      return 10;
    case "routine":
    case "movement":
    case "character_interaction":
    default:
      return 5;
  }
}

function normalizeNodeTimeRange(
  rawNode: Record<string, unknown>,
  fallbackStartTime: string
): { startTime: string; endTime: string; remainingMinutes: number } {
  const rawStart =
    (typeof rawNode.startTime === "string" && rawNode.startTime) ||
    fallbackStartTime;
  let rawEnd =
    (typeof rawNode.endTime === "string" && rawNode.endTime) || undefined;

  if (!rawEnd) {
    const baseMinutes = timeToMinutes(rawStart);
    rawEnd = minutesToTimeLabel(
      baseMinutes +
        getDefaultNodeDurationMinutes(
          typeof rawNode.type === "string" ? rawNode.type : "routine"
        )
    );
  }

  let remainingMinutes = timeToMinutes(rawEnd) - timeToMinutes(rawStart);
  if (remainingMinutes <= 0) {
    remainingMinutes = getDefaultNodeDurationMinutes(
      typeof rawNode.type === "string" ? rawNode.type : "routine"
    );
    rawEnd = minutesToTimeLabel(timeToMinutes(rawStart) + remainingMinutes);
  }

  return {
    startTime: rawStart,
    endTime: rawEnd,
    remainingMinutes,
  };
}

/**
 * Build a summary of sibling sub-scenes in the same building.
 * Returns name + description for each room the NPC is NOT currently in,
 * or empty string if the NPC is outdoors or the building has only one room.
 */
function buildBuildingContext(
  dgsm: DynamicGameStateManager,
  currentSceneId: string
): string {
  const state = dgsm.getState();
  const currentScene = state.scenes.get(currentSceneId);
  if (!currentScene) return "";

  const parentId = currentScene.parentLocationId;
  if (!parentId || parentId === "OUTDOOR") return "";

  const siblings: { name: string; description: string }[] = [];
  for (const [id, scene] of state.scenes) {
    if (id === currentSceneId) continue;
    if (scene.parentLocationId === parentId) {
      siblings.push({ name: scene.name, description: scene.description });
    }
  }

  if (siblings.length === 0) return "";
  return siblings
    .map((s) => `- **${s.name}**: ${s.description}`)
    .join("\n");
}

function normalizePlanNode(
  rawNode: Record<string, unknown>,
  params: {
    npcId: string;
    npcName: string;
    locationId: string;
    fallbackStartTime: string;
  }
): PlanNode {
  const { startTime, endTime, remainingMinutes } = normalizeNodeTimeRange(
    rawNode,
    params.fallbackStartTime
  );

  return {
    ...rawNode,
    nodeId:
      (typeof rawNode.nodeId === "string" && rawNode.nodeId) || randomUUID(),
    characterId: params.npcId,
    characterName: params.npcName,
    location: params.locationId,
    startTime,
    endTime,
    status: "pending",
    executionMeta: {
      remainingMinutes,
    },
  } as PlanNode;
}

function repairJson(text: string): string {
  // Remove trailing commas before } or ]
  text = text.replace(/,\s*([}\]])/g, "$1");

  // Fix unescaped newlines inside JSON string values
  text = text.replace(
    /"(?:[^"\\]|\\.)*"/g,
    (match) => match.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
  );

  // Try to close truncated JSON by balancing braces/brackets
  let inString = false;
  let escape = false;
  const stack: string[] = [];
  for (const ch of text) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  // Close any unclosed structures
  while (stack.length > 0) text += stack.pop();

  return text;
}

function parseJsonResponse<T>(raw: string): T {
  let text = raw.trim();
  // Strip markdown fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  // Fix invalid JSON escape sequences (e.g. \$ \' \. etc.) produced by LLMs
  text = text.replace(/\\([^"\\\/bfnrtu])/g, "$1");
  try {
    return JSON.parse(text) as T;
  } catch {
    // Attempt repair on malformed LLM output
    const repaired = repairJson(text);
    return JSON.parse(repaired) as T;
  }
}

/**
 * Extract revisedNodes array from various LLM response shapes:
 * - { revisedNodes: [...] }         → return revisedNodes
 * - { revisedNodes: { ... } }       → wrap in array
 * - [ ... ]  (raw array)            → return as-is
 * - { nodes: [...] }                → return nodes (common LLM alias)
 */
function extractRevisedNodes(parsed: unknown): PlanNode[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.revisedNodes)) return obj.revisedNodes as PlanNode[];
    if (
      obj.revisedNodes &&
      typeof obj.revisedNodes === "object" &&
      !Array.isArray(obj.revisedNodes)
    ) {
      return [obj.revisedNodes as PlanNode];
    }
    if (Array.isArray(obj.nodes)) return obj.nodes as PlanNode[];
  }
  return null;
}

function formatPlanNodesForLog(
  dgsm: DynamicGameStateManager,
  nodes: PlanNode[]
): string {
  if (nodes.length === 0) return "(no nodes)";

  return nodes
    .map(
      (node) =>
        `- [${node.startTime}-${node.endTime}] ${node.type} @ ${resolveLocationName(
          dgsm,
          node.location
        )}: ${node.action}`
    )
    .join("\n");
}

function buildImpactTriggerDescription(
  npcId: string,
  trigger: import("./types.js").ImpactTrigger
): string {
  const action = trigger.triggeringAction;

  if (action.characterId === "__encounter__") {
    return `Encountered others in person: ${action.outcome}`;
  }

  if (action.targetCharacterIds?.includes(npcId)) {
    return `You were directly involved: ${action.characterName} targeted you with "${action.action}" (${action.outcome})`;
  }

  return `You noticed ${action.characterName} ${action.action.toLowerCase()} (${action.outcome})`;
}

function buildFailureTriggerDescription(
  trigger: import("./types.js").FailureTrigger
): string {
  return `Action "${trigger.action}" at ${trigger.gameTime} failed with ${trigger.failureReason}.`;
}

export class NPCPlanningAgent {
  constructor(
    private prisma: PrismaClient,
    private runtime: any,
    private memoryManager?: NpcMemoryManager
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
    moduleId: string
  ): Promise<void> {
    const npcs = dgsm.getSimulatedNpcs();

    await Promise.all(
      npcs.map(async (npc) => {
        const intent = npc.longTermIntent;

        await this.prisma.npcLongTermIntent.upsert({
          where: {
            sessionId_npcId: { sessionId, npcId: npc.id },
          },
          create: {
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
    language = "en",
    registry?: GameEngineRegistry
  ): Promise<void> {
    // Delegate to two-tier schedule generation
    await this.generateDailySchedule(
      dgsm,
      sessionId,
      moduleId,
      gameDay,
      language,
      registry
    );
  }

  async generateDailySchedule(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    moduleId: string,
    gameDay: number,
    language = "en",
    registry?: GameEngineRegistry
  ): Promise<void> {
    const npcs = dgsm.getSimulatedNpcs();

    await Promise.all(
      npcs.map(async (npc) => {
        await this.generateSingleNpcSchedule(
          dgsm,
          sessionId,
          moduleId,
          npc.id,
          gameDay,
          language,
          registry
        );
      })
    );
  }

  async generateSingleNpcSchedule(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    moduleId: string,
    npcId: string,
    gameDay: number,
    language = "en",
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
    const npcPos = dgsm.getCharacterPosition(npc.id);
    const npcLocation = npcPos ? dgsm.resolveLocationId(npcPos) : undefined;
    const scenarioConditions = this.formatNpcLocalConditions(dgsm, npcLocation);
    const worldStatePrompt = this.buildNpcWorldStatePrompt(
      dgsm,
      npc.id,
      npcLocation,
      registry
    );

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

    console.log(`[Planning] 📋 Generating daily schedule for ${npc.name}`);
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
    language = "en",
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

    const currentPos = dgsm.getCharacterPosition(npcId);
    const currentLocationId = currentPos
      ? dgsm.resolveLocationId(currentPos)
      : "";
    const currentScene = currentLocationId
      ? (state.scenes.get(currentLocationId) ?? null)
      : null;
    // Show sub-scene name (e.g. "私人书房") so the LLM knows exactly which room
    const currentLocationName = currentScene?.name
      ?? resolveLocationName(dgsm, currentLocationId);
    const sceneDescription = currentScene?.description ?? "";
    const sceneItems = formatSceneItems(currentScene);
    const sceneConditions = currentScene
      ? dgsm
          .getSceneConditions(currentScene.id)
          .map((c) => `- ${c.description}`)
          .join("\n")
      : "";
    const worldStatePrompt = this.buildNpcWorldStatePrompt(
      dgsm,
      npcId,
      currentLocationId,
      registry
    );
    const sceneMap = this.formatSceneMap(dgsm, npc.id);

    // NPCs at current location with relationship info
    const relationshipGraph = state.npcRelationshipGraph[npcId] ?? {};
    const npcsAtLocation = state.npcCharacters
      .filter((n) => {
        if (n.id === npcId) return false;
        const nPos = dgsm.getCharacterPosition(n.id);
        const nLoc = nPos ? dgsm.resolveLocationId(nPos) : undefined;
        return nLoc === currentLocationId;
      })
      .map((n) => {
        const parts = [`- ${n.name} (${n.id})`];
        if (n.appearance) parts.push(`appearance: ${n.appearance}`);
        const rel = relationshipGraph[n.id];
        if (rel) parts.push(`relationship: score=${rel.score} (${rel.note})`);
        return parts.join(" | ");
      })
      .join("\n");

    const npcInventory = formatItemList(dgsm.getNpcInventory(npcId));
    const buildingContext = currentLocationId
      ? buildBuildingContext(dgsm, currentLocationId)
      : "";
    const sceneConnections = currentScene
      ? formatSceneConnections(dgsm, currentScene)
      : "";

    const { systemPrompt, userPrompt } = buildDetailedNodesPrompt({
      npcName: npc.name,
      npcId: npc.id,
      npcProfile: this.formatNpcProfile(npc),
      longTermIntent,
      memoryLog,
      todayPlan: schedule,
      currentLocation: currentLocationName,
      sceneMap,
      sceneDescription,
      sceneItems,
      sceneNpcs: npcsAtLocation,
      sceneConditions,
      sceneConnections,
      buildingContext,
      worldStatePrompt,
      npcInventory,
      currentTime: state.timeOfDay,
      gameDay,
      language,
      handlerPrompt: registry?.buildHandlerPrompt(),
      planningPrompt: registry?.buildPlanningPrompt(),
      outputSchemaPrompt: registry?.buildOutputSchemaPrompt({
        extraInstructions:
          "Use the current time as the default startTime for the first node. Always include both startTime and endTime.",
        language,
      }),
    });

    const nextEntry = schedule[0];
    console.log(
      `[Planning] 🎯 Generating detailed nodes for ${npc.name}: "${nextEntry?.activity ?? ""}" @ ${nextEntry?.location ?? "?"}`
    );
    const response = await generateText({
      runtime: this.runtime,
      context: userPrompt,
      customSystemPrompt: systemPrompt,
      modelClass: ModelClass.MEDIUM,
    });

    const rawNodes = parseJsonResponse<any[]>(response);
    // Resolve location names to IDs
    const nameMap = buildLocationNameMap(dgsm);
    const enrichedNodes: PlanNode[] = rawNodes.map((node) => ({
      ...normalizePlanNode(node as Record<string, unknown>, {
        npcId,
        npcName: npc.name,
        locationId: resolveLocationFromName(node.location, nameMap),
        fallbackStartTime: state.timeOfDay,
      }),
    }));
    console.log(
      `[Planning] 🧩 Detailed nodes for ${npc.name}\n${formatPlanNodesForLog(
        dgsm,
        enrichedNodes
      )}`
    );

    // Append new nodes to existing nodes in DB and consume the schedule entry
    const existingPlan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    const existingNodes = (existingPlan?.nodes as unknown as PlanNode[]) ?? [];
    const mergedNodes = [...existingNodes, ...enrichedNodes];

    // Consume the first schedule entry (shift it off)
    const remainingSchedule = schedule.slice(1);

    await this.prisma.npcDailyPlan.update({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
      data: {
        nodes: mergedNodes as any,
        schedule: remainingSchedule as any,
      },
    });

    return enrichedNodes;
  }

  async ensureNpcNodesAvailable(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    npcId: string,
    gameDay: number,
    currentTime: string,
    language = "en",
    registry?: GameEngineRegistry
  ): Promise<void> {
    const openNodes = await this.getOpenNodes(sessionId, npcId, gameDay);
    if (openNodes.length > 0) return; // Already has nodes, nothing to do

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
      const moduleId =
        existingPlan?.moduleId ??
        (
          await this.prisma.npcLongTermIntent.findFirst({
            where: { sessionId },
            select: { moduleId: true },
          })
        )?.moduleId;
      if (moduleId) {
        // Seed long-term intent from module data if missing
        const hasIntent = await this.getLongTermIntent(sessionId, npcId);
        if (!hasIntent) {
          await this.seedLongTermIntents(dgsm, sessionId, moduleId);
        }
        await this.generateSingleNpcSchedule(
          dgsm,
          sessionId,
          moduleId,
          npcId,
          gameDay,
          language,
          registry
        );
      }
    }

    const refreshedPlan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
      select: { schedule: true },
    });
    const schedule =
      (refreshedPlan?.schedule as unknown as ScheduleEntry[]) ?? [];
    if (schedule.length === 0) return; // No more schedule entries for today

    await this.generateDetailedNodes(
      dgsm,
      sessionId,
      npcId,
      gameDay,
      language,
      registry
    );
  }

  async reviseSchedule(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    npcId: string,
    triggerDescription: string,
    language = "en",
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

    const revSchedPos = dgsm.getCharacterPosition(npcId);
    const npcLocation = revSchedPos
      ? dgsm.resolveLocationId(revSchedPos)
      : undefined;

    const { systemPrompt, userPrompt } = buildReviseSchedulePrompt({
      npcName: npc.name,
      npcId: npc.id,
      npcProfile: this.formatNpcProfile(npc),
      longTermIntent,
      memoryContext: memoryContext ?? "",
      relationships: this.formatRelationships(dgsm, npcId),
      sceneMap: this.formatSceneMap(dgsm, npcId),
      scenarioConditions: this.formatNpcLocalConditions(dgsm, npcLocation),
      worldStatePrompt: this.buildNpcWorldStatePrompt(
        dgsm,
        npcId,
        npcLocation,
        registry
      ),
      remainingSchedule: JSON.stringify(schedule, null, 2),
      triggerDescription,
      gameDay,
      currentTime: state.timeOfDay,
      language,
    });

    console.log(
      `[Planning] 🔄 Revising schedule for ${npc.name}: "${triggerDescription.slice(0, 60)}"`
    );
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
    language = "en",
    registry?: GameEngineRegistry
  ): Promise<RevisePlansResult> {
    const state = dgsm.getState();
    const npc = state.npcCharacters.find((n) => n.id === npcId);
    if (!npc) return {};

    const failureTrigger =
      context.trigger.type === "failure" ? context.trigger : undefined;
    const triggerDescription =
      context.trigger.type === "failure"
        ? buildFailureTriggerDescription(context.trigger)
        : buildImpactTriggerDescription(npcId, context.trigger);

    const revisePos = dgsm.getCharacterPosition(npcId);
    const currentLocationId = revisePos
      ? dgsm.resolveLocationId(revisePos)
      : "";
    const currentPositionDetail = describePrecisePosition(revisePos, dgsm);
    const currentScene = currentLocationId
      ? (state.scenes.get(currentLocationId) ?? null)
      : null;
    const currentLocationName = currentScene?.name
      ?? resolveLocationName(dgsm, currentLocationId);
    const plan = await this.getDailyPlan(sessionId, npcId, state.gameDay);
    const schedule = (plan?.schedule as unknown as ScheduleEntry[]) ?? [];
    const existingNodes = (plan?.nodes as unknown as PlanNode[]) ?? [];
    const sceneMap = this.formatSceneMap(dgsm, npcId);

    const relationshipGraph = state.npcRelationshipGraph[npcId] ?? {};
    const npcsAtLocation = state.npcCharacters
      .filter((n) => {
        if (n.id === npcId) return false;
        const nPos = dgsm.getCharacterPosition(n.id);
        return arePositionsCoLocated(revisePos, nPos, dgsm);
      })
      .map((n) => {
        const parts = [`- ${n.name} (${n.id})`];
        if (n.appearance) parts.push(`appearance: ${n.appearance}`);
        const rel = relationshipGraph[n.id];
        if (rel) parts.push(`relationship: score=${rel.score} (${rel.note})`);
        return parts.join(" | ");
      })
      .join("\n");

    // Find in_progress node that will be interrupted
    const inProgressNode = existingNodes.find(
      (n) => n.status === "in_progress"
    );

    const buildingContext = currentLocationId
      ? buildBuildingContext(dgsm, currentLocationId)
      : "";

    const { systemPrompt, userPrompt } = buildRevisePlansPrompt({
      npcName: npc.name,
      npcId: npc.id,
      npcProfile: this.formatNpcProfile(npc),
      longTermIntent: context.longTermIntent,
      memoryLog: context.memoryLog.join("\n"),
      todayPlan: schedule,
      pendingNodes: JSON.stringify(context.pendingNodes, null, 2),
      interruptedNode: inProgressNode
        ? JSON.stringify(inProgressNode, null, 2)
        : undefined,
      triggerDescription,
      currentLocation: currentLocationName,
      currentPositionDetail,
      sceneMap,
      sceneDescription: currentScene?.description ?? "",
      sceneItems: formatSceneItems(currentScene),
      sceneNpcs: npcsAtLocation,
      sceneConditions: currentScene
        ? dgsm
            .getSceneConditions(currentScene.id)
            .map((c) => `- ${c.description}`)
            .join("\n")
        : "",
      buildingContext,
      worldStatePrompt: this.buildNpcWorldStatePrompt(
        dgsm,
        npcId,
        currentLocationId,
        registry
      ),
      npcInventory: formatItemList(dgsm.getNpcInventory(npcId)),
      currentTime: state.timeOfDay,
      gameDay: state.gameDay,
      language,
      handlerPrompt: registry?.buildHandlerPrompt(),
      planningPrompt: registry?.buildPlanningPrompt(),
      outputSchemaPrompt: registry?.buildOutputSchemaPrompt({
        extraInstructions:
          "Revise pending actions. Only change what the event actually affects.",
        language,
      }),
      failureReason: failureTrigger?.failureReason,
      failureOutcome: failureTrigger?.failureOutcome,
      blockedReason: failureTrigger?.blockedReason,
    });

    console.log(
      `[Planning] ⚡ Revising plans for ${npc.name}: ${triggerDescription.slice(0, 60)}`
    );
    const response = await generateText({
      runtime: this.runtime,
      context: userPrompt,
      customSystemPrompt: systemPrompt,
      modelClass: ModelClass.MEDIUM,
    });

    const parsed = parseJsonResponse<Record<string, unknown>>(response);
    const rawRevisedNodes = extractRevisedNodes(parsed);
    if (!rawRevisedNodes || rawRevisedNodes.length === 0) {
      console.warn(
        `[Planning] revisePlans for ${npc.name}: could not extract revisedNodes from LLM response, keeping existing nodes`
      );
      return {};
    }

    // Resolve location names to IDs
    const nameMap = buildLocationNameMap(dgsm);
    const revisedNodes = rawRevisedNodes.map((node) => ({
      ...normalizePlanNode(node as Record<string, unknown>, {
        npcId,
        npcName: npc.name,
        locationId: resolveLocationFromName(node.location, nameMap),
        fallbackStartTime: state.timeOfDay,
      }),
    }));
    console.log(
      `[Planning] 📝 Revised nodes for ${npc.name}\n${formatPlanNodesForLog(
        dgsm,
        revisedNodes
      )}`
    );

    const { nextNodes, interruptedNode } = mergeRevisedNodesWithHistory(
      existingNodes,
      revisedNodes,
      state.timeOfDay
    );

    // Update daily plan while preserving history nodes.
    const gameDay = state.gameDay;
    await this.prisma.npcDailyPlan.updateMany({
      where: { sessionId, npcId, gameDay },
      data: { nodes: nextNodes as any },
    });

    // Optionally update long-term intent
    if (parsed.shouldUpdateLongTermIntent && parsed.updatedLongTermIntent) {
      await this.prisma.npcLongTermIntent.updateMany({
        where: { sessionId, npcId },
        data: { intent: parsed.updatedLongTermIntent as string },
      });
    }

    return interruptedNode
      ? {
          interruptedAction: buildInterruptedAction(
            interruptedNode,
            state.timeOfDay,
            currentLocationId || interruptedNode.location
          ),
        }
      : {};
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
    language = "en"
  ): Promise<{
    shouldRevise: boolean;
    shouldReviseSchedule: boolean;
    witnessEntry: string;
  }> {
    const { systemPrompt, userPrompt } = buildImpactGatePrompt({
      bucketTime,
      candidate,
      language,
    });

    console.log(
      `[Planning] 🔍 Impact gate for ${candidate.npcName}: "${candidate.triggeringEvents.slice(0, 60)}"`
    );
    const response = await generateText({
      runtime: this.runtime,
      context: userPrompt,
      customSystemPrompt: systemPrompt,
      modelClass: ModelClass.MEDIUM,
    });

    try {
      return parseJsonResponse<{
        shouldRevise: boolean;
        shouldReviseSchedule: boolean;
        witnessEntry: string;
      }>(response);
    } catch (err) {
      console.warn(
        `[Planning] ⚠️ Impact gate JSON parse failed for ${candidate.npcName}, skipping revision:`,
        err instanceof Error ? err.message : err
      );
      return { shouldRevise: false, shouldReviseSchedule: false, witnessEntry: "" };
    }
  }

  async updateRelationshipViaLLM(
    dgsm: DynamicGameStateManager,
    characterAId: string,
    characterBId: string,
    interactionOutcome: string,
    language = "en"
  ): Promise<{ scoreDelta: number; newScore: number; note: string } | null> {
    const state = dgsm.getState();

    const findCharacter = (id: string) =>
      state.npcCharacters.find((n) => n.id === id);
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

    console.log(
      `[Planning] 💬 Updating relationship ${charA.name} ↔ ${charB.name}`
    );
    const response = await generateText({
      runtime: this.runtime,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
    });

    const parsed = parseJsonResponse<{ scoreDelta: number; note: string }>(
      response
    );
    dgsm.updateRelationship(
      characterAId,
      characterBId,
      parsed.scoreDelta,
      parsed.note
    );
    const updated = dgsm.getRelationship(characterAId, characterBId);
    return {
      scoreDelta: parsed.scoreDelta,
      newScore: updated?.score ?? 0,
      note: parsed.note,
    };
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

  async getOpenNodes(
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
    return nodes.filter(
      (n) => n.status === "pending" || n.status === "in_progress"
    );
  }

  async getLongTermIntent(sessionId: string, npcId: string): Promise<string> {
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
    void dgsm;
    const plans = await this.prisma.npcDailyPlan.findMany({
      where: { sessionId, gameDay },
    });

    const dueNodes: PlanNode[] = [];
    for (const plan of plans) {
      const nodes = plan.nodes as unknown as PlanNode[];
      for (const node of nodes) {
        if (node.status === "pending" && node.startTime <= upToTime) {
          dueNodes.push(node);
        }
      }
    }
    return dueNodes;
  }

  async getInProgressNodes(
    sessionId: string,
    gameDay: number
  ): Promise<PlanNode[]> {
    const plans = await this.prisma.npcDailyPlan.findMany({
      where: { sessionId, gameDay },
    });
    const activeNodes: PlanNode[] = [];
    for (const plan of plans) {
      const nodes = plan.nodes as unknown as PlanNode[];
      for (const node of nodes) {
        if (node.status === "in_progress") {
          activeNodes.push(node);
        }
      }
    }
    return activeNodes;
  }

  async getCurrentNpcActions(
    sessionId: string,
    gameDay: number,
    currentTime: string
  ): Promise<Record<string, string | null>> {
    const plans = await this.prisma.npcDailyPlan.findMany({
      where: { sessionId, gameDay },
    });

    const actions: Record<string, string | null> = {};
    for (const plan of plans) {
      const nodes = plan.nodes as unknown as PlanNode[];
      const currentNode = resolveCurrentNode(nodes, currentTime);
      actions[plan.npcId] = currentNode?.action ?? null;
    }
    return actions;
  }

  async updateNode(
    sessionId: string,
    npcId: string,
    gameDay: number,
    updatedNode: PlanNode
  ): Promise<void> {
    const plan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    if (!plan) return;

    const nodes = plan.nodes as unknown as PlanNode[];
    const nextNodes = nodes.map((node) =>
      node.nodeId === updatedNode.nodeId ? updatedNode : node
    );
    await this.prisma.npcDailyPlan.update({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
      data: { nodes: nextNodes as any },
    });
  }

  async replaceNodeWithNodes(
    sessionId: string,
    npcId: string,
    gameDay: number,
    nodeId: string,
    replacementNodes: PlanNode[]
  ): Promise<void> {
    const plan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    if (!plan) return;

    const nodes = plan.nodes as unknown as PlanNode[];
    const nextNodes: PlanNode[] = [];
    for (const node of nodes) {
      if (node.nodeId === nodeId) {
        nextNodes.push(...replacementNodes);
      } else {
        nextNodes.push(node);
      }
    }

    await this.prisma.npcDailyPlan.update({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
      data: { nodes: nextNodes as any },
    });
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
    const updatedNodes = nodes.map((node) =>
      node.nodeId === nodeId
        ? {
            ...node,
            status: "completed" as const,
            outcome,
            executionMeta: {
              ...node.executionMeta,
              remainingMinutes: 0,
              completedAt: node.endTime,
            },
          }
        : node
    );
    await this.prisma.npcDailyPlan.update({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
      data: { nodes: updatedNodes as any },
    });
  }

  async shiftPendingNodesByDelta(
    sessionId: string,
    npcId: string,
    gameDay: number,
    fromTime: string,
    deltaMinutes: number
  ): Promise<void> {
    if (deltaMinutes === 0) return;

    const plan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    if (!plan) return;

    const fromMinutes = timeToMinutes(fromTime);
    const nodes = plan.nodes as unknown as PlanNode[];
    const updatedNodes = nodes.map((node) => {
      if (node.status !== "pending") return node;
      if (timeToMinutes(node.startTime) < fromMinutes) return node;

      return {
        ...node,
        startTime: minutesToTimeLabel(timeToMinutes(node.startTime) - deltaMinutes),
        endTime: minutesToTimeLabel(timeToMinutes(node.endTime) - deltaMinutes),
      };
    });

    await this.prisma.npcDailyPlan.update({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
      data: { nodes: updatedNodes as any },
    });
  }

  async markNodeFailed(
    sessionId: string,
    npcId: string,
    gameDay: number,
    nodeId: string,
    reason: string
  ): Promise<void> {
    const plan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    if (!plan) return;
    const nodes = plan.nodes as unknown as PlanNode[];
    const updatedNodes = nodes.map((node) =>
      node.nodeId === nodeId
        ? {
            ...node,
            status: "failed" as const,
            executionMeta: {
              ...node.executionMeta,
              failedAt: node.endTime,
            },
          }
        : node
    );
    await this.prisma.npcDailyPlan.update({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
      data: { nodes: updatedNodes as any },
    });
  }

  // === Day transition lifecycle ===

  async onNewDay(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    moduleId: string,
    gameDay: number,
    language = "en",
    registry?: GameEngineRegistry
  ): Promise<void> {
    const previousDay = gameDay - 1;

    // 1. Summarize previous day's memory for all NPCs (parallel)
    if (previousDay >= 1) {
      await this.summarizeAllNpcDayMemory(
        dgsm,
        sessionId,
        previousDay,
        language
      );
    }

    // 1b. After summarization, trigger day_transition reasoning for all NPCs
    if (this.memoryManager && previousDay >= 1) {
      const generateTextFn = (prompt: string) =>
        generateText({
          runtime: this.runtime,
          context: prompt,
          modelClass: ModelClass.MEDIUM,
        });

      const npcCharacters = dgsm.getSimulatedNpcs();
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
          language
        )
      );
      await Promise.all(reasoningPromises);
    }

    // 2. Generate daily schedules for all NPCs (includes long-term intent check via ensureNpc path)
    await this.generateDailySchedule(
      dgsm,
      sessionId,
      moduleId,
      gameDay,
      language,
      registry
    );

    console.log(
      `[NPCPlanning] Day ${gameDay} lifecycle complete: summarized day ${previousDay}, generated schedules`
    );
  }

  private async summarizeAllNpcDayMemory(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    gameDay: number,
    language: string
  ): Promise<void> {
    const npcs = dgsm.getSimulatedNpcs();
    await Promise.all(
      npcs.map((npc) =>
        this.summarizeDayMemory(dgsm, sessionId, npc.id, gameDay, language)
      )
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
    const dayMemories = await this.memoryManager.getAllForDay(
      npcId,
      sessionId,
      gameDay
    );
    if (dayMemories.length === 0) return;

    const { getAllHandlers } = await import("../../memory/handlers/index.js");
    const handlers = getAllHandlers();
    const state = dgsm.getState();

    const eventLog = dayMemories
      .map((m) => handlers[m.type].format(m))
      .join("\n");

    const npc = state.npcCharacters.find((n) => n.id === npcId);
    if (!npc) return;

    // Query NPC's existing information/secret memories as knowledge context
    const existingKnowledgeMemories = await this.memoryManager.query({
      npcId,
      sessionId,
      query: "",
      filters: { types: ["information", "secret"] },
      limit: 50,
    });
    const existingKnowledge = existingKnowledgeMemories
      .map((m) => {
        const meta = m.metadata as Record<string, any> | null;
        const kid = (meta?.knowledgeId as string) ?? m.id;
        return `- [${kid}] ${m.content}`;
      })
      .join("\n");

    const { systemPrompt, userPrompt } = buildSummarizeDayMemoryPrompt({
      npcName: npc.name,
      npcProfile: this.formatNpcProfile(npc),
      gameDay,
      eventLog,
      existingKnowledge,
      language,
    });

    console.log(`[Planning] 📝 Summarizing day ${gameDay} for ${npc.name}`);
    const response = await generateText({
      runtime: this.runtime,
      context: userPrompt,
      customSystemPrompt: systemPrompt,
      modelClass: ModelClass.MEDIUM,
    });

    const parsed = parseJsonResponse<{
      memories: Array<{ content: string; importance: number }>;
      newKnowledge?: Array<{
        id?: string;
        text: string;
        category?: string;
        difficulty?: string;
      }>;
    }>(response);

    const moduleId = (await this.resolveModuleId(sessionId)) ?? "";

    // Write summary memories
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

    // Write new knowledge as information/secret memories
    if (parsed.newKnowledge?.length) {
      for (const k of parsed.newKnowledge) {
        const isSecret = k.category === "secret";
        const knowledgeId = k.id || `learned_day${gameDay}_${Date.now()}`;
        await this.memoryManager!.add({
          npcId,
          sessionId,
          moduleId,
          type: isSecret ? "secret" : "information",
          content: k.text,
          gameDay,
          gameTime: "23:59",
          metadata: {
            knowledgeId,
            difficulty: k.difficulty ?? (isSecret ? "hard" : "automatic"),
            revealed: false,
          },
        });
      }
    }
  }

  private async getNpcDayMemoryLog(
    sessionId: string,
    npcId: string,
    gameDay: number
  ): Promise<string> {
    if (!this.memoryManager) return "";

    const dayMemories = await this.memoryManager.getAllForDay(
      npcId,
      sessionId,
      gameDay
    );
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
    return memories
      .map((memory) => handlers[memory.type].format(memory))
      .join("\n");
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
    if (character.personality)
      parts.push(`Personality: ${character.personality}`);
    if (character.background) parts.push(`Background: ${character.background}`);
    if (character.backstory) parts.push(`Backstory: ${character.backstory}`);
    return parts.join("\n");
  }

  private formatRelationships(
    dgsm: DynamicGameStateManager,
    npcId: string
  ): string {
    const graph = dgsm.getState().npcRelationshipGraph[npcId];
    if (!graph || Object.keys(graph).length === 0)
      return "No known relationships.";
    return Object.entries(graph)
      .map(([targetId, rel]) => {
        const targetNpc = dgsm
          .getState()
          .npcCharacters.find((n) => n.id === targetId);
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
  private formatNpcLocalConditions(
    dgsm: DynamicGameStateManager,
    npcLocation?: string
  ): string {
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

    const entries = Object.entries(conds).filter(([scenarioId]) =>
      relevantSceneIds.has(scenarioId)
    );
    if (entries.length === 0) return "";
    return entries
      .map(
        ([scenarioId, conditions]) =>
          `${scenarioId}: ${conditions.map((c) => c.description).join("; ")}`
      )
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
    const staminaStates = dgsm.getFeatureState("stamina") as
      | Record<string, { fatigueLevel?: number; minutesSinceLastRest?: number }>
      | undefined;
    if (staminaStates?.[npcId]) {
      const stamina = staminaStates[npcId];
      if (stamina.fatigueLevel && stamina.fatigueLevel > 0) {
        const hours = ((stamina.minutesSinceLastRest ?? 0) / 60).toFixed(1);
        const label = stamina.fatigueLevel === 1 ? "Tired" : "Exhausted";
        sections.push(`Fatigue: ${label} (${hours}h active)`);
      }
    }

    // Sanity — only this NPC's active insanity
    const sanityStates = dgsm.getFeatureState("sanity") as
      | Record<
          string,
          {
            activeInsanity?: {
              isActive?: boolean;
              insanityType?: string;
              boutType?: string;
              description?: string;
              actionRestriction?: string;
            };
          }
        >
      | undefined;
    if (sanityStates?.[npcId]) {
      const sanity = sanityStates[npcId];
      if (sanity.activeInsanity?.isActive) {
        const ai = sanity.activeInsanity;
        sections.push(
          `Active insanity: ${ai.insanityType} (${ai.boutType}) — ${ai.description} | restriction: ${ai.actionRestriction}`
        );
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
  private buildPerceivedFireState(
    dgsm: DynamicGameStateManager,
    npcLocation: string
  ): string {
    const fireStates = dgsm.getFeatureState("fire");
    if (!fireStates || Object.keys(fireStates).length === 0) return "";

    const topology = dgsm.getTopology();

    // Build set of scenes whose fire light reaches the NPC
    const perceivedFires: Array<{
      sceneId: string;
      intensity: number;
      label: string;
    }> = [];
    const INTENSITY_LABELS = [
      "",
      "Smoldering",
      "Small Fire",
      "Burning",
      "Blazing",
      "Inferno",
    ];

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
          isAdjacent = fireScene?.connections.some(c => c.targetId === npcLocation) ?? false;
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
