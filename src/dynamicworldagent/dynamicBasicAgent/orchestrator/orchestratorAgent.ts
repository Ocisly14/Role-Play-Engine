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
import type {
  ActionAnalysis,
  ActionType,
  SceneChangeRequest,
} from "../../../shared/state/index.js";
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

type HistoricalActionResult = {
  gameTime?: unknown;
  location?: unknown;
  character?: unknown;
  result?: unknown;
  diceRolls?: unknown;
};

function normalizeActionResults(raw: unknown): HistoricalActionResult[] {
  if (Array.isArray(raw)) return raw as HistoricalActionResult[];
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as HistoricalActionResult[]) : [];
  } catch {
    return [];
  }
}

function extractSkillNamesFromDiceRolls(diceRolls: unknown): string[] {
  if (!Array.isArray(diceRolls)) return [];
  const skills: string[] = [];
  for (const roll of diceRolls) {
    if (typeof roll !== "string") continue;
    const match = roll.match(/\(([^()]+?)\s+\d{1,3}%/i);
    if (!match) continue;
    const skill = match[1].trim();
    if (!skill || skills.includes(skill)) continue;
    skills.push(skill);
    if (skills.length >= 5) break;
  }
  return skills;
}

function extractHistoricalPlayerSignals(
  actionResultsRaw: unknown,
  playerNameRaw: unknown
): {
  selectedSkill: string | null;
  playerActionLogs: string[];
} {
  const actionResults = normalizeActionResults(actionResultsRaw);
  if (actionResults.length === 0) {
    return { selectedSkill: null, playerActionLogs: [] };
  }

  const playerName =
    typeof playerNameRaw === "string" ? playerNameRaw.trim().toLowerCase() : "";
  const playerResults = actionResults.filter((result) => {
    const actor =
      typeof result.character === "string"
        ? result.character.trim().toLowerCase()
        : "";
    if (!playerName) return true;
    if (!actor) return false;
    return actor === playerName;
  });

  const relevantResults = playerResults.length > 0 ? playerResults : actionResults;
  const detectedSkills: string[] = [];
  const playerActionLogs: string[] = [];

  for (const result of relevantResults) {
    const skills = extractSkillNamesFromDiceRolls(result.diceRolls);
    for (const skill of skills) {
      if (!detectedSkills.includes(skill)) {
        detectedSkills.push(skill);
      }
    }

    const summary = typeof result.result === "string" ? result.result.trim() : "";
    if (!summary) continue;

    const time =
      typeof result.gameTime === "string" && result.gameTime.trim().length > 0
        ? result.gameTime.trim()
        : "";
    const location =
      typeof result.location === "string" && result.location.trim().length > 0
        ? result.location.trim()
        : "";
    const prefix = [time, location].filter(Boolean).join(" @ ");
    playerActionLogs.push(prefix ? `${prefix}: ${summary}` : summary);
  }

  return {
    selectedSkill: detectedSkills[0] ?? null,
    playerActionLogs: playerActionLogs.slice(0, 3),
  };
}

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
    selectedSkill?: string | null,
    language?: "en" | "zh"
  ): Promise<string> {
    const runtime = createRuntime();
    const dynamicState = gameStateManager.getState();

    // Get the template
    const template = getOrchestratorTemplate();
    const effectiveLanguage = language === "en" ? "en" : "zh";

    // Extract context from dynamic game state
    const characterName = dynamicState.playerCharacter?.name || "Unknown";
    const scenarioLocation =
      dynamicState.currentScenario?.location || "Unknown location";
    const currentScenarioName =
      dynamicState.currentScenario?.name || "Unknown scenario";
    const npcNames =
      dynamicState.npcCharacters?.map((npc) => npc.name).join(", ") || "None";

    // Get scenario connections for scene change validation
    // Note: currentScenario.id is snapshot_id, not scenario_id
    // We need to find the corresponding scenario outline to get connections
    let scenarioOutline: (typeof dynamicState.scenarioOutlines)[0] | undefined;

    if (db && dynamicState.currentScenario?.id) {
      // Try to get scenario_id from database using snapshot_id
      try {
        const prisma = getPrismaClient();
        const snapshotRow = await prisma.scenarioSnapshot.findFirst({
          where: { snapshotId: dynamicState.currentScenario.id },
          select: { scenarioId: true },
        });

        if (snapshotRow) {
          // Find scenario outline by scenario_id
          scenarioOutline = dynamicState.scenarioOutlines.find(
            (outline) => outline.id === snapshotRow.scenarioId
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
    if (!scenarioOutline && dynamicState.currentScenario?.name) {
      scenarioOutline = dynamicState.scenarioOutlines.find(
        (outline) => outline.name === dynamicState.currentScenario?.name
      );
    }
    const rawConnections = scenarioOutline?.connections || [];

    // Enrich connections with target scenario details
    const connections = rawConnections.map((conn) => {
      // Find target scenario outline by name or id
      const targetScenario = dynamicState.scenarioOutlines.find(
        (outline) =>
          outline.name === conn.scenarioName || outline.id === conn.scenarioName
      );

      return {
        scenarioName: targetScenario?.name || conn.scenarioName, // Use actual name from outline if found
        scenarioId: targetScenario?.id || conn.scenarioName, // Include ID
        relationshipType: conn.relationshipType,
        description: conn.description,
        blocked: conn.blocked,
        blockReason: conn.blockReason,
      };
    });

    // Log connections for debugging
    console.log(
      `\n🔗 [Orchestrator Agent] Current scenario connections (${connections.length}):`
    );
    if (connections.length > 0) {
      connections.forEach((conn, index) => {
        console.log(
          `   ${index + 1}. "${conn.scenarioName}" (ID: ${conn.scenarioId}) [${conn.relationshipType}]`
        );
        if (conn.description)
          console.log(`      Description: ${conn.description}`);
        if (conn.blocked) {
          console.log(
            `      ⚠️ BLOCKED: ${conn.blockReason || "No reason specified"}`
          );
        } else {
          console.log(`      ✓ Not blocked`);
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
      selectedSkill?: string | null;
      playerActionLogs?: string[];
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
          .map((turn) => {
            const playerSignals = extractHistoricalPlayerSignals(
              (turn as { actionResults?: unknown }).actionResults,
              (turn as { characterName?: unknown }).characterName
            );
            return {
              turnNumber: turn.turnNumber,
              characterInput: turn.characterInput,
              keeperNarrative: turn.keeperNarrative,
              selectedSkill: playerSignals.selectedSkill,
              playerActionLogs: playerSignals.playerActionLogs,
            };
          });

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
            selectedSkill?: string | null;
            playerActionLogs?: string[];
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
        topKTurns: 3,
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

    const relevantHistoryForPrompt = relevantHistory.filter(
      (item) => item.type === "turn"
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
    if (relevantHistory.length > relevantHistoryForPrompt.length) {
      console.debug(
        `[Orchestrator Agent] Withheld ${
          relevantHistory.length - relevantHistoryForPrompt.length
        } action-log item(s) from orchestrator prompt context`
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
        characterName,
        scenarioLocation,
        currentScenarioName,
        npcNames,
        conversationHistory, // Pass conversation history instead of single previousNarrative
        relevantHistory: relevantHistoryForPrompt,
        connections,
        hasSelectedSkill: !!selectedSkill, // Whether player has pre-selected a skill
      },
      "handlebars"
    );

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
        console.warn(
          "⚠️ [Orchestrator Agent] Failed to extract JSON from orchestrator response"
        );
        console.warn("Raw response:", response.substring(0, 500));
      } else {
        const parsedResponse = JSON.parse(jsonText);

        // Debug: Log the parsed sceneChangeRequest
        if (parsedResponse.sceneChangeRequest) {
          console.log(
            `\n🔍 [Orchestrator Agent] Parsed sceneChangeRequest:`,
            JSON.stringify(parsedResponse.sceneChangeRequest, null, 2)
          );
        } else {
          console.log(
            `\n⚠️ [Orchestrator Agent] No sceneChangeRequest in parsed response`
          );
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

          console.log(
            `🔍 [Orchestrator Agent] Checking sceneChangeRequest: shouldChange=${sceneChangeReq.shouldChange}, targetSceneName="${sceneChangeReq.targetSceneName}"`
          );

          if (sceneChangeReq.shouldChange && sceneChangeReq.targetSceneName) {
            // Valid scene change request - store in temporaryInfo
            const sceneChangeRequest: SceneChangeRequest = {
              shouldChange: true,
              targetSceneName: sceneChangeReq.targetSceneName,
              reason: sceneChangeReq.reason || "Scene change requested",
              timestamp: new Date(),
            };
            gameStateManager.setSceneChangeRequest(sceneChangeRequest);
            console.log(
              `✅ [Orchestrator Agent] Scene change request validated: ${sceneChangeReq.targetSceneName}`
            );
          } else {
            // No valid scene change request - clear any existing request
            console.log(
              `❌ [Orchestrator Agent] Scene change request invalid: shouldChange=${sceneChangeReq.shouldChange}, targetSceneName="${sceneChangeReq.targetSceneName}"`
            );
            gameStateManager.clearSceneChangeRequest();
          }
        } else {
          // No sceneChangeRequest in response - clear any existing request
          console.log(
            `⚠️ [Orchestrator Agent] No sceneChangeRequest field in response - clearing any existing request`
          );
          gameStateManager.clearSceneChangeRequest();
        }
      }
    } catch (error) {
      console.warn(
        "❌ [Orchestrator Agent] Failed to parse orchestrator response for action analysis:",
        error
      );
      console.warn("Response content:", response.substring(0, 500));
    }

    return response;
  }

  private normalizeActionAnalysis(
    rawAnalysis: any,
    fallbackCharacterName: string
  ): ActionAnalysis {
    const actionType = rawAnalysis.actionType as ActionType | undefined;
    return {
      character:
        rawAnalysis.character || rawAnalysis.player || fallbackCharacterName,
      action: rawAnalysis.action || "",
      actionType: actionType || "narrative",
      target: {
        name: rawAnalysis.target?.name ?? null,
        intent: rawAnalysis.target?.intent || "",
      },
      requiresSkillSelection: Boolean(rawAnalysis.requiresSkillSelection),
    };
  }
}
