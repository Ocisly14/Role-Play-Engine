import type { CoCDatabase } from "../../../src/coc_multiagents_system/agents/memory/database/index.js";
import { ScenarioLoader } from "../../../src/coc_multiagents_system/agents/memory/scenarioloader/index.js";
import { NPCLoader } from "../../../src/coc_multiagents_system/agents/character/npcloader/index.js";
import { createBgeSqliteRagManager, RagManager } from "../../../src/coc_multiagents_system/agents/memory/RagManager.js";
import { buildGraph, buildListenerGraph } from "../../../src/graph.js";
import { TurnManager } from "../../../src/coc_multiagents_system/agents/memory/index.js";
import { initialGameState } from "../../../src/state.js";

/**
 * Singleton class to manage graph and multi-agent system lifecycle
 * Manages initialization of graph, listenerGraph, ragManager, and turnManager
 */
export class GraphManager {
  private static instance: GraphManager | null = null;

  private graph: any = null;
  private listenerGraph: any = null;
  private ragManager: RagManager | null = null;
  private turnManager: TurnManager | null = null;

  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): GraphManager {
    if (!GraphManager.instance) {
      GraphManager.instance = new GraphManager();
    }
    return GraphManager.instance;
  }

  /**
   * Initialize multi-agent system (graph, RAG, turnManager)
   * @param db - Database instance
   * @param skipRag - Whether to skip RAG knowledge base building (default: true)
   */
  public async initialize(db: CoCDatabase, skipRag: boolean = true): Promise<void> {
    if (this.graph && this.ragManager) {
      console.log("✅ Multi-agent system already initialized");
      return;
    }

    console.log(`[${new Date().toISOString()}] Initializing multi-agent system...`);

    const scenarioLoader = new ScenarioLoader(db);
    const npcLoader = new NPCLoader(db);

    // Initialize RAG Manager
    this.ragManager = createBgeSqliteRagManager(db);

    if (!skipRag) {
      const isBaseKbBuilt = RagManager.isBaseKnowledgeBaseBuilt(db);

      if (!isBaseKbBuilt) {
        console.log(`[${new Date().toISOString()}] Building base RAG knowledge base...`);
        const scenarioProfiles = scenarioLoader.getAllScenarios();
        const npcProfiles = npcLoader.getAllNPCs();

        await this.ragManager.buildKnowledgeBase(
          {
            scenarios: scenarioProfiles.map((s: any) => s.snapshot),
            npcs: npcProfiles,
            clues: [],
            rules: [],
            playerInventory: initialGameState.playerCharacter.inventory,
            playerId: initialGameState.playerCharacter.id,
            playerName: initialGameState.playerCharacter.name,
          },
          {
            moduleName: "default-module",
            mode: "keeper",
            enableNodeEmbeddings: true,
            enableKnnEdges: true,
          }
        );
        console.log(`[${new Date().toISOString()}] Base RAG knowledge base built successfully`);
      } else {
        console.log(`[${new Date().toISOString()}] Base RAG knowledge base already exists, reusing it`);
      }
    } else {
      console.log(`[${new Date().toISOString()}] RAG knowledge base building skipped (SKIP_RAG = true)`);
    }

    // Build graphs
    this.graph = buildGraph(db, scenarioLoader, this.ragManager);
    this.listenerGraph = buildListenerGraph(db, scenarioLoader, this.ragManager);

    // Initialize TurnManager
    this.turnManager = new TurnManager(db);

    console.log(`[${new Date().toISOString()}] ✅ Multi-agent system initialized`);
  }

  /**
   * Get main graph instance
   */
  public getGraph(): any {
    return this.graph;
  }

  /**
   * Get listener graph instance (for progression checking)
   */
  public getListenerGraph(): any {
    return this.listenerGraph;
  }

  /**
   * Get RAG manager instance
   */
  public getRagManager(): RagManager | null {
    return this.ragManager;
  }

  /**
   * Get turn manager instance
   */
  public getTurnManager(): TurnManager | null {
    return this.turnManager;
  }

  /**
   * Check if multi-agent system is initialized
   */
  public isInitialized(): boolean {
    return this.graph !== null && this.ragManager !== null;
  }
}
