// src/engine/tools/inventoryValidationTool.ts
//
// Atomic inventory/presence facts for the unified Engine: where an item
// actually is, whether ownership is unique, and whether a given actor can
// reach it right now. Pure read — this tool never transfers or mutates items;
// the Engine emits ItemChange deltas and the Applier commits them.

import type { CodeToolContext, EngineCodeTool } from "./codeTool.js";

export interface InventoryValidationInput {
  itemId: string;
  /** When set, also answer whether this actor holds/can reach the item. */
  actorId?: string;
}

export interface ItemLocationRef {
  kind: "character" | "scene";
  id: string;
}

export interface InventoryValidationOutput {
  exists: boolean;
  /** Every place the item currently appears. More than one entry is a world
   *  invariant violation (duplicate ownership) the Engine must not extend. */
  locations: ItemLocationRef[];
  uniqueOwnership: boolean;
  /** Set when actorId was given. */
  actor?: {
    holdsItem: boolean;
    /** Item is in the actor's inventory or at the actor's current location. */
    canReach: boolean;
  };
}

export const inventoryValidationTool: EngineCodeTool<
  InventoryValidationInput,
  InventoryValidationOutput
> = {
  name: "inventoryValidation",
  description:
    "Locate an item (scene or character inventory), check unique ownership, and optionally whether an actor holds or can reach it.",
  execute(
    input: InventoryValidationInput,
    ctx: CodeToolContext
  ): InventoryValidationOutput {
    const state = ctx.dgsm.getState();
    const locations: ItemLocationRef[] = [];

    for (const scene of state.scenes.values()) {
      if ((scene.items ?? []).some((i) => i.id === input.itemId)) {
        locations.push({ kind: "scene", id: scene.id });
      }
    }
    for (const [npcId, items] of Object.entries(state.npcInventories)) {
      if ((items ?? []).some((i) => i.id === input.itemId)) {
        locations.push({ kind: "character", id: npcId });
      }
    }

    const output: InventoryValidationOutput = {
      exists: locations.length > 0,
      locations,
      uniqueOwnership: locations.length <= 1,
    };

    if (input.actorId !== undefined) {
      const holdsItem = locations.some(
        (l) => l.kind === "character" && l.id === input.actorId
      );
      const position = ctx.dgsm.getCharacterPosition(input.actorId);
      const actorLocationId = position
        ? ctx.dgsm.resolveLocationId(position)
        : "";
      const canReach =
        holdsItem ||
        (actorLocationId !== "" &&
          locations.some(
            (l) => l.kind === "scene" && l.id === actorLocationId
          ));
      output.actor = { holdsItem, canReach };
    }

    return output;
  },
};
