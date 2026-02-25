/**
 * Multiplayer Orchestrator Agent
 *
 * Differences from single-player:
 * - Processes ALL player inputs in one LLM call (roundInputs[])
 * - Outputs per-player ActionAnalysis
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
import {
  getLatestActionLogEntryWithLocation,
  isTimeAfter,
} from "../../utils/gameTime.js";

// =============================================
// Output types
// =============================================

export interface PlayerActionAnalysis {
  playerId: string;
  characterId: string;
  actionAnalysis: ActionAnalysis;
  sceneChangeRequest: SceneChangeRequest | null;
}

export interface MultiRoundValidation {
  status: "passed";
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
// MultiplayerOrchestratorAgent
// =============================================

export class MultiplayerOrchestratorAgent {
  private extractSceneNpcsForOrchestrator(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string
  ): Array<{ id: string; name: string; status: unknown; recentActionLog: unknown[] }> {
    const state = manager.getState();
    const sceneRoom = manager.getSceneRoom(sceneRoomId);
    const scenario = sceneRoom?.currentScenario;
    const location = scenario?.location;
    if (!location) return [];

    const snapshotTime =
      (scenario as any)?.gameTime ?? `Day ${state.gameDay}, ${state.timeOfDay}`;

    const out: Array<{ id: string; name: string; status: unknown; recentActionLog: unknown[] }> = [];
    const seen = new Set<string>();

    const add = (npc: any) => {
      if (!npc?.id || !npc?.name) return;
      if (seen.has(npc.id)) return;
      seen.add(npc.id);
      out.push({
        id: npc.id,
        name: npc.name,
        status: npc.status ?? null,
        recentActionLog: Array.isArray(npc.actionLog) ? npc.actionLog.slice(-3) : [],
      });
    };

    // Prefer scenario snapshot character list as authority.
    for (const sc of scenario?.characters ?? []) {
      const npc = state.npcCharacters.find((n) => n?.name === sc?.name) ??
        state.npcCharacters.find((n) =>
          typeof n?.name === "string" &&
          typeof sc?.name === "string" &&
          n.name.toLowerCase() === sc.name.toLowerCase()
        );
      if (!npc) continue;
      const latest = getLatestActionLogEntryWithLocation(npc.actionLog);
      if (
        latest &&
        isTimeAfter(latest.time, snapshotTime) &&
        typeof latest.location === "string" &&
        latest.location.toLowerCase() !== location.toLowerCase()
      ) {
        continue;
      }
      add(npc);
    }

    // Include NPCs whose latest actionLog places them here after snapshot time.
    for (const npc of state.npcCharacters) {
      const latest = getLatestActionLogEntryWithLocation(npc.actionLog);
      if (
        latest &&
        isTimeAfter(latest.time, snapshotTime) &&
        typeof latest.location === "string" &&
        latest.location.toLowerCase() === location.toLowerCase()
      ) {
        add(npc);
      }
    }

    return out;
  }

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

    // SceneRoom-scoped conversation history (DB-backed; do NOT leak other sceneRooms).
    const conversationHistory = await extractRecentConversationHistory(
      db,
      state.sessionId,
      3,
      sceneRoomId
    );

    // Relevant history (combined from all player inputs)
    const effectiveRoundInputs = roundInputs.filter(
      (i) => i.inputType === "input" && Boolean(i.content?.trim())
    );
    const combinedQuery = effectiveRoundInputs.map((i) => i.content?.trim()).join(" ");
    let relevantHistory: any[] = [];
    try {
      if (combinedQuery && db) {
        const result = await retrieveRelevantHistory(db, state.sessionId, combinedQuery, {
          sceneRoomId,
          language,
          sceneName: currentScenario?.name ?? undefined,
          sceneLocation: currentScenario?.location ?? undefined,
          npcNames: state.npcCharacters.map((n) => n.name).filter(Boolean),
          currentLocation: currentScenario?.location ?? undefined,
          topKTurns: 5,
        });
        relevantHistory = result ?? [];
      }
    } catch { /* non-fatal */ }

    // Build sceneRoom-scoped player injection (ONLY players with input this round; skip/no-input omitted)
    const inputPlayerIds = new Set(effectiveRoundInputs.map((i) => i.playerId));
    const scenePlayers = sceneRoom.memberPlayerIds
      .map((playerId) => {
        if (!inputPlayerIds.has(playerId)) return null;
        const player = state.players[playerId];
        if (!player) return null;
        const input = effectiveRoundInputs.find((ri) => ri.playerId === playerId);
        const thisRoundInput = input
          ? {
              inputType: "input" as const,
              content: input.content?.trim() ?? "",
              selectedSkill: input.selectedSkill ?? null,
              skillSelectionMode: input.skillSelectionMode ?? "manual",
            }
          : null;
        return {
          roleType: "player" as const,
          playerId,
          characterId: player.characterId,
          name: player.characterName,
          // Orchestrator only needs a light view; keep full profile out of the prompt.
          status: (player.profile as any)?.status ?? null,
          attributes: (player.profile as any)?.attributes ?? null,
          ...(thisRoundInput ? { thisRoundInput } : {}),
        };
      })
      .filter(Boolean);

    const roundInputsJson = effectiveRoundInputs
      .map((i) => ({
        playerId: i.playerId,
        characterId: i.characterId,
        inputType: "input" as const,
        content: i.content?.trim() ?? "",
        selectedSkill: i.selectedSkill ?? null,
        skillSelectionMode: i.skillSelectionMode ?? "manual",
      }));

    const sceneNpcs = this.extractSceneNpcsForOrchestrator(manager, sceneRoomId);

    const templateData = {
      sceneRoomId,
      currentScenarioName: currentScenario?.name ?? "Unknown Location",
      scenarioLocation: currentScenario?.location ?? "Unknown",
      npcNames: state.npcCharacters.map((n) => n.name).join(", ") || "None",
      connections: connections.length > 0 ? connections : null,
      scenePlayersJson: JSON.stringify(scenePlayers, null, 2),
      sceneNpcsJson: JSON.stringify(sceneNpcs, null, 2),
      roundInputsJson: JSON.stringify(roundInputsJson, null, 2),
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
      const fallback: PlayerActionAnalysis[] = effectiveRoundInputs.map((inp) => {
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
    const playerAnalyses: PlayerActionAnalysis[] = effectiveRoundInputs.map((input) => {
      const player = state.players[input.playerId];
      const found = (parsed.players ?? []).find((p: any) => p.playerId === input.playerId);

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
      };
    });

    const validation: MultiRoundValidation = { status: "passed" };

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
          conversationHistory,
          relevantHistory,
        },
      },
    });

    return { validation, playerAnalyses };
  }
}
