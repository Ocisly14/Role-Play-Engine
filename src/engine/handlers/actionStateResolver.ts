/**
 * LLM-based state resolver for current-location actions.
 *
 * After the handler determines completion / failure / interruption,
 * this module asks a MEDIUM-class LLM to produce concrete scene deltas,
 * memory, and fatigue changes for the actor.
 */

import { ModelClass, generateText } from "../../models/index.js";
import type {
  ActionResolutionContext,
  PlanNode,
  SceneStateDelta,
  SuccessLevel,
} from "../../planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { GameEngineRegistry } from "../registry.js";
import {
  buildExecutionContextPromptBlock,
  diffMinutes,
} from "../runtime/resolutionExecutionContext.js";
import { parseJsonResponse } from "../shared/jsonParse.js";
import { buildMovementRouteIgnoringBlocks } from "../shared/pathfinding.js";
import { buildWorldStateBlock } from "../shared/worldStateBlock.js";
import { applyItemResults } from "../tools/itemStateResolver.js";
import { resolveTargetPosition } from "./movementHandler.js";

export interface ActionMoveCandidate {
  id: string;
  kind: "scene" | "junction" | "road" | "outline" | "unknown";
  name?: string;
  reason: string;
}

// ── Prompt builders ──────────────────────────────────────────────────

function buildSystemPrompt(language: string): string {
  return `You are a Call of Cthulhu 7th Edition game state resolver for current-location actions.
Given an NPC action in their current scene that has already been determined to complete, fail, or be interrupted, determine the concrete scene state changes, fatigue change, and memory.

The node may be a quiet self-directed action or an environmental interaction. Many actions produce no scene delta at all.

## Execution Status
- **completed**: resolve the action normally.
- **failed**: the primary goal did NOT succeed. Usually output no scene change, though grounded side effects are allowed.
- **interrupted**: the action stopped partway through. Use elapsed time and the trigger information to decide whether there is no effect or only a partial effect. Do NOT assume the full intended result happened.

## Scene Conditions
Use "addSceneConditions" for observable environmental changes. Only include "mechanicalEffect" when it has a clear impact on dice rolls or movement.
Use "removeSceneConditions" to remove existing conditions (use the exact description string).

## Connection Effects
Use "connectionEffects" when the action changes access between locations:
- **"block"**: The actor barricades, locks, or obstructs a passage. The "targetId" must be an existing connected location ID.
- **"unblock"**: The actor clears debris, unlocks, or removes an obstruction.
- **"reveal"**: The actor discovers a hidden passage or secret door. Only use this for connections marked as [HIDDEN] in the scene data. The actor must be actively searching/investigating, and the skill roll must succeed.
- **"hide"**: The actor conceals a passage (rare — e.g. pushing a bookshelf back to cover a secret door).

Each entry needs:
- "targetId": the exact connected location ID from the scene data
- "action": one of "block", "unblock", "reveal", "hide"

## Incidental Relocation (moveTo)
Use "moveTo" only when the action itself physically displaces the actor into a nearby valid location as a side effect, such as:
- jumping out a window into a courtyard
- diving through a newly opened passage
- crawling into a revealed hidden stairwell

Rules:
- Do NOT use "moveTo" for ordinary travel or deliberate navigation. "Walk to the courtyard", "go upstairs", or "leave for the street" belong in a movement node instead.
- "moveTo" must be the exact ID from the injected "Incidental Relocation Targets" list.
- Omit "moveTo" when the actor stays where they are.
- On failed or interrupted actions, only use "moveTo" if the action genuinely got the actor to the destination.
- Never use "moveTo" to teleport to a distant or unrelated location.

## Hidden Connections
Connections marked as [HIDDEN] are secret passages, trap doors, or concealed exits that the actor does not know about.
- Only reveal them when the actor's action is specifically a search or investigation AND the skill roll succeeds.
- A critical success may reveal even the most cleverly concealed passages.
- A regular success reveals passages that are moderately hidden.
- Without a skill check or on failure, hidden connections must NOT be revealed.
- Do NOT mention hidden connections in the actor's memory if they were not revealed.

## Skill Check Results
- **No skill check (auto success)**: routine actions succeed as described. Hidden connections are NOT revealed without a skill check.
- **Critical success**: exceptional outcome — may reveal even extremely well-hidden passages.
- **Hard success**: strong outcome — reveals moderately hidden passages.
- **Regular success**: moderate outcome — reveals obvious-ish hidden passages.
- **Skill check failed**: the action did NOT succeed. Reflect this in the memory. The actor found nothing unusual.

## Items
Use "items" to output state changes for items affected by the interaction:
- "itemId": the exact item ID
- "location": final location — "scene", "inventory", "destroyed"
- "updates": (optional) changed Item fields to deep-merge (e.g. "damaged", "damageDetails", "consumableStats")

Only include items that actually changed. Common cases:
- Tool gets damaged from forceful use → \`{ "itemId": "crowbar", "location": "inventory", "updates": { "damaged": true } }\`
- Consumable used up → \`{ "itemId": "matches", "location": "destroyed" }\`
- Item dropped during action → \`{ "itemId": "flashlight", "location": "scene" }\`

## Narrative Grounding
- **Deterministic facts must match injected data:** scene contents, connections, conditions, and physical properties must come from the provided context. Do not fabricate details.
- **Non-deterministic character behavior may be creative:** how the character interacts with the environment, their reactions, and internal thoughts are yours to craft.

## CRITICAL: No Fabrication
- **All judgments must be grounded in the provided data.** You are a state resolver, not a story generator. Every state change you output must trace back to concrete information in the action node, skill roll results, scene data, or world state.
- **Never fabricate scene contents:** Do not invent objects, furniture, or environmental features that are not described in the scene data. If the scene description does not mention a bookshelf, there is no bookshelf to interact with.
- **Never fabricate connections:** connectionEffects must only reference targetId values that exist in the scene's Connections list. Do not invent passages or exits.
- **Never fabricate items:** items in the output must reference exact item IDs from the provided scene items or actor inventory. Do not create items that don't exist in the data.
- **Memory must reflect actual events:** The actor's memory must describe what actually happened based on the action and skill roll. Do not invent observations or sensory details that are not supported by the scene data. If the scene description is brief, the actor's observation should be proportionally brief.
- **Be substantive, not imaginative:** If the provided data is sparse, the outcome should be proportionally simple. Do not fill gaps with invented environmental details, hidden features, or atmospheric descriptions that have no basis in the data.

## Actor Conditions
If the actor has physical conditions listed (e.g. "detained", "restrained", "unconscious"), these represent binding constraints on the actor's current state. A detained or restrained actor cannot freely search rooms, barricade doors, or perform actions requiring free movement. Reflect these constraints in the outcome and memory — the action should fail or be severely limited if it contradicts the actor's physical state.

## Memory
Always required for the actor. Write from the actor's first-person perspective: what they did, what they observed, and the result.
- **Keep it concise: 1–3 sentences for routine interactions.** Only write longer memories (4+ sentences) for truly significant events — discovering a hidden passage, witnessing a supernatural phenomenon, or encountering something dangerous. Most environmental inspections, barricading doors, and routine scene actions should be brief.
- Write in ${language}.

## Fatigue
You may output:
- "fatigueDelta": integer from -3 to 3

Rules:
- Negative = reduced fatigue (resting, catching breath, safe downtime)
- Positive = increased fatigue (searching hard, forcing doors, sustained exertion, stressful effort)
- Omit or use 0 when the action has negligible fatigue impact
- Interrupted actions should usually have smaller absolute fatigue changes than fully completed ones
- Base the judgment on the action, elapsed time, world conditions, and whether the attempt actually finished

## Output
Return a single JSON object. No extra text. JSON keys must be in English. Write "memory" values in ${language}.

\`\`\`json
{
  "addSceneConditions": [
    { "description": "the door is barricaded with heavy furniture" },
    { "description": "the room is pitch dark", "mechanicalEffect": { "skillPenalty": [{ "skill": "Spot Hidden", "delta": -30 }] } }
  ],
  "removeSceneConditions": ["exact existing condition to remove"],
  "connectionEffects": [
    { "targetId": "location_id", "action": "reveal" }
  ],
  "moveTo": "courtyard_scene_id",
  "items": [
    { "itemId": "crowbar", "location": "inventory", "updates": { "damaged": true } }
  ],
  "fatigueDelta": 1,
  "memory": "first-person account (REQUIRED)"
}
\`\`\``;
}

function buildUserPrompt(
  node: PlanNode,
  actorName: string,
  actorConditions: string[],
  sceneBlock: string,
  relocationTargetBlock: string | null,
  skillRollResult: { successLevel: SuccessLevel; detail: string } | null,
  worldStateBlock: string,
  resolutionContext: ActionResolutionContext
): string {
  const nodeSection = JSON.stringify(
    {
      action: node.action,
      type: node.type,
      skill: node.skill,
      impact: node.impact,
    },
    null,
    2
  );

  const rollSection = skillRollResult
    ? `Skill roll: ${skillRollResult.successLevel} — ${skillRollResult.detail}`
    : resolutionContext.executionStatus === "failed"
      ? "No skill check result provided; the action still failed."
      : "No skill check — auto success";

  const actorSection = [
    `## Actor`,
    `Name: ${actorName}`,
    `ID: ${node.characterId}`,
    ...(actorConditions.length > 0
      ? [`Conditions: ${actorConditions.join(", ")}`]
      : []),
  ].join("\n");

  const executionSection = buildExecutionContextPromptBlock(resolutionContext);

  return [
    "# Current-Location Action Node",
    nodeSection,
    "",
    rollSection,
    "",
    executionSection,
    "",
    actorSection,
    "",
    sceneBlock,
    ...(relocationTargetBlock ? ["", relocationTargetBlock] : []),
    ...(worldStateBlock ? ["", worldStateBlock] : []),
  ].join("\n");
}

function describeActionMoveCandidate(
  locationId: string,
  dgsm: DynamicGameStateManager
): Pick<ActionMoveCandidate, "kind" | "name"> {
  const scene = dgsm.getScene(locationId);
  if (scene) {
    return { kind: "scene", name: scene.name };
  }

  const junction = dgsm.getJunction(locationId);
  if (junction) {
    return { kind: "junction", name: junction.name };
  }

  const road = dgsm.getRoad(locationId);
  if (road) {
    return { kind: "road", name: road.name };
  }

  const outline = dgsm
    .getState()
    .scenarioOutlines.find((o) => o.id === locationId);
  if (outline) {
    return { kind: "outline", name: outline.name };
  }

  return { kind: "unknown" };
}

function collectNearbyActionMoveCandidateIds(
  locationId: string,
  dgsm: DynamicGameStateManager
): string[] {
  const topology = dgsm.getTopology();
  const from = { type: "scene", sceneId: locationId } as const;
  const candidateIds = new Set<string>([
    ...topology.sceneToParent.keys(),
    ...topology.junctions.keys(),
    ...topology.roads.keys(),
  ]);

  return [...candidateIds].filter((candidateId) => {
    if (candidateId === locationId) return false;
    const target = resolveTargetPosition(candidateId, topology, dgsm);
    if (!target) return false;
    const route = buildMovementRouteIgnoringBlocks(
      from,
      target,
      topology,
      dgsm
    );
    return route != null && route.totalMinutes <= 2;
  });
}

export function collectActionMoveCandidates(
  locationId: string,
  dgsm: DynamicGameStateManager
): ActionMoveCandidate[] {
  const scene = dgsm.getScene(locationId);
  if (!scene) return [];

  const candidates: ActionMoveCandidate[] = [];
  const seen = new Set<string>();

  const pushCandidate = (targetId: string | undefined, reason: string) => {
    if (!targetId || targetId === locationId || seen.has(targetId)) return;
    const described = describeActionMoveCandidate(targetId, dgsm);
    candidates.push({
      id: targetId,
      reason,
      ...described,
    });
    seen.add(targetId);
  };

  for (const siblingScene of dgsm.getState().scenes.values()) {
    if (
      siblingScene.parentLocationId === scene.parentLocationId &&
      siblingScene.id !== locationId
    ) {
      pushCandidate(siblingScene.id, "shares the same parent location");
    }
  }

  for (const nearbyLocationId of collectNearbyActionMoveCandidateIds(
    locationId,
    dgsm
  )) {
    pushCandidate(
      nearbyLocationId,
      "reachable within 2 minutes from the current scene"
    );
  }

  return candidates;
}

function buildRelocationTargetsBlock(
  locationId: string,
  dgsm: DynamicGameStateManager
): { block: string; allowedTargetIds: Set<string> } {
  const candidates = collectActionMoveCandidates(locationId, dgsm);
  if (candidates.length === 0) {
    return {
      block:
        '## Incidental Relocation Targets\nNone available from the current context. Omit "moveTo".',
      allowedTargetIds: new Set<string>(),
    };
  }

  return {
    block: [
      "## Incidental Relocation Targets",
      'If the action itself displaces the actor, "moveTo" must be one of these exact IDs:',
      JSON.stringify(candidates, null, 2),
    ].join("\n"),
    allowedTargetIds: new Set(candidates.map((candidate) => candidate.id)),
  };
}

function buildSceneBlock(
  locationId: string,
  dgsm: DynamicGameStateManager
): string {
  const scene = dgsm.getScene(locationId);
  if (!scene) return "## Scene\n(no scene data)";

  const conditions = dgsm.getSceneConditions(locationId);
  const items = (scene as any).items ?? [];
  const connections = (scene as any).connections ?? [];

  const connectionLines =
    connections.length > 0
      ? connections.map((c: any) => {
          const entry: any = {
            targetId: c.targetId,
            description: c.description,
          };
          if (c.hidden) entry.hidden = "[HIDDEN]";
          const blockReason = dgsm.getConnectionBlockReason(
            locationId,
            c.targetId
          );
          if (blockReason) entry.blocked = blockReason;
          return entry;
        })
      : [];

  return [
    "## Scene",
    `ID: ${(scene as any).id ?? locationId}`,
    `Name: ${(scene as any).name ?? "unknown"}`,
    `Description: ${(scene as any).description ?? ""}`,
    conditions.length > 0 ? `Conditions: ${JSON.stringify(conditions)}` : null,
    items.length > 0
      ? `Items: ${JSON.stringify(
          items.map((i: any) => ({
            id: i.id,
            name: i.name,
            description: i.description,
          }))
        )}`
      : null,
    connectionLines.length > 0
      ? `Connections: ${JSON.stringify(connectionLines)}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Main resolver ────────────────────────────────────────────────────

export async function resolveActionState(
  node: PlanNode,
  dgsm: DynamicGameStateManager,
  runtime: any,
  skillRollResult: { successLevel: SuccessLevel; detail: string } | null,
  locationId: string,
  language: string,
  registry?: GameEngineRegistry,
  featureNotes?: string[],
  resolutionContext?: ActionResolutionContext
): Promise<SceneStateDelta> {
  const state = dgsm.getState();
  const actorNpc = state.npcCharacters.find((n) => n.id === node.characterId);
  const actorName = actorNpc?.name ?? node.characterName;
  const actorConditions = actorNpc?.status?.conditions ?? [];

  const sceneBlock = buildSceneBlock(locationId, dgsm);
  const { block: relocationTargetBlock, allowedTargetIds } =
    buildRelocationTargetsBlock(locationId, dgsm);

  const worldStateBlock = buildWorldStateBlock(
    dgsm,
    node.characterId,
    locationId,
    registry
  );

  const systemPrompt = buildSystemPrompt(language);
  let userPrompt = buildUserPrompt(
    node,
    actorName,
    actorConditions,
    sceneBlock,
    relocationTargetBlock,
    skillRollResult,
    worldStateBlock,
    resolutionContext ?? {
      executionStatus: "completed",
      startedAt: node.executionMeta.startedAt ?? node.startTime,
      resolvedAt: node.endTime,
      elapsedMinutes: Math.max(1, diffMinutes(node.startTime, node.endTime)),
      plannedMinutes: Math.max(1, diffMinutes(node.startTime, node.endTime)),
    }
  );

  if (featureNotes && featureNotes.length > 0) {
    userPrompt +=
      "\n\n## Feature Activation Results\n" + featureNotes.join("\n");
  }

  try {
    const response = await generateText({
      runtime,
      context: userPrompt,
      customSystemPrompt: systemPrompt,
      modelClass: ModelClass.MEDIUM,
    });

    const parsed = parseJsonResponse<{
      addSceneConditions?: Array<{
        description: string;
        mechanicalEffect?: {
          skillPenalty?: Array<{ skill: string; delta: number }>;
          blocked?: boolean;
        };
      }>;
      removeSceneConditions?: string[];
      connectionEffects?: Array<{
        targetId: string;
        action: "block" | "unblock" | "reveal" | "hide";
      }>;
      moveTo?: string;
      items?: Array<{
        itemId: string;
        location: string;
        updates?: Record<string, unknown>;
      }>;
      fatigueDelta?: number;
      memory?: string;
    }>(response);

    return {
      addSceneConditions: parsed.addSceneConditions,
      removeSceneConditions: parsed.removeSceneConditions,
      connectionEffects: parsed.connectionEffects,
      moveTo:
        typeof parsed.moveTo === "string" && allowedTargetIds.has(parsed.moveTo)
          ? parsed.moveTo
          : undefined,
      items: parsed.items,
      fatigueDelta:
        typeof parsed.fatigueDelta === "number"
          ? parsed.fatigueDelta
          : undefined,
      memory: parsed.memory ?? node.action,
    };
  } catch (error) {
    console.warn(
      `[ActionStateResolver] LLM call failed, using fallback:`,
      error instanceof Error ? error.message : error
    );
    return { memory: node.action };
  }
}

// ── State applicator ─────────────────────────────────────────────────

export function applyActionSceneDelta(
  dgsm: DynamicGameStateManager,
  delta: SceneStateDelta,
  sceneId: string,
  actorId: string
): { revealedHiddenConnections: Array<{ sceneId: string; targetId: string }> } {
  const revealedHiddenConnections: Array<{
    sceneId: string;
    targetId: string;
  }> = [];

  // Remove conditions
  if (delta.removeSceneConditions && delta.removeSceneConditions.length > 0) {
    const toRemove = new Set(delta.removeSceneConditions);
    const existing = dgsm.getSceneConditions(sceneId);
    const filtered = existing.filter((c) => !toRemove.has(c.description));
    if (filtered.length !== existing.length) {
      dgsm.replaceSceneConditions(sceneId, filtered);
    }
  }

  // Add conditions
  if (delta.addSceneConditions) {
    for (const condition of delta.addSceneConditions) {
      dgsm.appendSceneCondition(sceneId, condition);
    }
  }

  // Connection effects
  if (delta.connectionEffects) {
    for (const effect of delta.connectionEffects) {
      switch (effect.action) {
        case "block":
          dgsm.setConnectionBlocked(
            sceneId,
            effect.targetId,
            true,
            effect.action
          );
          break;
        case "unblock":
          dgsm.setConnectionBlocked(
            sceneId,
            effect.targetId,
            false,
            effect.action
          );
          break;
        case "reveal":
          revealedHiddenConnections.push({
            sceneId,
            targetId: effect.targetId,
          });
          break;
        case "hide":
          dgsm.setConnectionHidden(sceneId, effect.targetId, true);
          break;
      }
    }
  }

  if (delta.items && delta.items.length > 0) {
    applyItemResults(dgsm, actorId, delta.items, sceneId);
  }

  return { revealedHiddenConnections };
}
