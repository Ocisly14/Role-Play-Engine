/**
 * Memory Agent for DynamicWorld modules
 * Manages DynamicGameState loading and context enrichment
 * Focused on truth_timeline, knowledge_matrix, and world data
 */

import type { CoCDatabase } from "../../../coc_multiagents_system/agents/memory/database/index.js";
import type { DynamicGameState, DynamicGameStateManager } from "../../state/index.js";
import { loadDynamicGameState } from "../../state/DynamicGameStateLoader.js";

/**
 * Memory context enriched with DynamicGameState information
 */
export interface DynamicMemoryContext {
  // World structure data
  moduleDigest: {
    moduleNotes: string;
    keeperGuidance: string;
    moduleLimitations: string;
    introduction: string;
  } | null;

  // Truth and knowledge
  allTruthEvents: any[];
  revealedTruthEvents: any[];
  unrevealedTruthEvents: any[];

  // Knowledge matrix
  knowledgeHolders: any[];
  relevantKnowledgeHolders: any[];  // Based on current context

  // Red herrings and mythos
  redHerrings: any[];
  deployedRedHerrings: any[];
  mythosEvents: any[];
  revealedMythosEvents: any[];

  // Scenario data
  scenarioOutlines: any[];

  // Game progression
  pointOfNoReturnReached: boolean;
  pointOfNoReturnTrigger: string | null;

  // Metadata
  loadedAt: Date;
  lastUpdated: Date;
}

/**
 * Load DynamicGameState for a module
 */
export const loadModuleDynamicState = async (
  db: CoCDatabase,
  moduleName: string
): Promise<DynamicGameState | null> => {
  console.log(`🧠 [Memory Agent] Loading DynamicGameState for module: ${moduleName}`);

  try {
    const dynamicState = await loadDynamicGameState(db, moduleName);

    if (dynamicState) {
      console.log(`✅ [Memory Agent] DynamicGameState loaded successfully`);
      console.log(`   - Truth events: ${dynamicState.truthTimeline.length}`);
      console.log(`   - Knowledge holders: ${dynamicState.knowledgeMatrix.length}`);
      console.log(`   - Red herrings: ${dynamicState.redHerrings.length}`);
      console.log(`   - Mythos events: ${dynamicState.mythosEvents.length}`);
      console.log(`   - Scenario outlines: ${dynamicState.scenarioOutlines.length}`);
    } else {
      console.warn(`⚠️  [Memory Agent] Failed to load DynamicGameState for module: ${moduleName}`);
    }

    return dynamicState;
  } catch (error) {
    console.error(`❌ [Memory Agent] Error loading DynamicGameState:`, error);
    return null;
  }
};

/**
 * Enrich memory context with DynamicGameState information
 * This provides relevant world data for agent reasoning
 */
export const enrichMemoryContext = (
  dynamicState: DynamicGameState | null,
  dynamicStateManager: DynamicGameStateManager | null,
  contextHints?: {
    currentLocation?: string;
    currentNPCs?: string[];
    playerQuery?: string;
  }
): DynamicMemoryContext | null => {
  if (!dynamicState || !dynamicStateManager) {
    console.warn(`⚠️  [Memory Agent] No DynamicGameState available for enrichment`);
    return null;
  }

  console.log(`🧠 [Memory Agent] Enriching memory context...`);

  // Get revealed and unrevealed truth events
  const revealedTruthEvents = dynamicStateManager.getRevealedTruthEvents();
  const unrevealedTruthEvents = dynamicStateManager.getUnrevealedTruthEvents();

  console.log(`   - Revealed truth events: ${revealedTruthEvents.length}/${dynamicState.truthTimeline.length}`);

  // Get knowledge holders (optionally filter by context)
  let relevantKnowledgeHolders = dynamicState.knowledgeMatrix;
  if (contextHints?.currentLocation) {
    // Filter knowledge holders related to current location
    relevantKnowledgeHolders = dynamicState.knowledgeMatrix.filter(holder =>
      holder.holderType === "PLACE" &&
      holder.holderName.toLowerCase().includes(contextHints.currentLocation!.toLowerCase())
    );
    console.log(`   - Filtered knowledge holders by location: ${relevantKnowledgeHolders.length}`);
  }

  // Get deployed red herrings
  const deployedRedHerrings = dynamicState.redHerrings.filter(rh =>
    dynamicStateManager.isRedHerringDeployed(rh.id)
  );

  console.log(`   - Deployed red herrings: ${deployedRedHerrings.length}/${dynamicState.redHerrings.length}`);

  // Get revealed mythos events
  const revealedMythosEvents = dynamicState.mythosEvents.filter((_, index) =>
    dynamicStateManager.isMythosEventRevealed(index)
  );

  console.log(`   - Revealed mythos events: ${revealedMythosEvents.length}/${dynamicState.mythosEvents.length}`);

  // Check point of no return status
  const pnrReached = dynamicState.pointOfNoReturnReached;
  if (pnrReached) {
    console.log(`   ⚠️  Point of no return reached: ${dynamicState.pointOfNoReturnTrigger}`);
  }

  const context: DynamicMemoryContext = {
    moduleDigest: dynamicState.moduleDigest,
    allTruthEvents: dynamicState.truthTimeline,
    revealedTruthEvents,
    unrevealedTruthEvents,
    knowledgeHolders: dynamicState.knowledgeMatrix,
    relevantKnowledgeHolders,
    redHerrings: dynamicState.redHerrings,
    deployedRedHerrings,
    mythosEvents: dynamicState.mythosEvents,
    revealedMythosEvents,
    scenarioOutlines: dynamicState.scenarioOutlines,
    pointOfNoReturnReached: pnrReached,
    pointOfNoReturnTrigger: dynamicState.pointOfNoReturnTrigger,
    loadedAt: dynamicState.loadedAt,
    lastUpdated: dynamicState.lastUpdated,
  };

  console.log(`✅ [Memory Agent] Memory context enriched successfully`);

  return context;
};

/**
 * Get truth events relevant to a specific query or context
 */
export const getRelevantTruthEvents = (
  dynamicState: DynamicGameState | null,
  dynamicStateManager: DynamicGameStateManager | null,
  query: string
): any[] => {
  if (!dynamicState || !dynamicStateManager) return [];

  // Simple keyword-based relevance (can be enhanced with semantic search later)
  const queryLower = query.toLowerCase();
  const unrevealedEvents = dynamicStateManager.getUnrevealedTruthEvents();

  return unrevealedEvents.filter(event => {
    const eventText = `${event.event} ${event.cause || ''} ${event.consequence || ''}`.toLowerCase();
    return eventText.includes(queryLower);
  });
};

/**
 * Get knowledge holders relevant to a specific NPC or location
 */
export const getRelevantKnowledgeHolders = (
  dynamicStateManager: DynamicGameStateManager | null,
  filter: {
    npcName?: string;
    location?: string;
    holderType?: "ROLE" | "ORGANIZATION" | "PLACE" | "OBJECT";
  }
): any[] => {
  if (!dynamicStateManager) return [];

  const state = dynamicStateManager.getState();
  let filtered = state.knowledgeMatrix;

  if (filter.holderType) {
    filtered = dynamicStateManager.getKnowledgeHoldersByType(filter.holderType);
  }

  if (filter.npcName) {
    filtered = filtered.filter(holder =>
      holder.holderName.toLowerCase().includes(filter.npcName!.toLowerCase())
    );
  }

  if (filter.location) {
    filtered = filtered.filter(holder =>
      holder.holderType === "PLACE" &&
      holder.holderName.toLowerCase().includes(filter.location!.toLowerCase())
    );
  }

  return filtered;
};

/**
 * Get truth events that a specific knowledge holder knows
 */
export const getTruthEventsForKnowledgeHolder = (
  dynamicStateManager: DynamicGameStateManager | null,
  holderId: string
): any[] => {
  if (!dynamicStateManager) return [];

  const holder = dynamicStateManager.getKnowledgeHolder(holderId);
  if (!holder) return [];

  const state = dynamicStateManager.getState();
  return state.truthTimeline.filter(event =>
    holder.knows.includes(event.id)
  );
};

/**
 * Get available red herrings that haven't been deployed yet
 */
export const getAvailableRedHerrings = (
  dynamicStateManager: DynamicGameStateManager | null
): any[] => {
  if (!dynamicStateManager) return [];

  const state = dynamicStateManager.getState();
  return state.redHerrings.filter(rh =>
    !dynamicStateManager.isRedHerringDeployed(rh.id)
  );
};

/**
 * Format memory context for LLM prompt
 */
export const formatMemoryContextForPrompt = (
  context: DynamicMemoryContext | null
): string => {
  if (!context) return "No memory context available.";

  let formatted = "=== WORLD MEMORY CONTEXT ===\n\n";

  // Module information
  if (context.moduleDigest) {
    formatted += "MODULE GUIDANCE:\n";
    formatted += `${context.moduleDigest.keeperGuidance}\n\n`;

    if (context.moduleDigest.moduleLimitations) {
      formatted += "MODULE LIMITATIONS:\n";
      formatted += `${context.moduleDigest.moduleLimitations}\n\n`;
    }
  }

  // Truth events status
  formatted += `TRUTH TIMELINE STATUS:\n`;
  formatted += `- Total events: ${context.allTruthEvents.length}\n`;
  formatted += `- Revealed: ${context.revealedTruthEvents.length}\n`;
  formatted += `- Unrevealed: ${context.unrevealedTruthEvents.length}\n\n`;

  // Revealed truth events
  if (context.revealedTruthEvents.length > 0) {
    formatted += "REVEALED TRUTHS:\n";
    context.revealedTruthEvents.forEach((event, index) => {
      formatted += `${index + 1}. [${event.id}] ${event.event}\n`;
      if (event.time) {
        formatted += `   Time: ${event.time}\n`;
      }
      if (event.cause) {
        formatted += `   Cause: ${event.cause}\n`;
      }
      if (event.consequence) {
        formatted += `   Consequence: ${event.consequence}\n`;
      }
    });
    formatted += "\n";
  }

  // Knowledge holders
  if (context.relevantKnowledgeHolders.length > 0) {
    formatted += "RELEVANT KNOWLEDGE HOLDERS:\n";
    context.relevantKnowledgeHolders.forEach((holder, index) => {
      formatted += `${index + 1}. ${holder.holderName} (${holder.holderType})\n`;
      formatted += `   Knows: ${holder.knows.join(", ")}\n`;
      formatted += `   Access: ${holder.accessMethod}\n`;
    });
    formatted += "\n";
  }

  // Red herrings
  if (context.deployedRedHerrings.length > 0) {
    formatted += "DEPLOYED RED HERRINGS:\n";
    context.deployedRedHerrings.forEach((rh, index) => {
      formatted += `${index + 1}. ${rh.description}\n`;
    });
    formatted += "\n";
  }

  // Point of no return
  if (context.pointOfNoReturnReached) {
    formatted += `⚠️  POINT OF NO RETURN REACHED: ${context.pointOfNoReturnTrigger}\n\n`;
  }

  formatted += "=== END MEMORY CONTEXT ===\n";

  return formatted;
};
