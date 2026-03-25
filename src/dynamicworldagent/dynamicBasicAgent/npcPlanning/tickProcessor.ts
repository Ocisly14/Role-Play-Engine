import { ModelClass, generateText } from "../../../models/index.js";
import { ModelProviderName } from "../../../models/types.js";
import { EmbeddingClient } from "../../../rag/embedding.js";
import { drainPendingEmotions } from "../../engine/features/sanityFeature.js";
import {
  applyCharacterDelta,
  resolveInteractionState,
  resolveTargets,
} from "../../engine/handlers/interactionStateResolver.js";
import { resolveTargetPosition } from "../../engine/handlers/movementHandler.js";
import {
  applyObjectDelta,
  resolveObjectInteractionState,
} from "../../engine/handlers/objectInteractionStateResolver.js";
import type { GameEngineRegistry } from "../../engine/registry.js";
import {
  SUCCESS_RANK,
  getSuccessLevel,
  rollD100,
} from "../../engine/shared/dice.js";
import { findAffectedCharacters } from "../../engine/shared/impactPropagation.js";
import { arePositionsCoLocated } from "../../engine/shared/locationPresence.js";
import { buildMovementRouteIgnoringBlocks } from "../../engine/shared/pathfinding.js";
import type {
  ExecutionContext,
  TickRuntimeContext,
} from "../../engine/types.js";
import { t } from "../../i18n/t.js";
import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { CharacterPosition } from "../../state/topologyTypes.js";
import type { Item } from "../../state/types.js";
import {
  type SessionRagChunkInput,
  SessionRagService,
} from "../knowledge/sessionRagService.js";
import type { NPCPlanningAgent } from "./NPCPlanningAgent.js";
import type {
  CharacterAction,
  DiscoveryEntry,
  FailureTrigger,
  PlanNode,
  SimulationTickResult,
  SuccessLevel,
} from "./types.js";

// ==================== Time helpers ====================

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTimeLabel(minutes: number): string {
  const clamped = Math.min(minutes, 1439);
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const TICK_DURATION_MINUTES = 1;

// ==================== Stealth / Detection helpers ====================

/** Get an NPC's skill value by name (case-insensitive), falling back to a default. */
function getNpcSkillValue(
  dgsm: DynamicGameStateManager,
  npcId: string,
  skillName: string,
  defaultValue: number
): number {
  const npc = dgsm.getState().npcCharacters.find((n) => n.id === npcId);
  if (!npc?.skills) return defaultValue;
  const lower = skillName.toLowerCase();
  for (const [k, v] of Object.entries(npc.skills)) {
    if (k.toLowerCase() === lower) return v;
  }
  return defaultValue;
}

/** Get an NPC's detection skill value (Spot Hidden > Perception > base 25). */
function getDetectionSkillValue(
  dgsm: DynamicGameStateManager,
  npcId: string
): number {
  const npc = dgsm.getState().npcCharacters.find((n) => n.id === npcId);
  const skills = npc?.skills ?? {};
  const lower = Object.fromEntries(
    Object.entries(skills).map(([k, v]) => [k.toLowerCase(), v])
  );
  return lower["spot hidden"] ?? lower["perception"] ?? 25;
}

/**
 * Roll a Stealth check for a hidden NPC during movement.
 * Returns true if the NPC stays hidden.
 */
function rollStealthForMovement(
  dgsm: DynamicGameStateManager,
  npcId: string
): boolean {
  const stealthValue = getNpcSkillValue(dgsm, npcId, "Stealth", 20);
  const roll = rollD100();
  const level = getSuccessLevel(roll, stealthValue);
  return level !== "fail" && level !== "fumble";
}

/**
 * Opposed roll: observer's detection vs hidden NPC's Stealth.
 * Returns true if the observer detects the hidden NPC.
 */
function tryDetectHidden(
  dgsm: DynamicGameStateManager,
  observerId: string,
  hiddenNpcId: string
): boolean {
  const detectionValue = getDetectionSkillValue(dgsm, observerId);
  const stealthValue = getNpcSkillValue(dgsm, hiddenNpcId, "Stealth", 20);

  const observerRoll = rollD100();
  const stealthRoll = rollD100();
  const observerLevel = getSuccessLevel(observerRoll, detectionValue);
  const stealthLevel = getSuccessLevel(stealthRoll, stealthValue);

  // Observer must win strictly to detect
  return SUCCESS_RANK[observerLevel] > SUCCESS_RANK[stealthLevel];
}

interface ItemActionContext {
  itemId?: string;
  itemName?: string;
  targetItemId?: string;
  targetItemName?: string;
}

function findKnownItem(
  dgsm: DynamicGameStateManager,
  node: PlanNode,
  itemId: string
): Item | null {
  const actorItem = dgsm.findNpcItem(node.characterId, itemId);
  if (actorItem) return actorItem;

  const sceneItem = dgsm
    .getScene(node.location)
    ?.items.find((i) => i.id === itemId);
  if (sceneItem) return sceneItem;

  const primaryTargetId = node.targetCharacterIds?.[0];
  if (primaryTargetId) {
    const targetItem = dgsm.findNpcItem(primaryTargetId, itemId);
    if (targetItem) return targetItem;
  }

  return null;
}

function getItemActionContext(
  dgsm: DynamicGameStateManager,
  node: PlanNode
): ItemActionContext | null {
  if (node.type === "object_interaction" && node.objectInteractionPayload) {
    const { itemId } = node.objectInteractionPayload;
    if (!itemId) return null;

    const item = findKnownItem(dgsm, node, itemId);
    return {
      itemId,
      itemName: item?.name,
    };
  }

  return null;
}

function formatItemReference(
  name: string | undefined,
  id: string | undefined
): string | null {
  if (!name && !id) return null;
  if (name && id) return `${name} (id:${id})`;
  return name ?? id ?? null;
}

function appendItemContext(
  outcome: string,
  itemContext: ItemActionContext | null
): string {
  if (!itemContext) return outcome;

  const parts: string[] = [];
  const itemRef = formatItemReference(itemContext.itemName, itemContext.itemId);
  if (itemRef) parts.push(`item: ${itemRef}`);

  const targetRef = formatItemReference(
    itemContext.targetItemName,
    itemContext.targetItemId
  );
  if (targetRef) parts.push(`target: ${targetRef}`);

  if (parts.length === 0) return outcome;
  return `${outcome} [${parts.join("; ")}]`;
}

function buildEventMetadata(
  outcome: string,
  itemContext: ItemActionContext | null
): Record<string, string> {
  const metadata: Record<string, string> = { outcome };

  if (itemContext?.itemId) metadata.itemId = itemContext.itemId;
  if (itemContext?.itemName) metadata.itemName = itemContext.itemName;
  if (itemContext?.targetItemId)
    metadata.targetItemId = itemContext.targetItemId;
  if (itemContext?.targetItemName)
    metadata.targetItemName = itemContext.targetItemName;

  return metadata;
}

function formatActionStatusLabel(action: CharacterAction): string {
  switch (action.status) {
    case "completed":
      return "completed";
    case "failed":
      return `failed${action.failureReason ? ` (${action.failureReason})` : ""}`;
    case "interrupted":
      return `interrupted${action.interruptionReason ? ` (${action.interruptionReason})` : ""}`;
    default:
      return action.status;
  }
}

function logNodeExecutionResult(node: PlanNode, action: CharacterAction): void {
  const details: string[] = [
    `[NodeResult] ${formatActionStatusLabel(action)}`,
    `${node.characterName}`,
    `${node.type}`,
    `@ ${action.location}`,
    `[${action.gameTime}]`,
  ];

  if (action.successLevel) {
    details.push(`[roll ${action.successLevel}]`);
  }

  console.log(`${details.join(" ")} ${action.outcome}`);
}

function shouldRunImpactGate(action: CharacterAction): boolean {
  return action.impact >= 2 || (action.impact === 1 && Boolean(action.skill));
}

function classifyImpactPerspective(
  npcId: string,
  action: CharacterAction
): "targeted" | "witness" | "co_presence" {
  if (action.characterId === "__encounter__") return "co_presence";
  if (action.targetCharacterIds?.includes(npcId)) return "targeted";
  return "witness";
}

function buildImpactEventText(
  perspective: "targeted" | "witness" | "co_presence",
  action: CharacterAction,
  impact: number,
  lang: string
): string {
  switch (perspective) {
    case "targeted":
      return t("impact_targeted", lang, {
        impact: String(impact),
        name: action.characterName,
        outcome: action.outcome ?? "",
      });
    case "co_presence":
      return t("impact_co_presence", lang, {
        impact: String(impact),
        outcome: action.outcome ?? "",
      });
    case "witness":
    default:
      return t("impact_witness", lang, {
        impact: String(impact),
        name: action.characterName,
        outcome: action.outcome ?? "",
      });
  }
}

function buildImpactMemoryContent(
  perspective: "targeted" | "witness" | "co_presence",
  _bucketTime: string,
  _gameDay: number,
  witnessEntry: string,
  lang: string
): string {
  switch (perspective) {
    case "targeted":
      return t("memory_direct", lang, { entry: witnessEntry });
    case "co_presence":
      return t("memory_encounter", lang, { entry: witnessEntry });
    case "witness":
    default:
      return t("memory_witness", lang, { entry: witnessEntry });
  }
}

function getNodeDurationMinutes(node: PlanNode): number {
  return Math.max(
    1,
    timeToMinutes(node.endTime) - timeToMinutes(node.startTime)
  );
}

function startNode(node: PlanNode, currentTime: string): PlanNode {
  return {
    ...node,
    status: "in_progress",
    executionMeta: {
      ...node.executionMeta,
      startedAt: node.executionMeta.startedAt ?? currentTime,
      remainingMinutes:
        node.executionMeta.remainingMinutes > 0
          ? node.executionMeta.remainingMinutes
          : getNodeDurationMinutes(node),
    },
  };
}

function interpolateMovementPosition(
  from: CharacterPosition,
  to: CharacterPosition,
  progress: number
): CharacterPosition {
  if (from.type === "road" && to.type === "road" && from.roadId === to.roadId) {
    return {
      type: "road",
      roadId: from.roadId,
      position: from.position + (to.position - from.position) * progress,
    };
  }

  return progress >= 1 ? to : from;
}

function buildMovementAction(
  node: PlanNode,
  status: "completed" | "failed",
  gameTime: string,
  location: string,
  outcome: string,
  failureReason?: "location_blocked"
): CharacterAction {
  return {
    characterId: node.characterId,
    characterName: node.characterName,
    gameTime,
    action: node.action,
    location,
    type: node.type,
    skill: node.skill,
    impact: node.impact,
    status,
    outcome,
    failureReason,
    targetCharacterIds: node.targetCharacterIds,
  };
}

function initializeMovementNode(
  node: PlanNode,
  dgsm: DynamicGameStateManager,
  currentTime: string,
  lang: string
): PlanNode {
  const currentPosition = dgsm.getCharacterPosition(node.characterId);
  if (!currentPosition) {
    return {
      ...startNode(node, currentTime),
      status: "failed",
      executionMeta: {
        ...node.executionMeta,
        startedAt: currentTime,
        failedAt: currentTime,
        remainingMinutes: 0,
      },
      outcome: t("no_path_failed", lang, { action: node.action }),
    };
  }

  // Intra-building movement: same building, different sub-scene
  if (currentPosition.type === "scene") {
    const state = dgsm.getState();
    const currentScene = state.scenes.get(currentPosition.sceneId);
    const targetScene = state.scenes.get(node.location);
    if (
      currentScene &&
      targetScene &&
      currentScene.parentLocationId === targetScene.parentLocationId &&
      currentScene.parentLocationId !== "OUTDOOR" &&
      currentPosition.sceneId !== node.location
    ) {
      const targetPos: CharacterPosition = {
        type: "scene",
        sceneId: node.location,
      };
      const moveDuration = Math.max(1, node.executionMeta.remainingMinutes);
      return {
        ...startNode(node, currentTime),
        executionMeta: {
          ...node.executionMeta,
          startedAt: currentTime,
          remainingMinutes: moveDuration,
          movement: {
            routeSnapshot: [
              {
                kind: "to_scene",
                from: currentPosition,
                to: targetPos,
                durationMinutes: moveDuration,
                blockCheck: {
                  fromId: currentPosition.sceneId,
                  toId: node.location,
                },
              },
            ],
            currentStepIndex: 0,
            minutesIntoStep: 0,
            lastReachablePosition: currentPosition,
            targetPosition: targetPos,
          },
        },
      };
    }
  }

  // Topology-based movement
  const topology = dgsm.getTopology();
  const targetPosition = resolveTargetPosition(node.location, topology, dgsm);
  if (!targetPosition) {
    return {
      ...startNode(node, currentTime),
      status: "failed",
      executionMeta: {
        ...node.executionMeta,
        startedAt: currentTime,
        failedAt: currentTime,
        remainingMinutes: 0,
      },
      outcome: t("no_path_failed", lang, { action: node.action }),
    };
  }

  const route = buildMovementRouteIgnoringBlocks(
    currentPosition,
    targetPosition,
    topology,
    dgsm
  );
  if (!route) {
    return {
      ...startNode(node, currentTime),
      status: "failed",
      executionMeta: {
        ...node.executionMeta,
        startedAt: currentTime,
        failedAt: currentTime,
        remainingMinutes: 0,
      },
      outcome: t("no_path_failed", lang, { action: node.action }),
    };
  }

  return {
    ...startNode(node, currentTime),
    executionMeta: {
      ...node.executionMeta,
      startedAt: currentTime,
      remainingMinutes: Math.max(1, Math.ceil(route.totalMinutes)),
      movement: {
        routeSnapshot: route.steps,
        currentStepIndex: 0,
        minutesIntoStep: 0,
        lastReachablePosition: currentPosition,
        targetPosition,
      },
    },
  };
}

function processImmediateMovementTransitions(
  node: PlanNode,
  dgsm: DynamicGameStateManager
): { node: PlanNode; blockedReason?: string; moved: boolean } {
  const movement = node.executionMeta.movement;
  if (!movement) return { node, moved: false };

  let currentNode = node;
  let moved = false;

  while (true) {
    const currentMovement = currentNode.executionMeta.movement;
    if (!currentMovement) break;
    const step =
      currentMovement.routeSnapshot[currentMovement.currentStepIndex];
    if (!step || step.durationMinutes > 0) break;

    const blockedReason = step.blockCheck
      ? dgsm.getConnectionBlockReason(
          step.blockCheck.fromId,
          step.blockCheck.toId
        )
      : undefined;
    if (blockedReason) {
      return { node: currentNode, blockedReason, moved };
    }

    dgsm.setCharacterPosition(currentNode.characterId, step.to);
    moved = true;
    currentNode = {
      ...currentNode,
      executionMeta: {
        ...currentNode.executionMeta,
        movement: {
          ...currentMovement,
          currentStepIndex: currentMovement.currentStepIndex + 1,
          minutesIntoStep: 0,
          lastReachablePosition: step.to,
        },
      },
    };
  }

  return { node: currentNode, moved };
}

function advanceMovementNodeOneMinute(
  node: PlanNode,
  dgsm: DynamicGameStateManager,
  currentTime: string,
  lang: string
): {
  node: PlanNode;
  action?: CharacterAction;
  moved: boolean;
} {
  const processed = processImmediateMovementTransitions(node, dgsm);
  if (processed.blockedReason) {
    const failedNode: PlanNode = {
      ...processed.node,
      status: "failed",
      executionMeta: {
        ...processed.node.executionMeta,
        failedAt: currentTime,
        blockedReason: processed.blockedReason,
        remainingMinutes: 0,
        movement: processed.node.executionMeta.movement
          ? {
              ...processed.node.executionMeta.movement,
              blockedReason: processed.blockedReason,
            }
          : undefined,
      },
      outcome: t("blocked_failed", lang, {
        action: processed.node.action,
        reason: processed.blockedReason,
      }),
    };
    const failedPosition = dgsm.getCharacterPosition(node.characterId);
    return {
      node: failedNode,
      moved: processed.moved,
      action: buildMovementAction(
        failedNode,
        "failed",
        currentTime,
        failedPosition ? dgsm.resolveLocationId(failedPosition) : node.location,
        failedNode.outcome!,
        "location_blocked"
      ),
    };
  }

  const movement = processed.node.executionMeta.movement;
  if (!movement) {
    return { node: processed.node, moved: processed.moved };
  }

  const step = movement.routeSnapshot[movement.currentStepIndex];
  if (!step) {
    const completedNode: PlanNode = {
      ...processed.node,
      status: "completed",
      executionMeta: {
        ...processed.node.executionMeta,
        completedAt: currentTime,
        remainingMinutes: 0,
      },
      outcome: t("arrived_succeeded", lang, {
        action: processed.node.action,
        location: processed.node.location,
      }),
    };
    return {
      node: completedNode,
      moved: processed.moved,
      action: buildMovementAction(
        completedNode,
        "completed",
        currentTime,
        processed.node.location,
        completedNode.outcome!
      ),
    };
  }

  const blockedReason =
    movement.minutesIntoStep === 0 && step.blockCheck
      ? dgsm.getConnectionBlockReason(
          step.blockCheck.fromId,
          step.blockCheck.toId
        )
      : undefined;
  if (blockedReason) {
    const failedNode: PlanNode = {
      ...processed.node,
      status: "failed",
      executionMeta: {
        ...processed.node.executionMeta,
        failedAt: currentTime,
        blockedReason,
        remainingMinutes: 0,
        movement: {
          ...movement,
          blockedReason,
        },
      },
      outcome: t("blocked_failed", lang, {
        action: processed.node.action,
        reason: blockedReason,
      }),
    };
    const failedPosition = dgsm.getCharacterPosition(node.characterId);
    return {
      node: failedNode,
      moved: processed.moved,
      action: buildMovementAction(
        failedNode,
        "failed",
        currentTime,
        failedPosition ? dgsm.resolveLocationId(failedPosition) : node.location,
        failedNode.outcome!,
        "location_blocked"
      ),
    };
  }

  const duration = Math.max(1, step.durationMinutes);
  const nextMinutesIntoStep = movement.minutesIntoStep + 1;
  const progress = Math.min(nextMinutesIntoStep / duration, 1);
  const nextPosition = interpolateMovementPosition(
    step.from,
    step.to,
    progress
  );
  dgsm.setCharacterPosition(node.characterId, nextPosition);

  let nextNode: PlanNode = {
    ...processed.node,
    executionMeta: {
      ...processed.node.executionMeta,
      remainingMinutes: Math.max(
        0,
        processed.node.executionMeta.remainingMinutes - 1
      ),
      movement: {
        ...movement,
        minutesIntoStep: nextMinutesIntoStep,
        lastReachablePosition: nextPosition,
      },
    },
  };

  if (progress >= 1) {
    nextNode = {
      ...nextNode,
      executionMeta: {
        ...nextNode.executionMeta,
        movement: {
          ...nextNode.executionMeta.movement!,
          currentStepIndex: movement.currentStepIndex + 1,
          minutesIntoStep: 0,
          lastReachablePosition: step.to,
        },
      },
    };
  }

  const afterMinute = processImmediateMovementTransitions(nextNode, dgsm);
  if (afterMinute.blockedReason) {
    const failedNode: PlanNode = {
      ...afterMinute.node,
      status: "failed",
      executionMeta: {
        ...afterMinute.node.executionMeta,
        failedAt: currentTime,
        blockedReason: afterMinute.blockedReason,
        remainingMinutes: 0,
        movement: afterMinute.node.executionMeta.movement
          ? {
              ...afterMinute.node.executionMeta.movement,
              blockedReason: afterMinute.blockedReason,
            }
          : undefined,
      },
      outcome: t("blocked_failed", lang, {
        action: afterMinute.node.action,
        reason: afterMinute.blockedReason,
      }),
    };
    const failedPosition = dgsm.getCharacterPosition(node.characterId);
    return {
      node: failedNode,
      moved: true,
      action: buildMovementAction(
        failedNode,
        "failed",
        currentTime,
        failedPosition ? dgsm.resolveLocationId(failedPosition) : node.location,
        failedNode.outcome!,
        "location_blocked"
      ),
    };
  }

  const nextMovement = afterMinute.node.executionMeta.movement;
  if (
    !nextMovement ||
    !nextMovement.routeSnapshot[nextMovement.currentStepIndex]
  ) {
    const completedNode: PlanNode = {
      ...afterMinute.node,
      status: "completed",
      executionMeta: {
        ...afterMinute.node.executionMeta,
        completedAt: currentTime,
        remainingMinutes: 0,
      },
      outcome: t("arrived_succeeded", lang, {
        action: afterMinute.node.action,
        location: afterMinute.node.location,
      }),
    };
    return {
      node: completedNode,
      moved: true,
      action: buildMovementAction(
        completedNode,
        "completed",
        currentTime,
        afterMinute.node.location,
        completedNode.outcome!
      ),
    };
  }

  return {
    node: afterMinute.node,
    moved: true,
  };
}

// ==================== Discovery ====================

const DIFFICULTY_RANK: Record<string, number> = {
  automatic: 0,
  regular: 1,
  hard: 2,
  extreme: 3,
};

/** success level -> max difficulty rank discoverable */
const SUCCESS_TO_MAX_RANK: Record<SuccessLevel, number> = {
  critical: 3, // extreme
  hard: 2, // hard
  regular: 1, // regular
  fail: 0, // automatic only
  fumble: -1, // nothing, may damage evidence
};

const DISCOVERY_SIMILARITY_THRESHOLD = 0.7;

// Lazy embedding client singleton for evidence discovery semantic matching.
let _embeddingClient: EmbeddingClient | null = null;
function getEmbeddingClient(): EmbeddingClient {
  if (!_embeddingClient) {
    const provider =
      (process.env.MODEL_PROVIDER as ModelProviderName) ||
      ModelProviderName.OPENAI;
    _embeddingClient = new EmbeddingClient(provider);
  }
  return _embeddingClient;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

interface DiscoveryCandidate {
  id: string;
  text: string;
  difficulty: string;
  source: "evidence" | "npc";
  sourceId: string;
  sourceName: string;
}

/**
 * Discover evidence items (from scenes) after a successful action.
 * Triggered by scene_interaction / object_interaction.
 * Candidates: scene.items where category === "evidence" and !damaged.
 */
async function discoverEvidence(
  node: PlanNode,
  successLevel: SuccessLevel,
  dgsm: DynamicGameStateManager,
  language: string,
  sceneId: string
): Promise<DiscoveryEntry[]> {
  const scene = dgsm.getScene(sceneId);
  if (!scene?.items) return [];
  if (node.type !== "scene_interaction" && node.type !== "object_interaction")
    return [];

  // If skill roll was made, success level gates difficulty; otherwise automatic only
  const maxRank = node.skill ? (SUCCESS_TO_MAX_RANK[successLevel] ?? 0) : 0;

  const candidates: DiscoveryCandidate[] = [];
  for (const item of scene.items) {
    if (item.category !== "evidence" || item.damaged) continue;
    const difficulty = item.discoveryMethod ? "regular" : "automatic";
    const rank = DIFFICULTY_RANK[difficulty] ?? 1;
    if (rank > maxRank) continue;
    candidates.push({
      id: item.id,
      text: item.description || item.name,
      difficulty,
      source: "evidence",
      sourceId: scene.id,
      sourceName: scene.name,
    });
  }

  return matchCandidates(candidates, node, language);
}

/**
 * Load all candidate NPC knowledge for a character_interaction.
 * The LLM decides what actually gets transferred.
 */
async function discoverNpcKnowledge(
  node: PlanNode,
  dgsm: DynamicGameStateManager,
  memoryManager: NpcMemoryManager
): Promise<DiscoveryEntry[]> {
  if (node.type !== "character_interaction") return [];

  const state = dgsm.getState();
  const targetIds = resolveTargets(node);
  const discoveries: DiscoveryEntry[] = [];

  for (const targetId of targetIds) {
    const targetNpc = state.npcCharacters.find((n) => n.id === targetId);
    if (!targetNpc) continue;

    const targetMemories = await memoryManager.getAllByTypes(
      targetId,
      state.sessionId,
      ["information", "secret"]
    );

    for (const mem of targetMemories) {
      const meta = mem.metadata as Record<string, any> | null;
      discoveries.push({
        id: (meta?.knowledgeId as string) ?? mem.id,
        text: mem.content,
        difficulty: ((meta?.difficulty as string) ??
          (mem.type === "secret"
            ? "hard"
            : "regular")) as DiscoveryEntry["difficulty"],
        source: "npc",
        sourceId: targetNpc.id,
        sourceName: targetNpc.name,
        similarity: 1,
      });
    }
  }

  return discoveries;
}

/** Common logic: split automatic vs semantic-match candidates. */
async function matchCandidates(
  candidates: DiscoveryCandidate[],
  node: PlanNode,
  language: string
): Promise<DiscoveryEntry[]> {
  if (candidates.length === 0) return [];

  const automaticCandidates: DiscoveryCandidate[] = [];
  const semanticCandidates: DiscoveryCandidate[] = [];

  for (const c of candidates) {
    if (c.difficulty === "automatic") {
      automaticCandidates.push(c);
    } else {
      semanticCandidates.push(c);
    }
  }

  const automaticResults: DiscoveryEntry[] = automaticCandidates
    .slice(0, 1)
    .map((candidate) => ({
      id: candidate.id,
      text: candidate.text,
      source: candidate.source,
      sourceId: candidate.sourceId,
      sourceName: candidate.sourceName,
      difficulty: "automatic",
      similarity: 0,
    }));

  // All candidates (including automatic) go through semantic matching
  const allSemanticCandidates = [...automaticCandidates, ...semanticCandidates];
  if (allSemanticCandidates.length === 0) return [];

  try {
    const embedClient = getEmbeddingClient();
    const lang = (language?.startsWith("zh") ? "zh" : "en") as "zh" | "en";
    const actionEmbedding = await embedClient.embed(node.action, {
      language: lang,
    });
    if (!actionEmbedding.length) return [];

    allSemanticCandidates.sort(
      (a, b) =>
        (DIFFICULTY_RANK[b.difficulty] ?? 0) -
        (DIFFICULTY_RANK[a.difficulty] ?? 0)
    );

    const matched: DiscoveryEntry[] = [];
    for (const c of allSemanticCandidates) {
      const cEmbedding = await embedClient.embed(c.text, { language: lang });
      if (!cEmbedding.length) continue;

      const sim = cosineSimilarity(actionEmbedding, cEmbedding);
      if (sim >= DISCOVERY_SIMILARITY_THRESHOLD) {
        matched.push({
          id: c.id,
          text: c.text,
          source: c.source,
          sourceId: c.sourceId,
          sourceName: c.sourceName,
          difficulty: c.difficulty as DiscoveryEntry["difficulty"],
          similarity: sim,
        });
      }
    }

    matched.sort((a, b) => {
      const diffDelta =
        (DIFFICULTY_RANK[b.difficulty] ?? 0) -
        (DIFFICULTY_RANK[a.difficulty] ?? 0);
      if (diffDelta !== 0) return diffDelta;
      return b.similarity - a.similarity;
    });

    // Limit automatic discoveries to 1 per interaction (drip-feed)
    let automaticCount = 0;
    const results: DiscoveryEntry[] = [];
    for (const entry of matched) {
      if (entry.difficulty === "automatic") {
        if (automaticCount >= 1) continue;
        automaticCount++;
      }
      results.push(entry);
    }

    return results;
  } catch (error) {
    console.warn("[TickProcessor] Discovery embedding failed:", error);
    return automaticResults;
  }
}

// ==================== Discovery RAG embedding ====================

function embedDiscoveries(
  discoveries: DiscoveryEntry[],
  dgsm: DynamicGameStateManager,
  language: "en" | "zh"
): void {
  if (discoveries.length === 0) return;
  const ragService = new SessionRagService();
  const state = dgsm.getState();
  const ragChunks: SessionRagChunkInput[] = discoveries.map((entry) => ({
    sessionId: state.sessionId,
    chunkType: "discovery" as const,
    role: "system" as const,
    content: [
      "Discovery",
      `Type: ${entry.source}`,
      `Source: ${entry.sourceName}`,
      `Content: ${entry.text}`,
    ].join("\n"),
    metadata: {
      discoveryType: entry.source,
      sourceName: entry.sourceName,
      discoveredAt: `Day ${state.gameDay}, ${state.timeOfDay}`,
    },
    sourceKey: `discovery:${entry.id}`,
    language,
  }));
  void ragService
    .upsertChunks(ragChunks)
    .catch((err) =>
      console.error("[TickProcessor] Failed to embed discovery:", err)
    );
}

// ==================== Single tick execution ====================

interface SingleTickParams {
  tickStartMinutes: number;
  tickDurationMinutes: number;
  /** Nodes injected by previous ticks' feature propagation, to be executed in this tick */
  carryOverNodes?: PlanNode[];
  dgsm: DynamicGameStateManager;
  npcPlanningAgent: NPCPlanningAgent;
  sessionId: string;
  moduleId: string;
  language: string;
  registry: GameEngineRegistry;
  ctx: ExecutionContext;
  memoryManager?: NpcMemoryManager;
}

interface SingleTickResult {
  actions: CharacterAction[];
  injectedNodes: PlanNode[];
  worldEvents: import("./types.js").WorldEventDescriptor[];
}

/**
 * Execute a single 1-minute simulation tick.
 *
 * 1. Fetch NPC nodes due in [tickStart, tickEnd)
 * 2. Merge with carry-over nodes, sort (gameTime ASC, DEX DESC), scan encounters
 * 3. Execute all nodes via registry handlers
 * 4. Post-execution: relationship update, NPC memory, discovery, NPC failure revisePlans
 * 5. Built-in impact propagation (scan impact>0 actions, notify affected NPCs, LLM gate, plan revision)
 * 6. Feature temporal tick — each feature updates its time/state-driven logic
 * 7. Detect feature overlay fields on executed nodes → register propagation sources
 * 8. Drive feature propagation on schedule
 * 9. Return tick result
 */
async function executeSingleTick(
  params: SingleTickParams
): Promise<SingleTickResult> {
  const {
    tickStartMinutes,
    tickDurationMinutes,
    carryOverNodes,
    dgsm,
    npcPlanningAgent,
    sessionId,
    moduleId,
    language,
    registry,
    ctx,
    memoryManager,
  } = params;

  const state = dgsm.getState();
  const gameDay = state.gameDay;
  const tickEndMinutes = tickStartMinutes + tickDurationMinutes - 1; // inclusive end
  const tickStartTime = minutesToTimeLabel(tickStartMinutes);
  const tickEndTime = minutesToTimeLabel(tickEndMinutes);
  const isFullTick = tickDurationMinutes >= TICK_DURATION_MINUTES;
  ctx.currentTime = tickStartTime;

  // Build runtime context for WorldFeature hooks
  const tickRuntime: TickRuntimeContext = {
    sessionId,
    gameDay,
    language,
    tickTime: tickStartTime,
    tickDurationMinutes,
    npcPlanning: npcPlanningAgent,
  };

  // 0. Ensure NPCs have detailed nodes available (two-tier planning refill)
  const allNpcIds = dgsm.getSimulatedNpcs().map((n) => n.id);
  await Promise.all(
    allNpcIds.map((npcId) =>
      npcPlanningAgent.ensureNpcNodesAvailable(
        dgsm,
        sessionId,
        npcId,
        gameDay,
        tickStartTime,
        language,
        registry
      )
    )
  );

  // 1. Get active and due nodes for this minute
  const inProgressNodes = await npcPlanningAgent.getInProgressNodes(
    sessionId,
    gameDay,
    dgsm
  );
  const dueNpcNodes = await npcPlanningAgent.getDueNpcNodes(
    sessionId,
    gameDay,
    tickEndTime,
    dgsm
  );

  const nodeByNpc = new Map<string, PlanNode>();
  for (const node of inProgressNodes) {
    nodeByNpc.set(node.characterId, node);
  }
  for (const node of dueNpcNodes) {
    if (nodeByNpc.has(node.characterId)) continue;
    const existing = nodeByNpc.get(node.characterId);
    if (!existing) {
      nodeByNpc.set(node.characterId, node);
      continue;
    }
    const existingNpc = state.npcCharacters.find(
      (n) => n.id === existing.characterId
    );
    const nodeNpc = state.npcCharacters.find((n) => n.id === node.characterId);
    const existingDex = existingNpc?.attributes?.DEX ?? 50;
    const nodeDex = nodeNpc?.attributes?.DEX ?? 50;
    if (
      node.startTime < existing.startTime ||
      (node.startTime === existing.startTime && nodeDex > existingDex)
    ) {
      nodeByNpc.set(node.characterId, node);
    }
  }

  const allNodes: PlanNode[] = [
    ...nodeByNpc.values(),
    ...(carryOverNodes ?? []),
  ].filter((node) => dgsm.isNpcAlive(node.characterId));

  allNodes.sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === "in_progress" ? -1 : 1;
    }
    const timeDiff = a.startTime.localeCompare(b.startTime);
    if (timeDiff !== 0) return timeDiff;
    const npcA = state.npcCharacters.find((n) => n.id === a.characterId);
    const npcB = state.npcCharacters.find((n) => n.id === b.characterId);
    const dexA = npcA?.attributes?.DEX ?? 50;
    const dexB = npcB?.attributes?.DEX ?? 50;
    return dexB - dexA;
  });

  const tickActions: CharacterAction[] = [];
  const executedNodes: PlanNode[] = [];
  const nodesReadyToExecute: PlanNode[] = [];
  const movementFinalizations: Array<{
    node: PlanNode;
    action: CharacterAction;
  }> = [];
  const movedNpcIds = new Set<string>();
  const pendingRevisionRequests: Array<{
    npcId: string;
    trigger: FailureTrigger;
    reactionQuery: string;
  }> = [];

  const recordRevisionInterruption = async (
    action: CharacterAction | undefined
  ): Promise<void> => {
    if (!action) return;

    tickActions.push(action);
    if (!memoryManager) return;

    await memoryManager.add({
      npcId: action.characterId,
      sessionId,
      moduleId,
      type: "event",
      content: action.outcome,
      gameDay,
      gameTime: action.gameTime,
      location: action.location,
      metadata: {
        outcome: action.outcome,
        interruptionReason: action.interruptionReason ?? "",
      },
    });
  };

  for (const rawNode of allNodes) {
    if (rawNode.type === "movement") {
      const initializedNode =
        rawNode.status === "pending"
          ? initializeMovementNode(rawNode, dgsm, tickStartTime, language)
          : rawNode;

      const advancedMovement = advanceMovementNodeOneMinute(
        initializedNode,
        dgsm,
        tickStartTime,
        language
      );
      await npcPlanningAgent.updateNode(
        sessionId,
        rawNode.characterId,
        gameDay,
        advancedMovement.node
      );
      if (advancedMovement.moved) {
        movedNpcIds.add(rawNode.characterId);
        // Hidden NPC moving: Stealth check to stay concealed
        if (dgsm.isCharacterHidden(rawNode.characterId)) {
          if (!rollStealthForMovement(dgsm, rawNode.characterId)) {
            dgsm.setCharacterHidden(rawNode.characterId, false);
          }
        }
      }
      if (advancedMovement.action) {
        movementFinalizations.push({
          node: advancedMovement.node,
          action: advancedMovement.action,
        });
        executedNodes.push(advancedMovement.node);
      }
      continue;
    }

    let node = rawNode;
    if (node.status === "pending") {
      node = startNode(node, tickStartTime);
      // Fire onNodeStart hooks for feature overlays (e.g., prerequisite location checks)
      const blocked = registry.startNodeFeatures(node, dgsm);
      if (blocked) {
        // Prerequisite failed at action start — abort this node
        const failedNode: PlanNode = {
          ...node,
          status: "failed",
          executionMeta: {
            ...node.executionMeta,
            failedAt: tickStartTime,
            remainingMinutes: 0,
            blockedReason: blocked.reason,
          },
        };
        await npcPlanningAgent.updateNode(
          sessionId,
          node.characterId,
          gameDay,
          failedNode
        );
        tickActions.push({
          characterId: node.characterId,
          characterName: node.characterName,
          gameTime: tickStartTime,
          action: node.action,
          location: node.location,
          type: node.type,
          impact: node.impact ?? 0,
          status: "failed",
          failureReason: "prerequisite_not_met",
          outcome: blocked.reason,
        });
        pendingRevisionRequests.push({
          npcId: node.characterId,
          trigger: {
            type: "failure",
            failureReason: "prerequisite_not_met",
            action: node.action,
            gameTime: tickStartTime,
            failureOutcome: blocked.reason,
          },
          reactionQuery: blocked.reason,
        });
        continue;
      }
    }

    const remainingMinutes = Math.max(
      0,
      node.executionMeta.remainingMinutes - 1
    );
    if (remainingMinutes > 0) {
      await npcPlanningAgent.updateNode(sessionId, node.characterId, gameDay, {
        ...node,
        executionMeta: {
          ...node.executionMeta,
          remainingMinutes,
        },
      });
      continue;
    }

    nodesReadyToExecute.push({
      ...node,
      executionMeta: {
        ...node.executionMeta,
        remainingMinutes: 0,
      },
    });
  }

  // 2. Execute nodes that reach their final minute in this tick
  for (const node of nodesReadyToExecute) {
    // Dispatch to registry handler
    const handler = registry.getHandler(node.type);
    if (!handler) {
      console.warn(
        `[TickProcessor] No handler for node type: ${node.type}, skipping`
      );
      continue;
    }
    executedNodes.push(node);
    const itemContext = getItemActionContext(dgsm, node);
    let action = await handler.execute(node, dgsm, ctx);

    // Auto-movement: if the NPC isn't at the expected location, pathfind there
    // automatically instead of triggering an expensive LLM revision.
    if (action.failureReason === "location_mismatch") {
      const currentPos = dgsm.getCharacterPosition(node.characterId);
      const topology = dgsm.getTopology();
      const targetPos = resolveTargetPosition(node.location, topology, dgsm);

      if (currentPos && targetPos) {
        const route = buildMovementRouteIgnoringBlocks(
          currentPos,
          targetPos,
          topology,
          dgsm
        );
        if (route) {
          const travelMinutes = Math.max(1, Math.ceil(route.totalMinutes));
          const fromLocationId = dgsm.resolveLocationId(currentPos);

          // Move the NPC to the destination
          dgsm.setCharacterPosition(node.characterId, targetPos);
          movedNpcIds.add(node.characterId);

          // Shift all subsequent pending nodes for this NPC
          await npcPlanningAgent.shiftPendingNodesByDelta(
            sessionId,
            node.characterId,
            gameDay,
            tickStartTime,
            -travelMinutes
          );

          // Record travel memory
          if (memoryManager) {
            await memoryManager.add({
              npcId: node.characterId,
              sessionId,
              moduleId,
              type: "event",
              content: t("walked_from_to", language, {
                from: fromLocationId,
                to: node.location,
                minutes: String(travelMinutes),
              }),
              gameDay,
              gameTime: tickStartTime,
              location: node.location,
              metadata: {
                outcome: t("auto_movement_outcome", language, {
                  from: fromLocationId,
                  to: node.location,
                }),
              },
            });
          }

          console.log(
            `[TickProcessor] Auto-movement: ${node.characterName} walked from ${fromLocationId} to ${node.location} (~${travelMinutes} min)`
          );

          // Re-execute the handler now that the NPC is at the correct location
          action = await handler.execute(node, dgsm, ctx);
        }
      }
    }

    // Auto-movement for object_not_found: search sibling sub-scenes in the
    // same building for the missing item, walk there, and retry.
    if (
      action.failureReason === "object_not_found" &&
      node.objectInteractionPayload?.itemId
    ) {
      const itemId = node.objectInteractionPayload.itemId;
      const currentScene = dgsm.getScene(node.location);
      const parentId = currentScene?.parentLocationId;

      if (parentId && parentId !== "OUTDOOR") {
        const state = dgsm.getState();
        let targetSceneId: string | undefined;

        for (const [sceneId, scene] of state.scenes) {
          if (sceneId === node.location) continue;
          if (scene.parentLocationId !== parentId) continue;
          const found =
            scene.items?.some((i) => i.id === itemId) ||
            scene.items?.some((i) =>
              i.containerStats?.storedItems?.some((s) => s.id === itemId)
            );
          if (found) {
            targetSceneId = sceneId;
            break;
          }
        }

        if (targetSceneId) {
          const fromLocationId = node.location;

          dgsm.setCharacterPosition(node.characterId, {
            type: "scene",
            sceneId: targetSceneId,
          });

          await npcPlanningAgent.shiftPendingNodesByDelta(
            sessionId,
            node.characterId,
            gameDay,
            tickStartTime,
            -1
          );

          if (memoryManager) {
            await memoryManager.add({
              npcId: node.characterId,
              sessionId,
              moduleId,
              type: "event",
              content: t("walked_for_item", language, {
                from: fromLocationId,
                to: targetSceneId,
                item: itemId,
              }),
              gameDay,
              gameTime: tickStartTime,
              location: targetSceneId,
              metadata: {
                outcome: t("auto_movement_item_outcome", language, {
                  from: fromLocationId,
                  to: targetSceneId,
                  item: itemId,
                }),
              },
            });
          }

          console.log(
            `[TickProcessor] Auto-movement: ${node.characterName} walked from ${fromLocationId} to ${targetSceneId} for item ${itemId}`
          );

          node.location = targetSceneId;
          action = await handler.execute(node, dgsm, ctx);
        }
      }
    }

    tickActions.push(action);

    // Stealth: successful Stealth → hide; any other action → reveal
    if (action.status === "completed" && node.skill === "Stealth") {
      dgsm.setCharacterHidden(node.characterId, true);
    } else if (dgsm.isCharacterHidden(node.characterId)) {
      dgsm.setCharacterHidden(node.characterId, false);
    }

    // 3b. Activate feature overlays for this node (per-node, before resolver/memory)
    const featureResults = registry.activateNodeFeatures(node, dgsm);
    const featureNotes = featureResults
      .map((r) => r.outcomeNote)
      .filter(Boolean) as string[];

    let eventOutcome = appendItemContext(action.outcome, itemContext);
    const eventMetadata = buildEventMetadata(action.outcome, itemContext);
    const allTargetIds = node.targetCharacterIds ?? [];

    // If non-resolver action has feature notes, replace outcome
    if (
      featureNotes.length > 0 &&
      node.type !== "character_interaction" &&
      node.type !== "object_interaction"
    ) {
      const combined = featureNotes.join(" ");
      action.outcome = combined;
      eventOutcome = combined;
    }

    // 4. Post-execution processing

    // 4a. character_interaction: load full NPC knowledge first, then let the LLM decide transfer
    if (
      action.status === "completed" &&
      node.type === "character_interaction"
    ) {
      const npcKnowledge = memoryManager
        ? await discoverNpcKnowledge(node, dgsm, memoryManager)
        : [];

      const skillRollResult = action.successLevel
        ? {
            successLevel: action.successLevel,
            detail: action.rollDetail ?? "",
            perTargetResults: action.perTargetResults,
          }
        : null;

      const delta = await resolveInteractionState(
        node,
        dgsm,
        ctx.runtime,
        skillRollResult,
        npcKnowledge,
        language,
        registry,
        featureNotes
      );

      // Apply actor state changes
      const interactionTargets = resolveTargets(node);
      await applyCharacterDelta(
        dgsm,
        node.characterId,
        delta.actorChanges,
        interactionTargets.length > 0 ? interactionTargets : [node.characterId],
        memoryManager,
        sessionId,
        moduleId,
        gameDay,
        node.endTime
      );

      // Apply each target's state changes
      for (const targetId of Object.keys(delta.targetChanges)) {
        await applyCharacterDelta(
          dgsm,
          targetId,
          delta.targetChanges[targetId],
          [node.characterId],
          memoryManager,
          sessionId,
          moduleId,
          gameDay,
          node.endTime
        );
      }

      // Update action with LLM-resolved memory
      action.outcome = delta.actorChanges.memory;
      action.stateMemories = {
        [node.characterId]: delta.actorChanges.memory,
        ...Object.fromEntries(
          Object.entries(delta.targetChanges).map(([id, d]) => [id, d.memory])
        ),
      };
    }

    // 4b. object_interaction: call LLM resolver for item state changes + memories
    if (action.status === "completed" && node.type === "object_interaction") {
      const objSkillRollResult = action.successLevel
        ? { successLevel: action.successLevel, detail: action.rollDetail ?? "" }
        : null;

      const objDelta = await resolveObjectInteractionState(
        node,
        dgsm,
        ctx.runtime,
        objSkillRollResult,
        language,
        memoryManager,
        sessionId,
        registry,
        featureNotes
      );

      applyObjectDelta(dgsm, node.characterId, objDelta, node.location);

      action.outcome = objDelta.memory;
      action.stateMemories = {
        [node.characterId]: objDelta.memory,
        ...(objDelta.witnessMemories ?? {}),
      };
    }

    // On character_interaction success -> update relationships with all targets
    let relationshipChange: string | undefined;
    if (
      action.status === "completed" &&
      node.type === "character_interaction" &&
      allTargetIds.length > 0
    ) {
      const relParts: string[] = [];
      for (const targetId of allTargetIds) {
        const relResult = await npcPlanningAgent.updateRelationshipViaLLM(
          dgsm,
          node.characterId,
          targetId,
          action.outcome,
          language
        );
        if (relResult) {
          const sign = relResult.scoreDelta >= 0 ? "+" : "";
          const targetName =
            state.npcCharacters.find((n) => n.id === targetId)?.name ??
            targetId;
          relParts.push(
            `[rel:${targetName} ${sign}${relResult.scoreDelta} → ${relResult.newScore}]`
          );
        }
      }
      if (relParts.length > 0) {
        relationshipChange = relParts.join(" ");
      }
    }

    // Log NPC actions and mark completed
    {
      // Actor event memory: prefer stateMemories if available
      let logEntry = action.stateMemories?.[node.characterId] ?? eventOutcome;
      if (relationshipChange) logEntry += ` ${relationshipChange}`;

      // Write event memory via NpcMemoryManager
      if (memoryManager) {
        await memoryManager.add({
          npcId: node.characterId,
          sessionId,
          moduleId,
          type: "event",
          content: logEntry,
          gameDay,
          gameTime: action.gameTime,
          location: action.location,
          metadata: eventMetadata,
        });
      }

      // Mirror write: other participants get event memories
      if (memoryManager && action.stateMemories) {
        // Write memories for each target in stateMemories (except actor)
        for (const [charId, memoryText] of Object.entries(
          action.stateMemories
        )) {
          if (charId === node.characterId) continue; // actor already written above
          await memoryManager.add({
            npcId: charId,
            sessionId,
            moduleId,
            type: "event",
            content: memoryText,
            gameDay,
            gameTime: action.gameTime,
            location: action.location,
            metadata: eventMetadata,
          });
        }
      } else if (
        memoryManager &&
        action.status === "completed" &&
        node.type === "character_interaction" &&
        allTargetIds.length > 0
      ) {
        // Fallback mirror write for non-stateMemories handlers
        const initiatorName = node.characterName;
        for (const targetId of allTargetIds) {
          await memoryManager.add({
            npcId: targetId,
            sessionId,
            moduleId,
            type: "event",
            content: t("fallback_mirror_memory", language, {
              name: initiatorName,
              action: action.action,
              outcome: eventOutcome,
            }),
            gameDay,
            gameTime: action.gameTime,
            location: action.location,
            metadata: eventMetadata,
          });
        }
      }

      await npcPlanningAgent.markNodeCompleted(
        sessionId,
        node.characterId,
        gameDay,
        node.nodeId,
        action.outcome
      );
    }

    // Discovery — NPC discovers evidence on successful actions
    // Note: character_interaction npcKnowledge is already handled in step 4a above.
    if (action.status === "completed") {
      const effectiveSuccess: SuccessLevel = action.successLevel ?? "regular";
      const evidence = await discoverEvidence(
        node,
        effectiveSuccess,
        dgsm,
        language,
        node.location
      );
      const allDiscoveries = evidence;

      if (allDiscoveries.length > 0) {
        // Merge with any discoveries already set (e.g. from step 4a)
        action.discoveries = [...(action.discoveries ?? []), ...allDiscoveries];
        embedDiscoveries(allDiscoveries, dgsm, language as "en" | "zh");
        console.log(
          `[TickProcessor] NPC discovered ${allDiscoveries.length} item(s): ${allDiscoveries.map((d) => `[${d.difficulty}] ${d.text.slice(0, 40)}`).join("; ")}`
        );
      }
    }

    logNodeExecutionResult(node, action);

    // Fumble -> damage a random evidence item in the NPC's current scene
    if (action.successLevel === "fumble") {
      const scene = dgsm.getScene(node.location);
      const damageable =
        scene?.items?.filter((i) => i.category === "evidence" && !i.damaged) ??
        [];
      if (damageable.length > 0) {
        const victim =
          damageable[Math.floor(Math.random() * damageable.length)];
        dgsm.damageEvidenceItem(
          victim.id,
          node.characterName,
          `Fumbled: ${node.action}`,
          node.location
        );
        action.damagedEvidence = { itemId: victim.id, sourceName: scene!.name };
        console.log(
          `[TickProcessor] Fumble damaged evidence: ${(victim.description || victim.name).slice(0, 40)}`
        );
      }
    }

    // On failure -> mark node as failed (removes from pending), then revisePlans
    if (action.status === "failed") {
      // Remove the failed node first so revisePlans won't see it in pendingNodes
      await npcPlanningAgent.markNodeFailed(
        sessionId,
        node.characterId,
        gameDay,
        node.nodeId,
        action.failureReason ?? "unknown"
      );

      pendingRevisionRequests.push({
        npcId: node.characterId,
        trigger: {
          type: "failure",
          failureReason: action.failureReason!,
          action: action.action,
          gameTime: action.gameTime,
          failureOutcome: action.outcome,
        },
        reactionQuery: `${action.action} failed: ${action.outcome}`,
      });
    }
  }

  for (const { node, action } of movementFinalizations) {
    tickActions.push(action);
    logNodeExecutionResult(node, action);

    if (memoryManager) {
      await memoryManager.add({
        npcId: node.characterId,
        sessionId,
        moduleId,
        type: "event",
        content: action.outcome,
        gameDay,
        gameTime: action.gameTime,
        location: action.location,
        metadata: {
          outcome: action.outcome,
          failureReason: action.failureReason ?? "",
          blockedReason: node.executionMeta.blockedReason ?? "",
        },
      });
    }

    if (action.status === "failed") {
      pendingRevisionRequests.push({
        npcId: node.characterId,
        trigger: {
          type: "failure",
          failureReason: "location_blocked",
          action: action.action,
          gameTime: action.gameTime,
          failureOutcome: action.outcome,
          blockedReason: node.executionMeta.blockedReason,
        },
        reactionQuery: `${action.action} failed: ${node.executionMeta.blockedReason ?? action.outcome}`,
      });
    } else if (action.status === "completed") {
      const scheduledEndMinutes = timeToMinutes(node.endTime);
      const actualEndMinutes = timeToMinutes(action.gameTime);
      const scheduleDeltaMinutes = scheduledEndMinutes - actualEndMinutes;

      if (scheduleDeltaMinutes !== 0) {
        await npcPlanningAgent.shiftPendingNodesByDelta(
          sessionId,
          node.characterId,
          gameDay,
          node.endTime,
          scheduleDeltaMinutes
        );
      }
    }
  }

  if (pendingRevisionRequests.length > 0) {
    const revisionResults = await Promise.all(
      pendingRevisionRequests.map(async (request) => {
        let failureContext: string | undefined;
        if (memoryManager) {
          failureContext = await memoryManager.getContext({
            npcId: request.npcId,
            sessionId,
            purpose: "reaction",
            query: request.reactionQuery,
            currentGameDay: gameDay,
          });
        }
        const longTermIntent = await npcPlanningAgent.getLongTermIntent(
          sessionId,
          request.npcId
        );
        const memoryLog = failureContext ? [failureContext] : [];
        const reviseResult = await npcPlanningAgent.revisePlans(
          dgsm,
          sessionId,
          request.npcId,
          {
            longTermIntent,
            memoryLog,
            pendingNodes: [],
            trigger: request.trigger,
          },
          language,
          registry
        );

        return reviseResult.interruptedAction;
      })
    );

    for (const interruptedAction of revisionResults) {
      await recordRevisionInterruption(interruptedAction);
    }
  }

  // 4.5 Scan NPC co-presence → write witness memories + build synthetic encounter events
  const encounterEvents = scanUnplannedEncounters(
    dgsm,
    tickStartTime,
    tickActions,
    movedNpcIds,
    memoryManager,
    sessionId,
    moduleId,
    gameDay,
    language
  );

  // 5. Built-in impact propagation
  //    Scans for actions that pass the impact-gate threshold:
  //    impact >= 2, or impact === 1 with a skill check.
  //    Then notifies affected NPCs, runs the LLM impact gate,
  //    and triggers plan revision if needed.
  const injectedNodes: PlanNode[] = [];

  const impactEvents = [
    ...tickActions.filter((a) => shouldRunImpactGate(a)),
    ...encounterEvents,
  ];
  if (impactEvents.length > 0) {
    // Aggregate affected characters across all impact events
    const characterEventsMap = new Map<
      string,
      Array<{ event: CharacterAction; impact: number }>
    >();

    for (const event of impactEvents) {
      const affected = findAffectedCharacters(event, event.impact, dgsm);
      for (const [charId, level] of affected) {
        if (!characterEventsMap.has(charId)) characterEventsMap.set(charId, []);
        const existing = characterEventsMap.get(charId)!;
        const idx = existing.findIndex((e) => e.event === event);
        if (idx >= 0) {
          if (level > existing[idx].impact) existing[idx].impact = level;
        } else {
          existing.push({ event, impact: level });
        }
      }
    }

    // NPC processing — parallel LLM calls
    if (characterEventsMap.size > 0) {
      await Promise.all(
        [...characterEventsMap.entries()].map(async ([npcId, npcEvents]) => {
          const npc = state.npcCharacters.find((n) => n.id === npcId);
          const pendingNodes = await npcPlanningAgent.getPendingNodes(
            sessionId,
            npcId,
            gameDay
          );
          const plan = await npcPlanningAgent.getDailyPlan(
            sessionId,
            npcId,
            gameDay
          );
          const schedule =
            (plan?.schedule as unknown as import(
              "./types.js"
            ).ScheduleEntry[]) ?? [];
          let reactionContext: string | undefined;
          if (memoryManager) {
            const triggeringEvents = npcEvents
              .map((e) =>
                buildImpactEventText(
                  classifyImpactPerspective(npcId, e.event),
                  e.event,
                  e.impact,
                  language
                )
              )
              .join("\n");
            reactionContext = await memoryManager.getContext({
              npcId,
              sessionId,
              purpose: "reaction",
              query: triggeringEvents,
              currentGameDay: gameDay,
            });
          }
          const longTermIntent = await npcPlanningAgent.getLongTermIntent(
            sessionId,
            npcId
          );
          const sortedEvents = [...npcEvents].sort(
            (a, b) => b.impact - a.impact
          );
          const primaryEvent = sortedEvents[0]?.event;
          const perspective = primaryEvent
            ? classifyImpactPerspective(npcId, primaryEvent)
            : "witness";
          const triggeringEvents = npcEvents
            .map((e) =>
              buildImpactEventText(
                classifyImpactPerspective(npcId, e.event),
                e.event,
                e.impact,
                language
              )
            )
            .join("\n");

          const result = await npcPlanningAgent.runImpactGateForNpc(
            {
              npcId,
              npcName: npc?.name ?? npcId,
              currentLocation: (() => {
                const p = dgsm.getCharacterPosition(npcId);
                return p ? dgsm.resolveLocationId(p) : "unknown";
              })(),
              longTermIntent,
              todayScheduleSummary: schedule
                .map((s) => `${s.location}: ${s.activity}`)
                .join("; "),
              currentDetailedPlan: pendingNodes
                .map((n) => `${n.startTime}-${n.endTime} ${n.action}`)
                .join("; "),
              triggeringEvents,
              memoryContext: reactionContext,
            },
            tickRuntime.tickTime,
            language
          );

          const logEntry = primaryEvent
            ? buildImpactMemoryContent(
                perspective,
                tickRuntime.tickTime,
                gameDay,
                result.witnessEntry,
                language
              )
            : `[witness] ${result.witnessEntry}`;
          const npcLocPos = dgsm.getCharacterPosition(npcId);
          const npcLoc = npcLocPos
            ? dgsm.resolveLocationId(npcLocPos)
            : "unknown";

          // Write witness memory via NpcMemoryManager
          if (memoryManager) {
            await memoryManager.add({
              npcId,
              sessionId,
              moduleId,
              type: perspective === "targeted" ? "event" : "witness",
              content: logEntry,
              gameDay,
              gameTime: tickRuntime.tickTime,
              location: npcLoc,
              metadata: {
                sourceCharacterId: primaryEvent?.characterId ?? "",
                sourceAction: primaryEvent?.outcome ?? "",
                impact: sortedEvents[0]?.impact ?? 1,
                perspective,
              },
            });
          }

          if (result.shouldRevise) {
            // Use unified memory context for revision, or empty array as fallback
            const memoryLog = reactionContext ? [reactionContext] : [];
            const reviseResult = await npcPlanningAgent.revisePlans(
              dgsm,
              sessionId,
              npcId,
              {
                longTermIntent,
                memoryLog,
                pendingNodes,
                trigger: {
                  type: "impact",
                  triggeringAction: primaryEvent!,
                },
              },
              language,
              registry
            );
            await recordRevisionInterruption(reviseResult.interruptedAction);

            // Trigger reasoning for high-impact events
            if (memoryManager) {
              const npcForReasoning = state.npcCharacters.find(
                (n) => n.id === npcId
              );
              const npcProfile =
                npcForReasoning?.background ?? npcForReasoning?.backstory ?? "";
              const generateTextFn = (prompt: string) =>
                generateText({
                  runtime: npcPlanningAgent.getRuntime(),
                  context: prompt,
                  modelClass: ModelClass.MEDIUM,
                });
              await memoryManager.triggerReasoning(
                {
                  npcId,
                  sessionId,
                  moduleId,
                  trigger: "high_impact",
                  context: triggeringEvents,
                  gameDay,
                  gameTime: tickRuntime.tickTime,
                },
                npcForReasoning?.name ?? npcId,
                npcProfile,
                generateTextFn,
                language
              );
            }
          }
          if (result.shouldReviseSchedule) {
            const triggerDesc = primaryEvent
              ? buildImpactEventText(
                  perspective,
                  primaryEvent,
                  sortedEvents[0]?.impact ?? 1,
                  language
                )
              : t("perceived_something", language);
            await npcPlanningAgent.reviseSchedule(
              dgsm,
              sessionId,
              npcId,
              triggerDesc,
              language,
              registry
            );
          }
        })
      );
    }
  }

  // 6. Feature temporal tick — let each feature update its time/state-driven logic
  for (const feature of registry.getAllFeatures()) {
    feature.tick?.(dgsm, tickRuntime);
  }

  // 7. Feature overlay activation already done per-node in step 3b above.
  //    (propagation sources registered there as well)

  // 8. Drive feature propagation on schedule
  for (const feature of registry.getAllFeatures()) {
    if (!feature.propagation || !feature.propagate) continue;
    if (!registry.shouldPropagationFire(feature.id, isFullTick)) continue;

    const sources = registry.getPropagationSources(feature.id);
    if (sources.length === 0) continue;

    const nextSources: Array<{ sceneId: string; currentHop: number }> = [];

    for (const source of sources) {
      const propResult = await feature.propagate(
        source.sceneId,
        source.currentHop,
        dgsm,
        tickRuntime
      );

      // New scenes become sources at hop+1
      for (const newSceneId of propResult.spreadTo) {
        nextSources.push({
          sceneId: newSceneId,
          currentHop: source.currentHop + 1,
        });
      }
      // Original source persists at hop+1
      nextSources.push({
        sceneId: source.sceneId,
        currentHop: source.currentHop + 1,
      });

      // Collect propagation-injected nodes
      if (propResult.newNodes?.length) {
        injectedNodes.push(...propResult.newNodes);
      }
    }

    registry.updatePropagationSources(feature.id, nextSources);
  }

  // Drain sanity-triggered emotions (clear from pending queue; no longer persisted as memory)
  drainPendingEmotions(dgsm);

  // Collect world events from features (scene_updated, feature_triggered)
  const worldEvents = dgsm.drainWorldEvents();

  return {
    actions: tickActions,
    injectedNodes,
    worldEvents,
  };
}

// ==================== Unplanned encounters (signal-only) ====================

/**
 * Detect NPC co-presence per scene after node execution.
 * Writes a lightweight witness memory per NPC and returns synthetic
 * impact-2 CharacterActions (one per scene) for the gate pipeline.
 */
function scanUnplannedEncounters(
  dgsm: DynamicGameStateManager,
  tickTime: string,
  tickActions: CharacterAction[],
  movedNpcIds: Set<string>,
  memoryManager: NpcMemoryManager | undefined,
  sessionId: string,
  moduleId: string,
  gameDay: number,
  lang: string
): CharacterAction[] {
  const state = dgsm.getState();
  const aliveNpcs = state.npcCharacters.filter((npc) =>
    dgsm.isNpcAlive(npc.id)
  );
  const presentNpcs = state.npcCharacters.filter((npc) =>
    Boolean(dgsm.getCharacterPosition(npc.id))
  );
  const formatPresenceLabel = (npcId: string): string => {
    const npc = state.npcCharacters.find((candidate) => candidate.id === npcId);
    const name = npc?.name ?? npcId;
    return dgsm.isNpcAlive(npcId) ? name : `${name} (dead)`;
  };
  const positionByNpc = new Map(
    presentNpcs.map((npc) => [npc.id, dgsm.getCharacterPosition(npc.id)])
  );

  // NPCs who just arrived at a new scene this tick
  const arrivedNpcIds = new Set<string>(movedNpcIds);
  for (const action of tickActions) {
    if (action.type === "movement" && action.status === "completed") {
      arrivedNpcIds.add(action.characterId);
    }
  }

  // Build dedup set from already-executed character_interaction actions
  const interactedPairs = new Set<string>();
  for (const action of tickActions) {
    if (
      action.type === "character_interaction" &&
      action.targetCharacterIds?.length
    ) {
      for (const targetId of action.targetCharacterIds) {
        const pairKey = [action.characterId, targetId].sort().join("_");
        interactedPairs.add(pairKey);
      }
    }
  }

  const encounterEvents: CharacterAction[] = [];

  // Track NPCs that were caught hiding — keyed by detectorId → Set<spottedId>
  const spottedHiddenPairs = new Map<string, Set<string>>();
  const recordSpotted = (detectorId: string, spottedId: string) => {
    if (!spottedHiddenPairs.has(detectorId))
      spottedHiddenPairs.set(detectorId, new Set());
    spottedHiddenPairs.get(detectorId)!.add(spottedId);
  };

  // When a hidden NPC arrives at a scene, let all present non-hidden NPCs
  // attempt a Spot Hidden check (the reverse direction of the main loop below).
  for (const arrivedNpc of aliveNpcs) {
    if (!arrivedNpcIds.has(arrivedNpc.id)) continue;
    if (!dgsm.isCharacterHidden(arrivedNpc.id)) continue;

    const arrivedPos = positionByNpc.get(arrivedNpc.id) ?? null;
    for (const resident of aliveNpcs) {
      if (resident.id === arrivedNpc.id) continue;
      if (dgsm.isCharacterHidden(resident.id)) continue;
      const residentPos = positionByNpc.get(resident.id) ?? null;
      if (!arePositionsCoLocated(arrivedPos, residentPos, dgsm)) continue;

      if (tryDetectHidden(dgsm, resident.id, arrivedNpc.id)) {
        dgsm.setCharacterHidden(arrivedNpc.id, false);
        recordSpotted(resident.id, arrivedNpc.id);
        break; // already revealed, no need for more checks
      }
    }
  }

  const locationEncounterMaps = new Map<string, Map<string, string[]>>();
  for (const observer of aliveNpcs) {
    if (!arrivedNpcIds.has(observer.id)) continue;

    const observerPos = positionByNpc.get(observer.id) ?? null;
    const locationId = observerPos
      ? dgsm.resolveLocationId(observerPos)
      : undefined;
    if (!locationId) continue;

    for (const other of presentNpcs) {
      if (other.id === observer.id) continue;
      // Hidden NPCs: opposed Spot Hidden vs Stealth check
      if (dgsm.isCharacterHidden(other.id)) {
        if (!tryDetectHidden(dgsm, observer.id, other.id)) continue;
        // Detection succeeded — reveal the hidden NPC
        dgsm.setCharacterHidden(other.id, false);
        recordSpotted(observer.id, other.id);
      }

      const pairKey = [observer.id, other.id].sort().join("_");
      if (interactedPairs.has(pairKey)) continue;

      const otherPos = positionByNpc.get(other.id) ?? null;
      if (!arePositionsCoLocated(observerPos, otherPos, dgsm)) continue;

      if (!locationEncounterMaps.has(locationId)) {
        locationEncounterMaps.set(locationId, new Map<string, string[]>());
      }
      const npcEncounterMap = locationEncounterMaps.get(locationId)!;
      if (!npcEncounterMap.has(observer.id))
        npcEncounterMap.set(observer.id, []);
      npcEncounterMap.get(observer.id)!.push(other.id);
    }
  }

  for (const [locationId, npcEncounterMap] of locationEncounterMaps) {
    if (npcEncounterMap.size === 0) continue;

    const sceneName = dgsm.getScene(locationId)?.name ?? locationId;

    // Write witness memory per NPC
    if (memoryManager) {
      for (const [npcId, otherIds] of npcEncounterMap) {
        const spotted = spottedHiddenPairs.get(npcId);
        const normalNames: string[] = [];
        const spottedNames: string[] = [];
        for (const id of otherIds) {
          if (spotted?.has(id)) {
            spottedNames.push(formatPresenceLabel(id));
          } else {
            normalNames.push(formatPresenceLabel(id));
          }
        }
        const parts: string[] = [];
        if (normalNames.length > 0)
          parts.push(t("saw_here", lang, { names: normalNames.join(", ") }));
        if (spottedNames.length > 0)
          parts.push(
            t("spotted_hiding", lang, { names: spottedNames.join(", ") })
          );
        if (parts.length === 0) continue;
        // Fire-and-forget; consistent with existing memory write pattern
        void memoryManager.add({
          npcId,
          sessionId,
          moduleId,
          type: "witness",
          content: parts.join(". "),
          gameDay,
          gameTime: tickTime,
          location: locationId,
          metadata: {
            sourceCharacterId: "__encounter__",
            sourceAction:
              spottedNames.length > 0 ? "detected-hidden" : "co-presence",
            impact: spottedNames.length > 0 ? 3 : 2,
          },
        });
      }
    }

    // Build one synthetic event per scene (exclude hidden NPCs from visible roster)
    const allNpcIds = new Set<string>();
    for (const [observerId, otherIds] of npcEncounterMap) {
      if (!dgsm.isCharacterHidden(observerId)) allNpcIds.add(observerId);
      for (const otherId of otherIds) {
        if (!dgsm.isCharacterHidden(otherId)) allNpcIds.add(otherId);
      }
    }
    if (allNpcIds.size === 0) continue;
    const allNpcNames = [...allNpcIds].map((id) => formatPresenceLabel(id));

    encounterEvents.push({
      characterId: "__encounter__",
      characterName: t("co_presence_name", lang),
      gameTime: tickTime,
      action: t("npcs_present_at", lang, { scene: sceneName }),
      location: locationId,
      type: "character_interaction",
      impact: 2 as const,
      status: "completed",
      outcome: t("npcs_are_at", lang, {
        names: allNpcNames.join(", "),
        scene: sceneName,
      }),
    });
  }

  return encounterEvents;
}

// ==================== Simulation tick ====================

/**
 * Execute a single simulation tick (no player involved).
 *
 * Wraps executeSingleTick and advances game time
 * by TICK_DURATION_MINUTES afterwards.
 */
export async function runSimulationTick(params: {
  dgsm: DynamicGameStateManager;
  npcPlanningAgent: NPCPlanningAgent;
  sessionId: string;
  moduleId: string;
  language: string;
  registry: GameEngineRegistry;
  ctx: ExecutionContext;
  memoryManager?: NpcMemoryManager;
}): Promise<SimulationTickResult> {
  const state = params.dgsm.getState();
  const tickStartMinutes =
    Number.parseInt(state.timeOfDay.split(":")[0]) * 60 +
    Number.parseInt(state.timeOfDay.split(":")[1]);

  const result = await executeSingleTick({
    tickStartMinutes,
    tickDurationMinutes: TICK_DURATION_MINUTES,
    ...params,
  });

  const { dayChanged } = params.dgsm.updateGameTime(TICK_DURATION_MINUTES);

  return {
    actions: result.actions,
    worldEvents: result.worldEvents,
    dayChanged,
  };
}
