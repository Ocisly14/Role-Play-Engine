/**
 * Multiplayer Orchestrator Agent
 *
 * Differences from single-player:
 * - Processes ALL player inputs in one LLM call (roundInputs[])
 * - Outputs per-player ActionAnalysis + estimatedMinutes
 * - Validates time divergence: rejects round if any player's estimated time
 *   exceeds others' by >= 60 minutes (unless scene-transition exception)
 * - No isSimulatedQuery / simulatedQueryCount
 */

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
import type { MultiplayerDynamicGameStateManager } from "../../multiplayerState/MultiplayerDynamicGameState.js";
import type { MultiplayerTurnInput } from "../../multiplayerState/MultiplayerDynamicGameState.js";
import {
  extractRecentConversationHistory,
  retrieveRelevantHistory,
} from "../memory/memoryAgent.js";
import { getMultiplayerOrchestratorTemplate } from "./orchestratorTemplate.js";

// =============================================
// Output types
// =============================================

export interface PlayerActionAnalysis {
  playerId: string;
  characterId: string;
  actionAnalysis: ActionAnalysis;
  sceneChangeRequest: SceneChangeRequest | null;
  /** LLM-estimated minutes for this action (used for divergence check) */
  estimatedMinutes: number;
}

export interface MultiRoundValidation {
  status: "passed" | "rejected";
  code?: "round_rejected_time_divergence";
  reason?: string;
  estimatedMinutesByPlayer?: Record<string, number>;
  exemptedBySceneTransition?: boolean;
}

export interface OrchestratorResult {
  validation: MultiRoundValidation;
  playerAnalyses: PlayerActionAnalysis[];
}

// =============================================
// Runtime helpers
// =============================================

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

function normalizeActionAnalysis(raw: unknown): ActionAnalysis {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const validTypes: ActionType[] = [
    "exploration",
    "social",
    "stealth",
    "combat",
    "chase",
    "mental",
    "environmental",
    "narrative",
  ];
  const rawType = typeof obj.actionType === "string" ? obj.actionType : "";
  const actionType: ActionType = validTypes.includes(rawType as ActionType)
    ? (rawType as ActionType)
    : "exploration";

  const targetRaw = (obj.target ?? {}) as Record<string, unknown>;
  return {
    character: typeof obj.character === "string" ? obj.character : "Unknown",
    action: typeof obj.action === "string" ? obj.action : "",
    actionType,
    target: {
      name: typeof targetRaw.name === "string" ? targetRaw.name : null,
      intent:
        typeof targetRaw.intent === "string" ? targetRaw.intent : "unknown",
    },
    requiresSkillSelection:
      typeof obj.requiresSkillSelection === "boolean"
        ? obj.requiresSkillSelection
        : false,
  };
}

// =============================================
// Time divergence check
// =============================================

const TIME_DIVERGENCE_THRESHOLD_MINUTES = 60;

function checkTimeDivergence(
  playerAnalyses: PlayerActionAnalysis[]
): MultiRoundValidation {
  if (playerAnalyses.length <= 1) return { status: "passed" };

  const estimated = playerAnalyses.map((p) => p.estimatedMinutes);
  const sorted = [...estimated].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  const estimatedByPlayer: Record<string, number> = {};
  for (const pa of playerAnalyses) {
    estimatedByPlayer[pa.playerId] = pa.estimatedMinutes;
  }

  for (const pa of playerAnalyses) {
    const diff = pa.estimatedMinutes - median;
    if (diff >= TIME_DIVERGENCE_THRESHOLD_MINUTES) {
      const anySceneTransition = playerAnalyses.some(
        (p) => p.sceneChangeRequest?.shouldChange === true
      );
      if (anySceneTransition && pa.sceneChangeRequest?.shouldChange === true) {
        return {
          status: "passed",
          estimatedMinutesByPlayer: estimatedByPlayer,
          exemptedBySceneTransition: true,
        };
      }
      return {
        status: "rejected",
        code: "round_rejected_time_divergence",
        reason:
          `玩家 ${pa.playerId} 的行动预计耗时（约 ${pa.estimatedMinutes} 分钟）` +
          `比本轮其他玩家高出 ${diff} 分钟（超过 60 分钟阈值）。` +
          `请统一行动节奏，或拆分场景分别处理。`,
        estimatedMinutesByPlayer: estimatedByPlayer,
        exemptedBySceneTransition: false,
      };
    }
  }

  return { status: "passed", estimatedMinutesByPlayer: estimatedByPlayer };
}

// =============================================
// MultiplayerOrchestratorAgent
// =============================================

export class MultiplayerOrchestratorAgent {
  async processRound(
    roundInputs: MultiplayerTurnInput[],
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    db?: CoCDatabase | CoCDatabaseAdapter,
    language: "en" | "zh" = "zh"
  ): Promise<OrchestratorResult> {
    const runtime = createRuntime();
    const state = manager.getState();
    const sceneRoom = manager.getSceneRoom(sceneRoomId);
    if (!sceneRoom) throw new Error(`SceneRoom ${sceneRoomId} not found`);

    const currentScenario = sceneRoom.currentScenario;

    // Fetch scenario connections from DB
    let connections: any[] = [];
    if (currentScenario?.id) {
      try {
        const prisma = getPrismaClient();
        const snapshotRow = await prisma.scenarioSnapshot.findUnique({
          where: { snapshotId: currentScenario.id },
          select: { scenarioId: true },
        });
        if (snapshotRow?.scenarioId) {
          const scenarioRow = await prisma.scenario.findFirst({
            where: { scenarioId: snapshotRow.scenarioId },
            select: { connections: true },
          });
          if (scenarioRow?.connections) {
            connections = (scenarioRow.connections as any[]).map(
              (c: Record<string, unknown>) => ({
                scenarioName:
                  typeof c.scenarioName === "string" ? c.scenarioName : String(c.scenarioId ?? ""),
                relationshipType:
                  typeof c.relationshipType === "string" ? c.relationshipType : "connection",
                description:
                  typeof c.description === "string" ? c.description : undefined,
                blocked: Boolean(c.blocked),
                blockReason:
                  typeof c.blockReason === "string" ? c.blockReason : undefined,
              })
            );
          }
        }
      } catch (e) {
        console.warn("[MultiplayerOrchestrator] Failed to load connections:", e);
      }
    }

    // Fetch recent conversation history
    let conversationHistory: any[] = [];
    try {
      conversationHistory = await extractRecentConversationHistory(db, state.sessionId);
    } catch { /* non-fatal */ }

    // Relevant history (combined from all player inputs)
    const combinedQuery = roundInputs
      .filter((i) => i.inputType === "input" && i.content)
      .map((i) => i.content)
      .join(" ");
    let relevantHistory: any[] = [];
    try {
      if (combinedQuery && db) {
        const result = await retrieveRelevantHistory(db, state.sessionId, combinedQuery);
        relevantHistory = result ?? [];
      }
    } catch { /* non-fatal */ }

    // Build player context list for the prompt
    const playerContexts = roundInputs.map((input) => {
      const player = state.players[input.playerId];
      return {
        playerId: input.playerId,
        characterName: player?.characterName ?? input.playerId,
        inputType: input.inputType,
        content: input.content ?? "",
        selectedSkill: input.selectedSkill ?? null,
      };
    });

    const templateData = {
      currentScenarioName: currentScenario?.name ?? "Unknown Location",
      scenarioLocation: currentScenario?.location ?? "Unknown",
      npcNames: state.npcCharacters.map((n) => n.name).join(", ") || "None",
      connections: connections.length > 0 ? connections : null,
      players: playerContexts,
      conversationHistory: conversationHistory.length > 0 ? conversationHistory : null,
      relevantHistory: relevantHistory.length > 0 ? relevantHistory : null,
      language,
    };

    const prompt = composeTemplate(
      getMultiplayerOrchestratorTemplate(),
      templateData as any,
      {},
      "handlebars"
    );

    // Call LLM
    let rawResponse = "";
    try {
      rawResponse = await generateText({
        runtime,
        context: prompt,
        modelClass: ModelClass.SMALL,
      });
    } catch (err) {
      console.error("[MultiplayerOrchestrator] LLM call failed:", err);
      // Fallback: treat all inputs as exploration with no scene change
      const fallback: PlayerActionAnalysis[] = roundInputs.map((inp) => {
        const player = state.players[inp.playerId];
        return {
          playerId: inp.playerId,
          characterId: inp.characterId,
          actionAnalysis: {
            character: player?.characterName ?? inp.playerId,
            action: inp.content ?? "skip",
            actionType: "exploration" as ActionType,
            target: { name: null, intent: "unknown" },
            requiresSkillSelection: false,
          },
          sceneChangeRequest: null,
          estimatedMinutes: 5,
        };
      });
      return { validation: { status: "passed" }, playerAnalyses: fallback };
    }

    // Parse JSON response
    let parsed: { players: any[] } = { players: [] };
    try {
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch {
      console.warn("[MultiplayerOrchestrator] Failed to parse LLM JSON response");
    }

    // Build PlayerActionAnalysis per player
    const playerAnalyses: PlayerActionAnalysis[] = roundInputs.map((input) => {
      const player = state.players[input.playerId];
      const found = (parsed.players ?? []).find((p: any) => p.playerId === input.playerId);

      if (input.inputType === "skip") {
        return {
          playerId: input.playerId,
          characterId: input.characterId,
          actionAnalysis: {
            character: player?.characterName ?? input.playerId,
            action: "skip this round",
            actionType: "narrative" as ActionType,
            target: { name: null, intent: "skip" },
            requiresSkillSelection: false,
          },
          sceneChangeRequest: null,
          estimatedMinutes: 0,
        };
      }

      const actionAnalysis = normalizeActionAnalysis(found?.actionAnalysis ?? {});
      if (player) actionAnalysis.character = player.characterName;

      const scr = found?.sceneChangeRequest;
      const sceneChangeRequest: SceneChangeRequest | null =
        scr && typeof scr.shouldChange === "boolean"
          ? {
              shouldChange: Boolean(scr.shouldChange),
              targetSceneName:
                typeof scr.targetSceneName === "string" ? scr.targetSceneName : null,
              reason: typeof scr.reason === "string" ? scr.reason : "",
              timestamp: new Date(),
            }
          : null;

      return {
        playerId: input.playerId,
        characterId: input.characterId,
        actionAnalysis,
        sceneChangeRequest,
        estimatedMinutes:
          typeof found?.estimatedMinutes === "number" ? found.estimatedMinutes : 10,
      };
    });

    // Time divergence validation
    const validation = checkTimeDivergence(playerAnalyses);

    // Store analyses in sceneRoom temporaryInfo
    const existingTemp = sceneRoom.temporaryInfo;
    manager.updateSceneRoom(sceneRoomId, {
      temporaryInfo: {
        ...existingTemp,
        contextualData: {
          ...existingTemp.contextualData,
          playerActionAnalyses: Object.fromEntries(
            playerAnalyses.map((pa) => [pa.playerId, pa])
          ),
          relevantHistory,
        },
      },
    });

    return { validation, playerAnalyses };
  }
}
