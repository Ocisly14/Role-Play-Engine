#!/usr/bin/env tsx
//
// scripts/lint-module-names.ts
//
// ZERO-COST check: does any place file put a character's NAME where everyone
// who walks in will read it? A place's setting, its items and its passages
// are what a stranger perceives; a name there hands them a canonical name
// they never heard said, past the knownAs gate (setting design §5.6). What a
// regular knows about the place belongs in that character's memories.
//
// Scans every SCN_*/ROAD_*/VEH_* file: setting, item ids/names/descriptions/
// placements, connection names/descriptions, vehicle descriptions. Names come
// from the module's own NPC profiles (full name and each part longer than one
// letter), matched case-insensitively on word boundaries.
//
// Usage:
//   pnpm lint:module-names                         # testmods/grayhaven
//   pnpm lint:module-names --module testmods/grayhaven
//
// Exit 1 when anything is found. No model calls.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

type Json = Record<string, unknown>;

const args = process.argv.slice(2);
const moduleDir = args.includes("--module")
  ? args[args.indexOf("--module") + 1]
  : "testmods/grayhaven";

function subdirs(dir: string): string[] {
  return readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((p) => statSync(p).isDirectory());
}

function jsonFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name));
}

const npcDirs = subdirs(moduleDir).filter((d) => /_npc$/.test(d));
const names = new Set<string>();
for (const dir of npcDirs) {
  for (const file of jsonFiles(dir)) {
    const name = (JSON.parse(readFileSync(file, "utf8")) as Json).name;
    if (typeof name !== "string" || !name.trim()) continue;
    names.add(name.trim());
    for (const part of name.trim().split(/[\s·・]+/u)) {
      if (part.length > 1) names.add(part);
    }
  }
}
if (names.size === 0) {
  console.error(`no NPC profiles found under ${moduleDir}/*_npc/`);
  process.exit(2);
}
const patterns = [...names].map((name) => ({
  name,
  re: new RegExp(
    `(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`,
    "iu"
  ),
}));

let hits = 0;
function check(file: string, field: string, text: unknown): void {
  if (typeof text !== "string") return;
  // Ids separate words with "." and "_"; read them as spaces.
  const haystack = field.endsWith(".id") ? text.replace(/[._]/g, " ") : text;
  for (const { name, re } of patterns) {
    if (re.test(haystack)) {
      console.log(`${path.basename(file)}  ${field}  ${name}`);
      hits += 1;
    }
  }
}

const placeDirs = subdirs(moduleDir).filter((d) =>
  readdirSync(d).some((n) => /^(SCN|ROAD|VEH)_.*\.json$/.test(n))
);
for (const dir of placeDirs) {
  for (const file of jsonFiles(dir)) {
    if (!/^(SCN|ROAD|VEH)_/.test(path.basename(file))) continue;
    const data = JSON.parse(readFileSync(file, "utf8")) as Json;
    check(file, "setting", data.setting);
    if (path.basename(file).startsWith("VEH_")) {
      check(file, "description", data.description);
    }
    const refs = (data.references ?? {}) as Json;
    for (const item of (refs.items ?? []) as Json[]) {
      const at = `items[${String(item.id)}]`;
      check(file, `${at}.id`, item.id);
      check(file, `${at}.name`, item.name);
      check(file, `${at}.description`, item.description);
      check(file, `${at}.placement`, item.placement);
    }
    for (const c of (refs.connections ?? []) as Json[]) {
      const at = `connections[${String(c.id)}]`;
      check(file, `${at}.name`, c.name);
      check(file, `${at}.description`, c.description);
    }
  }
}

console.log(`${hits} name(s) found in place files of ${moduleDir}`);
process.exit(hits > 0 ? 1 : 0);
