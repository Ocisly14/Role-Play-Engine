import { resolveModuleIdByName } from "../../../src/shared/agents/memory/database/moduleScope.js";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
import { registerModuleForUser } from "./library.js";

type ProgressCallback = (
  stage: string,
  progress: number,
  message: string
) => void;

async function purgeMissingModFromDatabase(
  modName: string,
  emailId?: string
): Promise<void> {
  if (!emailId) return;

  const prisma = getPrismaClient();
  const normalized = modName.trim().toLowerCase();

  await prisma.$transaction(async (tx) => {
    const ownedModules = await tx.module.findMany({
      where: {
        ownerEmailId: emailId,
        moduleNameNormalized: normalized,
      },
      select: { moduleId: true },
    });

    if (ownedModules.length > 0) {
      const moduleIds = ownedModules.map((module) => module.moduleId);
      await tx.userModuleDeleted.deleteMany({
        where: { moduleId: { in: moduleIds } },
      });
      await tx.userModuleLibrary.deleteMany({
        where: { moduleId: { in: moduleIds } },
      });
      await tx.modulePermission.deleteMany({
        where: { moduleId: { in: moduleIds } },
      });
      await tx.module.deleteMany({
        where: { moduleId: { in: moduleIds } },
      });
      await tx.modGeneration.deleteMany({
        where: {
          emailId,
          moduleName: modName,
        },
      });
      return;
    }

    const accessibleModuleRows = await tx.modulePermission.findMany({
      where: {
        emailId,
        module: {
          moduleNameNormalized: normalized,
        },
      },
      select: { moduleId: true },
    });

    if (accessibleModuleRows.length === 0) {
      return;
    }

    const moduleIds = accessibleModuleRows.map((row) => row.moduleId);
    await tx.userModuleDeleted.deleteMany({
      where: {
        emailId,
        moduleId: { in: moduleIds },
      },
    });
    await tx.userModuleLibrary.deleteMany({
      where: {
        emailId,
        moduleId: { in: moduleIds },
      },
    });
    await tx.modulePermission.deleteMany({
      where: {
        emailId,
        moduleId: { in: moduleIds },
      },
    });
  });
}

/**
 * Load mod data — legacy loaders have been removed.
 * Module loading now happens via the simulation system's moduleLoader.
 */
export async function loadMod(
  _db: unknown,
  modName: string,
  emailId?: string,
  onProgress?: ProgressCallback
): Promise<any> {
  if (emailId) {
    await registerModuleForUser(emailId, modName);
  }

  onProgress?.("Complete", 100, "Module registered");

  return {
    success: true,
    message: `Module "${modName}" registered. Use simulation API to load module data.`,
    scenariosLoaded: 0,
    npcsLoaded: 0,
    modulesLoaded: 0,
    timestamp: new Date().toISOString(),
  };
}

async function clearExistingModData(
  emailId?: string,
  modName?: string
): Promise<void> {
  if (!emailId) throw new Error("emailId is required for clearExistingModData");

  const prisma = getPrismaClient();
  const moduleId = modName
    ? await resolveModuleIdByName(modName, emailId)
    : null;
  const noMatchModuleId = "00000000-0000-0000-0000-000000000000";

  // Delete in FK-respecting order within a transaction
  await prisma.$transaction([
    prisma.scenarioCondition.deleteMany({
      where: moduleId ? { moduleId } : { moduleId: noMatchModuleId },
    }),
    prisma.scenario.deleteMany({
      where: moduleId ? { moduleId } : { moduleId: noMatchModuleId },
    }),
    prisma.moduleBackground.deleteMany({
      where: moduleId ? { moduleId } : { moduleId: noMatchModuleId },
    }),
    prisma.npcRelationship.deleteMany({ where: { emailId } }),
    prisma.character.deleteMany({ where: { isNpc: true, emailId } }),
  ]);
}
