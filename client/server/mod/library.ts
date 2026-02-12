import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
import path from "path";
import fs from "fs";

type ModCatalogRow = {
  moduleName: string;
  ownerEmail: string;
  shared: boolean;
  deletedAt: Date | null;
};

const modsDir = path.join(process.cwd(), "data", "Mods");

function normalizeModName(name: string): string {
  return name.trim();
}

function parseScenarioNames(moduleDir: string, moduleName: string): string[] {
  const scenarioNames = new Set<string>();
  const scenariosDir = path.join(moduleDir, `${moduleName}_Scenarios`);
  const outlineFile = path.join(moduleDir, "scenarios_outline.json");

  const readScenarioFile = (filePath: string) => {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const json = JSON.parse(raw);
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        const name = item?.name || item?.snapshot?.name;
        if (typeof name === "string" && name.trim()) {
          scenarioNames.add(name.trim());
        }
      }
    } catch {
      // ignore parse errors
    }
  };

  if (fs.existsSync(outlineFile)) {
    try {
      const raw = fs.readFileSync(outlineFile, "utf-8");
      const json = JSON.parse(raw);
      const items = Array.isArray(json) ? json : [];
      for (const item of items) {
        if (item?.name && typeof item.name === "string") {
          scenarioNames.add(item.name.trim());
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  if (fs.existsSync(scenariosDir)) {
    const files = fs
      .readdirSync(scenariosDir)
      .filter((f) => f.toLowerCase().endsWith(".json"));
    for (const file of files) {
      readScenarioFile(path.join(scenariosDir, file));
    }
  }

  return Array.from(scenarioNames);
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

async function deleteDynamicCheckpointsForModule(
  email: string,
  modName: string
): Promise<void> {
  const prisma = getPrismaClient();

  // The original SQL joins game_checkpoints -> sessions -> characters WHERE characters.email_id = ?
  // Since Prisma schema doesn't have a direct relation from Session to Character via character_id,
  // we query in steps: find characters -> find sessions -> find checkpoints
  const characters = await prisma.character.findMany({
    where: { emailId: email },
    select: { characterId: true },
  });
  const characterIds = characters.map((c) => c.characterId);

  if (characterIds.length === 0) return;

  const sessions = await prisma.session.findMany({
    where: { characterId: { in: characterIds } },
    select: { sessionId: true },
  });
  const sessionIds = sessions.map((s) => s.sessionId);

  if (sessionIds.length === 0) return;

  const checkpoints = await prisma.gameCheckpoint.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { checkpointId: true, gameState: true },
  });

  const target = normalizeModName(modName).toLowerCase();
  const toDelete: string[] = [];

  for (const row of checkpoints) {
    try {
      const state =
        typeof row.gameState === "string"
          ? JSON.parse(row.gameState)
          : row.gameState;
      const moduleName =
        typeof state?.moduleName === "string"
          ? state.moduleName.trim().toLowerCase()
          : "";
      if (moduleName && moduleName === target) {
        toDelete.push(row.checkpointId);
      }
    } catch {
      // ignore malformed checkpoint payloads
    }
  }

  if (toDelete.length === 0) {
    return;
  }

  await prisma.gameCheckpoint.deleteMany({
    where: { checkpointId: { in: toDelete } },
  });
}

async function cleanModuleDataForOwner(
  ownerEmail: string,
  modName: string
): Promise<void> {
  const prisma = getPrismaClient();
  const moduleDir = path.join(modsDir, modName);

  const scenarioNames = parseScenarioNames(moduleDir, modName);
  const npcNames = parseNpcNames(moduleDir, modName);

  // With Prisma on PostgreSQL, all columns exist (no need for hasColumn checks).
  // We always filter by emailId.

  // Delete module_backgrounds
  await prisma.moduleBackground.deleteMany({
    where: { title: modName, emailId: ownerEmail },
  });

  if (scenarioNames.length > 0) {
    // Find scenario IDs
    const scenarioRows = await prisma.scenario.findMany({
      where: {
        name: { in: scenarioNames },
        emailId: ownerEmail,
      },
      select: { scenarioId: true },
    });

    const scenarioIds = scenarioRows.map((row) => row.scenarioId);
    if (scenarioIds.length > 0) {
      // Find snapshot IDs
      const snapshotRows = await prisma.scenarioSnapshot.findMany({
        where: {
          scenarioId: { in: scenarioIds },
          emailId: ownerEmail,
        },
        select: { snapshotId: true },
      });

      const snapshotIds = snapshotRows.map((row) => row.snapshotId);
      if (snapshotIds.length > 0) {
        // Delete scenario_characters by snapshot
        await prisma.scenarioCharacter.deleteMany({
          where: {
            snapshotId: { in: snapshotIds },
            emailId: ownerEmail,
          },
        });

        // Delete scenario_clues by snapshot
        await prisma.scenarioClue.deleteMany({
          where: {
            snapshotId: { in: snapshotIds },
            emailId: ownerEmail,
          },
        });

        // Delete scenario_conditions by snapshot
        await prisma.scenarioCondition.deleteMany({
          where: {
            snapshotId: { in: snapshotIds },
            emailId: ownerEmail,
          },
        });
      }

      // Delete scenario_snapshots
      await prisma.scenarioSnapshot.deleteMany({
        where: {
          scenarioId: { in: scenarioIds },
          emailId: ownerEmail,
        },
      });

      // Delete scenarios
      await prisma.scenario.deleteMany({
        where: {
          scenarioId: { in: scenarioIds },
          emailId: ownerEmail,
        },
      });
    }
  }

  if (npcNames.length > 0) {
    // Find NPC character IDs
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
      // Delete npc_clues
      await prisma.npcClue.deleteMany({
        where: {
          npcId: { in: npcIds },
          emailId: ownerEmail,
        },
      });

      // Delete npc_relationships (source OR target)
      await prisma.npcRelationship.deleteMany({
        where: {
          OR: [
            { sourceId: { in: npcIds } },
            { targetId: { in: npcIds } },
          ],
          emailId: ownerEmail,
        },
      });

      // Delete relationships
      await prisma.relationship.deleteMany({
        where: {
          npcId: { in: npcIds },
          emailId: ownerEmail,
        },
      });

      // Delete NPC characters
      await prisma.character.deleteMany({
        where: {
          characterId: { in: npcIds },
          isNpc: true,
          emailId: ownerEmail,
        },
      });
    }
  }
}

async function getCatalogEntry(
  modName: string
): Promise<ModCatalogRow | null> {
  const prisma = getPrismaClient();
  const row = await prisma.modCatalog.findFirst({
    where: {
      moduleName: { equals: modName, mode: "insensitive" },
    },
    select: {
      moduleName: true,
      ownerEmail: true,
      shared: true,
      deletedAt: true,
    },
  });
  return row || null;
}

export async function ensureModCatalogEntry(
  modName: string,
  ownerEmail: string
): Promise<void> {
  const prisma = getPrismaClient();
  const normalized = normalizeModName(modName);
  const existing = await getCatalogEntry(normalized);

  if (existing) {
    if (existing.deletedAt && existing.ownerEmail === ownerEmail) {
      await prisma.modCatalog.updateMany({
        where: {
          moduleName: { equals: normalized, mode: "insensitive" },
        },
        data: { deletedAt: null },
      });
    }
    return;
  }

  await prisma.modCatalog.create({
    data: {
      moduleName: normalized,
      ownerEmail: ownerEmail,
      shared: false,
    },
  });
}

export async function ensureUserLibraryEntry(
  email: string,
  modName: string
): Promise<void> {
  const prisma = getPrismaClient();
  const normalized = normalizeModName(modName);

  // INSERT OR IGNORE equivalent: try create, ignore if duplicate key
  try {
    await prisma.userMod.create({
      data: {
        emailId: email,
        moduleName: normalized,
      },
    });
  } catch (error: unknown) {
    // Ignore unique constraint violation (duplicate key)
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      // already exists, ignore
    } else {
      throw error;
    }
  }

  // Remove from deleted list
  await prisma.userModDeleted.deleteMany({
    where: {
      emailId: email,
      moduleName: { equals: normalized, mode: "insensitive" },
    },
  });
}

export async function registerModuleForUser(
  email: string,
  modName: string
): Promise<void> {
  await ensureModCatalogEntry(modName, email);
  await ensureUserLibraryEntry(email, modName);
}

export async function ensureLegacyLibraryEntries(
  email: string
): Promise<void> {
  const prisma = getPrismaClient();
  const bootstrapRow = await prisma.userModBootstrap.findUnique({
    where: { emailId: email },
  });

  if (bootstrapRow) {
    return;
  }

  const rows = await prisma.moduleBackground.findMany({
    where: {
      emailId: email,
      title: { not: "" },
    },
    select: { title: true },
    distinct: ["title"],
  });

  for (const row of rows) {
    const title = row.title?.trim();
    if (!title) {
      continue;
    }
    await ensureModCatalogEntry(title, email);
    await ensureUserLibraryEntry(email, title);
  }

  // INSERT OR REPLACE equivalent: upsert
  await prisma.userModBootstrap.upsert({
    where: { emailId: email },
    update: { bootstrappedAt: new Date() },
    create: { emailId: email, bootstrappedAt: new Date() },
  });
}

export async function cleanupExpiredDeletedMods(): Promise<void> {
  const prisma = getPrismaClient();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const expired = await prisma.modCatalog.findMany({
    where: {
      shared: false,
      deletedAt: { not: null, lte: sevenDaysAgo },
    },
    select: { moduleName: true },
  });

  for (const row of expired) {
    const modName = row.moduleName;
    const usage = await prisma.userMod.count({
      where: {
        moduleName: { equals: modName, mode: "insensitive" },
      },
    });

    if (usage > 0) {
      continue;
    }

    const catalog = await getCatalogEntry(modName);
    if (catalog?.ownerEmail) {
      try {
        await cleanModuleDataForOwner(catalog.ownerEmail, modName);
      } catch (error) {
        console.warn(
          `[Mod Library] Failed to clean module data for ${modName}:`,
          error
        );
      }
    }

    const modPath = path.join(modsDir, modName);
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

    await prisma.userMod.deleteMany({
      where: {
        moduleName: { equals: modName, mode: "insensitive" },
      },
    });
    await prisma.userModDeleted.deleteMany({
      where: {
        moduleName: { equals: modName, mode: "insensitive" },
      },
    });
    await prisma.modCatalog.deleteMany({
      where: {
        moduleName: { equals: modName, mode: "insensitive" },
      },
    });
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

  // Query user_mods joined with mod_catalog
  // Prisma doesn't support arbitrary joins on non-relation fields,
  // so we fetch user_mods then look up catalog entries.
  const userMods = await prisma.userMod.findMany({
    where: { emailId: email },
    orderBy: { moduleName: "asc" },
  });

  if (userMods.length === 0) {
    return [];
  }

  const moduleNames = userMods.map((um) => um.moduleName);

  // Fetch all matching catalog entries (case-insensitive match)
  const catalogEntries = await prisma.modCatalog.findMany({
    where: {
      moduleName: { in: moduleNames, mode: "insensitive" },
    },
  });

  // Build a lookup map (lowercase module name -> catalog entry)
  const catalogMap = new Map(
    catalogEntries.map((c) => [c.moduleName.toLowerCase(), c])
  );

  const results: Array<{
    name: string;
    shared: boolean;
    ownerEmail: string | null;
    isOwner: boolean;
  }> = [];

  for (const um of userMods) {
    const catalog = catalogMap.get(um.moduleName.toLowerCase());

    // Skip if catalog entry has a non-null deletedAt
    if (catalog?.deletedAt) {
      continue;
    }

    results.push({
      name: um.moduleName,
      shared: catalog ? catalog.shared : false,
      ownerEmail: catalog?.ownerEmail ?? null,
      isOwner: catalog?.ownerEmail === email,
    });
  }

  return results;
}

export async function listSharedMods(
  email: string,
  query?: string
): Promise<Array<{ name: string; ownerEmail: string; inLibrary: boolean }>> {
  await cleanupExpiredDeletedMods();

  const prisma = getPrismaClient();
  const normalizedQuery = query?.trim().toLowerCase();

  // Find all shared, non-deleted catalog entries (optionally filtered by name)
  const catalogEntries = await prisma.modCatalog.findMany({
    where: {
      shared: true,
      deletedAt: null,
      ...(normalizedQuery
        ? {
            moduleName: {
              contains: normalizedQuery,
              mode: "insensitive" as const,
            },
          }
        : {}),
    },
    orderBy: { moduleName: "asc" },
  });

  if (catalogEntries.length === 0) {
    return [];
  }

  // Check which ones are in the user's library
  const moduleNames = catalogEntries.map((c) => c.moduleName);
  const userMods = await prisma.userMod.findMany({
    where: {
      emailId: email,
      moduleName: { in: moduleNames, mode: "insensitive" },
    },
    select: { moduleName: true },
  });

  const userModSet = new Set(
    userMods.map((um) => um.moduleName.toLowerCase())
  );

  return catalogEntries.map((row) => ({
    name: row.moduleName,
    ownerEmail: row.ownerEmail,
    inLibrary: userModSet.has(row.moduleName.toLowerCase()),
  }));
}

export async function shareModule(
  email: string,
  modName: string
): Promise<void> {
  const prisma = getPrismaClient();
  const normalized = normalizeModName(modName);
  const catalog = await getCatalogEntry(normalized);

  if (!catalog) {
    throw new Error("Module not found in catalog");
  }
  if (catalog.ownerEmail !== email) {
    throw new Error("Only the owner can share this module");
  }

  await prisma.modCatalog.updateMany({
    where: {
      moduleName: { equals: normalized, mode: "insensitive" },
    },
    data: { shared: true, deletedAt: null },
  });
}

export async function unshareModule(
  email: string,
  modName: string
): Promise<void> {
  const prisma = getPrismaClient();
  const normalized = normalizeModName(modName);
  const catalog = await getCatalogEntry(normalized);

  if (!catalog) {
    throw new Error("Module not found in catalog");
  }
  if (catalog.ownerEmail !== email) {
    throw new Error("Only the owner can unshare this module");
  }

  await prisma.modCatalog.updateMany({
    where: {
      moduleName: { equals: normalized, mode: "insensitive" },
    },
    data: { shared: false },
  });
}

export async function removeModuleFromLibrary(
  email: string,
  modName: string
): Promise<{ trashed: boolean }> {
  const prisma = getPrismaClient();
  const normalized = normalizeModName(modName);
  const catalog = await getCatalogEntry(normalized);

  if (catalog && catalog.shared) {
    // Shared module: just remove from user's library
    await prisma.userMod.deleteMany({
      where: {
        emailId: email,
        moduleName: { equals: normalized, mode: "insensitive" },
      },
    });

    // Mark as deleted for user (upsert)
    await prisma.userModDeleted.upsert({
      where: {
        emailId_moduleName: { emailId: email, moduleName: normalized },
      },
      update: { deletedAt: new Date() },
      create: {
        emailId: email,
        moduleName: normalized,
        deletedAt: new Date(),
      },
    });

    await deleteDynamicCheckpointsForModule(email, normalized);
    return { trashed: false };
  }

  if (catalog && catalog.ownerEmail !== email) {
    throw new Error("Only the owner can remove this module");
  }

  // Remove from user_mods
  await prisma.userMod.deleteMany({
    where: {
      emailId: email,
      moduleName: { equals: normalized, mode: "insensitive" },
    },
  });

  // Soft-delete in catalog
  if (catalog) {
    await prisma.modCatalog.updateMany({
      where: {
        moduleName: { equals: normalized, mode: "insensitive" },
      },
      data: { deletedAt: new Date() },
    });
  }

  // Mark as deleted for user (upsert)
  await prisma.userModDeleted.upsert({
    where: {
      emailId_moduleName: { emailId: email, moduleName: normalized },
    },
    update: { deletedAt: new Date() },
    create: {
      emailId: email,
      moduleName: normalized,
      deletedAt: new Date(),
    },
  });

  await deleteDynamicCheckpointsForModule(email, normalized);
  return { trashed: true };
}

export async function addSharedModuleToLibrary(
  email: string,
  modName: string
): Promise<void> {
  const normalized = normalizeModName(modName);
  const catalog = await getCatalogEntry(normalized);

  if (!catalog || !catalog.shared || catalog.deletedAt) {
    throw new Error("Shared module not available");
  }

  await ensureUserLibraryEntry(email, normalized);
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
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Delete expired entries
  await prisma.userModDeleted.deleteMany({
    where: {
      deletedAt: { lte: sevenDaysAgo },
    },
  });

  // Fetch remaining deleted mods for this user with catalog info
  const deletedMods = await prisma.userModDeleted.findMany({
    where: { emailId: email },
    orderBy: { deletedAt: "desc" },
  });

  if (deletedMods.length === 0) {
    return [];
  }

  // Look up catalog entries for owner info
  const moduleNames = deletedMods.map((d) => d.moduleName);
  const catalogEntries = await prisma.modCatalog.findMany({
    where: {
      moduleName: { in: moduleNames, mode: "insensitive" },
    },
    select: { moduleName: true, ownerEmail: true },
  });

  const catalogMap = new Map(
    catalogEntries.map((c) => [c.moduleName.toLowerCase(), c.ownerEmail])
  );

  const now = Date.now();

  return deletedMods.map((row) => {
    const deletedAtMs = row.deletedAt ? row.deletedAt.getTime() : NaN;
    const expiresAtMs = Number.isFinite(deletedAtMs)
      ? deletedAtMs + 7 * 24 * 60 * 60 * 1000
      : now;
    const daysLeft = Math.max(
      0,
      Math.ceil((expiresAtMs - now) / (24 * 60 * 60 * 1000))
    );

    return {
      name: row.moduleName,
      ownerEmail:
        catalogMap.get(row.moduleName.toLowerCase()) || email,
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
  const normalized = normalizeModName(modName);

  const deletedRow = await prisma.userModDeleted.findFirst({
    where: {
      emailId: email,
      moduleName: { equals: normalized, mode: "insensitive" },
    },
  });

  if (!deletedRow) {
    throw new Error("Module not found in deleted list");
  }

  const modPath = path.join(modsDir, normalized);
  if (!fs.existsSync(modPath)) {
    throw new Error("Module files no longer exist");
  }

  const catalog = await getCatalogEntry(normalized);
  if (catalog && catalog.ownerEmail === email && catalog.deletedAt) {
    await prisma.modCatalog.updateMany({
      where: {
        moduleName: { equals: normalized, mode: "insensitive" },
      },
      data: { deletedAt: null },
    });
  }

  await prisma.userModDeleted.deleteMany({
    where: {
      emailId: email,
      moduleName: { equals: normalized, mode: "insensitive" },
    },
  });

  await ensureUserLibraryEntry(email, normalized);
}
