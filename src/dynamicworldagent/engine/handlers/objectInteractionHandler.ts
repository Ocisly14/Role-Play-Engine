import type {
  CharacterAction,
  ItemLocationRef,
  PlanNode,
} from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { Item } from "../../state/types.js";
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
        : (item.containerStats.contents ?? []);
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
    "An LLM resolver determines all item state changes (move, modify, destroy, disassemble, combine) " +
    "based on the action description and skill roll result.\n\n" +
    "Set `objectInteractionPayload.itemId` to the primary item being interacted with.\n\n" +
    "SKILL GUIDANCE: Do NOT set `skill` for routine actions — picking up items, opening unlocked containers, " +
    "inspecting objects, searching your own belongings, or using items normally. These always succeed without a roll. " +
    "Only set `skill` when the action is genuinely difficult: picking a lock without a key (Locksmith), " +
    "disarming a trap (Mechanical Repair), forcing open a stuck/barricaded container (STR), " +
    "or using an item in a non-standard way that requires expertise.",

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
      itemId: "petty_cash_box",
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

    // Item existence pre-check (fast-fail before LLM call)
    const payload = node.objectInteractionPayload;
    if (payload?.itemId) {
      const scene = dgsm.getScene(node.location);
      const inInventory = dgsm.findNpcItem(node.characterId, payload.itemId);
      const inScene = scene?.items.find((i) => i.id === payload.itemId);
      // Also check inside containers (scene + inventory)
      let inContainer = false;
      if (!inInventory && !inScene) {
        if (scene?.items) {
          for (const si of scene.items) {
            if (
              si.containerStats?.storedItems?.some(
                (s) => s.id === payload.itemId
              )
            ) {
              inContainer = true;
              break;
            }
          }
        }
        if (!inContainer) {
          const inv = dgsm.getNpcInventory(node.characterId);
          for (const ii of inv) {
            if (
              ii.containerStats?.storedItems?.some(
                (s) => s.id === payload.itemId
              )
            ) {
              inContainer = true;
              break;
            }
          }
        }
      }
      if (!inInventory && !inScene && !inContainer) {
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

    // Return success — tickProcessor calls LLM resolver for state changes
    const action = makeAction(node, "completed", node.action, {
      difficulty,
      successLevel: resolvedSuccessLevel,
    });
    action.rollDetail = lastRollDetail;
    return action;
  },
};
