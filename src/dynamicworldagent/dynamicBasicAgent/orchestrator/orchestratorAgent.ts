import {
  ModelClass,
  ModelProviderName,
  generateText,
} from "../../../models/index.js";
import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../../shared/agents/memory/database/index.js";
import { getPrismaClient } from "../../../shared/agents/memory/database/prismaClient.js";
import { composeTemplate } from "../../../template.js";
import type { DynamicGameStateManager } from "../../state/index.js";
import {
  extractRecentConversationHistory,
  retrieveRelevantHistory,
} from "../memory/memoryAgent.js";
import { getOrchestratorTemplate } from "./orchestratorTemplate.js";

interface OrchestratorRuntime {
  modelProvider: ModelProviderName;
  getSetting: (key: string) => string | undefined;
}

const createRuntime = (): OrchestratorRuntime => ({
  modelProvider:
    (process.env.MODEL_PROVIDER as ModelProviderName) ||
    ModelProviderName.OPENAI,
  getSetting: (key: string) => process.env[key],
});


/**
 * Orchestrator Agent - Routes user queries to appropriate agents
 */
export class OrchestratorAgent {
  /**
   * Process input (user query, agent result, or instruction) and determine which agent to route to
   */
  async processInput(
    input: string,
    gameStateManager: DynamicGameStateManager,
    db?: CoCDatabase | CoCDatabaseAdapter,
    _selectedSkill?: string | null,
    language?: "en" | "zh"
  ): Promise<string> {
    const runtime = createRuntime();
    const dynamicState = gameStateManager.getState();

    // Get the template
    const template = getOrchestratorTemplate();
    const effectiveLanguage = language === "en" ? "en" : "zh";

    // Extract context from dynamic game state
    const currentScene = dynamicState.scenes.get(dynamicState.currentSceneId ?? "");
    const scenarioLocation =
      currentScene?.name || "Unknown location";
    const currentScenarioName =
      currentScene?.name || "Unknown scenario";
    const npcList =
      dynamicState.npcCharacters?.map((npc) => ({
        id: npc.id,
        name: npc.name,
      })) || [];

    // Get scenario connections for scene change validation
    // Note: currentSceneId maps to a scene in the scenes Map
    // We need to find the corresponding scenario outline to get connections
    let scenarioOutline: (typeof dynamicState.scenarioOutlines)[0] | undefined;

    if (db && dynamicState.currentSceneId) {
      // Try to get scenario_id from database using scene_id
      try {
        const prisma = getPrismaClient();
        const sceneRow = await prisma.scene.findFirst({
          where: { sceneId: dynamicState.currentSceneId },
          select: { scenarioId: true },
        });

        if (sceneRow) {
          // Find scenario outline by scenario_id
          scenarioOutline = dynamicState.scenarioOutlines.find(
            (outline) => outline.id === sceneRow.scenarioId
          );
        }
      } catch (error) {
        console.warn(
          "[Orchestrator Agent] Failed to query scenario_id from database:",
          error
        );
      }
    }

    // Fallback: match by name if database query failed or db not available
    if (!scenarioOutline && currentScene?.name) {
      scenarioOutline = dynamicState.scenarioOutlines.find(
        (outline) => outline.name === currentScene?.name
      );
    }
    const rawConnections = scenarioOutline?.connections || [];

    // Resolve connection names (template only needs scenarioName)
    const connections = rawConnections.map((conn) => {
      const targetScenario = dynamicState.scenarioOutlines.find(
        (outline) =>
          outline.name === conn.scenarioName || outline.id === conn.scenarioName
      );
      return {
        scenarioName: targetScenario?.name || conn.scenarioName,
      };
    });

    console.log(
      `\n🔗 [Orchestrator Agent] Connected scenes (${connections.length}): ${connections.map((c) => c.scenarioName).join(", ") || "(none)"}`
    );

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
          3 // Get last 3 turns
        );

        // Filter to only include turns with narrative
        conversationHistory = history
          .filter((turn) => turn.keeperNarrative)
          .map((turn) => ({
            turnNumber: turn.turnNumber,
            characterInput: turn.characterInput,
            keeperNarrative: turn.keeperNarrative,
          }));

        if (conversationHistory.length > 0) {
          console.log(
            `📜 [Orchestrator Agent] Retrieved ${conversationHistory.length} rounds of Keeper Narrative from database (Turn #${conversationHistory[0]?.turnNumber} to Turn #${conversationHistory[conversationHistory.length - 1]?.turnNumber})`
          );
        }
      } catch (error) {
        console.warn(
          "[Orchestrator Agent] Failed to retrieve conversation history from database:",
          error
        );
        // Fallback to dynamicState if database access fails
        const fallbackHistory =
          (dynamicState.temporaryInfo.contextualData
            ?.conversationHistory as Array<{
            turnNumber: number;
            characterInput: string;
            keeperNarrative: string | null;
          }>) || [];

        conversationHistory = fallbackHistory
          .filter((turn) => turn.keeperNarrative)
          .slice(-3); // Get last 3 turns
      }
    } else {
      // Fallback to dynamicState if db is not provided
      const fallbackHistory =
        (dynamicState.temporaryInfo.contextualData
          ?.conversationHistory as Array<{
          turnNumber: number;
          characterInput: string;
          keeperNarrative: string | null;
          selectedSkill?: string | null;
          playerActionLogs?: string[];
        }>) || [];

      conversationHistory = fallbackHistory
        .filter((turn) => turn.keeperNarrative)
        .slice(-3); // Get last 3 turns
    }

    const recentTurnsForRewrite = conversationHistory
      .filter(
        (
          turn
        ): turn is {
          turnNumber: number;
          characterInput: string;
          keeperNarrative: string;
        } => typeof turn.keeperNarrative === "string"
      )
      .map((turn) => ({
        turnNumber: turn.turnNumber,
        playerInput: turn.characterInput,
        keeperNarrative: turn.keeperNarrative,
      }));

    const npcNamesList = Array.from(
      new Set(
        (dynamicState.npcCharacters || [])
          .map((npc) => (typeof npc?.name === "string" ? npc.name.trim() : ""))
          .filter((name) => name.length > 0)
      )
    ).slice(0, 30);

    const allScenes = (dynamicState.scenarioOutlines || [])
      .map((scene) => ({
        name: scene.name,
        description: scene.description,
      }))
      .filter((scene) => scene.name && scene.description)
      .slice(0, 50);

    const alpha = effectiveLanguage === "zh" ? 0.1 : 0.3;
    const relevantHistory = await retrieveRelevantHistory(
      db,
      dynamicState.sessionId,
      input,
      {
        topKActionLogs: 15,
        topKTurns: 5,
        alpha,
        includeActionLogs: true,
        language: effectiveLanguage,
        sceneName: currentScenarioName,
        sceneLocation: scenarioLocation,
        npcNames: npcNamesList,
        playerName: dynamicState.playerCharacter?.name || undefined,
        recentTurns: recentTurnsForRewrite,
        allScenes,
        minScore: 0.7,
      }
    );

    // Persist for downstream agents (memory/keeper) so we only retrieve once per turn.
    gameStateManager.setContextualData("relevantHistory", relevantHistory);
    gameStateManager.setContextualData("relevantHistoryThreshold", 0.7);
    gameStateManager.setContextualData("relevantHistoryQuery", input.trim());
    gameStateManager.setContextualData("relevantHistoryIncludesActionLogs", true);

    if (relevantHistory.length > 0) {
      console.log(
        `🧠 [Orchestrator Agent] Preloaded ${relevantHistory.length} relevant history items (threshold=0.7)`
      );
    }

    // Compose the prompt with input and game context
    // Pass DynamicGameState directly to composeTemplate
    // Use Handlebars so {{#if connections}}, {{#each connections}}, etc. render correctly
    const prompt = composeTemplate(
      template,
      dynamicState,
      {
        input,
        currentScenarioName,
        npcList,
        conversationHistory,
        connections,
      },
      "handlebars"
    );

    // Generate response using LLM
    const response = await generateText({
      runtime,
      context: prompt,
      modelClass: ModelClass.SMALL,
    });

    // Parse the simplified 3-field response: { targetScenarioName?, targetNpcId?, impact }
    try {
      const jsonText =
        response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ||
        response.match(/\{[\s\S]*\}/)?.[0];

      if (!jsonText) {
        console.warn(
          "[Orchestrator Agent] Failed to extract JSON from orchestrator response"
        );
        console.warn("Raw response:", response.substring(0, 500));
      } else {
        const parsed = JSON.parse(jsonText);

        // Store simplified orchestrator output for downstream PlayerPlanAgent
        gameStateManager.setContextualData("orchestratorOutput", {
          targetScenarioName: parsed.targetScenarioName ?? null,
          targetNpcId: parsed.targetNpcId ?? null,
          impact: parsed.impact ?? 0,
        });

        console.log(
          `[Orchestrator Agent] Output: targetScenarioName=${parsed.targetScenarioName ?? "(none)"}, targetNpcId=${parsed.targetNpcId ?? "(none)"}, impact=${parsed.impact ?? 0}`
        );
      }
    } catch (error) {
      console.warn(
        "[Orchestrator Agent] Failed to parse orchestrator response:",
        error
      );
      console.warn("Response content:", response.substring(0, 500));

      // Store fallback output so downstream agents have something to work with
      gameStateManager.setContextualData("orchestratorOutput", {
        targetScenarioName: null,
        targetNpcId: null,
        impact: 0,
      });
    }

    return response;
  }
}
