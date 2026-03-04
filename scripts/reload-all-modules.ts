/**
 * Reload all modules from data/Mods/ to regenerate NPC IDs without random UUID suffixes.
 *
 * Usage: npx tsx scripts/reload-all-modules.ts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadMod } from "../client/server/mod/service.js";
import { getPrismaClient } from "../src/shared/agents/memory/database/prismaClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const EMAIL_ID = "victor530914@gmail.com";

async function main() {
  const modsDir = path.join(rootDir, "data", "Mods");

  if (!fs.existsSync(modsDir)) {
    console.error(`Mods directory not found: ${modsDir}`);
    process.exit(1);
  }

  const modNames = fs
    .readdirSync(modsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  console.log(`Found ${modNames.length} modules to reload:\n`);
  for (const name of modNames) {
    console.log(`  - ${name}`);
  }
  console.log();

  let success = 0;
  let failed = 0;

  for (const modName of modNames) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Reloading: ${modName}`);
    console.log("=".repeat(60));

    try {
      const result = await loadMod(null as any, modName, EMAIL_ID, (stage, progress, message) => {
        console.log(`  [${progress}%] ${stage}: ${message}`);
      });
      console.log(`  ✅ ${result.message}`);
      success++;
    } catch (err: any) {
      console.error(`  ❌ Failed: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Done! ${success} succeeded, ${failed} failed out of ${modNames.length} modules.`);

  const prisma = getPrismaClient();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
