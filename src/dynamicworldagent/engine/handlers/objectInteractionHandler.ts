import type {
  CharacterAction,
  PlanNode,
} from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { Item } from "../../state/types.js";
import { deepMergeItem } from "../shared/deepMerge.js";
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
    if (item.containerStats.locked) {
      parts.push("Status: locked");
    } else if (item.containerStats.contents?.length) {
      parts.push(`Contents: ${item.containerStats.contents.join(", ")}`);
    } else {
      parts.push("Contents: empty");
    }
  }
  return parts.join(" | ");
}

// ── Main handler ──────────────────────────────────────────────

export const objectInteractionHandler: NodeHandler = {
  type: "object_interaction",

  description:
    "Interact with an object in the current scene. " +
    "Supports pickup, place, use, inspect, and destroy actions. " +
    "Side effects modify inventory and scene item lists.\n\n" +
    "For non-normal use (actionType set), include `itemUpdates` and/or `targetItemUpdates` " +
    "with the expected item state changes after success. Mergeable Item fields:\n" +
    "- `damaged` (boolean), `damageDetails`: `{ damagedBy, damagedAt, reason }`\n" +
    "- `isLightSource` (boolean), `lightLevel` (number)\n" +
    "- `consumableStats`: `{ uses, effect, duration }` — set uses to 0 to consume\n" +
    "- `containerStats`: `{ locked, contents }` — set locked:false to unlock\n" +
    "- `weaponStats`: `{ ammo }` — decrement for ammo use",

  requiredFields: ["action", "location"],

  optionalFields: ["actionType", "objectInteractionPayload"],

  exampleNode: {
    nodeId: "oi1",
    type: "object_interaction",
    action: "Pour acid on the padlock to dissolve it",
    location: "study_room",
    actionType: "exploration",
    impact: 2,
    timeAdvanceMinutes: 10,
    objectInteractionPayload: {
      action: "use",
      itemId: "acid_vial",
      targetItemId: "padlock",
      itemUpdates: { consumableStats: { uses: 0 } },
      targetItemUpdates: { containerStats: { locked: false }, damaged: true },
    },
  },

  execute(
    node: PlanNode,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext
  ): CharacterAction {
    const state = dgsm.getState();
    const npcLocation = dgsm.getNpcLocation(node.characterId);
    const npc = state.npcCharacters.find((n) => n.id === node.characterId);
    const npcSkills = npc?.skills ?? {};
    const luck = npc?.status?.luck ?? 50;
    const difficulty = ctx.getNodeDifficulty(node, dgsm);

    // Scene + character penalties
    const scenePenalties = ctx.getScenePenalties(node.location, dgsm);
    const charPenalties = ctx.getCharacterPenalties(node.characterId, dgsm);
    const afterScene = ctx.applyPenalties(npcSkills, scenePenalties);
    const adjustedSkills = ctx.applyPenalties(afterScene, charPenalties);

    // Location check
    if (npcLocation && npcLocation !== node.location) {
      return makeAction(
        node,
        "failed",
        buildOutcome(node, "failed", { reason: "not at expected location" }),
        { difficulty, failureReason: "location_mismatch" }
      );
    }

    // Skill roll (for non-normal use with actionType)
    let resolvedSuccessLevel:
      | import("../../dynamicBasicAgent/npcPlanning/types.js").SuccessLevel
      | undefined;
    let lastRollDetail: string | undefined;

    if (node.actionType) {
      // Luck check + skill roll
      if (Math.random() < ctx.luckFailureRate(luck)) {
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { reason: `bad luck (luck=${luck})` }),
          { difficulty, failureReason: "bad_luck" }
        );
      }
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
    } else {
      // No actionType: luck-only check
      if (Math.random() < ctx.luckFailureRate(luck)) {
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { reason: `bad luck (luck=${luck})` }),
          { difficulty, failureReason: "bad_luck" }
        );
      }
    }

    // ── Apply side effects ────────────────────────────────────
    const scene = dgsm.getScene(node.location);
    const payload = node.objectInteractionPayload;

    if (payload) {
      // --- Pickup ---
      if (payload.action === "pickup" && payload.itemId) {
        if (!scene) {
          return makeAction(
            node,
            "failed",
            buildOutcome(node, "failed", { reason: "scene not found" }),
            { difficulty, failureReason: "object_not_found" }
          );
        }
        const idx = scene.items.findIndex((i) => i.id === payload.itemId);
        if (idx === -1) {
          return makeAction(
            node,
            "failed",
            buildOutcome(node, "failed", {
              reason: `${payload.itemId} not found in scene`,
            }),
            { difficulty, failureReason: "object_not_found" }
          );
        }
        const item = scene.items.splice(idx, 1)[0];
        dgsm.addItemToNpc(node.characterId, item);
      }

      // --- Place ---
      else if (payload.action === "place" && payload.itemId) {
        const item = dgsm.removeItemFromNpc(node.characterId, payload.itemId);
        if (!item) {
          return makeAction(
            node,
            "failed",
            buildOutcome(node, "failed", {
              reason: `${payload.itemId} not in inventory`,
            }),
            { difficulty, failureReason: "object_not_found" }
          );
        }
        if (scene) {
          scene.items.push(item);
        }
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

        if (node.actionType) {
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
        return makeAction(
          node,
          "completed",
          inspectOutcome ?? buildInspectOutcome(item),
          { difficulty, successLevel: resolvedSuccessLevel }
        );
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
