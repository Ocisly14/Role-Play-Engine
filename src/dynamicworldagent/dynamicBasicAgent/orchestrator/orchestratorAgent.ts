import { getOrchestratorTemplate } from "./orchestratorTemplate.js";
import { composeTemplate } from "../../../template.js";
import type { ActionAnalysis, ActionType, SceneChangeRequest, SceneTransitionRejection } from "../../../coc_multiagents_system/state/index.js";
import type { DynamicGameStateManager } from "../../state/index.js";
import {
  ModelProviderName,
  ModelClass,
  generateText,
} from "../../../models/index.js";
import type { CoCDatabase } from "../../../coc_multiagents_system/agents/memory/database/index.js";
import { extractRecentConversationHistory } from "../../../coc_multiagents_system/agents/memory/memoryAgent.js";

interface OrchestratorRuntime {
  modelProvider: ModelProviderName;
  getSetting: (key: string) => string | undefined;
}

const createRuntime = (): OrchestratorRuntime => ({
  modelProvider: (process.env.MODEL_PROVIDER as ModelProviderName) || ModelProviderName.OPENAI,
  getSetting: (key: string) => process.env[key],
});

/**
 * Orchestrator Agent - Routes user queries to appropriate agents
 */
export class OrchestratorAgent {
  
  /**
   * Process input (user query, agent result, or instruction) and determine which agent to route to
   */
  async processInput(input: string, gameStateManager: DynamicGameStateManager, db?: CoCDatabase): Promise<string> {
    const runtime = createRuntime();
    const dynamicState = gameStateManager.getState();
    
    // Get the template
    const template = getOrchestratorTemplate();
    
    // Extract context from dynamic game state
    const characterName = dynamicState.playerCharacter?.name || "Unknown";
    const scenarioLocation = dynamicState.currentScenario?.location || "Unknown location";
    const npcNames = dynamicState.npcCharacters?.map(npc => npc.name).join(", ") || "None";
    
    // Get scenario connections for scene change validation
    const scenarioOutline = dynamicState.scenarioOutlines.find(
      outline => outline.id === dynamicState.currentScenario?.id
    );
    const connections = scenarioOutline?.connections?.filter(
      conn => conn.relationshipType === "leads_to"
    ) || [];
    
    // Get conversation history directly from database to extract previous narrative
    // This ensures we get the latest completed turns even if memory agent hasn't run yet
    let previousNarrative: string | null = null;
    if (db) {
      try {
        const conversationHistory = await extractRecentConversationHistory(
          db,
          dynamicState.sessionId,
          1
        );
        
        // Get previous round narrative (last completed turn with narrative)
        if (conversationHistory.length > 0) {
          const lastTurnWithNarrative = [...conversationHistory]
            .reverse()
            .find(turn => turn.keeperNarrative);
          if (lastTurnWithNarrative && lastTurnWithNarrative.keeperNarrative) {
            previousNarrative = lastTurnWithNarrative.keeperNarrative;
            console.log(`📜 [Orchestrator Agent] Retrieved last round's Keeper Narrative from database (Turn #${lastTurnWithNarrative.turnNumber})`);
          }
        }
      } catch (error) {
        console.warn("[Orchestrator Agent] Failed to retrieve conversation history from database:", error);
        // Fallback to dynamicState if database access fails
        const conversationHistory = (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
          turnNumber: number;
          characterInput: string;
          keeperNarrative: string | null;
        }>) || [];
        
        if (conversationHistory.length > 0) {
          const lastTurnWithNarrative = [...conversationHistory]
            .reverse()
            .find(turn => turn.keeperNarrative);
          if (lastTurnWithNarrative && lastTurnWithNarrative.keeperNarrative) {
            previousNarrative = lastTurnWithNarrative.keeperNarrative;
          }
        }
      }
    } else {
      // Fallback to dynamicState if db is not provided
      const conversationHistory = (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
        turnNumber: number;
        characterInput: string;
        keeperNarrative: string | null;
      }>) || [];
      
      if (conversationHistory.length > 0) {
        const lastTurnWithNarrative = [...conversationHistory]
          .reverse()
          .find(turn => turn.keeperNarrative);
        if (lastTurnWithNarrative && lastTurnWithNarrative.keeperNarrative) {
          previousNarrative = lastTurnWithNarrative.keeperNarrative;
        }
      }
    }
    
    // Compose the prompt with input and game context
    // Pass DynamicGameState directly to composeTemplate
    const prompt = composeTemplate(template, dynamicState, {
      input,
      characterName,
      scenarioLocation,
      npcNames,
      previousNarrative,
      connections
    });

    // Generate response using LLM
    const response = await generateText({
      runtime,
      context: prompt,
      modelClass: ModelClass.SMALL,
    });

    // Parse the response and store action analysis and scene change request
    try {
      // Extract JSON from response (in case LLM wraps it in markdown code blocks)
      const jsonText =
        response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ||
        response.match(/\{[\s\S]*\}/)?.[0];

      if (!jsonText) {
        console.warn("Failed to extract JSON from orchestrator response");
      } else {
        const parsedResponse = JSON.parse(jsonText);
        
        // Store action analysis
        if (parsedResponse.actionAnalysis) {
          const normalizedActionAnalysis = this.normalizeActionAnalysis(
            parsedResponse.actionAnalysis,
            characterName
          );
          gameStateManager.setActionAnalysis(normalizedActionAnalysis);
        }
        
        // Handle scene change request - store in temporaryInfo
        if (parsedResponse.sceneChangeRequest) {
          const sceneChangeReq = parsedResponse.sceneChangeRequest;
          
          if (sceneChangeReq.shouldChange && sceneChangeReq.targetSceneName) {
            // Valid scene change request - store in temporaryInfo
            const sceneChangeRequest: SceneChangeRequest = {
              shouldChange: true,
              targetSceneName: sceneChangeReq.targetSceneName,
              reason: sceneChangeReq.reason || "Scene change requested",
              timestamp: new Date()
            };
            gameStateManager.setSceneChangeRequest(sceneChangeRequest);
            console.log(`🎯 [Orchestrator Agent] Scene change request validated: ${sceneChangeReq.targetSceneName}`);
          } else {
            // No valid scene change request - clear any existing request
            gameStateManager.clearSceneChangeRequest();
          }
        } else {
          // No sceneChangeRequest in response - clear any existing request
          gameStateManager.clearSceneChangeRequest();
        }
      }
    } catch (error) {
      console.warn("Failed to parse orchestrator response for action analysis:", error);
      console.warn("Response content:", response.substring(0, 200));
    }

    return response;
  }

  private normalizeActionAnalysis(rawAnalysis: any, fallbackCharacterName: string): ActionAnalysis {
    const actionType = rawAnalysis.actionType as ActionType | undefined;
    return {
      character: rawAnalysis.character || rawAnalysis.player || fallbackCharacterName,
      action: rawAnalysis.action || "",
      actionType: actionType || "narrative",
      target: {
        name: rawAnalysis.target?.name ?? null,
        intent: rawAnalysis.target?.intent || ""
      },
      requiresDice: Boolean(rawAnalysis.requiresDice)
    };
  }

}
