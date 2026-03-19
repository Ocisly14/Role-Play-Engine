import type {
  CharacterAction,
  ItemLocationRef,
  PlanNode,
} from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { Item } from "../../state/types.js";
import { deepMergeItem } from "../shared/deepMerge.js";
import { isCharacterAtLocation } from "../shared/locationPresence.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";
import type { ExecutionContext, NodeHandler } from "../types.js";

// ── Normal-use type handlers ──────────────────────────────────

function useConsumable(
  item: Item,
  npcId: string,
  dgsm: DynamicGameStateManager
): string {
  if (item.consumableStats) {
    item.consumableStats.uses = Math.max(
      0,
      (item.consumableStats.uses ?? 1) - 1
    );
    if (item.consumableStats.uses <= 0) {
      dgsm.removeItemFromNpc(npcId, item.id);
      return `Used ${item.name} (consumed, removed from inventory)`;
    }
    return `Used ${item.name} (${item.consumableStats.uses} uses remaining)`;
  }
  return `Used ${item.name}`;
}

/** Returns a detail string on success, or null to signal failure. */
function useKey(
  item: Item,
  targetItemId: string | undefined,
  scene: { items: Item[] }
): string | null {
  if (!targetItemId) return null;
  const target = scene.items.find((i) => i.id === targetItemId);
  if (!target) return null;
  if (target.containerStats?.locked) {
    target.containerStats.locked = false;
    return `Unlocked ${target.name} with ${item.name}`;
  }
  return `${item.name} used on ${target.name} (already unlocked)`;
}

function useLighting(item: Item): string {
  item.isLightSource = !item.isLightSource;
  if (item.consumableStats && item.isLightSource) {
    item.consumableStats.uses = Math.max(
      0,
      (item.consumableStats.uses ?? 1) - 1
    );
  }
  return item.isLightSource
    ? `${item.name} turned on`
    : `${item.name} turned off`;
}

function useContainer(
  item: Item,
  npcId: string,
  dgsm: DynamicGameStateManager
): string {
  if (!item.containerStats) return `${item.name} has no container properties`;
  if (item.containerStats.locked) {
    const inv = dgsm.getNpcInventory(npcId);
    const key = inv.find((i) => i.type === "key");
    if (key) {
      item.containerStats.locked = false;
      return `Unlocked ${item.name} with ${key.name}`;
    }
    return `${item.name} is locked and you have no key`;
  }
  return `Opened ${item.name}`;
}

// ── Inspect helper ────────────────────────────────────────────

function buildInspectOutcome(item: Item): string {
  return buildInspectOutcomeWithContext(item);
}

function buildInspectOutcomeWithContext(
  item: Item,
  contextDescription?: string,
  contextLabel?: string
): string {
  const parts: string[] = [`[Inspect] ${item.name}`];
  if (item.description) parts.push(item.description);
  if (contextDescription) {
    parts.push(
      contextLabel
        ? `${contextLabel}: ${contextDescription}`
        : contextDescription
    );
  }
  if (item.damaged && item.damageDetails) {
    parts.push(`Damaged: ${item.damageDetails.reason}`);
  }
  if (item.containerStats) {
    const storedItems = item.containerStats.storedItems ?? [];
    const contentLabels =
      storedItems.length > 0
        ? storedItems.map((stored) => `${stored.name} (id:${stored.id})`)
        : item.containerStats.contents ?? [];
    if (item.containerStats.locked) {
      parts.push("Status: locked");
    } else if (contentLabels.length > 0) {
      parts.push(`Contents: ${contentLabels.join(", ")}`);
    } else {
      parts.push("Contents: empty");
    }
  }
  return parts.join(" | ");
}

function syncContainerContents(container: Item): void {
  if (!container.containerStats) return;
  const storedItems = container.containerStats.storedItems ?? [];
  container.containerStats.contents = storedItems.map((item) => item.id);
}

function findContainer(
  ref: ItemLocationRef,
  npcId: string,
  scene: { items: Item[] } | null,
  dgsm: DynamicGameStateManager
): Item | null {
  if (ref.type !== "container" || !ref.containerItemId) return null;

  if ((ref.scope ?? "scene") === "inventory") {
    return dgsm.findNpcItem(npcId, ref.containerItemId) ?? null;
  }

  return scene?.items.find((item) => item.id === ref.containerItemId) ?? null;
}

function removeItemFromMoveSource(
  ref: ItemLocationRef,
  itemId: string,
  npcId: string,
  scene: { items: Item[] } | null,
  dgsm: DynamicGameStateManager
): { item?: Item; error?: string } {
  if (ref.type === "scene") {
    if (!scene) return { error: "scene not found" };
    const idx = scene.items.findIndex((item) => item.id === itemId);
    if (idx === -1) return { error: `${itemId} not found in scene` };
    return { item: scene.items.splice(idx, 1)[0] };
  }

  if (ref.type === "inventory") {
    const item = dgsm.removeItemFromNpc(npcId, itemId);
    if (!item) return { error: `${itemId} not in inventory` };
    return { item };
  }

  const container = findContainer(ref, npcId, scene, dgsm);
  if (!container?.containerStats) {
    return { error: `${ref.containerItemId ?? "container"} not found` };
  }
  if (container.containerStats.locked) {
    return { error: `${container.name} is locked` };
  }

  const storedItems = container.containerStats.storedItems ?? [];
  const idx = storedItems.findIndex((item) => item.id === itemId);
  if (idx === -1) {
    return { error: `${itemId} not found in ${container.name}` };
  }

  const [item] = storedItems.splice(idx, 1);
  container.containerStats.storedItems = storedItems;
  syncContainerContents(container);
  return { item };
}

function addItemToMoveTarget(
  ref: ItemLocationRef,
  item: Item,
  npcId: string,
  scene: { items: Item[] } | null,
  dgsm: DynamicGameStateManager
): { error?: string } {
  if (ref.type === "scene") {
    if (!scene) return { error: "scene not found" };
    scene.items.push(item);
    return {};
  }

  if (ref.type === "inventory") {
    dgsm.addItemToNpc(npcId, item);
    return {};
  }

  const container = findContainer(ref, npcId, scene, dgsm);
  if (!container?.containerStats) {
    return { error: `${ref.containerItemId ?? "container"} not found` };
  }
  if (container.containerStats.locked) {
    return { error: `${container.name} is locked` };
  }

  const storedItems = container.containerStats.storedItems ?? [];
  storedItems.push(item);
  container.containerStats.storedItems = storedItems;
  syncContainerContents(container);
  return {};
}

function formatMoveRef(ref: ItemLocationRef): string {
  if (ref.type === "container") {
    const scope = ref.scope === "inventory" ? "inventory" : "scene";
    return `${scope} container ${ref.containerItemId ?? "unknown"}`;
  }
  return ref.type;
}

// ── Main handler ──────────────────────────────────────────────

export const objectInteractionHandler: NodeHandler = {
  type: "object_interaction",

  description:
    "Interact with an object in the current scene. " +
    "Supports move, use, inspect, and destroy actions. " +
    "Move uses explicit from/to refs so the same action can cover taking, putting back, stashing, and moving scene items into containers.\n\n" +
    "SKILL GUIDANCE: Do NOT set `skill` for routine actions — picking up items, opening unlocked containers, " +
    "inspecting objects, searching your own belongings, or using items normally. These always succeed without a roll. " +
    "Only set `skill` when the action is genuinely difficult: picking a lock without a key (Locksmith), " +
    "disarming a trap (Mechanical Repair), forcing open a stuck/barricaded container (STR), " +
    "or using an item in a non-standard way that requires expertise.\n\n" +
    "For non-normal use (skill set), include `itemUpdates` and/or `targetItemUpdates` " +
    "with the expected item state changes after success. Mergeable Item fields:\n" +
    "- `damaged` (boolean), `damageDetails`: `{ damagedBy, damagedAt, reason }`\n" +
    "- `isLightSource` (boolean), `lightLevel` (number)\n" +
    "- `consumableStats`: `{ uses, effect, duration }` — set uses to 0 to consume\n" +
    "- `containerStats`: `{ locked, contents, storedItems }` — set locked:false to unlock\n" +
    "- `weaponStats`: `{ ammo }` — decrement for ammo use",

  requiredFields: ["action", "location"],

  optionalFields: ["skill", "objectInteractionPayload"],

  exampleNode: {
    nodeId: "oi1",
    startTime: "14:00",
    endTime: "14:10",
    type: "object_interaction",
    action: "Move the petty cash box from the desk drawer into my briefcase",
    location: "study_room",
    impact: 1,
    objectInteractionPayload: {
      action: "move",
      itemId: "petty_cash_box",
      from: { type: "container", containerItemId: "desk_drawer", scope: "scene" },
      to: { type: "container", containerItemId: "briefcase", scope: "inventory" },
    },
  },

  execute(
    node: PlanNode,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext
  ): CharacterAction {
    const state = dgsm.getState();
    const pos = dgsm.getCharacterPosition(node.characterId);
    const npc = state.npcCharacters.find((n) => n.id === node.characterId);
    const npcSkills = npc?.skills ?? {};
    const difficulty = ctx.getNodeDifficulty(node, dgsm);

    // Scene + character penalties
    const scenePenalties = ctx.getScenePenalties(node.location, dgsm);
    const charPenalties = ctx.getCharacterPenalties(node.characterId, dgsm);
    const afterScene = ctx.applyPenalties(npcSkills, scenePenalties);
    const adjustedSkills = ctx.applyPenalties(afterScene, charPenalties);

    // Location check
    if (!isCharacterAtLocation(pos, node.location)) {
      return makeAction(
        node,
        "failed",
        buildOutcome(node, "failed", { reason: "not at expected location" }),
        { difficulty, failureReason: "location_mismatch" }
      );
    }

    // Skill roll (for non-normal use with skill)
    let resolvedSuccessLevel:
      | import("../../dynamicBasicAgent/npcPlanning/types.js").SuccessLevel
      | undefined;
    let lastRollDetail: string | undefined;

    // Skill roll if skill present; otherwise auto-success
    if (node.skill) {
      const rollResult = ctx.resolveSkillRoll(node, adjustedSkills, dgsm);
      resolvedSuccessLevel = rollResult.successLevel;
      if (rollResult.failed) {
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { rollDetail: rollResult.reason }),
          {
            difficulty,
            successLevel: resolvedSuccessLevel,
            failureReason: "skill_roll_failed",
          }
        );
      }
      lastRollDetail = rollResult.detail;
    }

    // ── Apply side effects ────────────────────────────────────
    const scene = dgsm.getScene(node.location);
    const payload = node.objectInteractionPayload;

    if (payload) {
      // --- Move ---
      if (
        payload.action === "move" &&
        payload.itemId &&
        payload.from &&
        payload.to
      ) {
        const sourceResult = removeItemFromMoveSource(
          payload.from,
          payload.itemId,
          node.characterId,
          scene,
          dgsm
        );
        if (!sourceResult.item) {
          return makeAction(
            node,
            "failed",
            buildOutcome(node, "failed", {
              reason: sourceResult.error ?? `${payload.itemId} not found`,
            }),
            { difficulty, failureReason: "object_not_found" }
          );
        }

        const targetResult = addItemToMoveTarget(
          payload.to,
          sourceResult.item,
          node.characterId,
          scene,
          dgsm
        );
        if (targetResult.error) {
          addItemToMoveTarget(
            payload.from,
            sourceResult.item,
            node.characterId,
            scene,
            dgsm
          );
          return makeAction(
            node,
            "failed",
            buildOutcome(node, "failed", {
              reason: targetResult.error,
            }),
            { difficulty, failureReason: "object_not_found" }
          );
        }

        lastRollDetail = `Moved ${sourceResult.item.name} from ${formatMoveRef(payload.from)} to ${formatMoveRef(payload.to)}`;
      }

      // --- Use ---
      else if (payload.action === "use" && payload.itemId) {
        // Find item in inventory or scene
        let item = dgsm.findNpcItem(node.characterId, payload.itemId);
        const itemInInventory = !!item;
        if (!item && scene) {
          item = scene.items.find((i) => i.id === payload.itemId);
        }
        if (!item) {
          return makeAction(
            node,
            "failed",
            buildOutcome(node, "failed", {
              reason: `${payload.itemId} not found`,
            }),
            { difficulty, failureReason: "object_not_found" }
          );
        }

        if (node.skill) {
          // Non-normal use: apply LLM-provided updates (skill check already passed above)
          if (payload.itemUpdates) {
            deepMergeItem(
              item as unknown as Record<string, unknown>,
              payload.itemUpdates as unknown as Record<string, unknown>
            );
          }
          if (payload.targetItemId && payload.targetItemUpdates && scene) {
            const target = scene.items.find(
              (i) => i.id === payload.targetItemId
            );
            if (target) {
              deepMergeItem(
                target as unknown as Record<string, unknown>,
                payload.targetItemUpdates as unknown as Record<string, unknown>
              );
            }
          }
          // Remove consumed items
          if (
            item.consumableStats &&
            item.consumableStats.uses !== undefined &&
            item.consumableStats.uses <= 0 &&
            itemInInventory
          ) {
            dgsm.removeItemFromNpc(node.characterId, item.id);
          }
        } else {
          // Normal use: type-specific handler
          let useDetail: string;
          switch (item.type) {
            case "consumable":
              useDetail = useConsumable(item, node.characterId, dgsm);
              break;
            case "key": {
              const keyResult = useKey(
                item,
                payload.targetItemId,
                scene ?? { items: [] }
              );
              if (keyResult === null) {
                return makeAction(
                  node,
                  "failed",
                  buildOutcome(node, "failed", {
                    reason: `no target specified for ${item.name}`,
                  }),
                  { difficulty, failureReason: "object_not_found" }
                );
              }
              useDetail = keyResult;
              break;
            }
            case "lighting":
              useDetail = useLighting(item);
              break;
            case "container":
              useDetail = useContainer(item, node.characterId, dgsm);
              break;
            default:
              useDetail = `Used ${item.name}`;
              break;
          }
          lastRollDetail = useDetail;
        }
      }

      // --- Inspect ---
      else if (payload.action === "inspect" && payload.itemId) {
        const inventoryItem = dgsm.findNpcItem(
          node.characterId,
          payload.itemId
        );
        let item = inventoryItem;
        let inspectOutcome: string | null = null;

        if (inventoryItem) {
          inspectOutcome = buildInspectOutcomeWithContext(
            inventoryItem,
            undefined
          );
        } else if (scene) {
          item = scene.items.find((i) => i.id === payload.itemId);
          if (item) {
            const sceneContext = scene.itemContexts?.[item.id];
            inspectOutcome = buildInspectOutcomeWithContext(item, sceneContext);
          }
        }
        if (!item) {
          return makeAction(
            node,
            "failed",
            buildOutcome(node, "failed", {
              reason: `${payload.itemId} not found`,
            }),
            { difficulty, failureReason: "object_not_found" }
          );
        }
        lastRollDetail = inspectOutcome ?? buildInspectOutcome(item);
      }

      // --- Destroy ---
      else if (payload.action === "destroy" && payload.itemId) {
        let removed = dgsm.removeItemFromNpc(node.characterId, payload.itemId);
        if (!removed && scene) {
          const idx = scene.items.findIndex((i) => i.id === payload.itemId);
          if (idx !== -1) {
            removed = scene.items.splice(idx, 1)[0];
          }
        }
        if (!removed) {
          return makeAction(
            node,
            "failed",
            buildOutcome(node, "failed", {
              reason: `${payload.itemId} not found`,
            }),
            { difficulty, failureReason: "object_not_found" }
          );
        }
      }
    }

    return makeAction(
      node,
      "completed",
      buildOutcome(node, "completed", { rollDetail: lastRollDetail }),
      { difficulty, successLevel: resolvedSuccessLevel }
    );
  },
};
