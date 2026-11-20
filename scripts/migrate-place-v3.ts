#!/usr/bin/env tsx
//
// scripts/migrate-place-v3.ts
//
// One-off MECHANICAL upgrade of schema-v2 place files to v3. It changes no
// meaning: every item the old prose cited stays cited — it becomes a fixture —
// so what anyone sees is unchanged. Three edits per SCN_*/ROAD_* file:
//
//   · schemaVersion 2 → 3
//   · description → setting (same key position)
//   · the [cond.*] citation tokens are cut out of the prose — conditions are
//     state in v3 and are never cited
//
// An item the old prose did NOT cite (v2's "not yet noticed") needs a
// placement and a container under v3; it is printed as `UNCITED <file> <id>`
// for a hand edit. VEH_* files are left alone (a vehicle's description is its
// exterior, like an item's). The content rewrite — pulling loose things out
// of the prose, dropping the hour and the crowd and the townsfolk's
// knowledge — is separate, careful work this script does not attempt.
//
// Usage:
//   pnpm tsx scripts/migrate-place-v3.ts <scenarios-dir> [<scenarios-dir> …]

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const CITATION_RE = /\[([^\]\n]{1,64})\]/g;

type Json = Record<string, unknown>;

function migrate(file: string): { changed: boolean; uncited: string[] } {
  const data = JSON.parse(readFileSync(file, "utf8")) as Json;
  if (data.schemaVersion !== 2) return { changed: false, uncited: [] };
  const refs = (data.references ?? {}) as Json;
  const conditionIds = new Set(
    ((refs.conditions ?? []) as Json[])
      .map((c) => c.id)
      .filter((id): id is string => typeof id === "string")
  );
  const prose = String(data.description ?? "");
  const setting = prose
    .replace(CITATION_RE, (whole, id: string) =>
      conditionIds.has(id) ? "" : whole
    )
    .replace(/[ \t]{2,}/g, " ");
  const cited = new Set([...setting.matchAll(CITATION_RE)].map((m) => m[1]));
  const uncited = ((refs.items ?? []) as Json[])
    .map((i) => String(i.id))
    .filter((id) => !cited.has(id));

  const out: Json = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "schemaVersion") out.schemaVersion = 3;
    else if (key === "description") out.setting = setting;
    else out[key] = value;
  }
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  return { changed: true, uncited };
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: migrate-place-v3.ts <scenarios-dir> [...]");
  process.exit(2);
}
for (const dir of dirs) {
  let changed = 0;
  for (const name of readdirSync(dir).sort()) {
    if (!/^(SCN|ROAD)_.*\.json$/.test(name)) continue;
    const result = migrate(path.join(dir, name));
    if (result.changed) changed += 1;
    for (const id of result.uncited) console.log(`UNCITED ${name} ${id}`);
  }
  console.log(`${dir}: ${changed} file(s) upgraded to v3`);
}
