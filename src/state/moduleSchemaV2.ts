/**
 * Schema v2 place-file parsing + derivation + module-wide reference validation.
 *
 * v2 is prose-first: `description` is the complete scene text, every visible
 * object / exit / condition is cited as `[reference-id]`, and the matching
 * machine-readable objects live in the same file under `references`. See
 * testmods/DYNAMIC_WORLD_SCENE_SCHEMA.md.
 *
 * v1 files (anything without `schemaVersion: 2`) are no longer supported —
 * `parsePlaceFileV2` reports a clear error instead of guessing shapes.
 */

import type { SceneCondition } from "../engine/core/types.js";
import type {
  AlongConnection,
  RoadConnection,
  RoadNode,
} from "./topologyTypes.js";
import type {
  DynamicScene,
  Item,
  SceneConnection,
  TransportEdge,
} from "./types.js";

// ─── Error type ────────────────────────────────────────────────────

/** Aggregates every problem found in one module entry into a single throw. */
export class ModuleSchemaError extends Error {
  readonly entryId: string;
  readonly problems: string[];

  constructor(entryId: string, problems: string[]) {
    super(`Module entry "${entryId}" is invalid:\n- ${problems.join("\n- ")}`);
    this.name = "ModuleSchemaError";
    this.entryId = entryId;
    this.problems = problems;
  }
}

// ─── File-shape types ──────────────────────────────────────────────

export type RoadConnectionRole = "endpointA" | "endpointB" | "access";

const ROAD_CONNECTION_ROLES: readonly RoadConnectionRole[] = [
  "endpointA",
  "endpointB",
  "access",
];

/** A connection as authored in a v2 place file. `role`/`position` are only
 *  legal on ROAD_* files (rejected by buildSceneV2). */
export interface PlaceFileV2Connection extends SceneConnection {
  role?: RoadConnectionRole;
  position?: number;
}

/** A condition as authored in a v2 place file — `id` is required. */
export interface PlaceFileV2Condition extends SceneCondition {
  id: string;
}

export interface PlaceFileV2References {
  items: Item[];
  connections: PlaceFileV2Connection[];
  conditions: PlaceFileV2Condition[];
}

/** The parsed, fully type-checked shape of a `SCN_*` / `ROAD_*` file. */
export interface PlaceFileV2 {
  schemaVersion: 2;
  id: string;
  name: string;
  description: string;
  /** Absent on a TOP-LEVEL scene — a geography node (street, crossroads,
   *  yard) that the road network runs between. */
  parentLocationId?: string;
  indoor?: boolean;
  /** Required for ROAD_* files (enforced by buildRoadV2). */
  travelTimeMinutes?: number;
  references: PlaceFileV2References;
}

// ─── Small guards ──────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function checkOptionalString(
  obj: Record<string, unknown>,
  field: string,
  path: string,
  problems: string[]
): string | undefined {
  const value = obj[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    problems.push(`${path}.${field}: expected a string`);
    return undefined;
  }
  return value;
}

function checkOptionalBoolean(
  obj: Record<string, unknown>,
  field: string,
  path: string,
  problems: string[]
): boolean | undefined {
  const value = obj[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    problems.push(`${path}.${field}: expected a boolean`);
    return undefined;
  }
  return value;
}

function checkOptionalNumber(
  obj: Record<string, unknown>,
  field: string,
  path: string,
  problems: string[]
): number | undefined {
  const value = obj[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || Number.isNaN(value)) {
    problems.push(`${path}.${field}: expected a number`);
    return undefined;
  }
  return value;
}

function checkRequiredString(
  obj: Record<string, unknown>,
  field: string,
  path: string,
  problems: string[]
): string | undefined {
  const value = obj[field];
  if (!isNonEmptyString(value)) {
    problems.push(`${path}.${field}: required non-empty string`);
    return undefined;
  }
  return value;
}

/** `skillPenalty` accepts ONLY the Record shape. The old array shape
 *  (`[{ skill, delta }]`) gets a targeted error rather than a generic one. */
function parseSkillPenalty(
  value: unknown,
  path: string,
  problems: string[]
): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    problems.push(
      `${path}: array form ([{ skill, delta }]) is no longer supported — use a Record<skillName, number> (e.g. { "Investigation": -10 })`
    );
    return undefined;
  }
  if (!isRecord(value)) {
    problems.push(`${path}: expected a Record<skillName, number>`);
    return undefined;
  }
  const out: Record<string, number> = {};
  let ok = true;
  for (const [skill, delta] of Object.entries(value)) {
    if (typeof delta !== "number" || Number.isNaN(delta)) {
      problems.push(`${path}.${skill}: expected a number`);
      ok = false;
      continue;
    }
    out[skill] = delta;
  }
  return ok ? out : undefined;
}

function parseMechanicalEffect(
  value: unknown,
  path: string,
  problems: string[]
): SceneCondition["mechanicalEffect"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    problems.push(`${path}: expected an object`);
    return undefined;
  }
  const effect: NonNullable<SceneCondition["mechanicalEffect"]> = {};
  const skillPenalty = parseSkillPenalty(
    value.skillPenalty,
    `${path}.skillPenalty`,
    problems
  );
  if (skillPenalty !== undefined) effect.skillPenalty = skillPenalty;
  const blockConnections = checkOptionalBoolean(
    value,
    "blockConnections",
    path,
    problems
  );
  if (blockConnections !== undefined) {
    effect.blockConnections = blockConnections;
  }
  return effect;
}

// ─── Reference-block parsers ───────────────────────────────────────

function parseItem(
  value: unknown,
  path: string,
  problems: string[]
): Item | null {
  if (!isRecord(value)) {
    problems.push(`${path}: expected an object`);
    return null;
  }
  const before = problems.length;
  const id = checkRequiredString(value, "id", path, problems);
  const name = checkRequiredString(value, "name", path, problems);
  const description = checkOptionalString(value, "description", path, problems);
  const hidden = checkOptionalBoolean(value, "hidden", path, problems);
  const isLightSource = checkOptionalBoolean(
    value,
    "isLightSource",
    path,
    problems
  );
  const lightLevel = checkOptionalNumber(value, "lightLevel", path, problems);
  const position = checkOptionalNumber(value, "position", path, problems);
  if (position !== undefined && (position < 0 || position > 1)) {
    problems.push(`${path}.position: must be in [0, 1], got ${position}`);
  }
  if (problems.length > before || id === undefined || name === undefined) {
    return null;
  }
  const item: Item = { id, name };
  if (description !== undefined) item.description = description;
  if (hidden !== undefined) item.hidden = hidden;
  if (isLightSource !== undefined) item.isLightSource = isLightSource;
  if (lightLevel !== undefined) item.lightLevel = lightLevel;
  if (position !== undefined) item.position = position;
  return item;
}

function parseConnection(
  value: unknown,
  path: string,
  problems: string[]
): PlaceFileV2Connection | null {
  if (!isRecord(value)) {
    problems.push(`${path}: expected an object`);
    return null;
  }
  const before = problems.length;
  const id = checkRequiredString(value, "id", path, problems);
  const targetId = checkRequiredString(value, "targetId", path, problems);
  const name = checkOptionalString(value, "name", path, problems);
  const description = checkOptionalString(value, "description", path, problems);
  const hidden = checkOptionalBoolean(value, "hidden", path, problems);
  const position = checkOptionalNumber(value, "position", path, problems);
  let role: RoadConnectionRole | undefined;
  if (value.role !== undefined) {
    const raw = value.role;
    if (
      typeof raw === "string" &&
      (ROAD_CONNECTION_ROLES as readonly string[]).includes(raw)
    ) {
      role = raw === "endpointA" || raw === "endpointB" ? raw : "access";
    } else {
      problems.push(
        `${path}.role: expected one of ${ROAD_CONNECTION_ROLES.join(" | ")}`
      );
    }
  }
  if (problems.length > before || id === undefined || targetId === undefined) {
    return null;
  }
  const connection: PlaceFileV2Connection = { id, targetId };
  if (name !== undefined) connection.name = name;
  if (description !== undefined) connection.description = description;
  if (hidden !== undefined) connection.hidden = hidden;
  if (role !== undefined) connection.role = role;
  if (position !== undefined) connection.position = position;
  return connection;
}

function parseCondition(
  value: unknown,
  path: string,
  problems: string[]
): PlaceFileV2Condition | null {
  if (!isRecord(value)) {
    problems.push(`${path}: expected an object`);
    return null;
  }
  const before = problems.length;
  const id = checkRequiredString(value, "id", path, problems);
  const description = checkRequiredString(value, "description", path, problems);
  const featureId = checkOptionalString(value, "featureId", path, problems);
  let data: Record<string, unknown> | undefined;
  if (value.data !== undefined) {
    if (isRecord(value.data)) {
      data = value.data;
    } else {
      problems.push(`${path}.data: expected an object`);
    }
  }
  const mechanicalEffect = parseMechanicalEffect(
    value.mechanicalEffect,
    `${path}.mechanicalEffect`,
    problems
  );
  if (
    problems.length > before ||
    id === undefined ||
    description === undefined
  ) {
    return null;
  }
  const condition: PlaceFileV2Condition = { id, description };
  if (featureId !== undefined) condition.featureId = featureId;
  if (data !== undefined) condition.data = data;
  if (
    mechanicalEffect !== undefined &&
    Object.keys(mechanicalEffect).length > 0
  ) {
    condition.mechanicalEffect = mechanicalEffect;
  }
  return condition;
}

function parseReferenceArray<T>(
  value: unknown,
  path: string,
  problems: string[],
  parseOne: (entry: unknown, entryPath: string, problems: string[]) => T | null
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`${path}: expected an array`);
    return [];
  }
  const out: T[] = [];
  value.forEach((entry, index) => {
    const parsed = parseOne(entry, `${path}[${index}]`, problems);
    if (parsed !== null) out.push(parsed);
  });
  return out;
}

// ─── parsePlaceFileV2 ──────────────────────────────────────────────

/**
 * Full type-guard parse of one `SCN_*` / `ROAD_*` entry.
 * Aggregates every problem in the file into one ModuleSchemaError.
 */
export function parsePlaceFileV2(entryId: string, data: unknown): PlaceFileV2 {
  if (!isRecord(data)) {
    throw new ModuleSchemaError(entryId, [
      "entry data: expected a JSON object",
    ]);
  }
  if (
    entryId.startsWith("JUNC_") ||
    (isRecord(data) &&
      typeof data.id === "string" &&
      data.id.startsWith("JUNC_"))
  ) {
    throw new ModuleSchemaError(entryId, [
      "JUNC_* 节点已移除:路口/院子等地理节点请改写为无 parentLocationId 的顶层 SCN_* 场景(道路端点直接指向它)",
    ]);
  }
  if (data.schemaVersion !== 2) {
    throw new ModuleSchemaError(entryId, [
      `schemaVersion: v1 不再支持,请按 v2 格式重写(见 testmods/DYNAMIC_WORLD_SCENE_SCHEMA.md)— got ${JSON.stringify(
        data.schemaVersion
      )}`,
    ]);
  }

  const problems: string[] = [];
  const id = checkRequiredString(data, "id", entryId, problems);
  const name = checkRequiredString(data, "name", entryId, problems);
  const description = checkRequiredString(
    data,
    "description",
    entryId,
    problems
  );
  const parentLocationId = checkOptionalString(
    data,
    "parentLocationId",
    entryId,
    problems
  );
  const indoor = checkOptionalBoolean(data, "indoor", entryId, problems);
  const travelTimeMinutes = checkOptionalNumber(
    data,
    "travelTimeMinutes",
    entryId,
    problems
  );

  let items: Item[] = [];
  let connections: PlaceFileV2Connection[] = [];
  let conditions: PlaceFileV2Condition[] = [];
  if (data.references !== undefined) {
    if (!isRecord(data.references)) {
      problems.push(`${entryId}.references: expected an object`);
    } else {
      items = parseReferenceArray(
        data.references.items,
        `${entryId}.references.items`,
        problems,
        parseItem
      );
      connections = parseReferenceArray(
        data.references.connections,
        `${entryId}.references.connections`,
        problems,
        parseConnection
      );
      conditions = parseReferenceArray(
        data.references.conditions,
        `${entryId}.references.conditions`,
        problems,
        parseCondition
      );
    }
  }

  if (
    problems.length > 0 ||
    id === undefined ||
    name === undefined ||
    description === undefined
  ) {
    throw new ModuleSchemaError(entryId, problems);
  }

  const parsed: PlaceFileV2 = {
    schemaVersion: 2,
    id,
    name,
    description,
    references: { items, connections, conditions },
  };
  if (parentLocationId !== undefined) {
    parsed.parentLocationId = parentLocationId;
  }
  if (indoor !== undefined) parsed.indoor = indoor;
  if (travelTimeMinutes !== undefined) {
    parsed.travelTimeMinutes = travelTimeMinutes;
  }
  return parsed;
}

// ─── Derivation builders ───────────────────────────────────────────

function rejectRoadOnlyFields(
  file: PlaceFileV2,
  problems: string[]
): SceneConnection[] {
  const out: SceneConnection[] = [];
  for (const c of file.references.connections) {
    if (c.role !== undefined || c.position !== undefined) {
      problems.push(
        `connection "${c.id}": role/position are only valid on ROAD_* files`
      );
      continue;
    }
    const connection: SceneConnection = { id: c.id, targetId: c.targetId };
    if (c.name !== undefined) connection.name = c.name;
    if (c.description !== undefined) connection.description = c.description;
    if (c.hidden !== undefined) connection.hidden = c.hidden;
    out.push(connection);
  }
  return out;
}

/** Derive a runtime DynamicScene from a parsed SCN_* file. */
export function buildSceneV2(file: PlaceFileV2): DynamicScene {
  const problems: string[] = [];
  const connections = rejectRoadOnlyFields(file, problems);
  for (const item of file.references.items) {
    if (item.position !== undefined) {
      problems.push(
        `item "${item.id}": position is only valid on ROAD_* files (a scene has no interior distance)`
      );
    }
  }
  if (problems.length > 0) {
    throw new ModuleSchemaError(file.id, problems);
  }
  const scene: DynamicScene = {
    id: file.id,
    name: file.name,
    description: file.description,
    items: file.references.items,
    conditions: file.references.conditions,
    connections,
  };
  if (file.parentLocationId !== undefined) {
    scene.parentLocationId = file.parentLocationId;
  }
  if (file.indoor !== undefined) scene.indoor = file.indoor;
  return scene;
}

/** Derive a runtime RoadNode from a parsed ROAD_* file. Requires exactly one
 *  endpointA and one endpointB (both targeting SCN_* node scenes; that the
 *  target is TOP-LEVEL is checked cross-file in validateModuleReferences),
 *  `position` in [0,1] on every access connection, and a positive
 *  `travelTimeMinutes`. */
export function buildRoadV2(file: PlaceFileV2): RoadNode {
  const problems: string[] = [];
  const connections: RoadConnection[] = [];
  const endpoints: { endpointA: string[]; endpointB: string[] } = {
    endpointA: [],
    endpointB: [],
  };
  const alongConnections: AlongConnection[] = [];

  for (const c of file.references.connections) {
    if (c.role === undefined) {
      problems.push(
        `connection "${c.id}": ROAD_* connections require a role (endpointA | endpointB | access)`
      );
      continue;
    }
    if (c.role === "endpointA" || c.role === "endpointB") {
      if (!c.targetId.startsWith("SCN_")) {
        problems.push(
          `connection "${c.id}": ${c.role} must target a top-level SCN_* node scene, got "${c.targetId}"`
        );
      }
      endpoints[c.role].push(c.targetId);
    } else {
      if (c.position === undefined) {
        problems.push(
          `connection "${c.id}": access connections require a position in [0, 1]`
        );
      } else if (c.position < 0 || c.position > 1) {
        problems.push(
          `connection "${c.id}": position must be in [0, 1], got ${c.position}`
        );
      } else {
        alongConnections.push({ sceneId: c.targetId, position: c.position });
      }
    }
    const connection: RoadConnection = {
      id: c.id,
      targetId: c.targetId,
      role: c.role,
    };
    if (c.name !== undefined) connection.name = c.name;
    if (c.description !== undefined) connection.description = c.description;
    if (c.hidden !== undefined) connection.hidden = c.hidden;
    if (c.position !== undefined) connection.position = c.position;
    connections.push(connection);
  }

  for (const role of ["endpointA", "endpointB"] as const) {
    if (endpoints[role].length !== 1) {
      problems.push(
        `expected exactly one ${role} connection, found ${endpoints[role].length}`
      );
    }
  }
  const travelTimeMinutes = file.travelTimeMinutes;
  if (travelTimeMinutes === undefined || !(travelTimeMinutes > 0)) {
    problems.push(
      `travelTimeMinutes: required positive number, got ${JSON.stringify(
        travelTimeMinutes
      )}`
    );
  }

  if (problems.length > 0 || travelTimeMinutes === undefined) {
    throw new ModuleSchemaError(file.id, problems);
  }
  const road: RoadNode = {
    id: file.id,
    name: file.name,
    description: file.description,
    connections,
    endpointA: endpoints.endpointA[0],
    endpointB: endpoints.endpointB[0],
    travelTimeMinutes,
    alongConnections,
    items: file.references.items,
    conditions: file.references.conditions,
  };
  if (file.parentLocationId !== undefined) {
    road.parentLocationId = file.parentLocationId;
  }
  return road;
}

// ─── Module-wide reference validation ──────────────────────────────

/** Matches `[reference-id]` citations in place descriptions. */
const CITATION_RE = /\[([^\]\n]{1,64})\]/g;

export const MODULE_REFERENCES_ENTRY_ID = "__module_references__";

interface PlaceForValidation {
  id: string;
  kind: "scene" | "road";
  description: string;
  items: Item[];
  connections: SceneConnection[];
  conditions: SceneCondition[];
}

/**
 * Cross-file validation over all loaded places:
 * - every place id and reference id shares one module-wide namespace (no dupes);
 * - every `[citation]` in a description resolves to a local item/condition or
 *   to the target place of one of this place's connections;
 * - every non-hidden item is cited exactly once; hidden items are exempt and
 *   must NOT be cited (the prose would leak them);
 * - conditions must always be cited;
 * - connections are topology bookkeeping, never citable by their own id: the
 *   prose points at the PLACE a passage leads to, not at the passage. Every
 *   non-hidden connection's targetId must be cited exactly once; a hidden
 *   connection's target must NOT be cited. (A door that matters as an object
 *   — lockable, breakable — is authored as an item.)
 * - every connection targetId exists and is not the owner itself.
 * Exit symmetry (a reverse connection) is deliberately NOT required.
 */
export function validateModuleReferences(module: {
  scenes: Map<string, DynamicScene>;
  roads: Map<string, RoadNode>;
}): void {
  const problems: string[] = [];
  const places: PlaceForValidation[] = [];
  for (const scene of module.scenes.values()) {
    places.push({ kind: "scene", ...scene });
  }
  for (const road of module.roads.values()) {
    places.push({ kind: "road", ...road });
  }

  // Road endpoints must land on TOP-LEVEL node scenes.
  for (const road of module.roads.values()) {
    for (const endpoint of [road.endpointA, road.endpointB]) {
      const target = module.scenes.get(endpoint);
      if (target?.parentLocationId) {
        problems.push(
          `${road.id}: endpoint "${endpoint}" must be a top-level scene (it has parentLocationId "${target.parentLocationId}")`
        );
      }
    }
  }

  // One namespace: place ids + all reference ids.
  const seenIds = new Map<string, string>(); // id → owner entry
  const claimId = (id: string, owner: string) => {
    const existing = seenIds.get(id);
    if (existing !== undefined) {
      problems.push(
        `duplicate id "${id}" (declared by both "${existing}" and "${owner}")`
      );
      return;
    }
    seenIds.set(id, owner);
  };
  for (const place of places) {
    claimId(place.id, place.id);
  }
  for (const place of places) {
    for (const item of place.items) claimId(item.id, place.id);
    for (const connection of place.connections) {
      claimId(connection.id, place.id);
    }
    for (const condition of place.conditions) {
      if (condition.id !== undefined) claimId(condition.id, place.id);
    }
  }

  const placeIds = new Set<string>(places.map((p) => p.id));

  for (const place of places) {
    // Citation counts within this place's description.
    const citationCounts = new Map<string, number>();
    for (const match of place.description.matchAll(CITATION_RE)) {
      const cited = match[1];
      citationCounts.set(cited, (citationCounts.get(cited) ?? 0) + 1);
    }

    const localReferences = new Map<string, { hidden: boolean }>();
    for (const item of place.items) {
      localReferences.set(item.id, { hidden: item.hidden === true });
    }
    for (const condition of place.conditions) {
      if (condition.id !== undefined) {
        // Conditions cannot be hidden — always require a citation.
        localReferences.set(condition.id, { hidden: false });
      }
    }

    // Where can you go from here — cited by TARGET place id, never by the
    // connection's own id. A target reachable both hidden and visibly counts
    // as visible.
    const visibleTargets = new Set<string>();
    const hiddenTargets = new Set<string>();
    for (const connection of place.connections) {
      (connection.hidden === true ? hiddenTargets : visibleTargets).add(
        connection.targetId
      );
    }
    for (const target of visibleTargets) hiddenTargets.delete(target);

    // Every citation must resolve to a local item/condition or a connection
    // target of THIS place.
    for (const cited of citationCounts.keys()) {
      if (localReferences.has(cited) || visibleTargets.has(cited)) continue;
      if (hiddenTargets.has(cited)) {
        problems.push(
          `${place.id}: description cites [${cited}], the target of a hidden connection (the prose would reveal it)`
        );
      } else if (placeIds.has(cited)) {
        problems.push(
          `${place.id}: description cites [${cited}], a place this file has no connection to`
        );
      } else {
        problems.push(
          `${place.id}: description cites [${cited}], which is not declared in this file's references`
        );
      }
    }

    // Every item/condition: hidden must not be cited; visible must be cited exactly once.
    for (const [refId, { hidden }] of localReferences) {
      const count = citationCounts.get(refId) ?? 0;
      if (hidden) {
        if (count > 0) {
          problems.push(
            `${place.id}: hidden reference "${refId}" must not be cited in the description (the prose would reveal it)`
          );
        }
        continue;
      }
      if (count === 0) {
        problems.push(
          `${place.id}: reference "${refId}" is never cited in the description (every visible reference must appear exactly once as [${refId}])`
        );
      } else if (count > 1) {
        problems.push(
          `${place.id}: reference "${refId}" is cited ${count} times (expected exactly once)`
        );
      }
    }

    // Every reachable place must be cited exactly once — the prose is the
    // only map the reader gets.
    for (const target of visibleTargets) {
      const count = citationCounts.get(target) ?? 0;
      if (count === 0) {
        problems.push(
          `${place.id}: connection target "${target}" is never cited in the description (the prose must say where you can go, as [${target}])`
        );
      } else if (count > 1) {
        problems.push(
          `${place.id}: connection target "${target}" is cited ${count} times (expected exactly once)`
        );
      }
    }

    // Connection targets must exist and must not be the owner itself.
    for (const connection of place.connections) {
      if (connection.targetId === place.id) {
        problems.push(
          `${place.id}: connection "${connection.id}" targets its own place`
        );
      } else if (!placeIds.has(connection.targetId)) {
        problems.push(
          `${place.id}: connection "${connection.id}" targets unknown place "${connection.targetId}"`
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new ModuleSchemaError(MODULE_REFERENCES_ENTRY_ID, problems);
  }
}

// ─── scenarios_outline / transport_edges validators ────────────────

/**
 * Validate the transport_edges entry. Every referenced id must exist:
 * from/to must be outline (macro) ids, streetSceneId must be a loaded place.
 */
export function validateTransportEdges(
  entryId: string,
  data: unknown,
  module: {
    outlineIds: Set<string>;
    placeIds: Set<string>;
  }
): TransportEdge[] {
  const raw = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.transportEdges)
      ? data.transportEdges
      : null;
  if (raw === null) {
    throw new ModuleSchemaError(entryId, [
      "expected an array of edges or an object with a `transportEdges` array",
    ]);
  }

  const problems: string[] = [];
  const edges: TransportEdge[] = [];
  raw.forEach((entry: unknown, index: number) => {
    const path = `transportEdges[${index}]`;
    if (!isRecord(entry)) {
      problems.push(`${path}: expected an object`);
      return;
    }
    const before = problems.length;
    const fromLocationId = checkRequiredString(
      entry,
      "fromLocationId",
      path,
      problems
    );
    const toLocationId = checkRequiredString(
      entry,
      "toLocationId",
      path,
      problems
    );
    const streetSceneId = checkRequiredString(
      entry,
      "streetSceneId",
      path,
      problems
    );
    const travelTimeMinutes = entry.travelTimeMinutes;
    if (typeof travelTimeMinutes !== "number" || !(travelTimeMinutes > 0)) {
      problems.push(`${path}.travelTimeMinutes: required positive number`);
    }
    if (
      fromLocationId !== undefined &&
      !module.outlineIds.has(fromLocationId)
    ) {
      problems.push(
        `${path}.fromLocationId: "${fromLocationId}" is not a known outline id`
      );
    }
    if (toLocationId !== undefined && !module.outlineIds.has(toLocationId)) {
      problems.push(
        `${path}.toLocationId: "${toLocationId}" is not a known outline id`
      );
    }
    if (streetSceneId !== undefined && !module.placeIds.has(streetSceneId)) {
      problems.push(
        `${path}.streetSceneId: "${streetSceneId}" is not a known place`
      );
    }
    if (
      problems.length > before ||
      fromLocationId === undefined ||
      toLocationId === undefined ||
      streetSceneId === undefined ||
      typeof travelTimeMinutes !== "number"
    ) {
      return;
    }
    edges.push({
      fromLocationId,
      toLocationId,
      streetSceneId,
      travelTimeMinutes,
    });
  });

  if (problems.length > 0) {
    throw new ModuleSchemaError(entryId, problems);
  }
  return edges;
}
