// src/engine/subsystem/conditionExpiry.ts
//
// Per-character + per-scene condition expiry subsystems. Phase I migration
// of TickOrchestrator.sweepExpiredCharacterConditions (Phase 9.5).
//
// Both subsystems are stateless — they scan their anchor each tick and
// emit removeCondition StateChanges for any condition whose `expiresAt`
// is at or before the current game time.

import type { FeatureReadContext } from "../core/featureReadContext.js";
import type {
  CharacterCondition,
  SceneCondition,
  StateChange,
} from "../core/types.js";
import type { AnchorSubsystem } from "./types.js";

/** ISO GameTime comparison — matches TickOrchestrator.timeIsAtOrBefore semantics. */
function isExpired(expiresAt: string | undefined, now: string): boolean {
  if (!expiresAt) return false;
  return expiresAt <= now;
}

// ─── Character variant ─────────────────────────────────────────────────────

export const characterConditionExpirySubsystem: AnchorSubsystem = {
  id: "characterConditionExpiry",
  kind: "anchor",
  anchorKind: "character",
  description: "Removes character conditions whose expiresAt has passed.",
  effectSummary: "Per-tick cleanup of timed conditions on each character.",
  affectedKinds: ["character.removeCondition"],
  priority: 900,

  shouldExist(anchorId: string, ctx: FeatureReadContext): boolean {
    return ctx.getCharacter(anchorId) !== undefined;
  },

  initialState(_anchorId: string, _ctx: FeatureReadContext): StateChange[] {
    return [];
  },

  onTick(anchorId: string, ctx: FeatureReadContext): StateChange[] {
    const character = ctx.getCharacter(anchorId);
    if (!character?.status?.conditions?.length) return [];
    const now = ctx.gameDateTime;
    const out: StateChange[] = [];
    for (const c of character.status.conditions as CharacterCondition[]) {
      if (isExpired(c.expiresAt, now)) {
        out.push({
          kind: "character.removeCondition",
          characterId: anchorId,
          conditionId: c.id,
        });
      }
    }
    return out;
  },
};

// ─── Scene variant ─────────────────────────────────────────────────────────
//
// SceneCondition currently has no `expiresAt` field (it uses `featureId` for
// identity and `ConditionPredicate = { featureId: string }` for removal).
// This subsystem is a guaranteed no-op until `expiresAt` is added to
// SceneCondition; it is provided now so the infrastructure is in place when
// that field lands.

export const sceneConditionExpirySubsystem: AnchorSubsystem = {
  id: "sceneConditionExpiry",
  kind: "anchor",
  anchorKind: "scene",
  description: "Removes scene conditions whose expiresAt has passed.",
  effectSummary: "Per-tick cleanup of timed conditions on each scene.",
  affectedKinds: ["scene.removeCondition"],
  priority: 900,

  shouldExist(anchorId: string, ctx: FeatureReadContext): boolean {
    return ctx.getScene(anchorId) !== undefined;
  },

  initialState(_anchorId: string, _ctx: FeatureReadContext): StateChange[] {
    return [];
  },

  onTick(anchorId: string, ctx: FeatureReadContext): StateChange[] {
    const conditions = ctx.getSceneConditions(anchorId);
    if (conditions.length === 0) return [];
    const now = ctx.gameDateTime;
    const out: StateChange[] = [];
    for (const c of conditions as SceneCondition[]) {
      // SceneCondition currently has no `expiresAt` field — cast to access it
      // defensively. This block is a no-op until `expiresAt` is added to
      // SceneCondition. When it is, `featureId` drives the removal predicate.
      const expiresAt = (c as { expiresAt?: string }).expiresAt;
      if (isExpired(expiresAt, now) && c.featureId) {
        out.push({
          kind: "scene.removeCondition",
          sceneId: anchorId,
          predicate: { featureId: c.featureId },
        });
      }
    }
    return out;
  },
};
