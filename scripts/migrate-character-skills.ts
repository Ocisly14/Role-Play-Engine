/**
 * Fold pre-consolidation character skill maps onto the 17 broad domains,
 * keeping the HIGHEST value among the specialties that merged into each
 * domain (a Locksmith 70 / Stealth 40 character is a 70 at Stealth &
 * Security). Rewrites both sources of character content:
 *
 *   - module files on disk    data/Mods/<mod>/**\/*.json
 *   - imported module NPCs    module_npcs.data in the database
 *
 * In-flight simulation snapshots (simulation_runtime.game_state) are session
 * state, not content, and are left alone — start a fresh session.
 *
 * Usage:
 *   pnpm tsx scripts/migrate-character-skills.ts            # dry run
 *   pnpm tsx scripts/migrate-character-skills.ts --apply     # write files
 *   pnpm tsx scripts/migrate-character-skills.ts --apply --db  # + database
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  canonicalSkillName,
  consolidateSkills,
} from "../src/engine/rules/skillCatalog.js";

const APPLY = process.argv.includes("--apply");
const INCLUDE_DB = process.argv.includes("--db");
const MODS_DIR = join(process.cwd(), "data", "Mods");

interface Stats {
  skillMapsSeen: number;
  skillMapsChanged: number;
  filesChanged: string[];
  unmapped: Map<string, number>;
  /** legacyName -> canonical domain that absorbed it, for the report. */
  merges: Map<string, Set<string>>;
}

function newStats(): Stats {
  return {
    skillMapsSeen: 0,
    skillMapsChanged: 0,
    filesChanged: [],
    unmapped: new Map(),
    merges: new Map(),
  };
}

function sameMap(
  a: Record<string, number>,
  b: Record<string, number>
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((k) => a[k] === b[k]);
}

/**
 * Rewrite every `skills` object anywhere in the tree. Returns true when
 * something actually changed.
 */
function rewriteSkillMaps(node: unknown, stats: Stats): boolean {
  let changed = false;

  if (Array.isArray(node)) {
    for (const item of node) {
      if (rewriteSkillMaps(item, stats)) changed = true;
    }
    return changed;
  }
  if (node === null || typeof node !== "object") return false;

  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (
      key === "skills" &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const before = value as Record<string, number>;
      // A map already holding only numbers is a skill map; anything else
      // (nested objects, per-skill metadata) is left untouched.
      if (!Object.values(before).every((v) => typeof v === "number")) continue;

      stats.skillMapsSeen += 1;
      const { consolidated, unmapped } = consolidateSkills(before);

      for (const name of unmapped) {
        stats.unmapped.set(name, (stats.unmapped.get(name) ?? 0) + 1);
      }
      const dropped = new Set(unmapped);
      for (const name of Object.keys(before)) {
        if (dropped.has(name)) continue;
        const domain = canonicalSkillName(name);
        if (domain === name) continue; // already canonical, nothing merged
        const set = stats.merges.get(domain) ?? new Set<string>();
        set.add(name);
        stats.merges.set(domain, set);
      }

      if (!sameMap(before, consolidated)) {
        stats.skillMapsChanged += 1;
        obj[key] = consolidated;
        changed = true;
      }
      continue;
    }
    if (rewriteSkillMaps(value, stats)) changed = true;
  }
  return changed;
}

function walkJsonFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkJsonFiles(full, out);
    else if (entry.endsWith(".json")) out.push(full);
  }
}

function migrateFiles(stats: Stats): void {
  const files: string[] = [];
  try {
    walkJsonFiles(MODS_DIR, files);
  } catch {
    console.warn(`[skills] no module directory at ${MODS_DIR}`);
    return;
  }

  for (const file of files) {
    let parsed: unknown;
    const raw = readFileSync(file, "utf-8");
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // not our concern; leave malformed files untouched
    }
    if (!rewriteSkillMaps(parsed, stats)) continue;

    stats.filesChanged.push(file.replace(`${process.cwd()}/`, ""));
    if (APPLY) {
      // Match the repo's existing 2-space JSON with a trailing newline.
      writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
    }
  }
}

async function migrateDatabase(stats: Stats): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.moduleNpc.findMany();
    let changedRows = 0;
    for (const row of rows) {
      const data = row.data as unknown;
      if (!rewriteSkillMaps(data, stats)) continue;
      changedRows += 1;
      if (APPLY) {
        await prisma.moduleNpc.update({
          where: {
            moduleId_npcId: { moduleId: row.moduleId, npcId: row.npcId },
          },
          data: { data: data as never },
        });
      }
    }
    console.log(
      `\ndatabase: ${changedRows}/${rows.length} module_npcs rows ${
        APPLY ? "updated" : "would change"
      }`
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  const stats = newStats();
  migrateFiles(stats);
  if (INCLUDE_DB) await migrateDatabase(stats);

  console.log(
    `\nskill maps: ${stats.skillMapsChanged}/${stats.skillMapsSeen} ${
      APPLY ? "rewritten" : "would change"
    }`
  );
  console.log(
    `files: ${stats.filesChanged.length} ${APPLY ? "written" : "would change"}`
  );

  if (stats.merges.size > 0) {
    console.log("\nmerges applied (highest value wins per domain):");
    for (const [domain, names] of [...stats.merges].sort()) {
      console.log(`  ${domain} <- ${[...names].sort().join(", ")}`);
    }
  }

  if (stats.unmapped.size > 0) {
    console.log("\nUNMAPPED — dropped, add them to LEGACY_SKILL_TO_CANONICAL:");
    for (const [name, count] of [...stats.unmapped].sort(
      (a, b) => b[1] - a[1]
    )) {
      console.log(`  ${count}x  ${name}`);
    }
    process.exitCode = 1;
    return;
  }

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply (and --db) to write.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
