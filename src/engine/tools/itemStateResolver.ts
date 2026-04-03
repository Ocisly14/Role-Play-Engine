/**
 * LLM-based state resolver for the item ActionTool.
 *
 * After the handler determines success/failure via dice,
 * this module asks a MEDIUM-class LLM to produce concrete
 * state deltas (item locations, item updates, scene conditions, outcome)
 * for the actor.
 */

import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import { ModelClass, generateText } from "../../models/index.js";
import type {
  ActionResolutionContext,
  ItemResult,
  NewItemEntry,
  ObjectStateDelta,
  PlanNode,
  SuccessLevel,
} from "../../npc/planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { Item } from "../../state/types.js";
import type { GameEngineRegistry } from "../registry.js";
import {
  buildExecutionContextPromptBlock,
  diffMinutes,
} from "../runtime/resolutionExecutionContext.js";
import { deepMergeItem } from "../shared/deepMerge.js";
import { parseJsonResponse } from "../shared/jsonParse.js";
import { buildWorldStateBlock } from "../shared/worldStateBlock.js";

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
Given an NPC's object interaction that has already been determined to complete, fail, or be interrupted, determine the concrete item state changes, scene condition changes, and outcome.

## Execution Status
- **completed**: resolve the action normally.
- **failed**: the primary goal did NOT succeed. Usually output no item transfer, though grounded side effects are allowed.
- **interrupted**: the action stopped partway through. Use elapsed time and interruption context to decide whether there is no effect or only a partial effect. Do NOT assume the intended result fully happened.

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
- **Skill check failed**: the action did NOT succeed. Reflect this in the outcome. Minor side effects (dropping something, making noise, partial damage) are acceptable but the primary goal was not achieved.

## Hidden Items & Discovery
Some items have a "discoveryMethod" field — these are hidden or not immediately obvious. When the actor's action relates to such an item, decide whether the actor discovers/accesses it based on:
1. **The action description** — is the actor specifically searching in the right place or doing something relevant?
2. **The discoveryMethod** — this describes how the item can be found (e.g. "search the desk drawers", "examine the bookshelf carefully"). The actor's action should be reasonably related.
3. **The skill roll result** — higher success = more likely to find hidden items. No skill check = only obvious items found.

If the actor **can** access the hidden item: process it normally (move, inspect, modify, etc.).
If the actor **cannot** (wrong approach, failed roll, physically blocked like a locked container without a key): do NOT include the item in the "items" array. Instead, note in the outcome what happened — e.g. "Searched the desk but found nothing unusual", "Tried to open the cabinet but it was locked solid".

The actor's related memories (if provided) give important context — they may recall hearing about this item, seeing someone else interact with it, or having prior knowledge of its existence. Use this to inform whether the actor would know to look for it and how they approach the interaction.

## Inspect Actions
For "inspect" actions, no item changes are typically needed. Write a factual outcome describing what the inspection revealed — textures, markings, wear, hidden compartments, anything observable based on the skill result.

## Narrative Grounding
- **Deterministic facts must match injected data:** items, objects, scene contents, sensory observations (what characters see/hear/smell), and physical properties must come from the provided context. Do not fabricate objects or details that objectively exist or don't exist in the world.
- **Non-deterministic character behavior may be creative:** how the character handles the object, their reactions, internal thoughts, and descriptions of the physical interaction are yours to craft.

## CRITICAL: No Fabrication
- **All judgments must be grounded in the provided data.** You are a state resolver, not a story generator. Every item change you output must trace back to concrete information in the action node, skill roll results, actor inventory, or scene items.
- **Never fabricate items:** Do not invent items that do not appear in the actor inventory or scene items list. "newItems" may only be used when an existing item is being disassembled or transformed — the source item must exist in the provided data. Do not conjure items out of thin air.
- **Never fabricate item properties:** When writing item "updates", only describe properties that are plausible given the item's existing data and the action performed. Do not add capabilities, contents, or descriptions that have no basis in the provided context.
- **Outcome must reflect actual events:** The outcome must describe what actually happened based on the action and skill roll. Do not invent discoveries, observations, or sensory details that are not supported by the scene data and item data provided. If the scene data does not describe a detail, it was not observed.
- **Be substantive, not imaginative:** If the provided data is sparse, the outcome should be proportionally simple. Do not fill gaps with invented content. An empty scene stays empty — do not populate it with imagined objects.

## Actor Conditions
If the actor has physical conditions listed (e.g. "detained", "restrained", "unconscious"), these represent binding constraints on the actor's current state. A detained or restrained actor cannot freely manipulate objects, move items, or perform actions requiring free movement. Reflect these constraints in the outcome — the action should fail or be severely limited if it contradicts the actor's physical state.

## Outcome
Always required. Write a factual third-person description of what happened to the items: what moved, what changed, what was discovered. This is NOT the actor's memory — it is an objective summary for the engine.
- Keep it concise: 1-2 sentences.
- Write in English (always English, regardless of game language).

## Output
Return a single JSON object. No extra text. JSON keys must be in English.

\`\`\`json
{
  "items": [
    { "itemId": "cash_box", "location": "inventory", "updates": {} }
  ],
  "newItems": [
    { "id": "gear_01", "name": "Small Gear", "type": "other", "description": "A tiny brass gear", "location": "scene", "sourceItemId": "clock_01" }
  ],
  "outcome": "factual third-person description (REQUIRED)"
}
\`\`\``;
}

function buildUserPrompt(
  node: PlanNode,
  locationId: string,
  actorName: string,
  actorConditions: string[],
  actorInventory: Item[],
  sceneItems: Item[],
  sceneDescription: string,
  itemContexts: Record<string, string> | undefined,
  skillRollResult: { successLevel: SuccessLevel; detail: string } | null,
  relatedMemories: string[],
  worldStateBlock: string,
  resolutionContext: ActionResolutionContext
): string {
  // Section 1: Object Interaction Node
  const nodeSection = JSON.stringify(
    {
      action: node.action,
      type: node.type,
      skill: node.skill,
      impact: node.impact,
      location: locationId,
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
    ...(actorConditions.length > 0
      ? [`Conditions: ${actorConditions.join(", ")}`]
      : []),
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
    buildExecutionContextPromptBlock(resolutionContext),
    "",
    actorSection,
    "",
    actorInvSection,
    "",
    sceneSection,
    "",
    sceneItemsSection,
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
export async function resolveItemState(
  node: PlanNode,
  dgsm: DynamicGameStateManager,
  runtime: any,
  skillRollResult: { successLevel: SuccessLevel; detail: string } | null,
  locationId: string,
  language?: string,
  memoryManager?: NpcMemoryManager,
  sessionId?: string,
  registry?: GameEngineRegistry,
  featureNotes?: string[],
  resolutionContext?: ActionResolutionContext
): Promise<ObjectStateDelta> {
  const state = dgsm.getState();
  const resolvedLanguage = language ?? locationId;
  const resolvedLocationId =
    language == null
      ? (() => {
          const pos = dgsm.getCharacterPosition(node.characterId);
          return pos ? dgsm.resolveLocationId(pos) : "";
        })()
      : locationId;

  // Collect actor inventory
  const actorInventory = dgsm.getNpcInventory(node.characterId);

  // Get actor name and conditions
  const actorNpc = state.npcCharacters.find((n) => n.id === node.characterId);
  const actorName = actorNpc?.name ?? node.characterName;
  const actorConditions = actorNpc?.status?.conditions ?? [];

  // Get scene data
  const scene = dgsm.getScene(resolvedLocationId);
  const sceneItems = scene?.items ?? [];
  const sceneDescription = scene
    ? `${(scene as any).name ?? resolvedLocationId}: ${(scene as any).description ?? ""}`
    : "(no scene data)";
  const itemContexts = (scene as any)?.itemContexts as
    | Record<string, string>
    | undefined;

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
    resolvedLocationId,
    registry
  );

  // Build prompts
  const systemPrompt = buildSystemPrompt(resolvedLanguage);
  let userPrompt = buildUserPrompt(
    node,
    resolvedLocationId,
    actorName,
    actorConditions,
    actorInventory,
    sceneItems,
    sceneDescription,
    itemContexts,
    skillRollResult,
    relatedMemories,
    worldStateBlock,
    resolutionContext ?? {
      executionStatus: "completed",
      startedAt: node.executionMeta.startedAt ?? node.startTime,
      resolvedAt: node.endTime,
      elapsedMinutes: Math.max(1, diffMinutes(node.startTime, node.endTime)),
      plannedMinutes: Math.max(1, diffMinutes(node.startTime, node.endTime)),
    }
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
      outcome?: string;
    }>(response);

    return {
      items: parsed.items ?? [],
      newItems: parsed.newItems,
      outcome: parsed.outcome ?? node.action,
    };
  } catch (error) {
    console.warn(
      `[ItemStateResolver] LLM call failed, using fallback:`,
      error instanceof Error ? error.message : error
    );

    return {
      items: [],
      outcome: node.action,
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
 * Shared by object_interaction and current-location action resolvers.
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
}
