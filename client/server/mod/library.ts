import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
import path from "path";
import fs from "fs";

const modsDir = path.join(process.cwd(), "data", "Mods");
const SYSTEM_OWNER_EMAIL = "__system__";
const TRASH_RETENTION_DAYS = 7;

function normalizeModName(name: string): string {
  return name.trim();
}

function normalizeModuleNameKey(name: string): string {
  return normalizeModName(name).toLowerCase();
}

function parseNpcNames(moduleDir: string, moduleName: string): string[] {
  const npcNames = new Set<string>();
  const npcDir = path.join(moduleDir, `${moduleName}_npc`);

  if (!fs.existsSync(npcDir)) {
    return [];
  }

  const files = fs
    .readdirSync(npcDir)
    .filter((f) => f.toLowerCase().endsWith(".json"));
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(npcDir, file), "utf-8");
      const json = JSON.parse(raw);
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        const name = item?.name;
        if (typeof name === "string" && name.trim()) {
          npcNames.add(name.trim());
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  return Array.from(npcNames);
}

async function resolveOwnedModule(email: string, modName: string) {
  const prisma = getPrismaClient();
  return prisma.module.findFirst({
    where: {
      ownerEmailId: email,
      moduleNameNormalized: normalizeModuleNameKey(modName),
    },
    orderBy: { createdAt: "desc" },
  });
}

async function resolveSharedModule(modName: string) {
  const prisma = getPrismaClient();
  return prisma.module.findFirst({
    where: {
      moduleNameNormalized: normalizeModuleNameKey(modName),
      share: true,
      status: "active",
    },
    orderBy: { createdAt: "desc" },
  });
}

async function resolveAccessibleModuleForUser(email: string, modName: string) {
  const prisma = getPrismaClient();
  const permission = await prisma.modulePermission.findFirst({
    where: {
      emailId: email,
      module: {
        moduleNameNormalized: normalizeModuleNameKey(modName),
        status: "active",
      },
    },
    include: { module: true },
    orderBy: [{ canManage: "desc" }, { grantedAt: "desc" }],
  });

  return permission?.module || null;
}

async function ensureModuleEntry(modName: string, ownerEmail: string) {
  const prisma = getPrismaClient();
  const normalized = normalizeModName(modName);
  const normalizedKey = normalizeModuleNameKey(normalized);
  const ownerEmailId = ownerEmail || SYSTEM_OWNER_EMAIL;

  return prisma.module.upsert({
    where: {
      uq_modules_owner_name_normalized: {
        ownerEmailId,
        moduleNameNormalized: normalizedKey,
      },
    },
    update: {
      moduleName: normalized,
      moduleNameNormalized: normalizedKey,
      ownerEmailId,
      status: "active",
      updatedAt: new Date(),
    },
    create: {
      moduleName: normalized,
      moduleNameNormalized: normalizedKey,
      ownerEmailId,
      share: false,
      status: "active",
    },
  });
}

async function ensureModulePermission(
  moduleId: string,
  emailId: string,
  role: "owner" | "viewer"
): Promise<void> {
  const prisma = getPrismaClient();
  const canManage = role === "owner";
  await prisma.modulePermission.upsert({
    where: { moduleId_emailId: { moduleId, emailId } },
    update: {
      role,
      canPlay: true,
      canManage,
      grantedAt: new Date(),
    },
    create: {
      moduleId,
      emailId,
      role,
      canPlay: true,
      canManage,
      grantedAt: new Date(),
    },
  });
}

async function ensureUserModuleLibraryLink(
  emailId: string,
  moduleId: string,
  source: "owned" | "shared_added"
): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.userModuleLibrary.upsert({
    where: { emailId_moduleId: { emailId, moduleId } },
    update: {
      source,
      addedAt: new Date(),
    },
    create: {
      emailId,
      moduleId,
      source,
      addedAt: new Date(),
    },
  });
}

async function markUserModuleDeleted(
  emailId: string,
  moduleId: string
): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.userModuleDeleted.upsert({
    where: { emailId_moduleId: { emailId, moduleId } },
    update: { deletedAt: new Date() },
    create: {
      emailId,
      moduleId,
      deletedAt: new Date(),
    },
  });
}

async function clearUserModuleDeleted(
  emailId: string,
  moduleId: string
): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.userModuleDeleted.deleteMany({
    where: { emailId, moduleId },
  });
}

async function deleteDynamicCheckpointsForModule(
  email: string,
  moduleId: string | null,
  modName: string
): Promise<void> {
  const prisma = getPrismaClient();

  const characters = await prisma.character.findMany({
    where: { emailId: email },
    select: { characterId: true },
  });
  const characterIds = characters.map((c) => c.characterId);

  const sessions = await prisma.session.findMany({
    where: {
      OR: [
        { emailId: email },
        ...(characterIds.length > 0
          ? [{ characterId: { in: characterIds } }]
          : []),
      ],
    },
    select: { sessionId: true, moduleId: true },
  });
  if (sessions.length === 0) return;

  let targetSessionIds = sessions.map((s) => s.sessionId);
  if (moduleId) {
    const moduleScoped = sessions
      .filter((s) => s.moduleId === moduleId)
      .map((s) => s.sessionId);
    if (moduleScoped.length > 0) {
      targetSessionIds = moduleScoped;
    }
  }

  const checkpoints = await prisma.gameCheckpoint.findMany({
    where: { sessionId: { in: targetSessionIds } },
    select: { checkpointId: true, gameState: true, moduleId: true },
  });

  const target = normalizeModuleNameKey(modName);
  const toDelete: string[] = [];
  for (const row of checkpoints) {
    if (moduleId && row.moduleId === moduleId) {
      toDelete.push(row.checkpointId);
      continue;
    }
    try {
      const state =
        typeof row.gameState === "string"
          ? JSON.parse(row.gameState)
          : row.gameState;
      const checkpointModuleName =
        typeof state?.moduleName === "string"
          ? normalizeModuleNameKey(state.moduleName)
          : "";
      if (checkpointModuleName && checkpointModuleName === target) {
        toDelete.push(row.checkpointId);
      }
    } catch {
      // ignore malformed payloads
    }
  }

  if (toDelete.length === 0) return;
  await prisma.gameCheckpoint.deleteMany({
    where: { checkpointId: { in: toDelete } },
  });
}

async function cleanModuleDataForOwner(
  ownerEmail: string,
  modName: string,
  moduleId: string
): Promise<void> {
  const prisma = getPrismaClient();
  const moduleDir = path.join(modsDir, modName);

  await prisma.moduleBackground.deleteMany({
    where: { moduleId },
  });

  // Scenario base-content is module-scoped.
  await prisma.scenarioCondition.deleteMany({ where: { moduleId } });
  await prisma.scenarioClue.deleteMany({ where: { moduleId } });
  await prisma.scenarioCharacter.deleteMany({ where: { moduleId } });
  await prisma.scenarioSnapshot.deleteMany({ where: { moduleId } });
  await prisma.scenario.deleteMany({ where: { moduleId } });

  // Legacy cleanup for NPC data that is still keyed by email+name.
  const npcNames = parseNpcNames(moduleDir, modName);

  if (npcNames.length > 0) {
    const npcRows = await prisma.character.findMany({
      where: {
        isNpc: true,
        name: { in: npcNames },
        emailId: ownerEmail,
      },
      select: { characterId: true },
    });
    const npcIds = npcRows.map((row) => row.characterId);
    if (npcIds.length > 0) {
      await prisma.npcClue.deleteMany({
        where: { npcId: { in: npcIds }, emailId: ownerEmail },
      });
      await prisma.npcRelationship.deleteMany({
        where: {
          OR: [{ sourceId: { in: npcIds } }, { targetId: { in: npcIds } }],
          emailId: ownerEmail,
        },
      });
      await prisma.relationship.deleteMany({
        where: { npcId: { in: npcIds }, emailId: ownerEmail },
      });
      await prisma.character.deleteMany({
        where: { characterId: { in: npcIds }, isNpc: true, emailId: ownerEmail },
      });
    }
  }
}

export async function ensureModCatalogEntry(
  modName: string,
  ownerEmail: string
): Promise<void> {
  const moduleEntry = await ensureModuleEntry(modName, ownerEmail);
  await ensureModulePermission(moduleEntry.moduleId, ownerEmail, "owner");
}

export async function ensureUserLibraryEntry(
  email: string,
  modName: string
): Promise<void> {
  const normalized = normalizeModName(modName);

  const owned = await resolveOwnedModule(email, normalized);
  if (owned) {
    await ensureModulePermission(owned.moduleId, email, "owner");
    await ensureUserModuleLibraryLink(email, owned.moduleId, "owned");
    await clearUserModuleDeleted(email, owned.moduleId);
    return;
  }

  const accessible = await resolveAccessibleModuleForUser(email, normalized);
  if (accessible) {
    const role = accessible.ownerEmailId === email ? "owner" : "viewer";
    const source = accessible.ownerEmailId === email ? "owned" : "shared_added";
    await ensureModulePermission(accessible.moduleId, email, role);
    await ensureUserModuleLibraryLink(email, accessible.moduleId, source);
    await clearUserModuleDeleted(email, accessible.moduleId);
    return;
  }

  const shared = await resolveSharedModule(normalized);
  if (shared && shared.ownerEmailId !== email) {
    await ensureModulePermission(shared.moduleId, email, "viewer");
    await ensureUserModuleLibraryLink(email, shared.moduleId, "shared_added");
    await clearUserModuleDeleted(email, shared.moduleId);
    return;
  }

  const moduleEntry = await ensureModuleEntry(normalized, email);
  await ensureModulePermission(moduleEntry.moduleId, email, "owner");
  await ensureUserModuleLibraryLink(email, moduleEntry.moduleId, "owned");
  await clearUserModuleDeleted(email, moduleEntry.moduleId);
}

export async function registerModuleForUser(
  email: string,
  modName: string
): Promise<void> {
  const moduleEntry = await ensureModuleEntry(modName, email);
  await ensureModulePermission(moduleEntry.moduleId, email, "owner");
  await ensureUserModuleLibraryLink(email, moduleEntry.moduleId, "owned");
  await clearUserModuleDeleted(email, moduleEntry.moduleId);
}

export async function ensureLegacyLibraryEntries(email: string): Promise<void> {
  const prisma = getPrismaClient();
  const rows = await prisma.moduleBackground.findMany({
    where: { emailId: email, title: { not: "" } },
    select: { title: true },
    distinct: ["title"],
  });

  for (const row of rows) {
    const title = row.title?.trim();
    if (!title) continue;
    await registerModuleForUser(email, title);
  }
}

export async function cleanupExpiredDeletedMods(): Promise<void> {
  const prisma = getPrismaClient();
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  await prisma.userModuleDeleted.deleteMany({
    where: { deletedAt: { lte: cutoff } },
  });

  const archivedModules = await prisma.module.findMany({
    where: {
      status: "archived",
      updatedAt: { lte: cutoff },
    },
    select: {
      moduleId: true,
      moduleName: true,
      ownerEmailId: true,
    },
  });

  for (const module of archivedModules) {
    const [libraryCount, deletedCount] = await Promise.all([
      prisma.userModuleLibrary.count({ where: { moduleId: module.moduleId } }),
      prisma.userModuleDeleted.count({ where: { moduleId: module.moduleId } }),
    ]);
    if (libraryCount > 0 || deletedCount > 0) {
      continue;
    }

    if (module.ownerEmailId && module.ownerEmailId !== SYSTEM_OWNER_EMAIL) {
      try {
        await cleanModuleDataForOwner(
          module.ownerEmailId,
          module.moduleName,
          module.moduleId
        );
      } catch (error) {
        console.warn(
          `[Mod Library] Failed to clean module data for ${module.moduleName}:`,
          error
        );
      }
    }

    const modPath = path.join(modsDir, module.moduleName);
    try {
      if (fs.existsSync(modPath)) {
        fs.rmSync(modPath, { recursive: true, force: true });
      }
    } catch (error) {
      console.warn(
        `[Mod Library] Failed to delete module folder: ${modPath}`,
        error
      );
      continue;
    }

    await prisma.module.delete({ where: { moduleId: module.moduleId } });
  }
}

export async function listUserLibrary(
  email: string
): Promise<
  Array<{
    name: string;
    shared: boolean;
    ownerEmail: string | null;
    isOwner: boolean;
  }>
> {
  await cleanupExpiredDeletedMods();
  await ensureLegacyLibraryEntries(email);

  const prisma = getPrismaClient();
  const rows = await prisma.userModuleLibrary.findMany({
    where: {
      emailId: email,
      module: { status: "active" },
    },
    include: { module: true },
    orderBy: { addedAt: "desc" },
  });

  return rows.map((row) => ({
    name: row.module.moduleName,
    shared: row.module.share,
    ownerEmail:
      row.module.ownerEmailId === SYSTEM_OWNER_EMAIL
        ? null
        : row.module.ownerEmailId,
    isOwner: row.module.ownerEmailId === email,
  }));
}

export async function listSharedMods(
  email: string,
  query?: string
): Promise<Array<{ name: string; ownerEmail: string; inLibrary: boolean }>> {
  await cleanupExpiredDeletedMods();
  const prisma = getPrismaClient();
  const normalizedQuery = query?.trim().toLowerCase();

  const modules = await prisma.module.findMany({
    where: {
      share: true,
      status: "active",
      ...(normalizedQuery
        ? { moduleNameNormalized: { contains: normalizedQuery } }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
  });

  if (modules.length === 0) return [];
  const moduleIds = modules.map((m) => m.moduleId);
  const inLibraryRows = await prisma.userModuleLibrary.findMany({
    where: {
      emailId: email,
      moduleId: { in: moduleIds },
    },
    select: { moduleId: true },
  });
  const inLibrary = new Set(inLibraryRows.map((r) => r.moduleId));

  return modules.map((m) => ({
    name: m.moduleName,
    ownerEmail:
      m.ownerEmailId === SYSTEM_OWNER_EMAIL ? "" : m.ownerEmailId,
    inLibrary: inLibrary.has(m.moduleId),
  }));
}

export async function shareModule(email: string, modName: string): Promise<void> {
  const prisma = getPrismaClient();
  const owned = await resolveOwnedModule(email, modName);
  if (!owned) {
    throw new Error("Module not found in library");
  }

  await prisma.module.update({
    where: { moduleId: owned.moduleId },
    data: {
      share: true,
      status: "active",
      updatedAt: new Date(),
    },
  });
  await ensureModulePermission(owned.moduleId, email, "owner");
  await ensureUserModuleLibraryLink(email, owned.moduleId, "owned");
}

export async function unshareModule(email: string, modName: string): Promise<void> {
  const prisma = getPrismaClient();
  const owned = await resolveOwnedModule(email, modName);
  if (!owned) {
    throw new Error("Module not found in library");
  }

  await prisma.module.update({
    where: { moduleId: owned.moduleId },
    data: {
      share: false,
      updatedAt: new Date(),
    },
  });
  await ensureModulePermission(owned.moduleId, email, "owner");
}

export async function removeModuleFromLibrary(
  email: string,
  modName: string
): Promise<{ trashed: boolean }> {
  const prisma = getPrismaClient();
  const normalized = normalizeModName(modName);

  const owned = await resolveOwnedModule(email, normalized);
  if (owned && owned.status === "active") {
    await prisma.module.update({
      where: { moduleId: owned.moduleId },
      data: {
        status: "archived",
        share: false,
        updatedAt: new Date(),
      },
    });

    await prisma.userModuleLibrary.deleteMany({
      where: { moduleId: owned.moduleId },
    });
    await prisma.modulePermission.deleteMany({
      where: { moduleId: owned.moduleId, emailId: { not: email } },
    });
    await markUserModuleDeleted(email, owned.moduleId);
    await deleteDynamicCheckpointsForModule(email, owned.moduleId, normalized);
    return { trashed: true };
  }

  const accessible = await resolveAccessibleModuleForUser(email, normalized);
  if (!accessible) {
    throw new Error("Module not found in library");
  }

  if (accessible.ownerEmailId === email) {
    throw new Error("Module is not in removable state");
  }

  await prisma.userModuleLibrary.deleteMany({
    where: {
      emailId: email,
      moduleId: accessible.moduleId,
    },
  });
  await prisma.modulePermission.deleteMany({
    where: {
      moduleId: accessible.moduleId,
      emailId: email,
    },
  });
  await markUserModuleDeleted(email, accessible.moduleId);
  await deleteDynamicCheckpointsForModule(
    email,
    accessible.moduleId,
    normalized
  );
  return { trashed: false };
}

export async function addSharedModuleToLibrary(
  email: string,
  modName: string
): Promise<void> {
  const shared = await resolveSharedModule(modName);
  if (!shared || shared.status !== "active") {
    throw new Error("Shared module not available");
  }

  if (shared.ownerEmailId === email) {
    await ensureModulePermission(shared.moduleId, email, "owner");
    await ensureUserModuleLibraryLink(email, shared.moduleId, "owned");
    await clearUserModuleDeleted(email, shared.moduleId);
    return;
  }

  await ensureModulePermission(shared.moduleId, email, "viewer");
  await ensureUserModuleLibraryLink(email, shared.moduleId, "shared_added");
  await clearUserModuleDeleted(email, shared.moduleId);
}

export async function listDeletedMods(
  email: string
): Promise<
  Array<{
    name: string;
    deletedAt: string;
    ownerEmail: string;
    daysLeft: number;
  }>
> {
  await cleanupExpiredDeletedMods();
  const prisma = getPrismaClient();
  const rows = await prisma.userModuleDeleted.findMany({
    where: { emailId: email },
    include: { module: true },
    orderBy: { deletedAt: "desc" },
  });

  const now = Date.now();
  const durationMs = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  return rows
    .filter((row) => !!row.module)
    .map((row) => {
      const deletedAt = row.deletedAt.getTime();
      const expiresAt = deletedAt + durationMs;
      const daysLeft = Math.max(
        0,
        Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000))
      );

      return {
        name: row.module.moduleName,
        ownerEmail:
          row.module.ownerEmailId === SYSTEM_OWNER_EMAIL
            ? ""
            : row.module.ownerEmailId,
        deletedAt: row.deletedAt.toISOString(),
        daysLeft,
      };
    });
}

export async function restoreDeletedModule(
  email: string,
  modName: string
): Promise<void> {
  const prisma = getPrismaClient();
  const normalizedKey = normalizeModuleNameKey(modName);

  const deletedRows = await prisma.userModuleDeleted.findMany({
    where: {
      emailId: email,
      module: { moduleNameNormalized: normalizedKey },
    },
    include: { module: true },
    orderBy: { deletedAt: "desc" },
  });

  const target = deletedRows.find((row) => !!row.module);
  if (!target || !target.module) {
    throw new Error("Module not found in deleted list");
  }

  const module = target.module;
  if (module.ownerEmailId === email) {
    await prisma.module.update({
      where: { moduleId: module.moduleId },
      data: { status: "active", updatedAt: new Date() },
    });
    await ensureModulePermission(module.moduleId, email, "owner");
    await ensureUserModuleLibraryLink(email, module.moduleId, "owned");
  } else {
    if (!module.share || module.status !== "active") {
      throw new Error("Shared module not available");
    }
    await ensureModulePermission(module.moduleId, email, "viewer");
    await ensureUserModuleLibraryLink(email, module.moduleId, "shared_added");
  }

  await clearUserModuleDeleted(email, module.moduleId);
}
