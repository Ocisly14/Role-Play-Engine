export type BlockedConnectionNodeType = "scene" | "road";

export interface BlockedConnectionNodeRef {
  type: BlockedConnectionNodeType;
  id: string;
}

export interface BlockedConnectionLookup {
  scenes?: Map<string, unknown>;
  roads?: Map<string, unknown>;
}

export function serializeBlockedConnectionNodeRef(
  ref: BlockedConnectionNodeRef
): string {
  return `${ref.type}:${ref.id}`;
}

export function makeBlockedConnectionKey(
  a: BlockedConnectionNodeRef,
  b: BlockedConnectionNodeRef
): string {
  const aKey = serializeBlockedConnectionNodeRef(a);
  const bKey = serializeBlockedConnectionNodeRef(b);
  return aKey <= bKey ? `${aKey}::${bKey}` : `${bKey}::${aKey}`;
}

export function hasBlockedConnection(
  blockedConnections: Map<string, string>,
  a: BlockedConnectionNodeRef,
  b: BlockedConnectionNodeRef
): boolean {
  return blockedConnections.has(makeBlockedConnectionKey(a, b));
}

export function getBlockedConnectionReason(
  blockedConnections: Map<string, string>,
  a: BlockedConnectionNodeRef,
  b: BlockedConnectionNodeRef
): string | undefined {
  return blockedConnections.get(makeBlockedConnectionKey(a, b));
}

export function resolveBlockedConnectionNodeRef(
  id: string,
  lookup: BlockedConnectionLookup
): BlockedConnectionNodeRef | null {
  if (lookup.scenes?.has(id)) {
    return { type: "scene", id };
  }
  if (lookup.roads?.has(id)) {
    return { type: "road", id };
  }
  return null;
}

/**
 * A subsystem votes to block the PASSAGE BETWEEN TWO PLACES, not one authored
 * exit: weather closes a mountain road in both directions at once. So weather
 * addresses an edge by its endpoints rather than by a connection id, in this form —
 * `<featureId>:<a>|<b>`, endpoints sorted so the two directions mint the same
 * string.
 *
 * Minting and reading live here together on purpose. They used to be a
 * hand-rolled template in each subsystem, and when the Applier moved to
 * resolving votes through the connection REGISTRY, nothing in weather
 * had to change to keep compiling — so nothing did, and every block it
 * cast was dropped as "resolves to no edge" for as long as that went
 * unnoticed.
 */
export function makeFeatureEdgeId(
  featureId: string,
  a: string,
  b: string
): string {
  return a <= b ? `${featureId}:${a}|${b}` : `${featureId}:${b}|${a}`;
}

/** The endpoints of a {@link makeFeatureEdgeId} id, or null for anything else
 *  — an authored `connection.*` id included, which is how the caller knows to
 *  fall back to the registry. */
export function parseFeatureEdgeId(
  id: string
): { featureId: string; a: string; b: string } | null {
  const colon = id.indexOf(":");
  if (colon <= 0) return null;
  const bar = id.indexOf("|", colon + 1);
  if (bar <= colon + 1 || bar === id.length - 1) return null;
  return {
    featureId: id.slice(0, colon),
    a: id.slice(colon + 1, bar),
    b: id.slice(bar + 1),
  };
}
