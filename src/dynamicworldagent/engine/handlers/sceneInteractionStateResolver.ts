/**
 * LLM-based state resolver for scene_interaction nodes.
 *
 * After the handler determines success/failure via dice,
 * this module asks a MEDIUM-class LLM to produce concrete
 * state deltas (scene conditions, connection effects, memories)
 * for the actor and any witnesses.
 */

import { ModelClass, generateText } from "../../../models/index.js";
import type {
  PlanNode,
  SceneStateDelta,
  SuccessLevel,
} from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { GameEngineRegistry } from "../registry.js";
import { buildWorldStateBlock } from "../shared/worldStateBlock.js";
import { applyItemResults } from "./objectInteractionStateResolver.js";

// ── Helpers ──────────────────────────────────────────────────────────

function repairJson(text: string): string {
  text = text.replace(/,\s*([}\]])/g, "$1");
  text = text.replace(/"(?:[^"\\]|\\.)*"/g, (match) =>
    match.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
  );
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
  while (stack.length > 0) text += stack.pop();
  return text;
}

function parseJsonResponse<T>(raw: string): T {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  text = text.replace(/\\([^"\\\/bfnrtu])/g, "$1");
  try {
    return JSON.parse(text) as T;
  } catch {
    const repaired = repairJson(text);
    return JSON.parse(repaired) as T;
  }
}

// ── Prompt builders ──────────────────────────────────────────────────

function buildSystemPrompt(language: string): string {
  return `You are a Call of Cthulhu 7th Edition game state resolver for scene interactions.
Given an NPC's scene interaction that has already been determined to succeed/fail via dice, determine the concrete scene state changes and memory.

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
If the actor is using a tool/item for this interaction, its details are provided in "Tool Being Used".
Use "items" to output state changes for items affected by the interaction:
- "itemId": the exact item ID
- "location": final location — "scene", "inventory", "destroyed"
- "updates": (optional) changed Item fields to deep-merge (e.g. "damaged", "damageDetails", "consumableStats")

Only include items that actually changed. Common cases:
- Tool gets damaged from forceful use → \`{ "itemId": "crowbar", "location": "inventory", "updates": { "damaged": true } }\`
- Consumable used up → \`{ "itemId": "matches", "location": "destroyed" }\`
- Item dropped during action → \`{ "itemId": "flashlight", "location": "scene" }\`

## Witnesses
If other NPCs are present in the scene, decide if they noticed the action:
- Obvious actions (barricading a door, breaking things) → witnesses notice
- Subtle actions (quietly searching a corner, inspecting a wall) → may go unnoticed
Write a first-person witness memory only for those who noticed, keyed by NPC ID.

## Narrative Grounding
- **Deterministic facts must match injected data:** scene contents, connections, conditions, and physical properties must come from the provided context. Do not fabricate details.
- **Non-deterministic character behavior may be creative:** how the character interacts with the environment, their reactions, and internal thoughts are yours to craft.

## Memory
Always required for the actor. Write from the actor's first-person perspective: what they did, what they observed, and the result. Write in ${language}.

## Output
Return a single JSON object. No extra text. JSON keys must be in English. Write "memory" and witness memory values in ${language}.

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
  "items": [
    { "itemId": "crowbar", "location": "inventory", "updates": { "damaged": true } }
  ],
  "memory": "first-person account (REQUIRED)",
  "witnessMemories": { "<npc_id>": "first-person witness account" }
}
\`\`\``;
}

function buildUserPrompt(
  node: PlanNode,
  actorName: string,
  sceneBlock: string,
  toolItemBlock: string | null,
  witnesses: Array<{ id: string; name: string }>,
  skillRollResult: { successLevel: SuccessLevel; detail: string } | null,
  worldStateBlock: string
): string {
  const nodeSection = JSON.stringify(
    {
      action: node.action,
      skill: node.skill,
      impact: node.impact,
    },
    null,
    2
  );

  const rollSection = skillRollResult
    ? `Skill roll: ${skillRollResult.successLevel} — ${skillRollResult.detail}`
    : "No skill check — auto success";

  const actorSection = [
    `## Actor`,
    `Name: ${actorName}`,
    `ID: ${node.characterId}`,
  ].join("\n");

  const witnessSection =
    witnesses.length > 0
      ? [
          `## Other NPCs Present`,
          ...witnesses.map((w) => `- ${w.name} (${w.id})`),
        ].join("\n")
      : `## Other NPCs Present\n(none)`;

  return [
    "# Scene Interaction Node",
    nodeSection,
    "",
    rollSection,
    "",
    actorSection,
    "",
    sceneBlock,
    ...(toolItemBlock ? ["", toolItemBlock] : []),
    "",
    witnessSection,
    ...(worldStateBlock ? ["", worldStateBlock] : []),
  ].join("\n");
}

function buildSceneBlock(
  node: PlanNode,
  dgsm: DynamicGameStateManager
): string {
  const scene = dgsm.getScene(node.location);
  if (!scene) return "## Scene\n(no scene data)";

  const conditions = dgsm.getSceneConditions(node.location);
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
            node.location,
            c.targetId
          );
          if (blockReason) entry.blocked = blockReason;
          return entry;
        })
      : [];

  return [
    "## Scene",
    `ID: ${(scene as any).id ?? node.location}`,
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

export async function resolveSceneInteractionState(
  node: PlanNode,
  dgsm: DynamicGameStateManager,
  runtime: any,
  skillRollResult: { successLevel: SuccessLevel; detail: string } | null,
  language: string,
  registry?: GameEngineRegistry,
  featureNotes?: string[]
): Promise<SceneStateDelta> {
  const state = dgsm.getState();
  const actorNpc = state.npcCharacters.find((n) => n.id === node.characterId);
  const actorName = actorNpc?.name ?? node.characterName;

  // Find witnesses
  const witnesses: Array<{ id: string; name: string }> = [];
  for (const npc of state.npcCharacters) {
    if (npc.id === node.characterId) continue;
    if (!dgsm.isNpcAlive(npc.id)) continue;
    const pos = dgsm.getCharacterPosition(npc.id);
    if (!pos) continue;
    const locId = dgsm.resolveLocationId(pos);
    if (locId === node.location) {
      witnesses.push({ id: npc.id, name: npc.name });
    }
  }

  const sceneBlock = buildSceneBlock(node, dgsm);

  // Build tool item block if an item is being used
  let toolItemBlock: string | null = null;
  const payload = node.objectInteractionPayload;
  if (payload?.itemId) {
    const item =
      dgsm.findNpcItem(node.characterId, payload.itemId) ??
      dgsm.getScene(node.location)?.items.find((i) => i.id === payload.itemId);
    if (item) {
      toolItemBlock = `## Tool Being Used\n${JSON.stringify({ id: item.id, name: item.name, description: item.description, type: item.type, damaged: item.damaged, consumableStats: item.consumableStats }, null, 2)}`;
    }
  }

  const worldStateBlock = buildWorldStateBlock(
    dgsm,
    node.characterId,
    node.location,
    registry
  );

  const systemPrompt = buildSystemPrompt(language);
  let userPrompt = buildUserPrompt(
    node,
    actorName,
    sceneBlock,
    toolItemBlock,
    witnesses,
    skillRollResult,
    worldStateBlock
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
      items?: Array<{
        itemId: string;
        location: string;
        updates?: Record<string, unknown>;
      }>;
      memory?: string;
      witnessMemories?: Record<string, string>;
    }>(response);

    return {
      addSceneConditions: parsed.addSceneConditions,
      removeSceneConditions: parsed.removeSceneConditions,
      connectionEffects: parsed.connectionEffects,
      items: parsed.items,
      memory: parsed.memory ?? node.action,
      witnessMemories: parsed.witnessMemories,
    };
  } catch (error) {
    console.warn(
      `[SceneInteractionStateResolver] LLM call failed, using fallback:`,
      error instanceof Error ? error.message : error
    );
    return { memory: node.action };
  }
}

// ── State applicator ─────────────────────────────────────────────────

export function applySceneDelta(
  dgsm: DynamicGameStateManager,
  delta: SceneStateDelta,
  sceneId: string,
  actorId: string
): void {
  // Remove conditions
  if (delta.removeSceneConditions && delta.removeSceneConditions.length > 0) {
    const toRemove = new Set(delta.removeSceneConditions);
    const existing = dgsm.getSceneConditions(sceneId);
    const filtered = existing.filter((c) => !toRemove.has(c.description));
    // Replace the array in state
    const state = dgsm.getState();
    if (filtered.length !== existing.length) {
      state.scenarioConditions[sceneId] = filtered;
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
          dgsm.setConnectionHidden(sceneId, effect.targetId, false);
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
}
