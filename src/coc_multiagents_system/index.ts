import "dotenv/config";
import fs from "fs";
import path from "path";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import {
  CoCDatabase,
  seedDatabase,
} from "./agents/memory/database/index.js";
import { NPCLoader } from "./agents/character/npcloader/index.js";
import { ModuleLoader } from "./agents/memory/moduleloader/index.js";
import { ScenarioLoader } from "./agents/memory/scenarioloader/index.js";
import { buildGraph } from "./graph/index.js";
import type { GraphState } from "./graph/index.js";
import { initialGameState } from "./state/index.js";
import { createBgeSqliteRagManager } from "./agents/memory/RagManager.js";

// Initialize database
const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new CoCDatabase();
seedDatabase(db);

// Initialize NPC directory
const npcDir = path.join(process.cwd(), "data", "npcs");
if (!fs.existsSync(npcDir)) {
  fs.mkdirSync(npcDir, { recursive: true });
  console.log(`Created NPC directory: ${npcDir}`);
  console.log(
    `Place your NPC .docx or .pdf files in this directory to load them automatically.\n`
  );
}

// Load NPCs from JSON files in Mods directory (skip document parsing)
const npcLoader = new NPCLoader(db);
const cassandraNPCsDir = path.join(process.cwd(), "data", "Mods", "Cassandra's Black Carnival", "Cassandra's_npc");
if (fs.existsSync(cassandraNPCsDir)) {
  await npcLoader.loadNPCsFromJSONDirectory(cassandraNPCsDir);
} else {
  // Fallback to document parsing if JSON directory doesn't exist
  await npcLoader.loadNPCsFromDirectory(npcDir);
}

// Initialize module loader
const moduleLoader = new ModuleLoader(db);

// Try to load module from module_digest.json first
const moduleDigestPath = path.join(process.cwd(), "data", "Mods", "Cassandra's Black Carnival", "module_digest.json");
let modules: any[] = [];

console.log(`\n=== Module Loading ===`);
console.log(`Current working directory: ${process.cwd()}`);
console.log(`Looking for module_digest.json at: ${moduleDigestPath}`);
console.log(`File exists: ${fs.existsSync(moduleDigestPath)}`);

if (fs.existsSync(moduleDigestPath)) {
  console.log(`✓ Found module_digest.json, loading module directly...`);
  modules = await moduleLoader.loadModuleFromJSON(moduleDigestPath);
} else {
  // Fallback to loading from directory
  const moduleDir = path.join(process.cwd(), "data", "Mods", "Cassandra's Black Carnival", "background");
  if (!fs.existsSync(moduleDir)) {
    // Fallback to old location
    const fallbackModuleDir = path.join(process.cwd(), "data", "background");
    if (!fs.existsSync(fallbackModuleDir)) {
      fs.mkdirSync(fallbackModuleDir, { recursive: true });
      console.log(`Created module background directory: ${fallbackModuleDir}`);
      console.log(
        `Place your module .docx or .pdf files in this directory to load background/outlines automatically.\n`
      );
    }
  }

  console.log(`module_digest.json not found, falling back to document parsing...`);
  modules = await moduleLoader.loadModulesFromDirectory(moduleDir);
}

// Prepare initial game state (will be used in main function)
let preparedGameState = { ...initialGameState };

// Load keeper guidance into game state if available
if (modules.length > 0 && modules[0].keeperGuidance) {
  preparedGameState.keeperGuidance = modules[0].keeperGuidance;
  console.log(`✓ Loaded keeper guidance from module: ${modules[0].title}`);
}

// Initialize scenario directory
const scenarioDir = path.join(process.cwd(), "data", "scenarios");
if (!fs.existsSync(scenarioDir)) {
  fs.mkdirSync(scenarioDir, { recursive: true });
  console.log(`Created scenario directory: ${scenarioDir}`);
  console.log(
    `Place your scenario .docx or .pdf files in this directory to load them automatically.\n`
  );
}

// Load scenarios from JSON files in Mods directory (skip document parsing)
const scenarioLoader = new ScenarioLoader(db);
const cassandraScenariosDir = path.join(process.cwd(), "data", "Mods", "Cassandra's Black Carnival", "Cassandra's_Scenarios");
if (fs.existsSync(cassandraScenariosDir)) {
  await scenarioLoader.loadScenariosFromJSONDirectory(cassandraScenariosDir);
} else {
  // Fallback to document parsing if JSON directory doesn't exist
  await scenarioLoader.loadScenariosFromDirectory(scenarioDir);
}

// Initialize RAG Manager (SQLite-backed, BGE embeddings with hash fallback)
const ragManager = createBgeSqliteRagManager(db);

// TODO: 暂时跳过RAG环节
const SKIP_RAG = true; // 设置为 false 以启用 RAG

// Build RAG knowledge base from loaded data
if (!SKIP_RAG) {
  const scenarioProfiles = scenarioLoader.getAllScenarios();
  const npcProfiles = npcLoader.getAllNPCs();
  await ragManager.buildKnowledgeBase(
    {
      scenarios: scenarioProfiles.map((s) => s.snapshot),
      npcs: npcProfiles,
      clues: [],
      rules: [],
      playerInventory: preparedGameState.playerCharacter.inventory,
      playerId: preparedGameState.playerCharacter.id,
      playerName: preparedGameState.playerCharacter.name,
    },
    {
      moduleName: modules[0]?.title || "default-module",
      mode: "keeper",
      enableNodeEmbeddings: true,
      enableKnnEdges: true,
    }
  );
} else {
  console.log("RAG知识库构建已跳过 (SKIP_RAG = true)");
}

const parseArgs = (argv: string[]): string => {
  const promptFlagIndex = argv.findIndex((arg) => arg === "--prompt");
  if (promptFlagIndex !== -1 && argv[promptFlagIndex + 1]) {
    return argv[promptFlagIndex + 1];
  }

  const joined = argv.slice(2).join(" ").trim();
  return joined || "I cautiously examine the dusty study for clues.";
};

const printTranscript = (messages: AIMessage[]) => {
  for (const message of messages) {
    const label = message.name ? `[${message.name}]` : "[agent]";
    const content =
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content, null, 2);
    console.log(`${label} ${content}\n`);
  }
};

const main = async () => {
  const userPrompt = parseArgs(process.argv);
  const app = buildGraph(db, scenarioLoader, ragManager);

  const initialMessages: BaseMessage[] = [new HumanMessage(userPrompt)];

  const result: any = await app.invoke({
    messages: initialMessages,
    agentQueue: [],
    gameState: preparedGameState,
  });

  const agentMessages = (result.messages as BaseMessage[]).filter(
    (message): message is AIMessage => message instanceof AIMessage
  );

  printTranscript(agentMessages);

  // Close database connection
  db.close();
};

main().catch((error) => {
  console.error("Error running graph:", error);
  process.exit(1);
});
