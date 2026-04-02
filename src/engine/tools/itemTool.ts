import type { PlanNode } from "../../planning/types.js";
import type { ObjectStateDelta } from "../../planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type {
  ActionTool,
  ToolPreCheckResult,
  ToolResolutionResult,
} from "../types.js";
import { applyObjectDelta, resolveItemState } from "./itemStateResolver.js";

function findItemAnywhere(
  dgsm: DynamicGameStateManager,
  actorId: string,
  locationId: string,
  itemId: string
): boolean {
  if (dgsm.findNpcItem(actorId, itemId)) return true;
  const scene = dgsm.getScene(locationId);
  if (scene?.items?.find((i) => i.id === itemId)) return true;
  if (scene?.items) {
    for (const si of scene.items) {
      if (si.containerStats?.storedItems?.some((s) => s.id === itemId))
        return true;
    }
  }
  const inv = dgsm.getNpcInventory(actorId);
  for (const ii of inv) {
    if (ii.containerStats?.storedItems?.some((s) => s.id === itemId))
      return true;
  }
  return false;
}

export const itemTool: ActionTool<ObjectStateDelta> = {
  id: "item",
  description:
    "Item manipulation sub-system. Handles picking up, moving, modifying, destroying, disassembling, combining, and inspecting items in the scene or actor inventory.",
  argsSchema: {
    requiredArgs: [
      {
        name: "itemId",
        type: "string",
        description: "Exact item ID being targeted",
      },
    ],
  },
  exampleCall: { name: "item", args: { itemId: "petty_cash_box" } },
  planningPrompt: `## Item Manipulation Tool
When your action primarily targets a specific portable item (pick up, inspect,
open, combine, disassemble, use), call the "item" tool:

\`\`\`json
{ "name": "item", "args": { "itemId": "exact_item_id" } }
\`\`\`

SKILL GUIDANCE: Do NOT set \`skill\` for routine actions — picking up items,
opening unlocked containers, inspecting objects. Only set \`skill\` when genuinely
difficult: picking a lock (Locksmith), disarming a trap (Mechanical Repair),
forcing open a stuck container (STR).

Do NOT call the item tool for:
- Actions targeting the environment (searching a room, barring a door) — plain action
- Actions targeting a character (giving an item to someone) — character_interaction
- Examining the scene generally — plain action`,

  preCheck(
    node: PlanNode,
    args: Record<string, unknown>,
    dgsm: DynamicGameStateManager
  ): ToolPreCheckResult {
    const itemId = args.itemId as string | undefined;
    if (!itemId) return { passed: true };
    const pos = dgsm.getCharacterPosition(node.characterId);
    const locationId = pos ? dgsm.resolveLocationId(pos) : "";
    if (!findItemAnywhere(dgsm, node.characterId, locationId, itemId)) {
      return {
        passed: false,
        failureReason: "object_not_found",
        failureDetail: `${itemId} not found`,
      };
    }
    return { passed: true };
  },

  async resolve(
    node,
    _args,
    dgsm,
    runtime,
    skillRollResult,
    locationId,
    language,
    resolutionContext,
    extras
  ): Promise<ToolResolutionResult<ObjectStateDelta>> {
    const delta = await resolveItemState(
      node,
      dgsm,
      runtime,
      skillRollResult,
      locationId,
      language,
      extras.memoryManager,
      extras.sessionId,
      extras.registry,
      extras.featureNotes,
      resolutionContext
    );
    return { delta, outcomeDescription: delta.outcome };
  },

  apply(dgsm, actorId, delta, locationId) {
    applyObjectDelta(dgsm, actorId, delta, locationId);
  },
};
