/**
 * LLM-based state resolver for character_interaction nodes.
 *
 * After the handler determines success/failure via dice,
 * this module asks a MEDIUM-class LLM to produce concrete
 * state deltas (HP, SAN, items, conditions, movement, memory)
 * for both actor and target characters.
 */

import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import { ModelClass, generateText } from "../../models/index.js";
import type {
  CharacterStateDelta,
  DiscoveryEntry,
  InteractionStateDelta,
  PlanNode,
  SuccessLevel,
} from "../../planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { GameEngineRegistry } from "../registry.js";
import { findTopologyPath } from "../shared/pathfinding.js";
import { buildWorldStateBlock } from "../shared/worldStateBlock.js";
import { resolveTargetPosition } from "./movementHandler.js";

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the list of target character IDs from a PlanNode.
 */
export function resolveTargets(node: PlanNode): string[] {
  return node.targetCharacterIds ?? [];
}

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

// ─── Character data collector ─────────────────────────────────────────

interface CharacterPromptData {
  id: string;
  name: string;
  isAlive: boolean;
  occupation?: string;
  appearance?: string;
  personality?: string;
  stats: { hp: number; san: number } | undefined;
  inventory: { id: string; name: string; description?: string }[];
  position: string | null;
  conditions: string[];
}

function collectCharacterData(
  characterId: string,
  dgsm: DynamicGameStateManager
): CharacterPromptData {
  const state = dgsm.getState();
  const npc = state.npcCharacters.find((n) => n.id === characterId);
  const stats = dgsm.getNpcStats(characterId);
  const inventory = dgsm.getNpcInventory(characterId).map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
  }));
  const pos = dgsm.getCharacterPosition(characterId);
  const positionLabel = pos ? dgsm.resolveLocationId(pos) : null;
  const conditions = npc?.status?.conditions ?? [];

  return {
    id: characterId,
    name: npc?.name ?? characterId,
    isAlive: dgsm.isNpcAlive(characterId),
    occupation: npc?.occupation,
    appearance: npc?.appearance,
    personality: npc?.personality,
    stats,
    inventory,
    position: positionLabel,
    conditions,
  };
}

// ─── Prompt builders ──────────────────────────────────────────────────

function buildSystemPrompt(language: string): string {
  return `You are a Call of Cthulhu 7th Edition game state resolver.
Given a character interaction that has already been determined to succeed/fail, determine the concrete state changes for both characters.

## HP / SAN Changes
- When pre-computed damage values are provided in the opposed roll results, use them directly as negative hpDelta on the target. Do NOT invent different damage numbers.
- When no pre-computed damage is provided, apply damage only when the action involves physical harm or healing, following CoC 7e mechanics.
- If a target resisted the opposed roll ("Target resists"), do NOT apply damage to that target.
- SAN loss: apply only for genuinely disturbing revelations or events (e.g. witnessing violence, learning a Mythos secret). Minor social friction does not cause SAN loss.
- critical success: halve SAN loss if applicable.
- fumble: attacker may harm themselves instead; defender takes no damage.

## Opposed Roll Results
When opposed roll results are provided per-target:
- "Actor wins": The action takes full effect on this target. Use the pre-computed damage value if provided.
- "Target resists": The target successfully defended — the action has reduced or no mechanical effect on this target (no damage, persuasion fails). The target should still get a memory of the attempted interaction.

## Dead Targets / Corpses
- If a target is marked as not alive or has HP <= 0, treat them as a corpse, not an active participant.
- Corpses do not speak, resist, plan, or form new thoughts. Do not invent dialogue or conscious reactions from them.
- You may still apply physical state changes to the corpse when appropriate: moving the body, changing appearance, transferring items, adding conditions, or further damaging it.
- For a dead target's "memory", write a brief state note about what happened to the corpse, not a conscious first-person recollection.

## Actor Success Level Impact
The actor's own success level (shown in "Actor skill roll") determines the intensity of effect on targets the actor won against:
- critical: Maximum effect — target is fully convinced/overwhelmed, may volunteer extra cooperation or information beyond what was asked.
- hard: Strong effect — target is clearly affected, complies willingly.
- regular: Moderate effect — target complies but may have reservations or conditions.
- In combat, the pre-computed damage already reflects the success level — use it directly.

## Movement (moveTo)
- Use only when the interaction physically displaces a character (e.g. fleeing after a fight, being escorted out, being knocked back).
- Value must be an exact location ID from the "Connected locations" list in the scene data. Do not invent IDs.
- Omit if neither character changes location as a result of this interaction.

## Items (addItems / removeItems)
- Use item IDs exactly as they appear in the character inventories or scene items list.
- Items transfer from one party to the other, or from the scene to a character. Do not invent new items.
- removeItems on the giver + addItems on the receiver for a transfer (both sides must be specified).
- Omit both fields if no item changes hands.

## Conditions (addConditions / removeConditions)
- Use short English labels: "bleeding", "unconscious" etc.
- Add a condition only when it is a direct mechanical or narrative consequence of this interaction.
- Remove a condition only when this interaction logically resolves it (e.g. being calmed removes "frightened").
- Omit both fields if no condition changes.

## Knowledge Transfer In Memory
When knowledge is revealed in this interaction, encode it directly in each character's "memory" text instead of relying on a separate field.

Select which facts each character learns based on TWO factors:

**1. Actor's intent and the interaction method:**
- What was the actor trying to find out or accomplish? Only information relevant to that goal should appear.
- The method matters: casual conversation surfaces only what the target would freely volunteer; persuasion can unlock guarded opinions; intimidation may extract reluctant admissions; deception may yield deliberately false info (write it as a believed fact from the recipient's perspective).

**2. Success level still matters, but you must decide transfer yourself from the full candidate list:**
- All candidate facts known by each target are provided below.
- critical: target may reveal even their most guarded secrets (including extreme-difficulty knowledge).
- hard success: target may reveal sensitive information they normally keep private (hard-difficulty knowledge).
- regular success: target may reveal information they would tell someone they moderately trust (regular-difficulty knowledge).
- fail: target usually shares only what they would tell anyone freely (automatic knowledge), or nothing if they are hostile.
- fumble: target shares nothing useful; may actively mislead the actor.

Apply both factors together: a critical success in casual small-talk still only surfaces facts the target actually knows and that are plausible to mention in that context.

## Memory
- Always required for both actor and every target involved.
- Write from that character's first-person perspective: what they experienced, felt, and understood from the interaction.
- Reflect the actual outcome — a failed persuasion attempt should read very differently from a successful one.
- If someone learned information from another character, state clearly who told them and what concrete knowledge they learned.
- If someone disclosed information, state clearly who they told and what concrete knowledge they revealed.
- **Keep it concise: 1–3 sentences for routine interactions.** Only write longer memories (4+ sentences) for truly significant events — combat with serious injury, major revelations, death, or sanity-breaking encounters. Most social exchanges, minor negotiations, and casual conversations should be brief.
- Write in ${language}.

## General Rules
- Only output fields that have a meaningful value. Omit fields with no change.
- Do not invent items, locations, or knowledge that do not appear in the provided data.
- **Deterministic facts must match injected data:** items, objects, scene contents, sensory observations (what characters see/hear/smell), backstory, lore, and factual information must come from the provided context. Do not fabricate things that objectively exist or don't exist in the world.
- **Non-deterministic character behavior may be creative:** dialogue, lies, deception content, social tactics, emotional reactions, and subjective judgments are yours to craft. If a character deceives another, you may invent the false narrative they tell — that is character behavior, not world fact.

## CRITICAL: No Fabrication
- **All judgments must be grounded in the provided data.** You are a state resolver, not a story generator. Every state change you output must trace back to concrete information in the action node, skill roll results, character data, scene data, or world state.
- **Never fabricate items:** Do not invent items that do not appear in the character inventories or scene items list. If an item ID is not present in the provided data, you must not reference it in addItems/removeItems.
- **Never fabricate knowledge:** Characters can only learn information that exists in the "Candidate knowledge" entries or that is directly observable from the scene/interaction context. Do not invent backstory, lore, rumors, or facts.
- **Never fabricate locations:** moveTo must reference exact location IDs from the connected locations list. Do not invent location names or IDs.
- **Be substantive, not imaginative:** Your output must reflect what actually happened based on the dice results and the provided context. Do not embellish with details that have no basis in the data. If the data is sparse, the outcome should be proportionally simple — do not fill gaps with invented content.

## Output
Return a single JSON object. No extra text. JSON keys must be in English. Write "memory" values in ${language}.

\`\`\`json
{
  "actorChanges": {
    "hpDelta": -2 (optional, negative = damage),
    "sanDelta": -1 (optional, negative = loss),
    "moveTo": "scene_id" (optional, must be from connected locations list),
    "addItems": ["item_id"] (optional, item must exist in scene or counterpart inventory),
    "removeItems": ["item_id"] (optional),
    "addConditions": ["condition_name"] (optional),
    "removeConditions": ["condition_name"] (optional),
    "appearanceChange": "description" (optional, it is a full description of the character's appearance if changes applied),
    "learnedLocationNames": ["location name"] (optional, names of places this character learns about from the conversation, e.g. building names, street names, area names mentioned by the other party),
    "memory": "first-person account of what happened with whom, including knowledge context if relevant (REQUIRED)"
  },
  "targetChanges": {
    "<target_character_id>": { ...same fields as actorChanges }
  }
}
\`\`\``;
}

interface SkillRollInput {
  successLevel: SuccessLevel;
  detail: string;
  perTargetResults?: Record<
    string,
    {
      successLevel: SuccessLevel;
      actorWon: boolean;
      detail: string;
      damage?: number;
    }
  >;
}

function buildUserPrompt(
  node: PlanNode,
  locationId: string,
  actor: CharacterPromptData,
  targets: CharacterPromptData[],
  relationships: { targetId: string; score: number; note: string }[],
  sceneBlock: string,
  worldStateBlock: string,
  skillRollResult: SkillRollInput | null,
  availableKnowledge: DiscoveryEntry[]
): string {
  const nodeSection = JSON.stringify(
    {
      action: node.action,
      type: node.type,
      skill: node.skill,
      impact: node.impact,
      location: locationId,
      targetCharacterIds: node.targetCharacterIds,
    },
    null,
    2
  );

  const rollLines: string[] = [];
  if (skillRollResult) {
    rollLines.push(
      `Actor skill roll: ${skillRollResult.successLevel} — ${skillRollResult.detail}`
    );
    if (skillRollResult.perTargetResults) {
      rollLines.push("Opposed results per target:");
      for (const [targetId, r] of Object.entries(
        skillRollResult.perTargetResults
      )) {
        const targetName =
          targets.find((t) => t.id === targetId)?.name ?? targetId;
        const wonLabel = r.actorWon ? "Actor wins" : "Target resists";
        const damagePart = r.damage != null ? `, damage: ${r.damage}` : "";
        rollLines.push(
          `  ${targetName} (${targetId}): ${r.detail} — ${wonLabel}${damagePart}`
        );
      }
    }
  } else {
    rollLines.push("No skill check — auto success");
  }
  const rollSection = rollLines.join("\n");

  const actorSection = [
    `## Actor`,
    `ID: ${actor.id}`,
    `Name: ${actor.name}`,
    actor.occupation ? `Occupation: ${actor.occupation}` : null,
    actor.appearance ? `Appearance: ${actor.appearance}` : null,
    actor.personality ? `Personality: ${actor.personality}` : null,
    `Status: ${actor.isAlive ? "alive" : "dead"}`,
    actor.stats ? `Stats: HP=${actor.stats.hp}, SAN=${actor.stats.san}` : null,
    `Inventory: ${JSON.stringify(actor.inventory)}`,
    `Position: ${actor.position ?? "unknown"}`,
    actor.conditions.length > 0
      ? `Conditions: ${actor.conditions.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const targetSections = targets
    .map((t) => {
      // Target not in simulation — no stats, no position, not in npcCharacters
      if (!t.stats && !t.position) {
        return [
          `## Target: ${t.name}`,
          `ID: ${t.id}`,
          `**This person is NOT present in the current scene. The actor cannot find them here. Treat this as: the actor arrived but the target was nowhere to be found. Do NOT treat the target as dead or as a corpse — they are simply absent/unavailable.**`,
        ].join("\n");
      }

      const rel = relationships.find((r) => r.targetId === t.id);
      const targetKnowledge = availableKnowledge.filter(
        (k) => k.sourceId === t.id
      );
      const knowledgeLines =
        targetKnowledge.length > 0
          ? [
              `Candidate knowledge known by this target (you must decide what, if anything, gets transferred):`,
              ...targetKnowledge.map((k) => `  [${k.difficulty}] "${k.text}"`),
            ]
          : null;

      return [
        `## Target: ${t.name}`,
        `ID: ${t.id}`,
        t.occupation ? `Occupation: ${t.occupation}` : null,
        t.appearance ? `Appearance: ${t.appearance}` : null,
        t.personality ? `Personality: ${t.personality}` : null,
        `Status: ${t.isAlive ? "alive" : "dead"}`,
        t.stats ? `Stats: HP=${t.stats.hp}, SAN=${t.stats.san}` : null,
        `Inventory: ${JSON.stringify(t.inventory)}`,
        `Position: ${t.position ?? "unknown"}`,
        t.conditions.length > 0
          ? `Conditions: ${t.conditions.join(", ")}`
          : null,
        rel
          ? `Relationship with actor: score=${rel.score}, note="${rel.note}"`
          : `Relationship with actor: none`,
        knowledgeLines ? knowledgeLines.join("\n") : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  return [
    "# Interaction Node",
    nodeSection,
    "",
    rollSection,
    "",
    actorSection,
    "",
    targetSections,
    "",
    sceneBlock,
    ...(worldStateBlock ? ["", worldStateBlock] : []),
  ].join("\n");
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
    connections.length > 0
      ? `Connected locations: ${JSON.stringify(
          connections.map((c: any) => {
            const entry: any = {
              targetId: c.targetId,
              description: c.description,
            };
            const blockReason = dgsm.getConnectionBlockReason(
              locationId,
              c.targetId
            );
            if (blockReason) entry.blocked = blockReason;
            return entry;
          })
        )}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── Main resolver ────────────────────────────────────────────────────

/**
 * Call the LLM to determine state changes for a character_interaction node.
 *
 * @param node               The PlanNode being executed (already success/fail determined).
 * @param dgsm               Dynamic game state manager.
 * @param runtime            Model runtime (passed through to generateText).
 * @param skillRollResult    Result of the skill roll, or null if auto-success.
 * @param availableKnowledge  Full NPC knowledge entries injected into the prompt so the LLM can decide which facts are transferred.
 * @param language           Language code for memory text (e.g., "en", "zh").
 * @returns Concrete state deltas for actor and all targets.
 */
export async function resolveInteractionState(
  node: PlanNode,
  dgsm: DynamicGameStateManager,
  runtime: any,
  skillRollResult: SkillRollInput | null,
  availableKnowledge: DiscoveryEntry[],
  locationId: string,
  language: string,
  registry?: GameEngineRegistry,
  featureNotes?: string[]
): Promise<InteractionStateDelta> {
  const targets = resolveTargets(node);

  // Collect character data
  const actor = collectCharacterData(node.characterId, dgsm);
  const targetDataList = targets.map((tId) => collectCharacterData(tId, dgsm));

  // Collect relationship data
  const relationships = targets.map((tId) => {
    const rel = dgsm.getRelationship(node.characterId, tId);
    return {
      targetId: tId,
      score: rel?.score ?? 0,
      note: rel?.note ?? "",
    };
  });

  // Build scene block
  const sceneBlock = buildSceneBlock(locationId, dgsm);

  // Build world state block (weather, fire, stamina, sanity)
  const worldStateBlock = buildWorldStateBlock(
    dgsm,
    node.characterId,
    locationId,
    registry
  );

  // Build prompts
  const systemPrompt = buildSystemPrompt(language);
  let userPrompt = buildUserPrompt(
    node,
    locationId,
    actor,
    targetDataList,
    relationships,
    sceneBlock,
    worldStateBlock,
    skillRollResult,
    availableKnowledge
  );

  // Inject feature activation notes (e.g. ritual invoke failed)
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
      actorChanges?: CharacterStateDelta;
      targetChanges?: Record<string, CharacterStateDelta>;
    }>(response);

    // Ensure memory is always present on actorChanges
    const actorChanges: CharacterStateDelta = {
      ...parsed.actorChanges,
      memory: parsed.actorChanges?.memory ?? node.action,
    };

    // Ensure memory is always present on each target's changes
    const targetChanges: Record<string, CharacterStateDelta> = {};
    for (const tId of targets) {
      const raw = parsed.targetChanges?.[tId];
      targetChanges[tId] = {
        ...raw,
        memory: raw?.memory ?? `${node.characterName} interacted with me.`,
      };
    }

    return { actorChanges, targetChanges };
  } catch (error) {
    console.warn(
      `[InteractionStateResolver] LLM call failed, using fallback:`,
      error instanceof Error ? error.message : error
    );

    // Fallback: empty changes with generic memory
    const fallbackTarget: Record<string, CharacterStateDelta> = {};
    for (const tId of targets) {
      fallbackTarget[tId] = {
        memory: `${node.characterName} interacted with me.`,
      };
    }
    return {
      actorChanges: { memory: node.action },
      targetChanges: fallbackTarget,
    };
  }
}

// ─── State applicator ─────────────────────────────────────────────────

/**
 * Apply a single character's state delta to the game state.
 *
 * @param dgsm           Dynamic game state manager.
 * @param characterId    The character to apply changes to.
 * @param delta          State changes from the LLM resolver.
 * @param counterpartId  The other character in the interaction (used for item source).
 * @param memoryManager  Optional memory manager for writing knowledge memories.
 * @param sessionId      Session ID (required when memoryManager is provided).
 * @param moduleId       Module ID (required when memoryManager is provided).
 * @param gameDay        Current game day (required when memoryManager is provided).
 * @param gameTime       Current game time (required when memoryManager is provided).
 * @returns Object indicating if movement was blocked.
 */
export async function applyCharacterDelta(
  dgsm: DynamicGameStateManager,
  characterId: string,
  delta: CharacterStateDelta,
  counterpartIds: string[],
  memoryManager?: NpcMemoryManager,
  sessionId?: string,
  moduleId?: string,
  gameDay?: number,
  gameTime?: string
): Promise<{ blocked?: boolean }> {
  // 1. HP / SAN
  if (delta.hpDelta) {
    dgsm.updateNpcHp(characterId, delta.hpDelta);
  }
  if (delta.sanDelta) {
    dgsm.updateNpcSan(characterId, delta.sanDelta);
  }

  // 2. Remove items
  if (delta.removeItems) {
    for (const itemId of delta.removeItems) {
      dgsm.removeItemFromNpc(characterId, itemId);
    }
  }

  // 3. Add items (from any counterpart inventory or scene)
  if (delta.addItems) {
    for (const itemId of delta.addItems) {
      // Try counterpart inventories first
      let found = false;
      for (const cId of counterpartIds) {
        const fromCounterpart = dgsm.removeItemFromNpc(cId, itemId);
        if (fromCounterpart) {
          dgsm.addItemToNpc(characterId, fromCounterpart);
          found = true;
          break;
        }
      }
      if (found) continue;

      // Try scene items
      const pos = dgsm.getCharacterPosition(characterId);
      if (pos) {
        const locationId = dgsm.resolveLocationId(pos);
        const scene = dgsm.getScene(locationId);
        if (scene && (scene as any).items) {
          const items = (scene as any).items as import(
            "../../state/types.js"
          ).Item[];
          const idx = items.findIndex((i) => i.id === itemId);
          if (idx !== -1) {
            const [item] = items.splice(idx, 1);
            dgsm.addItemToNpc(characterId, item);
            continue;
          }
        }
      }

      // Not found anywhere — silently skip
    }
  }

  // 4. Conditions
  const state = dgsm.getState();
  const npc = state.npcCharacters.find((n) => n.id === characterId);
  if (npc) {
    if (delta.removeConditions) {
      const toRemove = new Set(delta.removeConditions);
      npc.status.conditions = npc.status.conditions.filter(
        (c) => !toRemove.has(c)
      );
    }
    if (delta.addConditions) {
      const existing = new Set(npc.status.conditions);
      for (const cond of delta.addConditions) {
        if (!existing.has(cond)) {
          npc.status.conditions.push(cond);
        }
      }
    }

    // 5. Appearance
    if (delta.appearanceChange) {
      npc.appearance = delta.appearanceChange;
    }
  }

  // 6. Movement
  if (delta.moveTo) {
    const topology = dgsm.getTopology();
    const currentPos = dgsm.getCharacterPosition(characterId);
    const targetPos = resolveTargetPosition(delta.moveTo, topology, dgsm);

    if (currentPos && targetPos) {
      const path = findTopologyPath(
        currentPos,
        targetPos,
        topology,
        state.blockedConnections,
        dgsm
      );

      if (path) {
        dgsm.setCharacterPosition(characterId, targetPos);
      } else {
        // Path blocked
        if (memoryManager && sessionId && moduleId && gameDay && gameTime) {
          const locationId = dgsm.resolveLocationId(currentPos);
          await memoryManager.add({
            npcId: characterId,
            sessionId,
            moduleId,
            type: "event",
            content: `I tried to move to ${delta.moveTo} but the path was blocked.`,
            gameDay,
            gameTime,
            location: locationId,
          });
        }
        return { blocked: true };
      }
    }
  }

  return {};
}
