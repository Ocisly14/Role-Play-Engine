/**
 * Test script: generate 3 incremental map updates for The Sapphire Silence of Otemanu.
 * Each transition uses the previously generated map as the image reference.
 *
 * Run: npx tsx test-map-update.ts
 */

import "dotenv/config";
import path from "path";
import fs from "fs/promises";
import { generateMapOnSceneSwitch } from "./src/dynamicworldagent/visual/mapImage.js";
import type { ScenarioConnectionType } from "./src/dynamicworldagent/world_builder/types.js";

const MODULE_NAME = "Signals Beneath the Neon Spire";
const MOD_ROOT = path.join(process.cwd(), "data", "Mods", MODULE_NAME);

// Fixed starting image
const INITIAL_MAP = "Map/Signals_Beneath_the_Neon_Spire.png";

// 3 transitions: SCN_1→SCN_2, SCN_2→SCN_3, SCN_3→SCN_4
const TRANSITIONS = [
  [0, 1],
  [1, 2],
  [2, 3],
];

async function main() {
  const outlinePath = path.join(MOD_ROOT, "scenarios_outline.json");
  const raw = await fs.readFile(outlinePath, "utf-8");
  const { scenarios } = JSON.parse(raw) as {
    scenarios: Array<{
      id: string;
      name: string;
      description: string;
      connections: Array<{
        scenarioName: string;
        relationshipType: ScenarioConnectionType;
        description: string;
      }>;
    }>;
  };

  if (scenarios.length < 4) {
    throw new Error("Need at least 4 scenarios for 3 transitions.");
  }

  console.log(`\n🗺️  Map Update Test — 3 Transitions`);
  console.log(`   Module : ${MODULE_NAME}`);
  console.log(`   Start  : ${INITIAL_MAP}\n`);

  let previousMapPath: string | undefined = INITIAL_MAP;

  for (let i = 0; i < TRANSITIONS.length; i++) {
    const [fromIdx, toIdx] = TRANSITIONS[i];
    const currentScene = scenarios[fromIdx];
    const targetScene = scenarios[toIdx];

    console.log(`── Transition ${i + 1}/3 ─────────────────────────`);
    console.log(`   From : ${currentScene.name}`);
    console.log(`   To   : ${targetScene.name}`);

    const result = await generateMapOnSceneSwitch(
      MODULE_NAME,
      {
        name: currentScene.name,
        description: currentScene.description,
        connections: currentScene.connections,
      },
      {
        name: targetScene.name,
        description: targetScene.description,
        connections: targetScene.connections,
      },
      previousMapPath
    );

    if (result) {
      console.log(`   ✅ Map ${i + 1} saved: ${result.path}\n`);
      previousMapPath = result.path;
    } else {
      console.log(`   ❌ Map ${i + 1} failed.\n`);
      break;
    }
  }

  console.log(`🏁 Done.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
