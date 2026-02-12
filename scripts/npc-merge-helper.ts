#!/usr/bin/env tsx

/**
 * NPC merge helper
 * - Reads NPCs from PostgreSQL (via Prisma)
 * - Finds name-similar candidates
 * - Emits a merge prompt you can feed to an LLM
 *
 * Usage:
 *   npx tsx scripts/npc-merge-helper.ts
 */

import fs from "fs";
import path from "path";
import { CoCDatabaseAdapter } from "../src/shared/agents/memory/database/CoCDatabaseAdapter.js";
import { NPCLoader } from "../src/shared/agents/character/npcloader/index.js";
import type { NPCProfile } from "../src/shared/agents/models/gameTypes.js";

const outputPath = path.join("data", "npc_merge_prompt.txt");

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ")
    .trim();
}

// Simple Levenshtein distance
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function similar(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const tokensA = na.split(/\s+/);
  const tokensB = nb.split(/\s+/);
  // share first token (e.g., "ben" vs "ben cleo")
  if (tokensA[0] && tokensA[0] === tokensB[0]) return true;

  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  const score = 1 - dist / maxLen;
  return score >= 0.6; // loose threshold
}

function clusterSimilar(npcs: NPCProfile[]): NPCProfile[][] {
  const visited = new Set<string>();
  const clusters: NPCProfile[][] = [];

  for (const npc of npcs) {
    if (visited.has(npc.id)) continue;
    const group: NPCProfile[] = [npc];
    visited.add(npc.id);

    for (const other of npcs) {
      if (visited.has(other.id)) continue;
      if (similar(npc.name, other.name)) {
        group.push(other);
        visited.add(other.id);
      }
    }

    if (group.length > 1) {
      clusters.push(group);
    }
  }

  return clusters;
}

function summarizeNpc(npc: NPCProfile): string {
  const parts: string[] = [];
  parts.push(`id=${npc.id}`);
  parts.push(`name="${npc.name}"`);
  if (npc.occupation) parts.push(`occ=${npc.occupation}`);
  if (npc.age) parts.push(`age=${npc.age}`);
  parts.push(`clues=${npc.clues.length}`);
  parts.push(`rels=${npc.relationships.length}`);
  parts.push(`goals=${npc.goals?.length || 0}`);
  parts.push(`secrets=${npc.secrets?.length || 0}`);
  parts.push(`inventory=${npc.inventory.length}`);
  return parts.join(" | ");
}

function buildPrompt(clusters: NPCProfile[][]): string {
  const header = `You are deduplicating NPC entries that may refer to the same person. The data was parsed in chunks, so names may vary slightly.
- If entries clearly refer to the same NPC, merge them.
- If uncertain, keep them separate.
- Do NOT invent new data; leave missing fields empty.
- Return a JSON ARRAY of merged NPCs with these keys:
  {
    "canonicalName": "...",
    "mergedFrom": ["npc-id-1", "npc-id-2"],
    "occupation": "...",
    "age": number | null,
    "appearance": "...",
    "personality": "...",
    "background": "...",
    "goals": [...],
    "secrets": [...],
    "attributes": {...},
    "status": {...},
    "skills": {...},
    "inventory": [...],
    "clues": [...],
    "relationships": [...]
  }
- Keep clues/relationships/inventory/goals/secrets as the union of all merged entries (deduplicate exact duplicates).
`;

  const lines = [header, "Candidate groups:\n"];
  clusters.forEach((group, idx) => {
    lines.push(`Group ${idx + 1}:`);
    group.forEach((npc) => lines.push(`- ${summarizeNpc(npc)}`));
    lines.push("");
  });

  return lines.join("\n");
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const db = new CoCDatabaseAdapter();
  const loader = new NPCLoader(db);
  const npcs = await loader.getAllNPCs();

  if (npcs.length === 0) {
    console.log("No NPCs found in database.");
    db.close();
    return;
  }

  const clusters = clusterSimilar(npcs);
  if (clusters.length === 0) {
    console.log("No similar-name NPC groups found.");
    db.close();
    return;
  }

  const prompt = buildPrompt(clusters);
  fs.writeFileSync(outputPath, prompt, "utf8");
  console.log(
    `Found ${clusters.length} candidate group(s). Prompt written to ${outputPath}`
  );
  db.close();
}

main();
