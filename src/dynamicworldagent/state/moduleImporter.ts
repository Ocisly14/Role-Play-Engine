/**
 * Import a module from the filesystem into the database.
 * Reads JSON files and stores them as-is in module_npcs, module_scenes, module_setups.
 * Idempotent — uses upsert on compound PKs.
 */

import fs from "fs";
import path from "path";
import type { PrismaClient } from "@prisma/client";

export async function importModule(params: {
  prisma: PrismaClient;
  moduleDir: string;
  moduleName: string;
  emailId?: string;
}): Promise<string> {
  const { prisma, moduleDir, moduleName, emailId } = params;

  // 1. Upsert Module record
  const normalizedName = moduleName.toLowerCase().replace(/\s+/g, "_");
  const mod = await prisma.module.upsert({
    where: {
      uq_modules_owner_name_normalized: {
        ownerEmailId: emailId ?? "__system__",
        moduleNameNormalized: normalizedName,
      },
    },
    create: {
      moduleName: moduleName,
      moduleNameNormalized: normalizedName,
      ownerEmailId: emailId ?? "__system__",
    },
    update: {
      updatedAt: new Date(),
    },
  });
  const moduleId = mod.moduleId;

  // 2. Import module_setup.json
  const setupPath = path.join(moduleDir, "module_setup.json");
  if (fs.existsSync(setupPath)) {
    const data = JSON.parse(fs.readFileSync(setupPath, "utf8"));
    await prisma.moduleSetup.upsert({
      where: { moduleId },
      create: { moduleId, data },
      update: { data },
    });
  }

  // 3. Import scenarios_outline.json
  const outlinesPath = path.join(moduleDir, "scenarios_outline.json");
  if (fs.existsSync(outlinesPath)) {
    const data = JSON.parse(fs.readFileSync(outlinesPath, "utf8"));
    await prisma.moduleScene.upsert({
      where: {
        moduleId_entryId: { moduleId, entryId: "__scenarios_outline__" },
      },
      create: { moduleId, entryId: "__scenarios_outline__", data },
      update: { data },
    });
  }

  // 4. Import transport_edges.json
  const edgesPath = path.join(moduleDir, "transport_edges.json");
  if (fs.existsSync(edgesPath)) {
    const data = JSON.parse(fs.readFileSync(edgesPath, "utf8"));
    await prisma.moduleScene.upsert({
      where: {
        moduleId_entryId: { moduleId, entryId: "__transport_edges__" },
      },
      create: { moduleId, entryId: "__transport_edges__", data },
      update: { data },
    });
  }

  // 5. Import scene/junction/road files
  const scenarioDirs = fs.readdirSync(moduleDir).filter((d) => {
    const full = path.join(moduleDir, d);
    return fs.statSync(full).isDirectory() && d.endsWith("_Scenarios");
  });
  for (const dir of scenarioDirs) {
    const scenariosDir = path.join(moduleDir, dir);
    const files = fs
      .readdirSync(scenariosDir)
      .filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const data = JSON.parse(
        fs.readFileSync(path.join(scenariosDir, file), "utf8")
      );
      const entryId = data.id ?? path.basename(file, ".json");
      await prisma.moduleScene.upsert({
        where: { moduleId_entryId: { moduleId, entryId } },
        create: { moduleId, entryId, data },
        update: { data },
      });
    }
  }

  // 6. Import NPC files
  const npcDirs = fs.readdirSync(moduleDir).filter((d) => {
    const full = path.join(moduleDir, d);
    return (
      fs.statSync(full).isDirectory() &&
      (d.endsWith("_npc") || d.includes("'s_npc"))
    );
  });
  for (const dir of npcDirs) {
    const npcsDir = path.join(moduleDir, dir);
    const files = fs.readdirSync(npcsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const raw = fs.readFileSync(path.join(npcsDir, file), "utf8");
      const parsed = JSON.parse(raw);
      // NPC files can be a single object or an array
      const npcs = Array.isArray(parsed) ? parsed : [parsed];
      for (const npc of npcs) {
        const npcId = npc.id ?? path.basename(file, ".json");
        await prisma.moduleNpc.upsert({
          where: { moduleId_npcId: { moduleId, npcId } },
          create: { moduleId, npcId, data: npc },
          update: { data: npc },
        });
      }
    }
  }

  console.log(`[ModuleImporter] Imported module "${moduleName}" (${moduleId})`);
  return moduleId;
}

/**
 * Scan a directory for module subdirectories and import all of them.
 * A valid module directory must contain at least one of:
 * module_setup.json, scenarios_outline.json, or a *_Scenarios/ subdirectory.
 */
export async function scanAndImportModules(params: {
  prisma: PrismaClient;
  modsDir: string;
  emailId?: string;
}): Promise<string[]> {
  const { prisma, modsDir, emailId } = params;

  if (!fs.existsSync(modsDir)) {
    console.warn(`[ModuleImporter] Mods directory not found: ${modsDir}`);
    return [];
  }

  const entries = fs.readdirSync(modsDir).filter((d) => {
    const full = path.join(modsDir, d);
    if (!fs.statSync(full).isDirectory()) return false;
    // Must have at least one module marker file/dir
    return (
      fs.existsSync(path.join(full, "module_setup.json")) ||
      fs.existsSync(path.join(full, "scenarios_outline.json")) ||
      fs.readdirSync(full).some((sub) => sub.endsWith("_Scenarios"))
    );
  });

  const importedIds: string[] = [];
  for (const dir of entries) {
    const moduleDir = path.join(modsDir, dir);
    const moduleId = await importModule({
      prisma,
      moduleDir,
      moduleName: dir,
      emailId,
    });
    importedIds.push(moduleId);
  }

  if (importedIds.length > 0) {
    console.log(
      `[ModuleImporter] Scanned ${modsDir}: imported ${importedIds.length} module(s)`
    );
  }

  return importedIds;
}
