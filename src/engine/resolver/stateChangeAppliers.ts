/**
 * State Change Appliers — type-specific apply functions dispatched by typeId.
 *
 * Each applier reads a typed changes array and mutates DynamicGameStateManager
 * accordingly. Memory types are no-ops here — they are handled by the caller
 * (tickProcessor) via memoryManager.
 */

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { resolveOutputSchemaTypeIds } from "../outputSchema.js";
import type { OutputSchemaConfig } from "../types.js";

// ===== Applier type =====

export type Applier = (dgsm: DynamicGameStateManager, changes: any[]) => void;

// ===== STATE_CHANGE_APPLIERS =====

export const STATE_CHANGE_APPLIERS: Record<string, Applier> = {
  // ── character.hp ────────────────────────────────────────────────────────────
  "character.hp": (dgsm, changes) => {
    for (const c of changes) {
      if (c.delta !== 0) {
        dgsm.updateNpcHp(c.characterId, c.delta);
      }
    }
  },

  // ── character.san ───────────────────────────────────────────────────────────
  "character.san": (dgsm, changes) => {
    for (const c of changes) {
      if (c.delta !== 0) {
        dgsm.updateNpcSan(c.characterId, c.delta);
      }
    }
  },

  // ── character.fatigue ───────────────────────────────────────────────────────
  "character.fatigue": (dgsm, changes) => {
    for (const c of changes) {
      try {
        const { applyFatigueDelta } =
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require("../../features/staminaFeature.js") as {
            applyFatigueDelta: (
              dgsm: DynamicGameStateManager,
              characterId: string,
              delta: number | undefined
            ) => void;
          };
        applyFatigueDelta(dgsm, c.characterId, c.delta);
      } catch {
        /* skip */
      }
    }
  },

  // ── character.condition ─────────────────────────────────────────────────────
  "character.condition": (dgsm, changes) => {
    const state = dgsm.getState();
    for (const c of changes) {
      const npc = state.npcCharacters.find((n) => n.id === c.characterId);
      if (!npc) continue;

      if (c.remove && c.remove.length > 0) {
        const toRemove = new Set<string>(c.remove);
        npc.status.conditions = npc.status.conditions.filter(
          (cond: string) => !toRemove.has(cond)
        );
      }

      if (c.add && c.add.length > 0) {
        const existing = new Set<string>(npc.status.conditions);
        for (const cond of c.add) {
          if (!existing.has(cond)) {
            npc.status.conditions.push(cond);
            existing.add(cond);
          }
        }
      }
    }
  },

  // ── character.position ──────────────────────────────────────────────────────
  "character.position": (dgsm, changes) => {
    for (const c of changes) {
      dgsm.setCharacterPosition(c.characterId, {
        type: "scene",
        sceneId: c.sceneId,
        ...(c.junction ? { junction: c.junction } : {}),
      });
    }
  },

  // ── item.move ───────────────────────────────────────────────────────────────
  "item.move": (dgsm, changes) => {
    for (const c of changes) {
      const fromIsScene = c.from && (c.from as string).startsWith("scene:");
      const fromNpcId = fromIsScene
        ? null
        : ((c.from as string | undefined) ?? null);
      const fromSceneId = fromIsScene
        ? (c.from as string).slice("scene:".length)
        : null;

      let movedItem: any;

      // Remove from NPC inventory
      if (fromNpcId) {
        movedItem = dgsm.removeItemFromNpc(fromNpcId, c.itemId) ?? undefined;
      }

      // Remove from scene items
      if (!movedItem && fromSceneId) {
        const scene = dgsm.getScene(fromSceneId);
        if (scene?.items) {
          const idx = scene.items.findIndex((i: any) => i.id === c.itemId);
          if (idx !== -1) {
            [movedItem] = scene.items.splice(idx, 1);
          }
        }
      }

      // Place in destination
      if (movedItem && c.to) {
        if ((c.to as string).startsWith("scene:")) {
          const toSceneId = (c.to as string).slice("scene:".length);
          const toScene = dgsm.getScene(toSceneId);
          if (toScene?.items) {
            toScene.items.push(movedItem);
          }
        } else {
          dgsm.addItemToNpc(c.to, movedItem);
        }
      }
    }
  },

  // ── item.destroy ─────────────────────────────────────────────────────────────
  "item.destroy": (dgsm, changes) => {
    for (const c of changes) {
      // Remove from all NPC inventories
      const state = dgsm.getState();
      for (const npc of state.npcCharacters) {
        dgsm.removeItemFromNpc(npc.id, c.itemId);
      }
      // Remove from scene if from is provided
      if (c.from) {
        const scene = dgsm.getScene(c.from);
        if (scene?.items) {
          const idx = scene.items.findIndex((i: any) => i.id === c.itemId);
          if (idx !== -1) scene.items.splice(idx, 1);
        }
      }
    }
  },

  // ── item.create ──────────────────────────────────────────────────────────────
  "item.create": (dgsm, changes) => {
    for (const c of changes) {
      const newItem = {
        id: `item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: c.name,
        ...(c.properties ?? {}),
      };

      const location: string = c.location ?? c.to;
      if (!location) continue;

      if (location.startsWith("scene:")) {
        const toSceneId = location.slice("scene:".length);
        const scene = dgsm.getScene(toSceneId);
        if (scene?.items) {
          scene.items.push(newItem);
        }
      } else {
        dgsm.addItemToNpc(location, newItem);
      }
    }
  },

  // ── item.modify ──────────────────────────────────────────────────────────────
  "item.modify": (dgsm, changes) => {
    for (const c of changes) {
      if (!c.properties) continue;
      const state = dgsm.getState();

      // Search NPC inventories first
      let found = false;
      for (const npc of state.npcCharacters) {
        const inv = dgsm.getNpcInventory(npc.id);
        const item = inv.find((i: any) => i.id === c.itemId);
        if (item) {
          Object.assign(item, c.properties);
          found = true;
          break;
        }
      }

      // Search scene items
      if (!found) {
        for (const scene of state.scenes.values()) {
          if (scene.items) {
            const item = scene.items.find((i: any) => i.id === c.itemId);
            if (item) {
              Object.assign(item, c.properties);
              break;
            }
          }
        }
      }
    }
  },

  // ── scene.condition ──────────────────────────────────────────────────────────
  "scene.condition": (dgsm, changes) => {
    for (const c of changes) {
      // Remove conditions
      if (c.remove && c.remove.length > 0) {
        const toRemove = new Set<string>(c.remove);
        const existing = dgsm.getSceneConditions(c.sceneId);
        const filtered = existing.filter(
          (cond) => !toRemove.has(cond.description)
        );
        if (filtered.length !== existing.length) {
          dgsm.replaceSceneConditions(c.sceneId, filtered);
        }
      }

      // Add conditions
      if (c.add && c.add.length > 0) {
        for (const desc of c.add) {
          dgsm.appendSceneCondition(c.sceneId, { description: desc });
        }
      }
    }
  },

  // ── memory types — no-op, handled by tickProcessor via memoryManager ─────────
  "memory.event": (_dgsm, _changes) => {
    // No-op: memory writing is handled by the caller (tickProcessor)
  },

  "memory.witness": (_dgsm, _changes) => {
    // No-op: memory writing is handled by the caller (tickProcessor)
  },

  // ── relationship.change ──────────────────────────────────────────────────────
  "relationship.change": (dgsm, changes) => {
    for (const c of changes) {
      (dgsm as any).updateRelationship?.(c.fromId, c.toId, c.delta, c.note);
    }
  },
};

// ===== applyByTypeId =====

/**
 * Dispatch appliers for all typeIds resolved from outputSchema presets + use.
 * Skips types not in STATE_CHANGE_APPLIERS and skips empty arrays.
 */
export function applyByTypeId(
  dgsm: DynamicGameStateManager,
  resolution: Record<string, any>,
  config: OutputSchemaConfig
): void {
  for (const typeId of resolveOutputSchemaTypeIds(config)) {
    const changes = resolution[typeId];
    if (!Array.isArray(changes) || changes.length === 0) continue;
    const applier = STATE_CHANGE_APPLIERS[typeId];
    if (applier) applier(dgsm, changes);
  }
}
