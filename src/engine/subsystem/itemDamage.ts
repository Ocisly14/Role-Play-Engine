// src/engine/subsystem/itemDamage.ts
//
// Per-scene item damage subsystem. Phase I migration of itemDamageFeature.
// Stateless — no DGSM bucket; onTick reads scene env reading and emits
// scene.damageItem for a 20% sample of undamaged items when env temperature
// exceeds 200°C.

import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { StateChange } from "../core/types.js";
import type { AnchorSubsystem } from "./types.js";

const SUBSYSTEM_ID = "itemDamage";
const HEAT_DAMAGE_THRESHOLD = 200; // matches itemDamageFeature.ts:13
const DAMAGE_SAMPLE_RATE = 0.2; // matches itemDamageFeature.ts:17

export const itemDamageSubsystem: AnchorSubsystem = {
  id: SUBSYSTEM_ID,
  kind: "anchor",
  anchorKind: "scene",
  description:
    "Damages items in scenes exposed to extreme heat (env.temperature > 200°C).",
  effectSummary:
    "20% of undamaged items per tick take fire damage when scene env.temperature > 200°C.",
  affectedKinds: ["scene.damageItem"],
  priority: 350,

  shouldExist(anchorId: string, ctx: FeatureReadContext): boolean {
    return ctx.getScene(anchorId) !== undefined;
  },

  initialState(): StateChange[] {
    return [];
  },

  onTick(anchorId: string, ctx: FeatureReadContext): StateChange[] {
    const reading = ctx.getEnvironmentReading(anchorId);
    if (reading.temperature <= HEAT_DAMAGE_THRESHOLD) return [];

    const scene = ctx.getScene(anchorId);
    if (!scene?.items || scene.items.length === 0) return [];

    const undamaged = scene.items.filter((it) => !it.damaged);
    if (undamaged.length === 0) return [];

    const sampleCount = Math.round(undamaged.length * DAMAGE_SAMPLE_RATE);
    if (sampleCount === 0) return [];

    const shuffled = [...undamaged].sort(() => Math.random() - 0.5);
    const reason = `Damaged by heat (env.temperature ${reading.temperature.toFixed(0)}°C)`;
    const out: StateChange[] = [];
    for (let i = 0; i < sampleCount; i++) {
      out.push({
        kind: "scene.damageItem",
        sceneId: anchorId,
        itemId: shuffled[i].id,
        damagedBy: "fire",
        reason,
        sourceFeatureId: SUBSYSTEM_ID,
      });
    }
    return out;
  },
};
