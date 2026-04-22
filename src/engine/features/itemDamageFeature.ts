import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { StateChange } from "../core/types.js";
import type { WorldFeature } from "../core/worldFeature.js";

// ===== Constants =====

const FEATURE_ID = "itemDamage";

// Anything hotter than this (Celsius) is treated as "inside a fire" and starts
// damaging items in the scene. 200°C is roughly the autoignition point of
// paper / many fabrics — well above the fire feature's intensity-1 contribution
// (100°C) so light smoke alone won't start cooking inventory.
const HEAT_DAMAGE_THRESHOLD = 200;

// Per-tick proportion of undamaged items in the scene that take damage.
// Mirrors the OLD fireFeature behaviour (20% sample of undamaged items).
const DAMAGE_SAMPLE_RATE = 0.2;

// ===== Exported feature =====

export const itemDamageFeature: WorldFeature = {
  id: FEATURE_ID,
  description:
    "Reacts to extreme environmental conditions and damages items in affected scenes",
  stateScope: "global",
  affectedKinds: ["scene.damageItem"],
  effectSummary:
    "Damages items in scenes with env.temperature > 200°C (e.g. inside a fire)",
  priority: 350,

  onTick(ctx: FeatureReadContext): StateChange[] {
    const out: StateChange[] = [];
    const sceneIds = ctx.getSceneIds();
    for (const sceneId of sceneIds) {
      const reading = ctx.getEnvironmentReading(sceneId);
      if (reading.temperature <= HEAT_DAMAGE_THRESHOLD) continue;

      const scene = ctx.getScene(sceneId);
      if (!scene?.items || scene.items.length === 0) continue;

      const undamaged = scene.items.filter((it) => !it.damaged);
      if (undamaged.length === 0) continue;

      const sampleCount = Math.round(undamaged.length * DAMAGE_SAMPLE_RATE);
      if (sampleCount === 0) continue;

      // Random sample without replacement — shuffle then take the first N.
      const shuffled = [...undamaged].sort(() => Math.random() - 0.5);
      const reason = `Damaged by heat (env.temperature ${reading.temperature.toFixed(0)}°C)`;
      for (let i = 0; i < sampleCount; i++) {
        out.push({
          kind: "scene.damageItem",
          sceneId,
          itemId: shuffled[i].id,
          damagedBy: "fire",
          reason,
          sourceFeatureId: FEATURE_ID,
        });
      }
    }
    return out;
  },
};
