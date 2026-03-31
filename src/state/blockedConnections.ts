export type BlockedConnectionNodeType = "scene" | "junction" | "road";

export interface BlockedConnectionNodeRef {
  type: BlockedConnectionNodeType;
  id: string;
}

export interface BlockedConnectionLookup {
  scenes?: Map<string, unknown>;
  junctions?: Map<string, unknown>;
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
  if (lookup.junctions?.has(id)) {
    return { type: "junction", id };
  }
  if (lookup.roads?.has(id)) {
    return { type: "road", id };
  }
  return null;
}
