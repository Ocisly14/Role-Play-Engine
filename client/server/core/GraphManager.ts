import type { CoCDatabase } from "../../../src/shared/agents/memory/database/index.js";
import { ScenarioLoader } from "../../../src/shared/agents/memory/scenarioloader/index.js";
import { buildDynamicGraph, buildDynamicListenerGraph } from "../../../src/dynamicworldagent/graph/index.js";

/**
 * Singleton class to manage DynamicWorld graph lifecycle
 * Manages initialization of graph and listenerGraph
 */
export class GraphManager {
  private static instance: GraphManager | null = null;

  private dynamicGraph: any = null;
  private dynamicListenerGraph: any = null;
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
   * Initialize DynamicWorld system (graphs)
   * @param db - Database instance
   */
  public async initialize(db: CoCDatabase): Promise<void> {
    if (this.dynamicGraph) {
      console.log("✅ DynamicWorld system already initialized");
      return;
    }

    console.log(`[${new Date().toISOString()}] Initializing DynamicWorld system...`);

    const scenarioLoader = new ScenarioLoader(db);

    // Build DynamicWorld graphs
    this.dynamicGraph = buildDynamicGraph(db, scenarioLoader);
    this.dynamicListenerGraph = buildDynamicListenerGraph(db, scenarioLoader);

    console.log(`[${new Date().toISOString()}] ✅ DynamicWorld system initialized`);
  }

  /**
   * Get graph instance (DynamicWorld only)
   */
  public getGraph(_useDynamic: boolean = true): any {
    return this.dynamicGraph;
  }

  /**
   * Get listener graph instance (DynamicWorld only)
   */
  public getListenerGraph(_useDynamic: boolean = true): any {
    return this.dynamicListenerGraph;
  }

  /**
   * Get DynamicWorld graph instance
   */
  public getDynamicGraph(): any {
    return this.dynamicGraph;
  }

  /**
   * Get DynamicWorld listener graph instance
   */
  public getDynamicListenerGraph(): any {
    return this.dynamicListenerGraph;
  }

  /**
   * Check if DynamicWorld system is initialized
   */
  public isInitialized(): boolean {
    return this.dynamicGraph !== null;
  }
}
