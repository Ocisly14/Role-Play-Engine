#!/usr/bin/env tsx

/**
 * Test getPlayerSceneSwitchTemplate by:
 * 1. Loading a module (Voyage into the Black)
 * 2. Creating a DynamicGameState with initial scene
 * 3. Injecting action logs into NPCs in the initial scene
 * 4. Composing the template and calling the LLM
 * 5. Saving the LLM output (updatedSnapshots + globalTrigger) as JSON
 *
 * Output format matches directorTemplate.ts (438-538): updatedSnapshots array + optional globalTrigger.
 *
 * Usage (from project root):
 *   pnpm test:scene-switch
 *   pnpm exec tsx scripts/test-scene-switch-template.ts
 *
 * Requires: .env with MODEL_PROVIDER and API keys (e.g. GOOGLE_API_KEY).
 */

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { getPlayerSceneSwitchTemplate } from "../src/dynamicworldagent/dynamicBasicAgent/director/directorTemplate.js";
import { composeTemplate } from "../src/template.js";
import { generateText, ModelClass, ModelProviderName } from "../src/models/index.js";
import type {
  MacroSceneStructure,
  TruthEvent,
  KnowledgeHolder,
  RedHerring,
  ScenarioOutline,
  DynamicScenarioSnapshot,
  DynamicNPCProfile,
  DynamicCharacterProfile,
} from "../src/dynamicworldagent/world_builder/types.js";
import type { DynamicGameState } from "../src/dynamicworldagent/state/DynamicGameState.js";

const MODULE_NAME = "Voyage into the Black";
const MODULE_DIR = path.join(process.cwd(), "data", "Mods", MODULE_NAME);
const OUTPUT_FILE = path.join(process.cwd(), "scripts", "test-scene-switch-output.json");
const TEST_OUTPUT_DIR = path.join(process.cwd(), "scripts", "test");

// Load module data from files
async function loadModuleData() {
  console.log("📂 Loading module data from:", MODULE_DIR);
  
  const [macroRaw, truthRaw, knowledgeRaw, scenariosRaw] = await Promise.all([
    fs.readFile(path.join(MODULE_DIR, "macro_scene.json"), "utf-8"),
    fs.readFile(path.join(MODULE_DIR, "truth_timeline.json"), "utf-8"),
    fs.readFile(path.join(MODULE_DIR, "knowledge_matrix.json"), "utf-8"),
    fs.readFile(path.join(MODULE_DIR, "scenarios_outline.json"), "utf-8"),
  ]);

  const macroParsed = JSON.parse(macroRaw);
  const truthParsed = JSON.parse(truthRaw);
  const knowledgeParsed = JSON.parse(knowledgeRaw);
  const scenariosParsed = JSON.parse(scenariosRaw);

  const macroScene = macroParsed.macroScene ?? macroParsed;
  const truthTimeline = truthParsed.truthTimeline ?? truthParsed;
  const knowledgeMatrix = knowledgeParsed.knowledgeMatrix ?? knowledgeParsed;
  const redHerrings = knowledgeParsed.redHerrings ?? [];
  const scenarios = scenariosParsed.scenarios ?? scenariosParsed;

  return { macroScene, truthTimeline, knowledgeMatrix, redHerrings, scenarios };
}

// Load NPC data from files
async function loadNPCData() {
  console.log("👥 Loading NPC data...");
  const npcDir = path.join(MODULE_DIR, `${MODULE_NAME}_npc`);
  const files = await fs.readdir(npcDir);
  const npcFiles = files.filter(f => f.endsWith(".json"));
  
  const npcs: DynamicNPCProfile[] = [];
  for (const file of npcFiles) {
    const content = await fs.readFile(path.join(npcDir, file), "utf-8");
    const npc = JSON.parse(content);
    // Add actionLog if not present
    if (!npc.actionLog) {
      npc.actionLog = [];
    }
    npcs.push(npc);
  }
  
  console.log(`   Loaded ${npcs.length} NPCs`);
  return npcs;
}

// Load scenario snapshots from files
async function loadScenarioSnapshots() {
  console.log("🎬 Loading scenario snapshots...");
  const scenarioDir = path.join(MODULE_DIR, `${MODULE_NAME}_Scenarios`);
  const files = await fs.readdir(scenarioDir);
  const scenarioFiles = files.filter(f => f.endsWith(".json"));
  
  const snapshots: DynamicScenarioSnapshot[] = [];
  for (const file of scenarioFiles) {
    const content = await fs.readFile(path.join(scenarioDir, file), "utf-8");
    const scenarioData = JSON.parse(content);
    
    // Extract the snapshot from the scenario file
    if (Array.isArray(scenarioData)) {
      for (const item of scenarioData) {
        if (item.snapshot) {
          snapshots.push(item.snapshot);
        }
      }
    } else if (scenarioData.snapshot) {
      snapshots.push(scenarioData.snapshot);
    }
  }
  
  console.log(`   Loaded ${snapshots.length} scenario snapshots`);
  return snapshots;
}

// Inject action logs into NPCs in the initial scene
function injectActionLogs(npcs: DynamicNPCProfile[], initialScene: DynamicScenarioSnapshot) {
  console.log("\n💉 Injecting action logs into NPCs in scene:", initialScene.name);
  
  // Find NPCs in the initial scene
  const npcIdsInScene = initialScene.characters
    .filter(c => c.role === "other")
    .map(c => c.id);
  
  console.log(`   Found ${npcIdsInScene.length} NPCs in scene: ${npcIdsInScene.join(", ")}`);
  
  // Sample action logs to inject (ActionLogEntry: time, location, summary)
  const sampleActions = [
    {
      time: "Day 3, 01:45",
      location: initialScene.location,
      summary: "Checked the emergency lighting system in the corridor. Found that backup batteries are depleting faster than expected.",
    },
    {
      time: "Day 3, 01:55",
      location: initialScene.location,
      summary: "Heard strange sounds from the lower decks. Metallic scraping and what sounded like water dripping.",
    },
    {
      time: "Day 3, 02:00",
      location: initialScene.location,
      summary: "Noticed temperature drop in the area. Despite the tropical climate, breath is now visible.",
    },
  ];

  // Inject logs into NPCs in the scene
  for (const npcId of npcIdsInScene) {
    const npc = npcs.find(n => n.id === npcId);
    if (npc) {
      console.log(`   ✓ Injecting ${sampleActions.length} actions into ${npc.name} (${npc.id})`);
      npc.actionLog = [...sampleActions];
    }
  }
  
  return npcs;
}

// Create mock game state
function createMockGameState(
  moduleName: string,
  macroScene: MacroSceneStructure,
  truthTimeline: TruthEvent[],
  knowledgeMatrix: KnowledgeHolder[],
  redHerrings: RedHerring[],
  scenarios: ScenarioOutline[],
  npcs: DynamicNPCProfile[],
  snapshots: DynamicScenarioSnapshot[],
  playerCharacter: DynamicCharacterProfile
): DynamicGameState {
  console.log("\n🎮 Creating mock game state...");
  
  // Use the first scenario as initial scene
  const initialSnapshot = snapshots[0];
  if (!initialSnapshot) {
    throw new Error("No scenario snapshots available");
  }
  
  console.log(`   Initial scene: ${initialSnapshot.name}`);
  
  // Create map of scenario snapshots
  const snapshotMap = new Map<string, DynamicScenarioSnapshot[]>();
  for (const snapshot of snapshots) {
    snapshotMap.set(snapshot.id, [snapshot]);
  }
  
  const state: DynamicGameState = {
    sessionId: "test-session-" + Date.now(),
    currentScenario: initialSnapshot,
    gameDay: 3,
    timeOfDay: "02:00",
    scenarioTimeState: {
      sceneStartTime: "02:00",
      playerTimeConsumption: {},
    },
    tension: 5,
    keeperGuidance: "Test scenario for scene switch template",
    moduleLimitations: "None for testing",
    playerCharacter,
    npcCharacters: npcs,
    discoveredClues: [],
    turnsInCurrentScene: 2,
    lastPlayerInputTime: new Date(),
    consecutiveProgressionTriggers: 0,
    temporaryInfo: {
      rules: [],
      contextualData: {},
      actionResults: [],
      currentActionAnalysis: null,
      npcResponseAnalyses: [],
      sceneChangeRequest: null,
      previousScenario: null,
    },
    moduleName,
    moduleDigest: {
      moduleNotes: "Test module notes",
      keeperGuidance: "Test scenario for scene switch template",
      moduleLimitations: "None for testing",
      introduction: "Test introduction",
      macroMapPath: undefined,
      globalTrigger: undefined,
    },
    macroScene,
    truthTimeline,
    knowledgeMatrix,
    redHerrings,
    mythosEvents: [],
    endState: null,
    scenarioOutlines: scenarios,
    revealedTruthEvents: new Set(),
    activatedKnowledgeHolders: new Set(),
    deployedRedHerrings: new Set(),
    mythosRevelations: new Set(),
    pointOfNoReturnReached: false,
    pointOfNoReturnTrigger: null,
    updatedDynamicScenarioSnapshots: snapshotMap,
    globalTrigger: null,
    loadedAt: new Date(),
    lastUpdated: new Date(),
  };
  
  return state;
}

// Generate template context for scene switch
function generateTemplateContext(
  state: DynamicGameState,
  targetScenarioName: string
) {
  console.log("\n🔧 Generating template context for target scene:", targetScenarioName);
  
  const currentScenario = state.currentScenario;
  if (!currentScenario) {
    throw new Error("No current scenario in state");
  }
  
  // Get all snapshots from the map
  const allSnapshots: DynamicScenarioSnapshot[] = [];
  for (const snapshots of state.updatedDynamicScenarioSnapshots.values()) {
    if (snapshots.length > 0) {
      allSnapshots.push(snapshots[snapshots.length - 1]); // Get latest snapshot for each scenario
    }
  }
  
  // Find target scenario
  const targetScenario = allSnapshots.find(s => s.name === targetScenarioName);
  if (!targetScenario) {
    throw new Error(`Target scenario not found: ${targetScenarioName}`);
  }
  
  // Find scenario outline for player's current scene
  const playerScenarioOutline = state.scenarioOutlines.find(
    s => s.name === currentScenario.name
  );
  
  // Prepare scenarios to update (all scenarios)
  const scenariosToUpdate = allSnapshots.map((snapshot) => {
    const outline = state.scenarioOutlines.find(o => o.name === snapshot.name);
    
    // Find NPCs in this scenario
    const npcIdsInScenario = snapshot.characters
      .filter(c => c.role === "other")
      .map(c => c.id);
    
    const npcsInScenario = state.npcCharacters
      .filter(npc => npcIdsInScenario.includes(npc.id))
      .map(npc => ({
        ...npc,
        // Include action log for context
        actionLog: npc.actionLog || [],
      }));
    
    return {
      scenarioId: snapshot.id,
      scenarioName: snapshot.name,
      currentSnapshot: snapshot,
      outline: outline || null,
      npcs: npcsInScenario,
      connections: outline?.connections || [],
    };
  });
  
  const templateContext = {
    currentScenarioName: currentScenario.name,
    playerCurrentScene: {
      name: currentScenario.name,
      location: currentScenario.location,
      description: currentScenario.description || null,
      sourcePlaceId: playerScenarioOutline?.sourcePlaceId || null,
      sourcePlaceName: playerScenarioOutline?.sourcePlaceName || null,
      connections: playerScenarioOutline?.connections || [],
    },
    targetScene: {
      id: targetScenario.id,
      name: targetScenario.name,
    },
    scenariosToUpdateJson: JSON.stringify(scenariosToUpdate, null, 2),
    currentGameDay: state.gameDay,
    currentTimeOfDay: state.timeOfDay,
    truthTimelineJson: JSON.stringify(state.truthTimeline, null, 2),
    knowledgeMatrixJson: JSON.stringify(state.knowledgeMatrix, null, 2),
    previousGlobalTrigger: state.globalTrigger,
    previousGlobalTriggerJson: state.globalTrigger ? JSON.stringify(state.globalTrigger, null, 2) : null,
    endStateJson: state.endState ? JSON.stringify(state.endState, null, 2) : "null",
  };
  
  console.log(`   Scenarios to update: ${scenariosToUpdate.length}`);
  console.log(`   Target scene ID: ${targetScenario.id}`);
  
  return templateContext;
}

async function main() {
  console.log("\n🧪 Testing getPlayerSceneSwitchTemplate\n");
  console.log("=" .repeat(60));
  
  // Load module data
  const { macroScene, truthTimeline, knowledgeMatrix, redHerrings, scenarios } = await loadModuleData();
  console.log(`✓ Truth events: ${truthTimeline.length}`);
  console.log(`✓ Knowledge holders: ${knowledgeMatrix.length}`);
  console.log(`✓ Scenarios: ${scenarios.length}`);
  
  // Load NPCs
  const npcs = await loadNPCData();
  
  // Load scenario snapshots
  const snapshots = await loadScenarioSnapshots();
  
  // Create mock player character
  const playerCharacter: DynamicCharacterProfile = {
    id: "player-test",
    name: "Test Character",
    occupation: "Detective",
    age: 35,
    gender: "male",
    appearance: "A weathered investigator",
    personality: "Methodical and cautious",
    backstory: "Former police detective",
    attributes: {
      STR: 60,
      CON: 65,
      DEX: 55,
      APP: 50,
      POW: 70,
      SIZ: 60,
      INT: 75,
      EDU: 70,
    },
    status: {
      hp: 13,
      maxHp: 13,
      sanity: 70,
      maxSanity: 99,
      luck: 65,
      mp: 14,
      conditions: [],
      damageBonus: "+1d4",
      build: 1,
      mov: 8,
    },
    skills: {
      "Perception": 65,
      "Listen": 60,
      "Psychology": 55,
      "Persuade": 50,
      "First Aid": 45,
    },
    inventory: [
      {
        name: "Flashlight",
        quantity: 1,
        properties: { description: "Battery-powered flashlight", batteries: "50% charged" },
      },
      {
        name: "Notebook",
        quantity: 1,
        properties: { description: "Leather-bound notebook with notes" },
      },
    ],
    notes: "Passenger on the Aurora Queen, awoke during the blackout",
    actionLog: [
      {
        time: "Day 3, 01:30",
        location: "First Class Cabin",
        summary: "Woke up to complete darkness in cabin. Power completely out, emergency lights flickering.",
      },
      {
        time: "Day 3, 01:45",
        location: "Grand Atrium",
        summary: "Made way to Grand Atrium. Found hundreds of passengers in panic.",
      },
    ],
  };
  
  // Create game state
  const state = createMockGameState(
    MODULE_NAME,
    macroScene,
    truthTimeline,
    knowledgeMatrix,
    redHerrings,
    scenarios,
    npcs,
    snapshots,
    playerCharacter
  );
  
  // Inject action logs into NPCs in initial scene
  injectActionLogs(state.npcCharacters, state.currentScenario!);
  
  // Get all snapshots for target selection
  const allSnapshots: DynamicScenarioSnapshot[] = [];
  for (const snapshots of state.updatedDynamicScenarioSnapshots.values()) {
    if (snapshots.length > 0) {
      allSnapshots.push(snapshots[snapshots.length - 1]);
    }
  }
  
  // Choose a target scene different from current
  const targetSceneName = allSnapshots[1]?.name || "The Bridge";
  console.log(`\n🎯 Testing scene switch from "${state.currentScenario!.name}" to "${targetSceneName}"`);
  
  // Generate template context
  const templateContext = generateTemplateContext(state, targetSceneName);
  
  // Get template
  const template = getPlayerSceneSwitchTemplate();
  console.log("\n📝 Composing template...");
  
  // Compose template with context
  const composedPrompt = composeTemplate(
    template,
    { dynamicGameState: state },
    templateContext,
    "handlebars"
  );
  
  console.log(`✓ Template composed (${composedPrompt.length} characters)`);

  // Call LLM to generate updatedSnapshots + globalTrigger (same as directorAgent)
  const runtime = {
    modelProvider: (process.env.MODEL_PROVIDER as ModelProviderName) || ModelProviderName.GOOGLE,
    getSetting: (key: string) => process.env[key],
  };
  console.log("\n🤖 Calling LLM to generate updatedSnapshots (1 target + simplified background)...");
  const response = await generateText({
    runtime,
    context: composedPrompt,
    modelClass: ModelClass.LARGE,
  });

  // Parse LLM response to get { updatedSnapshots, globalTrigger? } (directorTemplate 438-538)
  type ParsedResponse = {
    updatedSnapshots?: Array<{
      scenarioId: string;
      isTargetScene?: boolean;
      snapshot: Record<string, unknown>;
      connections?: Array<{
        scenarioName: string;
        relationshipType: string;
        description?: string;
        blocked?: boolean;
        blockReason?: string | null;
      }>;
    }>;
    globalTrigger?: {
      timeRestriction?: string;
      timeReason?: string;
      events?: string[];
      eventReasons?: string[];
      keeperNotes?: string;
    };
  };
  let parsed: ParsedResponse;
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]) as ParsedResponse;
    } else {
      parsed = JSON.parse(response) as ParsedResponse;
    }
  } catch (err) {
    console.error("❌ Failed to parse LLM response as JSON:", err);
    console.error("Raw response (first 500 chars):", response.slice(0, 500));
    throw err;
  }

  if (!parsed.updatedSnapshots || parsed.updatedSnapshots.length === 0) {
    console.error("❌ LLM response missing updatedSnapshots array");
    console.error("Parsed:", JSON.stringify(parsed, null, 2).slice(0, 800));
    throw new Error("LLM response missing updatedSnapshots");
  }

  // Output format: same as directorTemplate 438-538 (updatedSnapshots + globalTrigger)
  const output = {
    updatedSnapshots: parsed.updatedSnapshots,
    ...(parsed.globalTrigger ? { globalTrigger: parsed.globalTrigger } : {}),
    _metadata: {
      timestamp: new Date().toISOString(),
      moduleName: MODULE_NAME,
      currentScene: state.currentScenario!.name,
      targetScene: targetSceneName,
      gameTime: `Day ${state.gameDay}, ${state.timeOfDay}`,
    },
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");
  console.log("\n💾 Saved result to:", OUTPUT_FILE);

  // Save each snapshot as a separate JSON file in scripts/test/
  await fs.mkdir(TEST_OUTPUT_DIR, { recursive: true });
  for (const item of parsed.updatedSnapshots) {
    const safeName = (item.scenarioId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
    const fileName = `${safeName}.json`;
    const filePath = path.join(TEST_OUTPUT_DIR, fileName);
    await fs.writeFile(filePath, JSON.stringify(item, null, 2), "utf-8");
    console.log(`   • ${fileName} (${item.isTargetScene ? "target" : "background"})`);
  }
  console.log(`   → ${TEST_OUTPUT_DIR}`);

  console.log("\n✅ Test complete!");
  console.log("=" .repeat(60));
  console.log("\nOutput (directorTemplate 438-538 format):");
  console.log(`  • updatedSnapshots: ${output.updatedSnapshots.length} items → each in scripts/test/*.json`);
  if (output.globalTrigger) {
    console.log(`  • globalTrigger: present`);
  }
  console.log(`  • _metadata: currentScene=${output._metadata.currentScene}, targetScene=${output._metadata.targetScene}`);
  console.log(`  • Full result: ${OUTPUT_FILE}`);

  console.log("\n📊 NPCs with injected action logs:");
  for (const npc of state.npcCharacters.filter(n => n.actionLog && n.actionLog.length > 0)) {
    console.log(`  • ${npc.name} (${npc.id}): ${(npc.actionLog ?? []).length} actions`);
  }
}

main().catch((err) => {
  console.error("\n❌ Error:", err);
  process.exit(1);
});
