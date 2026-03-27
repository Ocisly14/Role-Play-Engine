/**
 * LLM-based state resolver for object_interaction nodes.
 *
 * After the handler determines success/failure via dice,
 * this module asks a MEDIUM-class LLM to produce concrete
 * state deltas (item locations, item updates, scene conditions, memories)
 * for the actor and any witnesses.
 */

import { ModelClass, generateText } from "../../../models/index.js";
import type {
  ItemResult,
  NewItemEntry,
  ObjectStateDelta,
  PlanNode,
  SuccessLevel,
} from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { Item } from "../../state/types.js";
import type { GameEngineRegistry } from "../registry.js";
import { deepMergeItem } from "../shared/deepMerge.js";
import { buildWorldStateBlock } from "../shared/worldStateBlock.js";

// ─── Helpers ──────────────────────────────────────────────────────────

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

// ─── Item formatter ───────────────────────────────────────────────────

function formatItem(item: Item): string {
  const parts: string[] = [
    `- [${item.id}] ${item.name}`,
    `  type: ${item.type ?? "other"}`,
  ];
  if (item.description) parts.push(`  description: ${item.description}`);
  if (item.category) parts.push(`  category: ${item.category}`);
  if (item.discoveryMethod)
    parts.push(`  discoveryMethod: ${item.discoveryMethod}`);
  if (item.reveals?.length)
    parts.push(`  reveals: ${JSON.stringify(item.reveals)}`);
  if (item.damaged) {
    parts.push(`  damaged: true`);
    if (item.damageDetails)
      parts.push(`  damageDetails: ${JSON.stringify(item.damageDetails)}`);
  }
  if (item.isLightSource != null)
    parts.push(
      `  isLightSource: ${item.isLightSource}, lightLevel: ${item.lightLevel ?? "unknown"}`
    );
  if (item.consumableStats) {
    const cs = item.consumableStats;
    const statParts: string[] = [];
    if (cs.uses != null) statParts.push(`uses: ${cs.uses}`);
    if (cs.effect) statParts.push(`effect: ${cs.effect}`);
    if (cs.duration) statParts.push(`duration: ${cs.duration}`);
    if (statParts.length)
      parts.push(`  consumableStats: { ${statParts.join(", ")} }`);
  }
  if (item.containerStats) {
    const cs = item.containerStats;
    const lockLabel = cs.locked ? "locked" : "unlocked";
    const storedNames =
      cs.storedItems && cs.storedItems.length > 0
        ? cs.storedItems.map((si) => si.name).join(", ")
        : "empty";
    parts.push(`  container: ${lockLabel}, contents: [${storedNames}]`);
    if (cs.storedItems && cs.storedItems.length > 0) {
      for (const si of cs.storedItems) {
        parts.push(`    stored: [${si.id}] ${si.name}`);
      }
    }
  }
  if (item.weaponStats) {
    const ws = item.weaponStats;
    const wsParts: string[] = [];
    if (ws.damage) wsParts.push(`damage: ${ws.damage}`);
    if (ws.range) wsParts.push(`range: ${ws.range}`);
    if (ws.ammo != null) wsParts.push(`ammo: ${ws.ammo}`);
    if (ws.attacksPerRound)
      wsParts.push(`attacksPerRound: ${ws.attacksPerRound}`);
    if (wsParts.length) parts.push(`  weaponStats: { ${wsParts.join(", ")} }`);
  }
  return parts.join("\n");
}

// ─── Prompt builders ──────────────────────────────────────────────────

function buildSystemPrompt(language: string): string {
  return `You are a Call of Cthulhu 7th Edition game state resolver for object interactions.
Given an NPC's object interaction that has already been determined to succeed/fail via dice, determine the concrete item state changes, scene condition changes, and memory.

## Items Array
Output an "items" array. Each entry has:
- "itemId": the exact item ID from the provided data. NEVER invent item IDs.
- "location": the item's final location after this action:
  - "scene" = in the current scene (use the item's "description" field in "updates" to specify where exactly — e.g. "on the desk", "tucked behind the bookshelf")
  - "inventory" = actor's inventory
  - "inventory:<npcId>" = a specific NPC's inventory
  - "container:<containerId>" = inside a container item
  - "destroyed" = removed from play entirely
- "updates": (optional) an object of Item fields to deep-merge into the item. Only include if the item's properties changed.
  Supported update fields: "name", "type", "category", "description", "damaged", "damageDetails", "discoveryMethod", "reveals", "isLightSource", "lightLevel", "consumableStats", "containerStats", "weaponStats".

Only include items that actually changed location or properties. Omit unchanged items.

## New Items Array
Use "newItems" when an action produces items that don't exist yet (disassembly, crafting). Each entry has:
- "id": a new unique ID (use a descriptive slug, e.g. "broken_gear_01")
- "name": display name
- "type": item type (optional)
- "description": item description (optional)
- "category": "evidence" or "mundane" (optional)
- "location": where the new item appears (same format as items.location)
- "sourceItemId": (optional) the original item this was produced from — the source item is automatically destroyed. Multiple new items can share the same sourceItemId (the source is only removed once).

## What You Can Do With Items
You have full creative freedom to determine outcomes based on the action description and skill roll result:
- **Move** items between locations (scene, inventories, containers)
- **Modify** any item property — description, state, damage, lock status, contents
- **Destroy** items (set location to "destroyed")
- **Disassemble** items — destroy the original, output resulting parts as "newItems" (e.g. breaking a clock yields gears, batteries as new items)
- **Combine/Transform** items — create a new combined item via "newItems" and set "sourceItemId" on each entry to destroy the consumed components automatically.
- **Open locked containers** — if the actor has a key, picks the lock (via skill check), forces it open, or finds another creative way based on the action and roll result. Whether a lock can be opened is determined by the skill roll result and the item's properties. Some lock may need higher level of success to open it. A critical success might open it cleanly; a regular success might damage the lock; a failure might jam it further.

Base your decisions on:
1. The **action description** — what the actor is trying to do
2. The **skill roll result** — critical/hard/regular success enables increasingly impressive outcomes
3. **Physical plausibility** within the CoC 7e setting — a person can break a wooden box but not a steel vault with bare hands

## Skill Check Results
- **No skill check (auto success)**: routine actions succeed as described
- **Critical success**: exceptional outcome — maximum effect, bonus discoveries, pristine execution
- **Hard success**: strong outcome — action succeeds cleanly
- **Regular success**: moderate outcome — action succeeds but may be imperfect (slight damage, noise, etc.)
- **Skill check failed**: the action did NOT succeed. Reflect this in the memory. Minor side effects (dropping something, making noise, partial damage) are acceptable but the primary goal was not achieved.

## Hidden Items & Discovery
Some items have a "discoveryMethod" field — these are hidden or not immediately obvious. When the actor's action relates to such an item, decide whether the actor discovers/accesses it based on:
1. **The action description** — is the actor specifically searching in the right place or doing something relevant?
2. **The discoveryMethod** — this describes how the item can be found (e.g. "search the desk drawers", "examine the bookshelf carefully"). The actor's action should be reasonably related.
3. **The skill roll result** — higher success = more likely to find hidden items. No skill check = only obvious items found.

If the actor **can** access the hidden item: process it normally (move, inspect, modify, etc.).
If the actor **cannot** (wrong approach, failed roll, physically blocked like a locked container without a key): do NOT include the item in the "items" array. Instead, explain in the actor's memory what happened from their first-person perspective — e.g. "I searched the desk but didn't find anything unusual", "I tried to open the cabinet but it was locked solid", "I rummaged through the papers but nothing caught my eye."

The actor's related memories (if provided) give important context — they may recall hearing about this item, seeing someone else interact with it, or having prior knowledge of its existence. Use this to inform whether the actor would know to look for it and how they approach the interaction.

## Inspect Actions
For "inspect" actions, no item changes are typically needed. Write a detailed memory of what the actor observed — describe textures, markings, wear, hidden compartments, anything the character would notice based on the skill result.

## Scene Conditions
Use "addSceneConditions" for observable environmental changes caused by the action (e.g. "desk drawer left open", "broken glass on the floor"). Each entry is a short description string.

## Witnesses
If other NPCs are present in the scene, decide if they noticed the action based on context:
- Obvious actions (moving furniture, breaking things, loud noise) → witnesses notice
- Subtle actions (quietly pocketing a small item, reading a document) → may go unnoticed
- The actor's intent matters — if they are deliberately being stealthy, witnesses are less likely to notice
Write a first-person witness memory only for those who noticed, keyed by NPC ID in "witnessMemories".

## Narrative Grounding
- **Deterministic facts must match injected data:** items, objects, scene contents, sensory observations (what characters see/hear/smell), and physical properties must come from the provided context. Do not fabricate objects or details that objectively exist or don't exist in the world.
- **Non-deterministic character behavior may be creative:** how the character handles the object, their reactions, internal thoughts, and descriptions of the physical interaction are yours to craft.

## Memory
Always required for the actor. Write from the actor's first-person perspective: what they did, what they observed, and the result. Write in ${language}.

## Output
Return a single JSON object. No extra text. JSON keys must be in English. Write "memory" and witness memory values in ${language}.

\`\`\`json
{
  "items": [
    { "itemId": "cash_box", "location": "inventory", "updates": {} }
  ],
  "newItems": [
    { "id": "gear_01", "name": "Small Gear", "type": "other", "description": "A tiny brass gear", "location": "scene", "sourceItemId": "clock_01" }
  ],
  "addSceneConditions": ["desk drawer left open"],
  "memory": "first-person account (REQUIRED)",
  "witnessMemories": { "<npc_id>": "first-person witness account" }
}
\`\`\``;
}

function buildUserPrompt(
  node: PlanNode,
  actorName: string,
  actorInventory: Item[],
  sceneItems: Item[],
  sceneDescription: string,
  itemContexts: Record<string, string> | undefined,
  witnesses: Array<{ id: string; name: string }>,
  skillRollResult: { successLevel: SuccessLevel; detail: string } | null,
  relatedMemories: string[],
  worldStateBlock: string
): string {
  // Section 1: Object Interaction Node
  const nodeSection = JSON.stringify(
    {
      action: node.action,
      type: node.type,
      skill: node.skill,
      impact: node.impact,
      location: node.location,
      targetItemId: node.objectInteractionPayload?.itemId,
    },
    null,
    2
  );

  // Skill roll result
  const rollSection = skillRollResult
    ? `Skill roll: ${skillRollResult.successLevel} — ${skillRollResult.detail}`
    : "No skill check — auto success";

  // Section 3: Actor
  const actorSection = [
    `## Actor`,
    `Name: ${actorName}`,
    `ID: ${node.characterId}`,
  ].join("\n");

  // Section 4: Actor Inventory
  const actorInvSection =
    actorInventory.length > 0
      ? [
          `### Actor Inventory`,
          ...actorInventory.map((item) => formatItem(item)),
        ].join("\n")
      : `### Actor Inventory\n(empty)`;

  // Section 5: Scene
  const sceneSection = [`## Scene`, sceneDescription].join("\n");

  // Section 6: Scene Items
  let sceneItemsSection: string;
  if (sceneItems.length > 0) {
    const lines = sceneItems.map((item) => {
      const base = formatItem(item);
      const ctx = itemContexts?.[item.id];
      return ctx ? `${base}\n  (context: ${ctx})` : base;
    });
    sceneItemsSection = [`### Scene Items`, ...lines].join("\n");
  } else {
    sceneItemsSection = `### Scene Items\n(none)`;
  }

  // Section 7: Other NPCs Present
  const witnessSection =
    witnesses.length > 0
      ? [
          `## Other NPCs Present`,
          ...witnesses.map((w) => `- ${w.name} (${w.id})`),
        ].join("\n")
      : `## Other NPCs Present\n(none)`;

  const memorySection =
    relatedMemories.length > 0
      ? [
          `## Actor's Related Memories`,
          ...relatedMemories.map((m, i) => `${i + 1}. ${m}`),
        ].join("\n")
      : null;

  return [
    "# Object Interaction Node",
    nodeSection,
    "",
    rollSection,
    "",
    actorSection,
    "",
    actorInvSection,
    "",
    sceneSection,
    "",
    sceneItemsSection,
    "",
    witnessSection,
    ...(memorySection ? ["", memorySection] : []),
    ...(worldStateBlock ? ["", worldStateBlock] : []),
  ].join("\n");
}

// ─── Main resolver ────────────────────────────────────────────────────

/**
 * Call the LLM to determine state changes for an object_interaction node.
 *
 * @param node             The PlanNode being executed (already success/fail determined).
 * @param dgsm             Dynamic game state manager.
 * @param runtime          Model runtime (passed through to generateText).
 * @param skillRollResult  Result of the skill roll, or null if auto-success.
 * @param language         Language code for memory text (e.g., "en", "zh").
 * @param memoryManager    Optional NPC memory manager for querying related memories.
 * @param sessionId        Session ID (required when memoryManager is provided).
 * @returns Concrete state deltas for items, conditions, and memories.
 */
export async function resolveObjectInteractionState(
  node: PlanNode,
  dgsm: DynamicGameStateManager,
  runtime: any,
  skillRollResult: { successLevel: SuccessLevel; detail: string } | null,
  language: string,
  memoryManager?: NpcMemoryManager,
  sessionId?: string,
  registry?: GameEngineRegistry,
  featureNotes?: string[]
): Promise<ObjectStateDelta> {
  const state = dgsm.getState();

  // Collect actor inventory
  const actorInventory = dgsm.getNpcInventory(node.characterId);

  // Get actor name
  const actorNpc = state.npcCharacters.find((n) => n.id === node.characterId);
  const actorName = actorNpc?.name ?? node.characterName;

  // Get scene data
  const scene = dgsm.getScene(node.location);
  const sceneItems = scene?.items ?? [];
  const sceneDescription = scene
    ? `${(scene as any).name ?? node.location}: ${(scene as any).description ?? ""}`
    : "(no scene data)";
  const itemContexts = (scene as any)?.itemContexts as
    | Record<string, string>
    | undefined;

  // Find witnesses: NPCs in the same scene, excluding the actor
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

  // Query related memories about the target item via semantic search
  let relatedMemories: string[] = [];
  if (memoryManager && sessionId) {
    try {
      const payload = node.objectInteractionPayload;
      const targetItem = payload?.itemId
        ? (sceneItems.find((i) => i.id === payload.itemId) ??
          actorInventory.find((i) => i.id === payload.itemId))
        : null;
      const searchQuery = targetItem
        ? `${targetItem.name} ${targetItem.description ?? ""}`
        : node.action;

      const results = await memoryManager.query({
        npcId: node.characterId,
        sessionId,
        query: searchQuery,
        filters: { currentGameDay: state.gameDay },
        limit: 5,
      });
      relatedMemories = results.map((r) => r.content);
    } catch {
      // Non-critical — proceed without memories
    }
  }

  // Build world state block (weather, fire, stamina, sanity)
  const worldStateBlock = buildWorldStateBlock(
    dgsm,
    node.characterId,
    node.location,
    registry
  );

  // Build prompts
  const systemPrompt = buildSystemPrompt(language);
  let userPrompt = buildUserPrompt(
    node,
    actorName,
    actorInventory,
    sceneItems,
    sceneDescription,
    itemContexts,
    witnesses,
    skillRollResult,
    relatedMemories,
    worldStateBlock
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
      items?: ItemResult[];
      newItems?: NewItemEntry[];
      addSceneConditions?: string[];
      memory?: string;
      witnessMemories?: Record<string, string>;
    }>(response);

    return {
      items: parsed.items ?? [],
      newItems: parsed.newItems,
      addSceneConditions: parsed.addSceneConditions,
      memory: parsed.memory ?? node.action,
      witnessMemories: parsed.witnessMemories,
    };
  } catch (error) {
    console.warn(
      `[ObjectInteractionStateResolver] LLM call failed, using fallback:`,
      error instanceof Error ? error.message : error
    );

    return {
      items: [],
      memory: node.action,
    };
  }
}

// ─── State applicator ─────────────────────────────────────────────────

interface ItemLocation {
  source:
    | "scene"
    | "inventory"
    | "npc-inventory"
    | "container-scene"
    | "container-inventory";
  /** The Item reference */
  item: Item;
  /** NPC ID when source is "inventory" or "npc-inventory" */
  npcId?: string;
  /** Container Item ID when source is "container-scene" or "container-inventory" */
  containerId?: string;
  /** NPC ID that owns the container, when source is "container-inventory" */
  containerOwnerId?: string;
}

/**
 * Find the current location of an item by searching all possible places.
 */
function findItemLocation(
  itemId: string,
  actorId: string,
  dgsm: DynamicGameStateManager,
  sceneId: string
): ItemLocation | null {
  // 1. Check actor inventory
  const actorInv = dgsm.getNpcInventory(actorId);
  const inActorInv = actorInv.find((i) => i.id === itemId);
  if (inActorInv) {
    return { source: "inventory", item: inActorInv, npcId: actorId };
  }

  // 2. Check scene items
  const scene = dgsm.getScene(sceneId);
  if (scene?.items) {
    const inScene = scene.items.find((i) => i.id === itemId);
    if (inScene) {
      return { source: "scene", item: inScene };
    }

    // 3. Check containers in scene
    for (const sceneItem of scene.items) {
      if (sceneItem.containerStats?.storedItems) {
        const inContainer = sceneItem.containerStats.storedItems.find(
          (si) => si.id === itemId
        );
        if (inContainer) {
          return {
            source: "container-scene",
            item: inContainer,
            containerId: sceneItem.id,
          };
        }
      }
    }
  }

  // 4. Check containers in actor inventory
  for (const invItem of actorInv) {
    if (invItem.containerStats?.storedItems) {
      const inContainer = invItem.containerStats.storedItems.find(
        (si) => si.id === itemId
      );
      if (inContainer) {
        return {
          source: "container-inventory",
          item: inContainer,
          containerId: invItem.id,
          containerOwnerId: actorId,
        };
      }
    }
  }

  // 5. Check other NPCs' inventories (for transfers)
  const state = dgsm.getState();
  for (const npc of state.npcCharacters) {
    if (npc.id === actorId) continue;
    const npcInv = dgsm.getNpcInventory(npc.id);
    const inNpcInv = npcInv.find((i) => i.id === itemId);
    if (inNpcInv) {
      return { source: "npc-inventory", item: inNpcInv, npcId: npc.id };
    }
  }

  return null;
}

/**
 * Remove an item from its current location.
 */
function removeFromCurrent(
  loc: ItemLocation,
  dgsm: DynamicGameStateManager,
  sceneId: string
): void {
  switch (loc.source) {
    case "inventory":
    case "npc-inventory": {
      dgsm.removeItemFromNpc(loc.npcId!, loc.item.id);
      break;
    }
    case "scene": {
      const scene = dgsm.getScene(sceneId);
      if (scene?.items) {
        const idx = scene.items.findIndex((i) => i.id === loc.item.id);
        if (idx !== -1) scene.items.splice(idx, 1);
      }
      break;
    }
    case "container-scene": {
      const scene = dgsm.getScene(sceneId);
      if (scene?.items) {
        const container = scene.items.find((i) => i.id === loc.containerId);
        if (container?.containerStats?.storedItems) {
          const idx = container.containerStats.storedItems.findIndex(
            (i) => i.id === loc.item.id
          );
          if (idx !== -1) container.containerStats.storedItems.splice(idx, 1);
        }
      }
      break;
    }
    case "container-inventory": {
      const ownerInv = dgsm.getNpcInventory(loc.containerOwnerId!);
      const container = ownerInv.find((i) => i.id === loc.containerId);
      if (container?.containerStats?.storedItems) {
        const idx = container.containerStats.storedItems.findIndex(
          (i) => i.id === loc.item.id
        );
        if (idx !== -1) container.containerStats.storedItems.splice(idx, 1);
      }
      break;
    }
  }
}

/**
 * Add an item to a target location.
 */
function addToTarget(
  item: Item,
  targetLocation: string,
  actorId: string,
  dgsm: DynamicGameStateManager,
  sceneId: string
): void {
  if (targetLocation === "scene") {
    const scene = dgsm.getScene(sceneId);
    if (scene?.items) {
      scene.items.push(item);
    }
  } else if (targetLocation === "inventory") {
    dgsm.addItemToNpc(actorId, item);
  } else if (targetLocation.startsWith("inventory:")) {
    const npcId = targetLocation.slice("inventory:".length);
    dgsm.addItemToNpc(npcId, item);
  } else if (targetLocation.startsWith("container:")) {
    const containerId = targetLocation.slice("container:".length);
    // Find the container in scene or actor inventory
    const scene = dgsm.getScene(sceneId);
    let container: Item | undefined;
    if (scene?.items) {
      container = scene.items.find((i) => i.id === containerId);
    }
    if (!container) {
      const actorInv = dgsm.getNpcInventory(actorId);
      container = actorInv.find((i) => i.id === containerId);
    }
    if (container) {
      if (!container.containerStats) {
        container.containerStats = {};
      }
      if (!container.containerStats.storedItems) {
        container.containerStats.storedItems = [];
      }
      container.containerStats.storedItems.push(item);
    }
  }
  // "destroyed" — don't add anywhere
}

/**
 * Apply a list of item results (final location + optional field updates).
 * Shared by object_interaction and scene_interaction resolvers.
 */
export function applyItemResults(
  dgsm: DynamicGameStateManager,
  actorId: string,
  items: ItemResult[],
  sceneId: string
): void {
  for (const itemResult of items) {
    const loc = findItemLocation(itemResult.itemId, actorId, dgsm, sceneId);
    if (!loc) {
      console.warn(
        `[applyItemResults] Item "${itemResult.itemId}" not found anywhere — skipping.`
      );
      continue;
    }

    if (itemResult.updates && Object.keys(itemResult.updates).length > 0) {
      deepMergeItem(
        loc.item as unknown as Record<string, unknown>,
        itemResult.updates as Record<string, unknown>
      );
    }

    let currentLocationStr: string;
    switch (loc.source) {
      case "scene":
        currentLocationStr = "scene";
        break;
      case "inventory":
        currentLocationStr = "inventory";
        break;
      case "npc-inventory":
        currentLocationStr = `inventory:${loc.npcId}`;
        break;
      case "container-scene":
      case "container-inventory":
        currentLocationStr = `container:${loc.containerId}`;
        break;
    }

    const targetLocation = itemResult.location;
    if (targetLocation !== currentLocationStr) {
      removeFromCurrent(loc, dgsm, sceneId);
      if (targetLocation !== "destroyed") {
        addToTarget(loc.item, targetLocation, actorId, dgsm, sceneId);
      }
    }
  }
}

/**
 * Apply the resolved object state delta to the game state.
 *
 * For each ItemResult:
 * 1. Find the item's current location
 * 2. Apply updates if present
 * 3. If target location differs, move the item
 *
 * Also applies scene condition additions.
 */
export function applyObjectDelta(
  dgsm: DynamicGameStateManager,
  actorId: string,
  delta: ObjectStateDelta,
  sceneId: string
): void {
  applyItemResults(dgsm, actorId, delta.items, sceneId);

  // Create new items from disassembly/crafting, auto-remove sources
  if (delta.newItems) {
    const removedSources = new Set<string>();
    for (const entry of delta.newItems) {
      // Remove source item once
      if (entry.sourceItemId && !removedSources.has(entry.sourceItemId)) {
        const sourceLoc = findItemLocation(
          entry.sourceItemId,
          actorId,
          dgsm,
          sceneId
        );
        if (sourceLoc) {
          removeFromCurrent(sourceLoc, dgsm, sceneId);
        }
        removedSources.add(entry.sourceItemId);
      }

      // Spread all fields except metadata (location, sourceItemId) onto the new Item
      const { location: _loc, sourceItemId: _src, ...itemFields } = entry;
      const newItem: Item = {
        type: "other",
        ...itemFields,
      } as Item;
      addToTarget(newItem, entry.location, actorId, dgsm, sceneId);
    }
  }

  // Apply scene condition additions
  if (delta.addSceneConditions) {
    for (const description of delta.addSceneConditions) {
      dgsm.appendSceneCondition(sceneId, { description });
    }
  }
}
