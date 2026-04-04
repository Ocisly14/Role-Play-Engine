/**
 * Applies a StateResolution object to DynamicGameStateManager.
 * Pure code — no LLM calls.
 */

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { StateResolution } from "../types.js";

export function applyStateResolution(
  dgsm: DynamicGameStateManager,
  resolution: StateResolution
): void {
  // === Character changes ===
  if (resolution.characterChanges) {
    for (const change of resolution.characterChanges) {
      // HP / SAN deltas
      if (change.hp !== undefined && change.hp !== 0) {
        dgsm.updateNpcHp(change.characterId, change.hp);
      }
      if (change.san !== undefined && change.san !== 0) {
        dgsm.updateNpcSan(change.characterId, change.san);
      }

      // Fatigue delta — delegate to stamina feature helper if available,
      // otherwise fall through (stamina feature is optional).
      // We import lazily to avoid a hard dep on the stamina feature.
      if (change.fatigue !== undefined && change.fatigue !== 0) {
        try {
          // Dynamic import so tests don't need the full feature tree.
          // applyFatigueDelta is synchronous; we call it inline.
          const { applyFatigueDelta } =
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require("../features/staminaFeature.js") as {
              applyFatigueDelta: (
                dgsm: DynamicGameStateManager,
                characterId: string,
                delta: number | undefined
              ) => void;
            };
          applyFatigueDelta(dgsm, change.characterId, change.fatigue);
        } catch {
          // staminaFeature not available — skip fatigue silently
        }
      }

      // Conditions — mutate npc.status.conditions directly (same pattern as
      // applyCharacterDelta in interactionStateResolver.ts)
      if (change.addConditions || change.removeConditions) {
        const state = dgsm.getState();
        const npc = state.npcCharacters.find(
          (n) => n.id === change.characterId
        );
        if (npc) {
          if (change.removeConditions && change.removeConditions.length > 0) {
            const toRemove = new Set(change.removeConditions);
            npc.status.conditions = npc.status.conditions.filter(
              (c) => !toRemove.has(c)
            );
          }
          if (change.addConditions && change.addConditions.length > 0) {
            const existing = new Set(npc.status.conditions);
            for (const cond of change.addConditions) {
              if (!existing.has(cond)) {
                npc.status.conditions.push(cond);
                existing.add(cond);
              }
            }
          }
        }
      }

      // Position change
      if (change.position !== undefined) {
        dgsm.setCharacterPosition(change.characterId, change.position);
      }
    }
  }

  // === Scene changes ===
  if (resolution.sceneChanges) {
    for (const sceneChange of resolution.sceneChanges) {
      // Remove conditions
      if (
        sceneChange.removeConditions &&
        sceneChange.removeConditions.length > 0
      ) {
        const toRemove = new Set(sceneChange.removeConditions);
        const existing = dgsm.getSceneConditions(sceneChange.sceneId);
        const filtered = existing.filter((c) => !toRemove.has(c.description));
        if (filtered.length !== existing.length) {
          dgsm.replaceSceneConditions(sceneChange.sceneId, filtered);
        }
      }

      // Add conditions
      if (sceneChange.addConditions && sceneChange.addConditions.length > 0) {
        for (const condDescription of sceneChange.addConditions) {
          dgsm.appendSceneCondition(sceneChange.sceneId, {
            description: condDescription,
          });
        }
      }
    }
  }

  // === Item changes ===
  if (resolution.itemChanges) {
    for (const itemChange of resolution.itemChanges) {
      switch (itemChange.action) {
        case "destroy": {
          // Remove from NPC inventories
          const state = dgsm.getState();
          for (const npc of state.npcCharacters) {
            dgsm.removeItemFromNpc(npc.id, itemChange.itemId);
          }
          // Remove from scene items
          if (itemChange.from) {
            const scene = dgsm.getScene(itemChange.from);
            if (scene?.items) {
              const idx = scene.items.findIndex(
                (i) => i.id === itemChange.itemId
              );
              if (idx !== -1) scene.items.splice(idx, 1);
            }
          }
          break;
        }

        case "move": {
          // Locate and move the item
          const fromNpcInv =
            itemChange.from && !itemChange.from.startsWith("scene:")
              ? itemChange.from
              : null;
          const fromSceneId = itemChange.from?.startsWith("scene:")
            ? itemChange.from.slice("scene:".length)
            : !fromNpcInv
              ? itemChange.from
              : null;

          let movedItem: import("../../state/types.js").Item | undefined;

          // Try removing from NPC inventory
          if (fromNpcInv) {
            movedItem =
              dgsm.removeItemFromNpc(fromNpcInv, itemChange.itemId) ??
              undefined;
          }

          // Try removing from scene
          if (!movedItem && fromSceneId) {
            const scene = dgsm.getScene(fromSceneId);
            if (scene?.items) {
              const idx = scene.items.findIndex(
                (i) => i.id === itemChange.itemId
              );
              if (idx !== -1) {
                [movedItem] = scene.items.splice(idx, 1);
              }
            }
          }

          // Place item in destination
          if (movedItem && itemChange.to) {
            if (itemChange.to.startsWith("scene:")) {
              const toSceneId = itemChange.to.slice("scene:".length);
              const toScene = dgsm.getScene(toSceneId);
              if (toScene?.items) {
                toScene.items.push(movedItem);
              }
            } else {
              // Treat as NPC id
              dgsm.addItemToNpc(itemChange.to, movedItem);
            }
          }
          break;
        }

        case "create": {
          if (itemChange.to && itemChange.properties) {
            const newItem = {
              id: itemChange.itemId,
              name:
                (itemChange.properties.name as string | undefined) ??
                itemChange.itemId,
              ...itemChange.properties,
            } as import("../../state/types.js").Item;

            if (itemChange.to.startsWith("scene:")) {
              const toSceneId = itemChange.to.slice("scene:".length);
              const toScene = dgsm.getScene(toSceneId);
              if (toScene?.items) {
                toScene.items.push(newItem);
              }
            } else {
              dgsm.addItemToNpc(itemChange.to, newItem);
            }
          }
          break;
        }

        case "modify": {
          // Apply property updates to the item wherever it lives
          if (itemChange.properties) {
            const state = dgsm.getState();

            // Check NPC inventories
            let found = false;
            for (const npc of state.npcCharacters) {
              const inv = dgsm.getNpcInventory(npc.id);
              const item = inv.find((i) => i.id === itemChange.itemId);
              if (item) {
                Object.assign(item, itemChange.properties);
                found = true;
                break;
              }
            }

            // Check scene items
            if (!found) {
              for (const scene of state.scenes.values()) {
                if (scene.items) {
                  const item = scene.items.find(
                    (i) => i.id === itemChange.itemId
                  );
                  if (item) {
                    Object.assign(item, itemChange.properties);
                    break;
                  }
                }
              }
            }
          }
          break;
        }
      }
    }
  }
}
