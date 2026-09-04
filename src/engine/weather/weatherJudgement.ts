// src/engine/weather/weatherJudgement.ts
//
// The deterministic half of the weather engine: what the model is asked (the
// region's outdoor places, the passages between them, the weather), what a
// valid answer is, and how an answer becomes StateChanges. No model call
// lives here — see weatherEngine.ts — so every rule about candidates, diffs
// and penalties is testable without one.

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { makeFeatureEdgeId } from "../../state/blockedConnections.js";
import type { SceneCondition, StateChange } from "../core/types.js";
import {
  WEATHER_FEATURE_ID,
  type WeatherRegionState,
  type WeatherType,
  computeSkillPenalties,
  getWeatherLabel,
} from "../subsystem/weather.js";

export interface WeatherPlace {
  id: string;
  kind: "scene" | "road";
  name: string;
  description: string;
}

/** A passage the weather may close: both ends outdoors, addressed by the
 *  weather's own edge id (`weather:<a>|<b>`, endpoints sorted) — the id the
 *  applier resolves through the connection registry's pair fallback. */
export interface WeatherPassage {
  connectionId: string;
  from: string;
  to: string;
  /** Full-length walk when one end is a road. */
  travelTimeMinutes?: number;
  /** Set when the passage is blocked at this moment, by anyone, with why. */
  blockedNow?: string;
}

export interface WeatherJudgementRequest {
  regionId: string;
  weather: { type: WeatherType; intensity: number; label: string };
  places: WeatherPlace[];
  passages: WeatherPassage[];
  /** What the last judgement closed. Anything not closed again reopens. */
  previouslyClosed: string[];
}

export interface WeatherJudgement {
  blocks: Array<{ connectionId: string; reason: string }>;
  conditions: Array<{ placeId: string; description: string }>;
}

/** Clear weather: nothing closed, nothing hung. No model is asked for it. */
export const EMPTY_WEATHER_JUDGEMENT: WeatherJudgement = Object.freeze({
  blocks: [],
  conditions: [],
}) as WeatherJudgement;

export function buildWeatherJudgementRequest(
  dgsm: DynamicGameStateManager,
  regionId: string,
  state: WeatherRegionState
): WeatherJudgementRequest {
  const roads = dgsm.getState().roads ?? new Map();
  const places: WeatherPlace[] = [];
  const passages: WeatherPassage[] = [];
  const seen = new Set<string>();
  for (const id of state.affectedSceneIds) {
    const place = dgsm.getScene(id);
    if (!place) continue;
    const isRoad = roads.has(id);
    places.push({
      id,
      kind: isRoad ? "road" : "scene",
      name: place.name,
      description: place.description ?? "",
    });
    for (const connection of place.connections ?? []) {
      const other = dgsm.getScene(connection.targetId);
      // Only an outdoor-to-outdoor edge is the weather's to close; a doorway
      // into a house is not.
      if (!other || other.indoor) continue;
      const connectionId = makeFeatureEdgeId(
        WEATHER_FEATURE_ID,
        id,
        connection.targetId
      );
      if (seen.has(connectionId)) continue;
      seen.add(connectionId);
      const road = roads.get(isRoad ? id : connection.targetId);
      const blockedNow = dgsm.getConnectionBlockReason(id, connection.targetId);
      passages.push({
        connectionId,
        from: id,
        to: connection.targetId,
        ...(road ? { travelTimeMinutes: road.travelTimeMinutes } : {}),
        ...(blockedNow !== undefined ? { blockedNow } : {}),
      });
    }
  }
  return {
    regionId,
    weather: {
      type: state.weatherType,
      intensity: state.intensity,
      label: getWeatherLabel(state.weatherType, state.intensity),
    },
    places,
    passages,
    previouslyClosed: [...(state.judgedBlockIds ?? [])],
  };
}

export type WeatherJudgementValidation =
  | { ok: true; judgement: WeatherJudgement }
  | { ok: false; errors: string[] };

/** Shape and reference checks only — whether a passage DESERVES closing is
 *  the rule document's judgement, in full context. */
export function validateWeatherJudgement(
  raw: unknown,
  request: WeatherJudgementRequest
): WeatherJudgementValidation {
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      errors: [
        "the judgement must be an object with `blocks` and `conditions` arrays",
      ],
    };
  }
  const { blocks, conditions } = raw as {
    blocks?: unknown;
    conditions?: unknown;
  };
  const errors: string[] = [];
  const passageIds = new Set(request.passages.map((p) => p.connectionId));
  const placeIds = new Set(request.places.map((p) => p.id));
  const outBlocks: WeatherJudgement["blocks"] = [];
  const outConditions: WeatherJudgement["conditions"] = [];

  if (blocks !== undefined && !Array.isArray(blocks)) {
    errors.push("`blocks` must be an array");
  }
  const seenBlocks = new Set<string>();
  for (const [i, b] of (Array.isArray(blocks) ? blocks : []).entries()) {
    const at = `blocks[${i}]`;
    const entry = b as { connectionId?: unknown; reason?: unknown } | null;
    if (!entry || typeof entry !== "object") {
      errors.push(`${at}: must be {connectionId, reason}`);
      continue;
    }
    if (
      typeof entry.connectionId !== "string" ||
      !passageIds.has(entry.connectionId)
    ) {
      errors.push(
        `${at}: connectionId ${JSON.stringify(entry.connectionId)} is not one of this region's passages — use an id from the Passages list verbatim`
      );
      continue;
    }
    if (seenBlocks.has(entry.connectionId)) {
      errors.push(`${at}: "${entry.connectionId}" is listed twice`);
      continue;
    }
    seenBlocks.add(entry.connectionId);
    if (typeof entry.reason !== "string" || !entry.reason.trim()) {
      errors.push(
        `${at}: reason is required — one objective sentence naming what blocks the way`
      );
      continue;
    }
    outBlocks.push({
      connectionId: entry.connectionId,
      reason: entry.reason.trim(),
    });
  }

  if (conditions !== undefined && !Array.isArray(conditions)) {
    errors.push("`conditions` must be an array");
  }
  const seenPlaces = new Set<string>();
  for (const [i, c] of (Array.isArray(conditions) ? conditions : []).entries()) {
    const at = `conditions[${i}]`;
    const entry = c as { placeId?: unknown; description?: unknown } | null;
    if (!entry || typeof entry !== "object") {
      errors.push(`${at}: must be {placeId, description}`);
      continue;
    }
    if (typeof entry.placeId !== "string" || !placeIds.has(entry.placeId)) {
      errors.push(
        `${at}: placeId ${JSON.stringify(entry.placeId)} is not one of this region's places`
      );
      continue;
    }
    if (seenPlaces.has(entry.placeId)) {
      errors.push(
        `${at}: "${entry.placeId}" already has a condition — one per place`
      );
      continue;
    }
    seenPlaces.add(entry.placeId);
    if (typeof entry.description !== "string" || !entry.description.trim()) {
      errors.push(`${at}: description is required`);
      continue;
    }
    outConditions.push({
      placeId: entry.placeId,
      description: entry.description.trim(),
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, judgement: { blocks: outBlocks, conditions: outConditions } };
}

/** The condition the weather engine's sentence becomes: the subsystem's
 *  featureId so the next judgement can replace it wholesale, and the
 *  code-computed skill penalties for this weather — the model writes what
 *  the place is like, never a number. */
function weatherCondition(
  state: WeatherRegionState,
  description: string
): SceneCondition {
  const penalties = computeSkillPenalties(state.weatherType, state.intensity);
  const skillPenalty: Record<string, number> = {};
  for (const { skill, delta } of penalties) {
    skillPenalty[skill] = (skillPenalty[skill] ?? 0) + delta;
  }
  return {
    featureId: WEATHER_FEATURE_ID,
    description: `[Weather] ${description}`,
    mechanicalEffect: penalties.length > 0 ? { skillPenalty } : undefined,
  };
}

/**
 * A judgement as StateChanges. The model states the full set; code does the
 * bookkeeping: every judged passage is set (idempotently — last writer wins
 * on the flag), every passage the last judgement closed and this one does
 * not is lifted, every affected place sheds its old weather condition and
 * the judged ones get a new one, and the set is remembered on the region
 * state for the next diff.
 */
export function weatherJudgementChanges(
  regionId: string,
  state: WeatherRegionState,
  judgement: WeatherJudgement
): StateChange[] {
  const out: StateChange[] = [];
  const next = new Set(judgement.blocks.map((b) => b.connectionId));
  for (const block of judgement.blocks) {
    out.push({
      kind: "connection.setBlock",
      connectionId: block.connectionId,
      blocked: true,
      sourceFeatureId: WEATHER_FEATURE_ID,
      reason: block.reason,
    });
  }
  for (const id of state.judgedBlockIds ?? []) {
    if (next.has(id)) continue;
    out.push({
      kind: "connection.setBlock",
      connectionId: id,
      blocked: false,
      sourceFeatureId: WEATHER_FEATURE_ID,
      reason: "weather cleared",
    });
  }
  for (const sceneId of state.affectedSceneIds) {
    out.push({
      kind: "scene.removeCondition",
      sceneId,
      predicate: { featureId: WEATHER_FEATURE_ID },
    });
  }
  for (const condition of judgement.conditions) {
    out.push({
      kind: "scene.addCondition",
      sceneId: condition.placeId,
      condition: weatherCondition(state, condition.description),
    });
  }
  out.push({
    kind: "feature.setState",
    featureId: WEATHER_FEATURE_ID,
    key: regionId,
    state: { ...state, judgedBlockIds: [...next] },
  });
  return out;
}
