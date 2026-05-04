import type { PrismaClient } from "@prisma/client";
import type { ActionDefinitionRegistry } from "../engine/definitions/registry.js";
import { t } from "../i18n/t.js";
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { KnownMapSnapshot } from "../memory/types.js";
import { ModelClass, generateText } from "../models/index.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import { formatItemList, formatSceneItems } from "./itemFormatHelpers.js";
import {
  type ImpactPerspective,
  buildDailySchedulePrompt,
  buildDetailedNodesPrompt,
  buildImpactGatePrompt,
  buildImpactObservationPrompt,
  buildRelationshipUpdatePrompt,
  buildReviseSchedulePrompt,
} from "./npcPlanningTemplates.js";
import { buildSummarizeDayMemoryPrompt } from "./npcSummaryTemplates.js";
import {
  buildLocationNameMap,
  formatSceneConnections,
  formatSceneMap,
  resolveLocationId as resolveLocationFromName,
  resolveLocationName,
} from "./sceneMapFormatter.js";
import type { PlanNode, ScheduleEntry } from "./types.js";

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
      .sort(
        (a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime)
      )[0] ?? null;
  if (inProgressNode) return inProgressNode;

  const duePendingNode =
    nodes
      .filter(
        (node) =>
          node.status === "pending" &&
          timeToMinutes(node.startTime) <= timeToMinutes(currentTime)
      )
      .sort(
        (a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime)
      )[0] ?? null;

  return duePendingNode;
}

function getDefaultNodeDurationMinutes(type: string): number {
  switch (type) {
    case "object_interaction":
      return 10;
    case "action":
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
          typeof rawNode.type === "string" ? rawNode.type : "action"
        )
    );
  }

  let remainingMinutes = timeToMinutes(rawEnd) - timeToMinutes(rawStart);
  if (remainingMinutes <= 0) {
    remainingMinutes = getDefaultNodeDurationMinutes(
      typeof rawNode.type === "string" ? rawNode.type : "action"
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

function formatVisibleNpcRoster(
  dgsm: DynamicGameStateManager,
  npcId: string,
  isPresent: (candidateId: string) => boolean
): string {
  const state = dgsm.getState();
  const relationshipGraph = state.npcRelationshipGraph[npcId] ?? {};

  return state.npcCharacters
    .filter((npc) => {
      if (npc.id === npcId) return false;
      if (dgsm.isCharacterHidden(npc.id)) return false;
      return isPresent(npc.id);
    })
    .map((npc) => {
      const parts = [`- ${npc.name} (${npc.id})`];
      if (!dgsm.isNpcAlive(npc.id)) parts.push("status: dead");
      if (npc.appearance) parts.push(`appearance: ${npc.appearance}`);
      const rel = relationshipGraph[npc.id];
      if (rel) parts.push(`relationship: score=${rel.score} (${rel.note})`);
      return parts.join(" | ");
    })
    .join("\n");
}

function normalizePlanNode(
  rawNode: Record<string, unknown>,
  params: {
    npcId: string;
    npcName: string;
    destinationId?: string;
    fallbackStartTime: string;
  }
): PlanNode {
  const { startTime, endTime, remainingMinutes } = normalizeNodeTimeRange(
    rawNode,
    params.fallbackStartTime
  );
  const {
    location: _rawLocation,
    destination: _rawDestination,
    ...rest
  } = rawNode;

  // Always generate a deterministic, unique nodeId from NPC + timestamp
  // to prevent duplication when the LLM reuses the same nodeId across replans.
  const nodeId = `${params.npcId}_${startTime.replace(":", "")}_${Date.now().toString(36)}`;

  return {
    ...rest,
    nodeId,
    characterId: params.npcId,
    characterName: params.npcName,
    ...(params.destinationId ? { destination: params.destinationId } : {}),
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
  text = text.replace(/"(?:[^"\\]|\\.)*"/g, (match) =>
    match.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
  );

  // Try to close truncated JSON by balancing braces/brackets
  let inString = false;
  let escape = false;
  const stack: string[] = [];
  for (const ch of text) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
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

function formatPlanNodesForLog(
  dgsm: DynamicGameStateManager,
  nodes: PlanNode[]
): string {
  if (nodes.length === 0) return "(no nodes)";

  return nodes
    .map((node) =>
      node.type === "movement" && node.destination
        ? `- [${node.startTime}-${node.endTime}] ${node.type} @ ${resolveLocationName(
            dgsm,
            node.destination
          )}: ${node.action}`
        : `- [${node.startTime}-${node.endTime}] ${node.type}: ${node.action}`
    )
    .join("\n");
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
    definitions?: ActionDefinitionRegistry
  ): Promise<void> {
    // Delegate to two-tier schedule generation
    await this.generateDailySchedule(
      dgsm,
      sessionId,
      moduleId,
      gameDay,
      language,
      definitions
    );
  }

  async generateDailySchedule(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    moduleId: string,
    gameDay: number,
    language = "en",
    definitions?: ActionDefinitionRegistry
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
          definitions
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
    definitions?: ActionDefinitionRegistry
  ): Promise<void> {
    const state = dgsm.getState();
    const npc = state.npcCharacters.find((n) => n.id === npcId);
    if (!npc || !dgsm.isNpcAlive(npcId)) return;

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
    const mapSnapshot = await this.getPlanningMapSnapshot(sessionId, npc.id);

    const npcProfile = this.formatNpcProfile(npc);
    const relationships = this.formatRelationships(dgsm, npc.id);
    const { townMap, yourLocation } = this.formatSceneMap(
      dgsm,
      npc.id,
      mapSnapshot
    );
    const npcPos = dgsm.getCharacterPosition(npc.id);
    const npcLocation = npcPos ? dgsm.resolveLocationId(npcPos) : undefined;
    const scenarioConditions = this.formatNpcLocalConditions(
      dgsm,
      npcLocation,
      mapSnapshot
    );
    const worldStatePrompt = this.buildNpcWorldStatePrompt(
      dgsm,
      npc.id,
      npcLocation,
      definitions
    );

    const moduleBackground =
      state.moduleSetup?.background || state.moduleSetup?.introduction || "";

    const { systemPrompt, userPrompt } = buildDailySchedulePrompt({
      npcName: npc.name,
      npcId: npc.id,
      npcProfile,
      longTermIntent,
      relationships,
      townMap,
      yourLocation,
      scenarioConditions,
      worldStatePrompt,
      gameDay,
      currentTime: state.timeOfDay,
      language,
      memoryContext,
      moduleBackground,
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

  async generateNextAction(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    npcId: string,
    gameDay: number,
    language = "en",
    definitions?: ActionDefinitionRegistry
  ): Promise<PlanNode | null> {
    const state = dgsm.getState();
    const npc = state.npcCharacters.find((n) => n.id === npcId);
    if (!npc || !dgsm.isNpcAlive(npcId)) return null;

    const plan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    const schedule = (plan?.schedule as unknown as ScheduleEntry[]) ?? [];
    if (schedule.length === 0) return null;

    const longTermIntent = await this.getLongTermIntent(sessionId, npcId);
    const shortTermIntent = await this.getShortTermIntent(sessionId, npcId);
    let memoryLog = "";
    if (this.memoryManager) {
      memoryLog = await this.memoryManager.getContext({
        npcId,
        sessionId,
        purpose: "detailing",
        currentGameDay: gameDay,
      });
    }

    // Get last action outcome from existing nodes
    const existingNodes = (plan?.nodes as unknown as PlanNode[]) ?? [];
    const lastCompletedNode = [...existingNodes]
      .reverse()
      .find(
        (n) =>
          n.status === "completed" ||
          n.status === "failed" ||
          n.status === "interrupted"
      );
    const lastActionOutcome = lastCompletedNode?.outcome ?? undefined;

    const currentPos = dgsm.getCharacterPosition(npcId);
    const currentLocationId = currentPos
      ? dgsm.resolveLocationId(currentPos)
      : "";
    const mapSnapshot = await this.getPlanningMapSnapshot(sessionId, npcId);
    const currentScene = currentLocationId
      ? (mapSnapshot?.scenes[currentLocationId] ??
        state.scenes.get(currentLocationId) ??
        null)
      : null;
    const sceneDescription = currentScene?.description ?? "";
    const sceneItems = formatSceneItems(currentScene);
    const sceneConditions =
      currentScene?.conditions?.map((c) => `- ${c.description}`).join("\n") ??
      "";
    const worldStatePrompt = this.buildNpcWorldStatePrompt(
      dgsm,
      npcId,
      currentLocationId,
      definitions
    );
    const { townMap, yourLocation } = this.formatSceneMap(
      dgsm,
      npc.id,
      mapSnapshot
    );

    // NPCs at current location with relationship info
    const npcsAtLocation = formatVisibleNpcRoster(
      dgsm,
      npcId,
      (candidateId) => {
        const candidatePos = dgsm.getCharacterPosition(candidateId);
        const candidateLocationId = candidatePos
          ? dgsm.resolveLocationId(candidatePos)
          : undefined;
        return candidateLocationId === currentLocationId;
      }
    );

    const npcInventory = formatItemList(dgsm.getNpcInventory(npcId));
    const sceneConnections = currentScene
      ? formatSceneConnections(dgsm, currentScene, mapSnapshot)
      : "";

    const moduleBackground =
      state.moduleSetup?.background || state.moduleSetup?.introduction || "";

    const { systemPrompt, userPrompt } = buildDetailedNodesPrompt({
      npcName: npc.name,
      npcId: npc.id,
      npcProfile: this.formatNpcProfile(npc),
      longTermIntent,
      shortTermIntent,
      lastActionOutcome,
      memoryLog,
      todayPlan: schedule,
      yourLocation,
      townMap,
      sceneDescription,
      sceneItems,
      sceneNpcs: npcsAtLocation,
      sceneConditions,
      sceneConnections,
      worldStatePrompt,
      npcInventory,
      currentTime: state.timeOfDay,
      gameDay,
      language,
      // handlerPrompt / planningPrompt / outputSchemaPrompt previously came
      // from the legacy GameEngineRegistry's buildXxx helpers. Phase E1
      // removed those helpers; the templates fall back to their built-in
      // defaults when these fields are omitted. A future phase will route
      // the new ActionDefinitionRegistry through dedicated prompt builders.
      moduleBackground,
    });

    const nextEntry = schedule[0];
    console.log(
      `[Planning] 🎯 Generating next action for ${npc.name}: "${nextEntry?.activity ?? ""}" @ ${nextEntry?.location ?? "?"}`
    );
    const response = await generateText({
      runtime: this.runtime,
      context: userPrompt,
      customSystemPrompt: systemPrompt,
      modelClass: ModelClass.MEDIUM,
    });

    const parsed = parseJsonResponse<{
      node: Record<string, unknown>;
      updatedShortTermIntent?: string;
    }>(response);

    const rawNode = parsed.node;
    if (!rawNode) {
      console.warn(
        `[Planning] generateNextAction for ${npc.name}: no node in LLM response`
      );
      return null;
    }

    const nameMap = buildLocationNameMap(dgsm, mapSnapshot);
    const nodeType = typeof rawNode.type === "string" ? rawNode.type : "action";
    const rawDestination =
      typeof rawNode.destination === "string" && rawNode.destination
        ? rawNode.destination
        : undefined;
    const destinationId = rawDestination
      ? resolveLocationFromName(rawDestination, nameMap)
      : undefined;
    const enrichedNode = normalizePlanNode(rawNode, {
      npcId,
      npcName: npc.name,
      destinationId: nodeType === "movement" ? destinationId : undefined,
      fallbackStartTime: state.timeOfDay,
    });

    console.log(
      `[Planning] 🧩 Next action for ${npc.name}\n${formatPlanNodesForLog(
        dgsm,
        [enrichedNode]
      )}`
    );

    // Append single node to existing nodes in DB
    const mergedNodes = [...existingNodes, enrichedNode];

    // Update short-term intent if provided
    if (parsed.updatedShortTermIntent) {
      await this.setShortTermIntent(
        sessionId,
        npcId,
        parsed.updatedShortTermIntent
      );
    }

    // Append node to DB — schedule stays intact (LLM judges progress via memory)
    await this.prisma.npcDailyPlan.update({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
      data: { nodes: mergedNodes as any },
    });

    return enrichedNode;
  }

  async ensureNpcNodesAvailable(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    npcId: string,
    gameDay: number,
    currentTime: string,
    language = "en",
    definitions?: ActionDefinitionRegistry
  ): Promise<void> {
    if (!dgsm.isNpcAlive(npcId)) return;

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
          definitions
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

    await this.generateNextAction(
      dgsm,
      sessionId,
      npcId,
      gameDay,
      language,
      definitions
    );
  }

  async reviseSchedule(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    npcId: string,
    triggerDescription: string,
    language = "en",
    definitions?: ActionDefinitionRegistry
  ): Promise<void> {
    const state = dgsm.getState();
    const npc = state.npcCharacters.find((n) => n.id === npcId);
    if (!npc || !dgsm.isNpcAlive(npcId)) return;

    const gameDay = state.gameDay;
    const plan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    if (!plan?.schedule) return;

    const schedule = plan.schedule as unknown as ScheduleEntry[];
    if (schedule.length === 0) return;

    // Always fetch longTermIntent (same as normal Layer 1)
    const longTermIntent = await this.getLongTermIntent(sessionId, npcId);

    // Use scheduling profile: full background (info/belief/secret/summary) + today's events/witnesses
    let memoryContext: string | undefined;
    if (this.memoryManager) {
      memoryContext = await this.memoryManager.getContext({
        npcId,
        sessionId,
        purpose: "scheduling",
        query: triggerDescription,
        currentGameDay: gameDay,
      });
    }
    const mapSnapshot = await this.getPlanningMapSnapshot(sessionId, npcId);

    const revSchedPos = dgsm.getCharacterPosition(npcId);
    const npcLocation = revSchedPos
      ? dgsm.resolveLocationId(revSchedPos)
      : undefined;

    const moduleBackground =
      state.moduleSetup?.background || state.moduleSetup?.introduction || "";

    const { systemPrompt, userPrompt } = buildReviseSchedulePrompt({
      npcName: npc.name,
      npcId: npc.id,
      npcProfile: this.formatNpcProfile(npc),
      longTermIntent,
      memoryContext: memoryContext ?? "",
      relationships: this.formatRelationships(dgsm, npcId),
      ...this.formatSceneMap(dgsm, npcId, mapSnapshot),
      scenarioConditions: this.formatNpcLocalConditions(
        dgsm,
        npcLocation,
        mapSnapshot
      ),
      worldStatePrompt: this.buildNpcWorldStatePrompt(
        dgsm,
        npcId,
        npcLocation,
        definitions
      ),
      remainingSchedule: JSON.stringify(schedule, null, 2),
      triggerDescription,
      gameDay,
      currentTime: state.timeOfDay,
      language,
      moduleBackground,
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
      shortTermIntent?: string;
    },
    bucketTime: string,
    language = "en",
    moduleBackground?: string
  ): Promise<{
    shouldUpdateIntent: boolean;
    updatedIntent?: string;
    shouldInterruptCurrentNode: boolean;
    shouldReviseSchedule: boolean;
  }> {
    const { systemPrompt, userPrompt } = buildImpactGatePrompt({
      bucketTime,
      candidate,
      language,
      moduleBackground,
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
        shouldUpdateIntent: boolean;
        updatedIntent?: string;
        shouldInterruptCurrentNode: boolean;
        shouldReviseSchedule: boolean;
      }>(response);
    } catch (err) {
      console.warn(
        `[Planning] ⚠️ Impact gate JSON parse failed for ${candidate.npcName}, skipping revision:`,
        err instanceof Error ? err.message : err
      );
      return {
        shouldUpdateIntent: false,
        shouldInterruptCurrentNode: false,
        shouldReviseSchedule: false,
      };
    }
  }

  async generateImpactObservationForNpc(
    candidate: {
      npcId: string;
      npcName: string;
      currentLocation: string;
      longTermIntent: string;
      todayScheduleSummary: string;
      currentDetailedPlan: string;
      triggeringEvents: string;
      memoryContext?: string;
      shortTermIntent?: string;
    },
    bucketTime: string,
    perspective: ImpactPerspective,
    language = "en",
    moduleBackground?: string
  ): Promise<string> {
    const { systemPrompt, userPrompt } = buildImpactObservationPrompt({
      bucketTime,
      candidate,
      perspective,
      language,
      moduleBackground,
    });

    console.log(
      `[Planning] 👁️ Impact observation for ${candidate.npcName}: "${candidate.triggeringEvents.slice(0, 60)}"`
    );
    const response = await generateText({
      runtime: this.runtime,
      context: userPrompt,
      customSystemPrompt: systemPrompt,
      modelClass: ModelClass.MEDIUM,
    });

    try {
      const parsed = parseJsonResponse<{ observation: string }>(response);
      return parsed.observation?.trim() ?? "";
    } catch (err) {
      console.warn(
        `[Planning] ⚠️ Impact observation JSON parse failed for ${candidate.npcName}, using fallback:`,
        err instanceof Error ? err.message : err
      );
      return "";
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

  async getShortTermIntent(
    sessionId: string,
    npcId: string
  ): Promise<string | null> {
    const record = await this.prisma.npcShortTermIntent.findUnique({
      where: { sessionId_npcId: { sessionId, npcId } },
    });
    return record?.intent ?? null;
  }

  async setShortTermIntent(
    sessionId: string,
    npcId: string,
    intent: string
  ): Promise<void> {
    await this.prisma.npcShortTermIntent.upsert({
      where: { sessionId_npcId: { sessionId, npcId } },
      update: { intent },
      create: { sessionId, npcId, intent },
    });
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
      if (!dgsm.isNpcAlive(plan.npcId)) continue;
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
    gameDay: number,
    dgsm?: DynamicGameStateManager
  ): Promise<PlanNode[]> {
    const plans = await this.prisma.npcDailyPlan.findMany({
      where: { sessionId, gameDay },
    });
    const activeNodes: PlanNode[] = [];
    for (const plan of plans) {
      if (dgsm && !dgsm.isNpcAlive(plan.npcId)) continue;
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
    currentTime: string,
    dgsm?: DynamicGameStateManager
  ): Promise<Record<string, string | null>> {
    const plans = await this.prisma.npcDailyPlan.findMany({
      where: { sessionId, gameDay },
    });

    const actions: Record<string, string | null> = {};
    for (const plan of plans) {
      if (dgsm && !dgsm.isNpcAlive(plan.npcId)) {
        actions[plan.npcId] = null;
        continue;
      }
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
        startTime: minutesToTimeLabel(
          timeToMinutes(node.startTime) - deltaMinutes
        ),
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

  async interruptOpenNodesForDeath(
    sessionId: string,
    npcId: string,
    gameDay: number,
    gameTime: string,
    language = "en"
  ): Promise<void> {
    const plan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    if (!plan) return;

    let changed = false;
    const nodes = plan.nodes as unknown as PlanNode[];
    const updatedNodes = nodes.map((node) => {
      if (
        node.status === "completed" ||
        node.status === "failed" ||
        node.status === "interrupted"
      ) {
        return node;
      }

      changed = true;
      return {
        ...node,
        status: "interrupted" as const,
        outcome: t("interrupted_death", language, { action: node.action }),
        executionMeta: {
          ...node.executionMeta,
          remainingMinutes: 0,
          interruptedAt: gameTime,
          interruptionReason: "character_dead",
        },
      };
    });

    if (!changed) return;

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
    definitions?: ActionDefinitionRegistry
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

    // 2. Generate daily schedules for all NPCs (includes long-term intent check via ensureNpc path)
    await this.generateDailySchedule(
      dgsm,
      sessionId,
      moduleId,
      gameDay,
      language,
      definitions
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
    if (!dgsm.isNpcAlive(npcId)) return;

    // Fetch only event + witness memories — these are what actually happened
    const dayMemories = await this.memoryManager.getForDayByTypes(
      npcId,
      sessionId,
      gameDay,
      ["event", "witness"]
    );
    if (dayMemories.length === 0) return;

    const { getHandler } = await import("../memory/handlers/index.js");
    const eventHandler = getHandler("event");
    const witnessHandler = getHandler("witness");
    const state = dgsm.getState();

    const eventLog = dayMemories
      .map((m) =>
        m.type === "event" ? eventHandler.format(m) : witnessHandler.format(m)
      )
      .join("\n");

    const npc = state.npcCharacters.find((n) => n.id === npcId);
    if (!npc) return;

    // Query NPC's existing information/secret memories as knowledge context
    const existingKnowledgeMemories = await this.memoryManager.getAllByTypes(
      npcId,
      sessionId,
      ["information", "secret"]
    );
    const existingKnowledge = existingKnowledgeMemories
      .map((m) => {
        const meta = m.metadata as Record<string, any> | null;
        const kid = (meta?.knowledgeId as string) ?? m.id;
        return `- [${kid}] ${m.content}`;
      })
      .join("\n");

    // Query NPC's current beliefs
    const existingBeliefMemories = await this.memoryManager.getAllByTypes(
      npcId,
      sessionId,
      ["belief"]
    );
    const existingBeliefs = existingBeliefMemories
      .map((m) => {
        const meta = m.metadata as Record<string, any> | null;
        const confidence = meta?.confidence ?? 1.0;
        return `- [${m.id}] ${m.content} (confidence: ${confidence})`;
      })
      .join("\n");

    const { systemPrompt, userPrompt } = buildSummarizeDayMemoryPrompt({
      npcName: npc.name,
      npcProfile: this.formatNpcProfile(npc),
      gameDay,
      eventLog,
      existingKnowledge,
      existingBeliefs,
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
      updatedKnowledge?: Array<{
        id: string;
        text?: string;
        action?: "update" | "remove";
      }>;
      updatedBeliefs?: Array<{
        id: string;
        confidence: number;
        reason: string;
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

    // Update existing knowledge
    if (parsed.updatedKnowledge?.length) {
      const knowledgeById = new Map(
        existingKnowledgeMemories.map((m) => {
          const meta = m.metadata as Record<string, any> | null;
          const kid = (meta?.knowledgeId as string) ?? m.id;
          return [kid, m];
        })
      );
      for (const uk of parsed.updatedKnowledge) {
        const existing = knowledgeById.get(uk.id);
        if (!existing) continue;
        if (uk.action === "remove") {
          // Mark as disproven by setting importance to near-zero (accelerate decay)
          await this.memoryManager!.updateBeliefConfidence(
            existing.id,
            0,
            "Disproven during day summary",
            (existing.metadata as Record<string, any>) ?? {}
          );
        } else if (uk.text) {
          const meta = (existing.metadata as Record<string, any>) ?? {};
          await this.memoryManager!.updateKnowledgeContent(
            existing.id,
            uk.text,
            meta
          );
        }
      }
    }

    // Update existing beliefs
    if (parsed.updatedBeliefs?.length) {
      const beliefById = new Map(existingBeliefMemories.map((m) => [m.id, m]));
      for (const ub of parsed.updatedBeliefs) {
        const existing = beliefById.get(ub.id);
        if (!existing) continue;
        await this.memoryManager!.updateBeliefConfidence(
          existing.id,
          ub.confidence,
          ub.reason ?? "",
          (existing.metadata as Record<string, any>) ?? {}
        );
      }
    }
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

  private formatSceneMap(
    dgsm: DynamicGameStateManager,
    npcId: string,
    snapshot?: KnownMapSnapshot
  ) {
    return formatSceneMap(dgsm, npcId, snapshot);
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
    npcLocation?: string,
    snapshot?: KnownMapSnapshot
  ): string {
    if (!npcLocation) return "";
    if (snapshot) {
      const currentScene = snapshot.scenes[npcLocation];
      if (!currentScene) return "";

      const relevantScenes = Object.values(snapshot.scenes).filter(
        (scene) => scene.parentLocationId === currentScene.parentLocationId
      );
      if (relevantScenes.length === 0) return "";

      return relevantScenes
        .filter((scene) => (scene.conditions ?? []).length > 0)
        .map(
          (scene) =>
            `${scene.id}: ${(scene.conditions ?? [])
              .map((condition) => condition.description)
              .join("; ")}`
        )
        .join("\n");
    }

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

  private async getPlanningMapSnapshot(
    sessionId: string,
    npcId: string
  ): Promise<KnownMapSnapshot | undefined> {
    if (!this.memoryManager) return undefined;
    return (
      (await this.memoryManager.getMapSnapshot(npcId, sessionId)) ?? undefined
    );
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
    _npcLocation?: string,
    _definitions?: ActionDefinitionRegistry
  ): string {
    // Phase E: the legacy `dgsm.getFeatureState(...)` API was removed in
    // Phase D. Per-NPC perception of fire / stamina / sanity is the
    // renderer's responsibility (post-Phase-E follow-on). The two sections
    // below — concealment + physical conditions — read directly from DGSM
    // and remain valid; everything else is suppressed until the renderer
    // ships.
    const state = dgsm.getState();
    const sections: string[] = [];

    // Concealment — this NPC's hidden/stealth status
    if (dgsm.isCharacterHidden(npcId)) {
      sections.push(
        "Concealment: You are currently HIDDEN (Stealth active). Others cannot see you. Moving requires a Stealth check to stay hidden. Performing any non-Stealth action will reveal you. You can use this advantage to eavesdrop, follow someone, or set up an ambush."
      );
    }

    // Physical conditions — detained, restrained, unconscious, etc.
    const npc = state.npcCharacters.find((n) => n.id === npcId);
    const conditions = npc?.status?.conditions ?? [];
    const nonInsanityConditions = conditions.filter(
      (c) => !c.description.startsWith("[Insanity:")
    );
    if (nonInsanityConditions.length > 0) {
      sections.push(
        `Physical conditions: ${nonInsanityConditions.map((c) => c.description).join(", ")}. These are binding physical constraints on your current state. You cannot take actions that contradict these conditions unless you first resolve or escape them.`
      );
    }

    if (sections.length === 0) return "";
    return "## World Conditions\n\n" + sections.join("\n") + "\n";
  }
}
