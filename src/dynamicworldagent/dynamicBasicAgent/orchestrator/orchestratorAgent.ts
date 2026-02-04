import { getOrchestratorTemplate } from "./orchestratorTemplate.js";
import { composeTemplate } from "../../../template.js";
import type { ActionAnalysis, ActionType, SceneChangeRequest, SceneTransitionRejection } from "../../../shared/state/index.js";
import type { DynamicGameStateManager } from "../../state/index.js";
import {
  ModelProviderName,
  ModelClass,
  generateText,
} from "../../../models/index.js";
import type { CoCDatabase } from "../../../shared/agents/memory/database/index.js";
import { extractRecentConversationHistory } from "../memory/memoryAgent.js";
import { resolveEmailId } from "../../../shared/agents/memory/database/userContext.js";

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
    const currentScenarioName = dynamicState.currentScenario?.name || "Unknown scenario";
    const npcNames = dynamicState.npcCharacters?.map(npc => npc.name).join(", ") || "None";
    
    // Get scenario connections for scene change validation
    // Note: currentScenario.id is snapshot_id, not scenario_id
    // We need to find the corresponding scenario outline to get connections
    let scenarioOutline: typeof dynamicState.scenarioOutlines[0] | undefined;
    
    if (db && dynamicState.currentScenario?.id) {
      // Try to get scenario_id from database using snapshot_id
      try {
        const database = db.getDatabase();
        const emailId = resolveEmailId();
        const hasSnapshotEmailId = db.hasColumn("scenario_snapshots", "email_id");
        const snapshotRow = database
          .prepare(`SELECT scenario_id FROM scenario_snapshots WHERE snapshot_id = ?${hasSnapshotEmailId && emailId ? " AND email_id = ?" : ""}`)
          .get(...(hasSnapshotEmailId && emailId ? [dynamicState.currentScenario.id, emailId] : [dynamicState.currentScenario.id])) as { scenario_id: string } | undefined;
        
        if (snapshotRow) {
          // Find scenario outline by scenario_id
          scenarioOutline = dynamicState.scenarioOutlines.find(
            outline => outline.id === snapshotRow.scenario_id
          );
        }
      } catch (error) {
        console.warn("[Orchestrator Agent] Failed to query scenario_id from database:", error);
      }
    }
    
    // Fallback: match by name if database query failed or db not available
    if (!scenarioOutline && dynamicState.currentScenario?.name) {
      scenarioOutline = dynamicState.scenarioOutlines.find(
        outline => outline.name === dynamicState.currentScenario?.name
      );
    }
    const rawConnections = scenarioOutline?.connections?.filter(
      conn => conn.relationshipType === "leads_to"
    ) || [];
    
    // Enrich connections with target scenario details
    const connections = rawConnections.map(conn => {
      // Find target scenario outline by name or id
      const targetScenario = dynamicState.scenarioOutlines.find(
        outline => outline.name === conn.scenarioName || outline.id === conn.scenarioName
      );

      return {
        scenarioName: targetScenario?.name || conn.scenarioName, // Use actual name from outline if found
        scenarioId: targetScenario?.id || conn.scenarioName,     // Include ID
        relationshipType: conn.relationshipType,
        description: conn.description,
        blocked: conn.blocked,
        blockReason: conn.blockReason
      };
    });

    // Log connections for debugging
    console.log(`\n🔗 [Orchestrator Agent] Current scenario connections (${connections.length}):`);
    if (connections.length > 0) {
      connections.forEach((conn, index) => {
        console.log(`   ${index + 1}. "${conn.scenarioName}" (ID: ${conn.scenarioId}) [${conn.relationshipType}]`);
        if (conn.description) console.log(`      Description: ${conn.description}`);
        if (conn.blocked) {
          console.log(`      ⚠️ BLOCKED: ${conn.blockReason || 'No reason specified'}`);
        } else {
          console.log(`      ✓ Accessible`);
        }
        console.log(`      → Resolved to: "${conn.scenarioName}"`);
      });
    } else {
      console.log(`   (No connections found for current scenario)`);
    }

    // Get conversation history directly from database to extract previous narrative
    // This ensures we get the latest completed turns even if memory agent hasn't run yet
    let conversationHistory: Array<{
      turnNumber: number;
      characterInput: string;
      keeperNarrative: string | null;
    }> = [];
    
    if (db) {
      try {
        const history = await extractRecentConversationHistory(
          db,
          dynamicState.sessionId,
          3  // Get last 3 turns
        );
        
        // Filter to only include turns with narrative
        conversationHistory = history
          .filter(turn => turn.keeperNarrative)
          .map(turn => ({
            turnNumber: turn.turnNumber,
            characterInput: turn.characterInput,
            keeperNarrative: turn.keeperNarrative
          }));
        
        if (conversationHistory.length > 0) {
          console.log(`📜 [Orchestrator Agent] Retrieved ${conversationHistory.length} rounds of Keeper Narrative from database (Turn #${conversationHistory[0]?.turnNumber} to Turn #${conversationHistory[conversationHistory.length - 1]?.turnNumber})`);
        }
      } catch (error) {
        console.warn("[Orchestrator Agent] Failed to retrieve conversation history from database:", error);
        // Fallback to dynamicState if database access fails
        const fallbackHistory = (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
          turnNumber: number;
          characterInput: string;
          keeperNarrative: string | null;
        }>) || [];
        
        conversationHistory = fallbackHistory
          .filter(turn => turn.keeperNarrative)
          .slice(-3);  // Get last 3 turns
      }
    } else {
      // Fallback to dynamicState if db is not provided
      const fallbackHistory = (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
        turnNumber: number;
        characterInput: string;
        keeperNarrative: string | null;
      }>) || [];
      
      conversationHistory = fallbackHistory
        .filter(turn => turn.keeperNarrative)
        .slice(-3);  // Get last 3 turns
    }
    
    // Compose the prompt with input and game context
    // Pass DynamicGameState directly to composeTemplate
    // Use Handlebars so {{#if connections}}, {{#each connections}}, etc. render correctly
    const prompt = composeTemplate(
      template,
      dynamicState,
      {
        input,
        characterName,
        scenarioLocation,
        currentScenarioName,
        npcNames,
        conversationHistory,  // Pass conversation history instead of single previousNarrative
        connections,
      },
      "handlebars"
    );

    // Generate response using LLM
    const response = await generateText({
      runtime,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
    });

    // Parse the response and store action analysis and scene change request
    try {
      // Extract JSON from response (in case LLM wraps it in markdown code blocks)
      const jsonText =
        response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ||
        response.match(/\{[\s\S]*\}/)?.[0];

      if (!jsonText) {
        console.warn("⚠️ [Orchestrator Agent] Failed to extract JSON from orchestrator response");
        console.warn("Raw response:", response.substring(0, 500));
      } else {
        const parsedResponse = JSON.parse(jsonText);
        
        // Debug: Log the parsed sceneChangeRequest
        if (parsedResponse.sceneChangeRequest) {
          console.log(`\n🔍 [Orchestrator Agent] Parsed sceneChangeRequest:`, JSON.stringify(parsedResponse.sceneChangeRequest, null, 2));
        } else {
          console.log(`\n⚠️ [Orchestrator Agent] No sceneChangeRequest in parsed response`);
        }
        
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
          
          console.log(`🔍 [Orchestrator Agent] Checking sceneChangeRequest: shouldChange=${sceneChangeReq.shouldChange}, targetSceneName="${sceneChangeReq.targetSceneName}"`);
          
          if (sceneChangeReq.shouldChange && sceneChangeReq.targetSceneName) {
            // Valid scene change request - store in temporaryInfo
            const sceneChangeRequest: SceneChangeRequest = {
              shouldChange: true,
              targetSceneName: sceneChangeReq.targetSceneName,
              reason: sceneChangeReq.reason || "Scene change requested",
              timestamp: new Date()
            };
            gameStateManager.setSceneChangeRequest(sceneChangeRequest);
            console.log(`✅ [Orchestrator Agent] Scene change request validated: ${sceneChangeReq.targetSceneName}`);
          } else {
            // No valid scene change request - clear any existing request
            console.log(`❌ [Orchestrator Agent] Scene change request invalid: shouldChange=${sceneChangeReq.shouldChange}, targetSceneName="${sceneChangeReq.targetSceneName}"`);
            gameStateManager.clearSceneChangeRequest();
          }
        } else {
          // No sceneChangeRequest in response - clear any existing request
          console.log(`⚠️ [Orchestrator Agent] No sceneChangeRequest field in response - clearing any existing request`);
          gameStateManager.clearSceneChangeRequest();
        }
      }
    } catch (error) {
      console.warn("❌ [Orchestrator Agent] Failed to parse orchestrator response for action analysis:", error);
      console.warn("Response content:", response.substring(0, 500));
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
