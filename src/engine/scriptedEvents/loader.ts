/**
 * ScriptedEvent loader + validator.
 *
 * Two-pass validation:
 *   Pass 1 — Structural: per-file, per-event shape (required fields,
 *            Predicate / CharacterPredicate / ScenePredicate / Effect op discriminators,
 *            Tracker kinds, status enum values).
 *   Pass 2 — Reference integrity: duplicate ids, cross-event id refs
 *            (eventStatus predicate, event.transition effect), tracker id refs
 *            (must resolve on the SAME event).
 *
 * All errors are aggregated into a single `ScriptedEventLoadError` — author sees
 * full list in one go, not fix-and-rerun.
 */

import type {
  ActionMatch,
  CharacterPredicate,
  Effect,
  Predicate,
  ScenePredicate,
  ScriptedEvent,
  ScriptedEventStatus,
  Tracker,
} from "./types.js";

// ─── Public API ────────────────────────────────────────────────────────────

export interface ScriptedEventFile {
  /** Filename for error reporting (e.g., "ritual.json"). */
  file: string;
  /** Parsed JSON content (root is array of ScriptedEvent). */
  raw: unknown;
}

export interface LoaderError {
  file: string;
  /** Path within the file (e.g., "[2].fireWhen.children[1].trackerId"). */
  path: string;
  message: string;
}

export class ScriptedEventLoadError extends Error {
  constructor(public errors: LoaderError[]) {
    super(
      `Invalid scripted events: ${errors.length} error(s)\n${errors
        .map((e) => `  ${e.file} ${e.path}: ${e.message}`)
        .join("\n")}`
    );
    this.name = "ScriptedEventLoadError";
  }
}

export function loadScriptedEvents(
  files: ScriptedEventFile[]
): ScriptedEvent[] {
  const errors: LoaderError[] = [];
  const events: ScriptedEvent[] = [];
  // Parallel array tracking origin (file + path) of each accepted event — used
  // for cross-event reference error reporting in Pass 2.
  const origins: Array<{ file: string; path: string }> = [];

  // Pass 1 — structural validation per file.
  for (const { file, raw } of files) {
    if (!Array.isArray(raw)) {
      errors.push({
        file,
        path: "",
        message: "root must be an array of ScriptedEvent",
      });
      continue;
    }
    raw.forEach((item, i) => {
      const basePath = `[${i}]`;
      const event = validateScriptedEvent(item, file, basePath, errors);
      if (event) {
        events.push(event);
        origins.push({ file, path: basePath });
      }
    });
  }

  if (errors.length > 0) {
    throw new ScriptedEventLoadError(errors);
  }

  // Pass 2 — cross-event reference integrity.
  validateReferences(events, origins, errors);

  if (errors.length > 0) {
    throw new ScriptedEventLoadError(errors);
  }

  return events;
}

// ─── Type-narrowing helpers ────────────────────────────────────────────────

function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

type Errors = LoaderError[];

function pushErr(
  errors: Errors,
  file: string,
  path: string,
  message: string
): void {
  errors.push({ file, path, message });
}

// ─── Pass 1: structural validation ─────────────────────────────────────────

const VALID_CMP = new Set<string>(["gte", "lte", "eq"]);
const VALID_STATUS = new Set<string>([
  "active",
  "pending",
  "completed",
  "failed",
  "disabled",
] satisfies ScriptedEventStatus[]);
const VALID_INITIAL_STATUS = new Set<string>(["active", "disabled"]);
const VALID_TRANSITION = new Set<string>([
  "active",
  "completed",
  "failed",
  "disabled",
]);
const VALID_TRACKER_KIND = new Set<string>(["actionCount", "lastFulfillment"]);

const PREDICATE_OPS = [
  "trackerCount",
  "trackerSinceFulfillment",
  "trackerNeverFulfilled",
  "actionCommittedThisTick",
  "characterAt",
  "characterAlive",
  "characterHasItem",
  "sceneHasConditionFromFeature",
  "gameDate",
  "eventStatus",
  "and",
  "or",
  "not",
];
const CHARACTER_PREDICATE_OPS = [
  "atScene",
  "alive",
  "hasItem",
  "is",
  "and",
  "or",
  "not",
];
const SCENE_PREDICATE_OPS = [
  "is",
  "inRegion",
  "hasConditionFromFeature",
  "and",
  "or",
  "not",
];
const EFFECT_KINDS = [
  "character.san",
  "character.hp",
  "character.fatigue",
  "character.addCondition",
  "character.removeCondition",
  "scene.addCondition",
  "scene.removeCondition",
  "connection.setBlock",
  "event.emit",
  "event.transition",
];

export function validateScriptedEvent(
  item: unknown,
  file: string,
  path: string,
  errors: Errors
): ScriptedEvent | null {
  if (!isObject(item)) {
    pushErr(errors, file, path, "must be an object");
    return null;
  }

  const startErrs = errors.length;

  // Required: id
  if (!isString(item.id) || item.id.length === 0) {
    pushErr(errors, file, `${path}.id`, "required string");
  }
  // Required: label
  if (!isString(item.label)) {
    pushErr(errors, file, `${path}.label`, "required string");
  }
  // Optional: initialStatus
  if (item.initialStatus !== undefined) {
    if (
      !isString(item.initialStatus) ||
      !VALID_INITIAL_STATUS.has(item.initialStatus)
    ) {
      pushErr(
        errors,
        file,
        `${path}.initialStatus`,
        `must be one of: ${[...VALID_INITIAL_STATUS].join(", ")}`
      );
    }
  }
  // Optional: fireDelayTicks
  if (item.fireDelayTicks !== undefined && !isNumber(item.fireDelayTicks)) {
    pushErr(errors, file, `${path}.fireDelayTicks`, "must be a number");
  }
  // Optional: durationTicks
  if (item.durationTicks !== undefined && !isNumber(item.durationTicks)) {
    pushErr(errors, file, `${path}.durationTicks`, "must be a number");
  }

  // Optional: trackers
  if (item.trackers !== undefined) {
    if (!isArray(item.trackers)) {
      pushErr(errors, file, `${path}.trackers`, "must be an array");
    } else {
      item.trackers.forEach((t, i) => {
        validateTracker(t, file, `${path}.trackers[${i}]`, errors);
      });
    }
  }

  // Required: fireWhen
  if (item.fireWhen === undefined) {
    pushErr(errors, file, `${path}.fireWhen`, "required Predicate");
  } else {
    validatePredicate(item.fireWhen, file, `${path}.fireWhen`, errors);
  }

  // Optional: failWhen
  if (item.failWhen !== undefined) {
    validatePredicate(item.failWhen, file, `${path}.failWhen`, errors);
  }

  // Required: onComplete
  if (!isArray(item.onComplete)) {
    pushErr(errors, file, `${path}.onComplete`, "required Effect[] array");
  } else {
    item.onComplete.forEach((eff, i) => {
      validateEffect(eff, file, `${path}.onComplete[${i}]`, errors);
    });
  }

  // Optional: onFail
  if (item.onFail !== undefined) {
    if (!isArray(item.onFail)) {
      pushErr(errors, file, `${path}.onFail`, "must be an Effect[] array");
    } else {
      item.onFail.forEach((eff, i) => {
        validateEffect(eff, file, `${path}.onFail[${i}]`, errors);
      });
    }
  }

  if (errors.length > startErrs) return null;

  // Cast is safe: all structural checks passed. Cross-event integrity is Pass 2.
  return item as unknown as ScriptedEvent;
}

function validateTracker(
  item: unknown,
  file: string,
  path: string,
  errors: Errors
): void {
  if (!isObject(item)) {
    pushErr(errors, file, path, "must be an object");
    return;
  }
  if (!isString(item.id) || item.id.length === 0) {
    pushErr(errors, file, `${path}.id`, "required string");
  }
  if (!isString(item.kind) || !VALID_TRACKER_KIND.has(item.kind)) {
    pushErr(
      errors,
      file,
      `${path}.kind`,
      `unknown tracker kind "${String(item.kind)}" — expected one of: ${[
        ...VALID_TRACKER_KIND,
      ].join(", ")}`
    );
    return;
  }
  if (item.match === undefined) {
    pushErr(errors, file, `${path}.match`, "required ActionMatch");
    return;
  }
  validateActionMatch(item.match, file, `${path}.match`, errors);
}

function validateActionMatch(
  item: unknown,
  file: string,
  path: string,
  errors: Errors
): void {
  if (!isObject(item)) {
    pushErr(errors, file, path, "must be an object");
    return;
  }
  const m = item as Record<string, unknown>;
  const stringOptional = (key: keyof ActionMatch & string) => {
    if (m[key] !== undefined && !isString(m[key])) {
      pushErr(errors, file, `${path}.${key}`, "must be a string if present");
    }
  };
  stringOptional("definitionId");
  stringOptional("byNpcId");
  stringOptional("atSceneId");
  stringOptional("withTargetId");
}

function validatePredicate(
  item: unknown,
  file: string,
  path: string,
  errors: Errors
): void {
  if (!isObject(item)) {
    pushErr(errors, file, path, "must be an object");
    return;
  }
  const op = item.op;
  if (!isString(op) || !PREDICATE_OPS.includes(op)) {
    pushErr(
      errors,
      file,
      `${path}.op`,
      `unknown predicate op "${String(op)}" — expected one of: ${PREDICATE_OPS.join(
        ", "
      )}`
    );
    return;
  }

  switch (op) {
    case "trackerCount":
    case "trackerSinceFulfillment": {
      if (!isString(item.trackerId) || item.trackerId.length === 0) {
        pushErr(errors, file, `${path}.trackerId`, "required string");
      }
      if (!isString(item.cmp) || !VALID_CMP.has(item.cmp)) {
        pushErr(
          errors,
          file,
          `${path}.cmp`,
          `must be one of: ${[...VALID_CMP].join(", ")}`
        );
      }
      if (!isNumber(item.value)) {
        pushErr(errors, file, `${path}.value`, "required number");
      }
      return;
    }
    case "trackerNeverFulfilled": {
      if (!isString(item.trackerId) || item.trackerId.length === 0) {
        pushErr(errors, file, `${path}.trackerId`, "required string");
      }
      return;
    }
    case "actionCommittedThisTick": {
      if (item.match === undefined) {
        pushErr(errors, file, `${path}.match`, "required ActionMatch");
      } else {
        validateActionMatch(item.match, file, `${path}.match`, errors);
      }
      return;
    }
    case "characterAt": {
      if (!isString(item.characterId)) {
        pushErr(errors, file, `${path}.characterId`, "required string");
      }
      if (!isString(item.sceneId)) {
        pushErr(errors, file, `${path}.sceneId`, "required string");
      }
      return;
    }
    case "characterAlive": {
      if (!isString(item.characterId)) {
        pushErr(errors, file, `${path}.characterId`, "required string");
      }
      if (!isBoolean(item.expectedAlive)) {
        pushErr(errors, file, `${path}.expectedAlive`, "required boolean");
      }
      return;
    }
    case "characterHasItem": {
      if (!isString(item.characterId)) {
        pushErr(errors, file, `${path}.characterId`, "required string");
      }
      if (!isString(item.itemName)) {
        pushErr(errors, file, `${path}.itemName`, "required string");
      }
      return;
    }
    case "sceneHasConditionFromFeature": {
      if (!isString(item.sceneId)) {
        pushErr(errors, file, `${path}.sceneId`, "required string");
      }
      if (!isString(item.featureId)) {
        pushErr(errors, file, `${path}.featureId`, "required string");
      }
      return;
    }
    case "gameDate": {
      if (!isString(item.cmp) || !VALID_CMP.has(item.cmp)) {
        pushErr(
          errors,
          file,
          `${path}.cmp`,
          `must be one of: ${[...VALID_CMP].join(", ")}`
        );
      }
      if (!isString(item.value)) {
        pushErr(errors, file, `${path}.value`, "required ISO date string");
      }
      return;
    }
    case "eventStatus": {
      if (!isString(item.otherEventId) || item.otherEventId.length === 0) {
        pushErr(errors, file, `${path}.otherEventId`, "required string");
      }
      if (!isString(item.isStatus) || !VALID_STATUS.has(item.isStatus)) {
        pushErr(
          errors,
          file,
          `${path}.isStatus`,
          `must be one of: ${[...VALID_STATUS].join(", ")}`
        );
      }
      return;
    }
    case "and":
    case "or": {
      if (!isArray(item.children)) {
        pushErr(errors, file, `${path}.children`, "required Predicate[] array");
        return;
      }
      item.children.forEach((child, i) => {
        validatePredicate(child, file, `${path}.children[${i}]`, errors);
      });
      return;
    }
    case "not": {
      if (item.child === undefined) {
        pushErr(errors, file, `${path}.child`, "required Predicate");
      } else {
        validatePredicate(item.child, file, `${path}.child`, errors);
      }
      return;
    }
  }
  // Used to satisfy exhaustiveness lint if added later:
  ((_x: never) => {})(op as never);
}

function validateCharacterPredicate(
  item: unknown,
  file: string,
  path: string,
  errors: Errors
): void {
  if (!isObject(item)) {
    pushErr(errors, file, path, "must be an object");
    return;
  }
  const op = item.op;
  if (!isString(op) || !CHARACTER_PREDICATE_OPS.includes(op)) {
    pushErr(
      errors,
      file,
      `${path}.op`,
      `unknown character-predicate op "${String(
        op
      )}" — expected one of: ${CHARACTER_PREDICATE_OPS.join(", ")}`
    );
    return;
  }
  switch (op) {
    case "atScene": {
      if (!isString(item.sceneId)) {
        pushErr(errors, file, `${path}.sceneId`, "required string");
      }
      return;
    }
    case "alive": {
      if (!isBoolean(item.expectedAlive)) {
        pushErr(errors, file, `${path}.expectedAlive`, "required boolean");
      }
      return;
    }
    case "hasItem": {
      if (!isString(item.itemName)) {
        pushErr(errors, file, `${path}.itemName`, "required string");
      }
      return;
    }
    case "is": {
      if (!isString(item.characterId)) {
        pushErr(errors, file, `${path}.characterId`, "required string");
      }
      return;
    }
    case "and":
    case "or": {
      if (!isArray(item.children)) {
        pushErr(
          errors,
          file,
          `${path}.children`,
          "required CharacterPredicate[] array"
        );
        return;
      }
      item.children.forEach((child, i) => {
        validateCharacterPredicate(
          child,
          file,
          `${path}.children[${i}]`,
          errors
        );
      });
      return;
    }
    case "not": {
      if (item.child === undefined) {
        pushErr(errors, file, `${path}.child`, "required CharacterPredicate");
      } else {
        validateCharacterPredicate(item.child, file, `${path}.child`, errors);
      }
      return;
    }
  }
}

function validateScenePredicate(
  item: unknown,
  file: string,
  path: string,
  errors: Errors
): void {
  if (!isObject(item)) {
    pushErr(errors, file, path, "must be an object");
    return;
  }
  const op = item.op;
  if (!isString(op) || !SCENE_PREDICATE_OPS.includes(op)) {
    pushErr(
      errors,
      file,
      `${path}.op`,
      `unknown scene-predicate op "${String(
        op
      )}" — expected one of: ${SCENE_PREDICATE_OPS.join(", ")}`
    );
    return;
  }
  switch (op) {
    case "is": {
      if (!isString(item.sceneId)) {
        pushErr(errors, file, `${path}.sceneId`, "required string");
      }
      return;
    }
    case "inRegion": {
      if (!isString(item.regionId)) {
        pushErr(errors, file, `${path}.regionId`, "required string");
      }
      return;
    }
    case "hasConditionFromFeature": {
      if (!isString(item.featureId)) {
        pushErr(errors, file, `${path}.featureId`, "required string");
      }
      return;
    }
    case "and":
    case "or": {
      if (!isArray(item.children)) {
        pushErr(
          errors,
          file,
          `${path}.children`,
          "required ScenePredicate[] array"
        );
        return;
      }
      item.children.forEach((child, i) => {
        validateScenePredicate(child, file, `${path}.children[${i}]`, errors);
      });
      return;
    }
    case "not": {
      if (item.child === undefined) {
        pushErr(errors, file, `${path}.child`, "required ScenePredicate");
      } else {
        validateScenePredicate(item.child, file, `${path}.child`, errors);
      }
      return;
    }
  }
}

function validateEffect(
  item: unknown,
  file: string,
  path: string,
  errors: Errors
): void {
  if (!isObject(item)) {
    pushErr(errors, file, path, "must be an object");
    return;
  }
  const kind = item.kind;
  if (!isString(kind) || !EFFECT_KINDS.includes(kind)) {
    pushErr(
      errors,
      file,
      `${path}.kind`,
      `unknown effect kind "${String(kind)}" — expected one of: ${EFFECT_KINDS.join(
        ", "
      )}`
    );
    return;
  }
  switch (kind) {
    case "character.san":
    case "character.hp":
    case "character.fatigue": {
      if (item.targetFilter === undefined) {
        pushErr(
          errors,
          file,
          `${path}.targetFilter`,
          "required CharacterPredicate"
        );
      } else {
        validateCharacterPredicate(
          item.targetFilter,
          file,
          `${path}.targetFilter`,
          errors
        );
      }
      if (!isNumber(item.delta)) {
        pushErr(errors, file, `${path}.delta`, "required number");
      }
      return;
    }
    case "character.addCondition": {
      if (item.targetFilter === undefined) {
        pushErr(
          errors,
          file,
          `${path}.targetFilter`,
          "required CharacterPredicate"
        );
      } else {
        validateCharacterPredicate(
          item.targetFilter,
          file,
          `${path}.targetFilter`,
          errors
        );
      }
      validateCharacterCondition(
        item.condition,
        file,
        `${path}.condition`,
        errors
      );
      return;
    }
    case "character.removeCondition": {
      if (item.targetFilter === undefined) {
        pushErr(
          errors,
          file,
          `${path}.targetFilter`,
          "required CharacterPredicate"
        );
      } else {
        validateCharacterPredicate(
          item.targetFilter,
          file,
          `${path}.targetFilter`,
          errors
        );
      }
      if (!isString(item.conditionId)) {
        pushErr(errors, file, `${path}.conditionId`, "required string");
      }
      return;
    }
    case "scene.addCondition": {
      if (item.sceneFilter === undefined) {
        pushErr(errors, file, `${path}.sceneFilter`, "required ScenePredicate");
      } else {
        validateScenePredicate(
          item.sceneFilter,
          file,
          `${path}.sceneFilter`,
          errors
        );
      }
      validateSceneCondition(item.condition, file, `${path}.condition`, errors);
      return;
    }
    case "scene.removeCondition": {
      if (item.sceneFilter === undefined) {
        pushErr(errors, file, `${path}.sceneFilter`, "required ScenePredicate");
      } else {
        validateScenePredicate(
          item.sceneFilter,
          file,
          `${path}.sceneFilter`,
          errors
        );
      }
      if (!isObject(item.predicate)) {
        pushErr(
          errors,
          file,
          `${path}.predicate`,
          "required { featureId: string }"
        );
      } else if (!isString(item.predicate.featureId)) {
        pushErr(errors, file, `${path}.predicate.featureId`, "required string");
      }
      return;
    }
    case "connection.setBlock": {
      if (!isString(item.connectionId)) {
        pushErr(errors, file, `${path}.connectionId`, "required string");
      }
      if (!isBoolean(item.blocked)) {
        pushErr(errors, file, `${path}.blocked`, "required boolean");
      }
      if (!isString(item.reason)) {
        pushErr(errors, file, `${path}.reason`, "required string");
      }
      return;
    }
    case "event.emit": {
      if (!isObject(item.event)) {
        pushErr(errors, file, `${path}.event`, "required FeatureEvent object");
        return;
      }
      const ev = item.event;
      if (typeof ev.impact !== "number" || ev.impact < 0 || ev.impact > 5) {
        pushErr(
          errors,
          file,
          `${path}.event.impact`,
          "event.emit: 'impact' must be a number 0-5"
        );
      }
      if (
        typeof ev.description !== "string" ||
        !(ev.description as string).trim()
      ) {
        pushErr(
          errors,
          file,
          `${path}.event.description`,
          "event.emit: 'description' is required"
        );
      }
      return;
    }
    case "event.transition": {
      if (!isString(item.otherEventId) || item.otherEventId.length === 0) {
        pushErr(errors, file, `${path}.otherEventId`, "required string");
      }
      if (!isString(item.to) || !VALID_TRANSITION.has(item.to)) {
        pushErr(
          errors,
          file,
          `${path}.to`,
          `must be one of: ${[...VALID_TRANSITION].join(", ")}`
        );
      }
      return;
    }
  }
}

function validateCharacterCondition(
  item: unknown,
  file: string,
  path: string,
  errors: Errors
): void {
  if (!isObject(item)) {
    pushErr(errors, file, path, "required CharacterCondition object");
    return;
  }
  if (!isString(item.id) || item.id.length === 0) {
    pushErr(errors, file, `${path}.id`, "required string");
  }
  if (!isString(item.description)) {
    pushErr(errors, file, `${path}.description`, "required string");
  }
  if (item.featureId !== undefined && !isString(item.featureId)) {
    pushErr(errors, file, `${path}.featureId`, "must be a string if present");
  }
}

function validateSceneCondition(
  item: unknown,
  file: string,
  path: string,
  errors: Errors
): void {
  // SceneCondition shape is defined in core/types.ts; we validate only the
  // fields we can reliably check without pulling in implementation details.
  if (!isObject(item)) {
    pushErr(errors, file, path, "required SceneCondition object");
    return;
  }
  if (!isString(item.id) || item.id.length === 0) {
    pushErr(errors, file, `${path}.id`, "required string");
  }
  if (item.featureId !== undefined && !isString(item.featureId)) {
    pushErr(errors, file, `${path}.featureId`, "must be a string if present");
  }
}

// ─── Pass 2: cross-event reference integrity ───────────────────────────────

export function validateReferences(
  events: ScriptedEvent[],
  origins: Array<{ file: string; path: string }>,
  errors: Errors
): void {
  // Index events by id for lookup. For duplicate ids, keep the first occurrence
  // but report both.
  const idToFirstIndex = new Map<string, number>();
  const duplicates = new Map<string, number[]>();
  events.forEach((ev, i) => {
    const existing = idToFirstIndex.get(ev.id);
    if (existing === undefined) {
      idToFirstIndex.set(ev.id, i);
    } else {
      const arr = duplicates.get(ev.id) ?? [existing];
      arr.push(i);
      duplicates.set(ev.id, arr);
    }
  });

  for (const [id, indices] of duplicates) {
    const locations = indices
      .map((i) => `${origins[i].file} ${origins[i].path}`)
      .join(", ");
    // Report duplicate against the second-and-later origin so the author sees
    // one error per duplicate file. (Pass 1 file/path tracking is preserved
    // via `origins`.)
    for (let j = 1; j < indices.length; j++) {
      const idx = indices[j];
      pushErr(
        errors,
        origins[idx].file,
        origins[idx].path,
        `duplicate event id "${id}" — also declared at ${locations}`
      );
    }
  }

  // Known ids for reference checks (use all ids, even duplicates — duplicates
  // already produced their own error).
  const knownIds = new Set(events.map((e) => e.id));

  events.forEach((event, i) => {
    const origin = origins[i];
    const trackerIds = new Set(event.trackers?.map((t) => t.id) ?? []);

    // Walk fireWhen / failWhen for trackerId + eventStatus refs
    if (event.fireWhen) {
      walkPredicateRefs(
        event.fireWhen,
        `${origin.path}.fireWhen`,
        origin.file,
        trackerIds,
        knownIds,
        errors
      );
    }
    if (event.failWhen) {
      walkPredicateRefs(
        event.failWhen,
        `${origin.path}.failWhen`,
        origin.file,
        trackerIds,
        knownIds,
        errors
      );
    }

    // Walk onComplete / onFail for event.transition refs
    event.onComplete?.forEach((eff, j) => {
      walkEffectRefs(
        eff,
        `${origin.path}.onComplete[${j}]`,
        origin.file,
        knownIds,
        errors
      );
    });
    event.onFail?.forEach((eff, j) => {
      walkEffectRefs(
        eff,
        `${origin.path}.onFail[${j}]`,
        origin.file,
        knownIds,
        errors
      );
    });
  });
}

function walkPredicateRefs(
  pred: Predicate,
  path: string,
  file: string,
  trackerIds: Set<string>,
  knownIds: Set<string>,
  errors: Errors
): void {
  switch (pred.op) {
    case "trackerCount":
    case "trackerSinceFulfillment":
    case "trackerNeverFulfilled": {
      if (!trackerIds.has(pred.trackerId)) {
        const available =
          trackerIds.size > 0 ? [...trackerIds].join(", ") : "(none)";
        pushErr(
          errors,
          file,
          `${path}.trackerId`,
          `"${pred.trackerId}" — no such tracker on this event. Available: [${available}]`
        );
      }
      return;
    }
    case "eventStatus": {
      if (!knownIds.has(pred.otherEventId)) {
        pushErr(
          errors,
          file,
          `${path}.otherEventId`,
          `"${pred.otherEventId}" — no such event`
        );
      }
      return;
    }
    case "and":
    case "or": {
      pred.children.forEach((child, i) => {
        walkPredicateRefs(
          child,
          `${path}.children[${i}]`,
          file,
          trackerIds,
          knownIds,
          errors
        );
      });
      return;
    }
    case "not": {
      walkPredicateRefs(
        pred.child,
        `${path}.child`,
        file,
        trackerIds,
        knownIds,
        errors
      );
      return;
    }
    default:
      // Leaf predicates with no cross-refs — nothing to walk.
      return;
  }
}

function walkEffectRefs(
  eff: Effect,
  path: string,
  file: string,
  knownIds: Set<string>,
  errors: Errors
): void {
  if (eff.kind === "event.transition") {
    if (!knownIds.has(eff.otherEventId)) {
      pushErr(
        errors,
        file,
        `${path}.otherEventId`,
        `"${eff.otherEventId}" — no such event`
      );
    }
  }
  // Other effect kinds have no cross-event id refs.
}

// Explicit re-exports satisfy the plan's import list at the top of the file.
export type {
  ActionMatch,
  CharacterPredicate,
  Effect,
  Predicate,
  ScenePredicate,
  ScriptedEvent,
  ScriptedEventStatus,
  Tracker,
};
