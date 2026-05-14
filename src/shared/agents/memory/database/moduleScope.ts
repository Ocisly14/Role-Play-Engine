import { getPrismaClient } from "./prismaClient.js";

export function normalizeModuleNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function scopeIdByModule(id: string, _moduleId?: string | null): string {
  return stripModuleScope(id);
}

export function stripModuleScope(id: string): string {
  const legacySep = id.indexOf("::");
  if (legacySep > 0) {
    return id.slice(legacySep + 2);
  }
  const hashedSep = id.lastIndexOf("__");
  if (hashedSep > 0) {
    const maybeHash = id.slice(hashedSep + 2);
    if (/^[a-f0-9]{8}$/.test(maybeHash)) {
      return id.slice(0, hashedSep);
    }
  }
  return id;
}

export async function resolveModuleIdByName(
  moduleName: string,
  emailId?: string
): Promise<string | null> {
  const prisma = getPrismaClient();
  const normalized = normalizeModuleNameKey(moduleName);

  if (emailId) {
    const owned = await prisma.module.findFirst({
      where: {
        ownerEmailId: emailId,
        moduleNameNormalized: normalized,
        status: "active",
      },
      select: { moduleId: true },
      orderBy: { updatedAt: "desc" },
    });
    if (owned) return owned.moduleId;
  }

  const fallback = await prisma.module.findFirst({
    where: {
      moduleNameNormalized: normalized,
      status: "active",
    },
    select: { moduleId: true },
    orderBy: { updatedAt: "desc" },
  });

  return fallback?.moduleId || null;
}
