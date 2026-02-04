import { getTokenContext } from "../../../../models/index.js";

export function resolveEmailId(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const context = getTokenContext();
  return context?.email;
}

export function scopeId(id: string, emailId?: string): string {
  if (!emailId) return id;
  const prefix = `${emailId}::`;
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}

export function scopeOptionalId(
  id: string | null | undefined,
  emailId?: string
): string | null {
  if (!id) return null;
  return scopeId(id, emailId);
}

export function scopeArray(
  ids: string[] | undefined,
  emailId?: string
): string[] | undefined {
  if (!ids) return ids;
  return ids.map((id) => scopeId(id, emailId));
}
