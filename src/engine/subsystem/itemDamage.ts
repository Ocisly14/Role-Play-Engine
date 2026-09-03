// src/engine/subsystem/itemDamage.ts
//
// Per-scene item damage subsystem. Stateless — no DGSM bucket; onTick reads
// the scene env reading and burns a 20% sample of the items when temperature
// exceeds 200°C.
//
// There is no `damaged` flag any more: an item IS its description, so the burn
// is a sentence appended to it and the idempotence guard reads that same
// sentence back. Without a guard this fires every tick a room is alight and
// would append the line forever.

import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { StateChange } from "../core/types.js";
import type { AnchorSubsystem } from "./types.js";

const SUBSYSTEM_ID = "itemDamage";
const HEAT_DAMAGE_THRESHOLD = 200; // matches itemDamageFeature.ts:13
const DAMAGE_SAMPLE_RATE = 0.2; // matches itemDamageFeature.ts:17
/** Written into the description, and read back as the "already burned" test. */
const HEAT_DAMAGE_MARKER = "Scorched by extreme heat";

export const itemDamageSubsystem: AnchorSubsystem = {
  id: SUBSYSTEM_ID,
  kind: "anchor",
  anchorKind: "scene",
  description:
    "Damages items in scenes exposed to extreme heat (env.temperature > 200°C).",
  effectSummary:
    "20% of undamaged items per tick take heat damage when scene env.temperature > 200°C.",
  affectedKinds: ["item.set"],
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

    // The marker is the state: an item already carrying the burn line is not
    // burned twice.
    const undamaged = scene.items.filter(
      (it) => !(it.description ?? "").includes(HEAT_DAMAGE_MARKER)
    );
    if (undamaged.length === 0) return [];

    const sampleCount = Math.round(undamaged.length * DAMAGE_SAMPLE_RATE);
    if (sampleCount === 0) return [];

    const shuffled = [...undamaged].sort(() => Math.random() - 0.5);
    const reason = `${HEAT_DAMAGE_MARKER} (${reading.temperature.toFixed(0)}°C).`;
    const out: StateChange[] = [];
    for (let i = 0; i < sampleCount; i++) {
      out.push({
        kind: "item.set",
        itemId: shuffled[i].id,
        appendDescription: reason,
        sourceFeatureId: SUBSYSTEM_ID,
      });
    }
    return out;
  },
};
