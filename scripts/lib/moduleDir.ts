// scripts/lib/moduleDir.ts
//
// Where a module's files live. `data/Mods/` is the shipped location; a module
// still being authored sits in `testmods/`. Every script that stages a module
// resolves through here, so a testmod can be run against without first being
// copied into data/Mods — one copy, one source of truth.

import { existsSync } from "node:fs";
import path from "node:path";

/** Search order: the shipped mods dir first, then the authoring one. */
export const MODS_DIRS = ["data/Mods", "testmods"] as const;

export interface ResolvedModuleDir {
  /** The module's own directory. */
  moduleDir: string;
  /** Its parent — what `loadModule({ modsDir })` scans for scripted-events. */
  modsDir: string;
}

/** A directory is a module if it carries the file every module must have. */
function isModuleDir(dir: string): boolean {
  return existsSync(path.join(dir, "module_setup.json"));
}

export function resolveModuleDir(
  moduleName: string,
  cwd: string = process.cwd()
): ResolvedModuleDir {
  const tried: string[] = [];
  for (const rel of MODS_DIRS) {
    const modsDir = path.resolve(cwd, rel);
    const moduleDir = path.join(modsDir, moduleName);
    if (isModuleDir(moduleDir)) return { moduleDir, modsDir };
    tried.push(moduleDir);
  }
  throw new Error(
    `模组 "${moduleName}" 找不到（需要 module_setup.json）。已尝试：\n  ${tried.join("\n  ")}`
  );
}
