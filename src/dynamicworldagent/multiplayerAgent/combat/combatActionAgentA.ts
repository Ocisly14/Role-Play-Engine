import { generateText } from "../../../models/index.js";
import { ModelClass } from "../../../models/types.js";
import type { PendingNpcAction } from "../../state/DynamicGameState.js";
import type { MultiplayerDynamicGameStateManager } from "../../multiplayerState/MultiplayerDynamicGameState.js";
import { buildCombatActionASystemPrompt } from "./combatActionAgentATemplate.js";
import { withCombatSkillDefaults } from "./combatSkillDefaults.js";

export interface CombatActionAResult {
  diceUsed: string[];
  actionLog: Array<{
    characterId: string;
    summary: string;
    successLevel?: string;
    time: string;
    location: string;
  }>;
  stateUpdate: {
    playerCharacters?: Array<{
      id: string;
      name: string;
      status?: { hp?: number; conditions?: string[] };
    }>;
    npcCharacters?: Array<{
      id: string;
      name: string;
      status?: { hp?: number; conditions?: string[] };
    }>;
  };
  timeElapsedMinutes: number;
  combatEnded: boolean;
  combatEndReason: string;
  defeatedNpcs: Array<{
    npcId: string;
    npcName: string;
  }>;
}

/**
 * Combat Action Agent A - Resolves player attack or player defense against NPC attacks
 * Uses MultiplayerDynamicGameStateManager directly (no adapter shim).
 */
export class CombatActionAgentA {
  private normalizeDefeatedNpcs(raw: unknown): Array<{
    npcId: string;
    npcName: string;
  }> {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const npcId = (item as Record<string, unknown>).npcId;
        const npcName = (item as Record<string, unknown>).npcName;
        if (typeof npcId !== "string" || typeof npcName !== "string") {
          return null;
        }
        const trimmedId = npcId.trim();
        const trimmedName = npcName.trim();
        if (!trimmedId || !trimmedName) return null;
        return { npcId: trimmedId, npcName: trimmedName };
      })
      .filter(
        (item): item is { npcId: string; npcName: string } => item !== null
      );
  }

  private preRollDice(): Record<string, number[]> {
    const roll = (sides: number, count: number): number[] =>
      Array.from(
        { length: count },
        () => Math.floor(Math.random() * sides) + 1
      );

    const d6_pairs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const pair = roll(6, 2);
      d6_pairs.push(pair[0] + pair[1]);
    }

    return {
      "1d100": roll(100, 10),
      "1d100_opposed": roll(100, 5),
      "1d20": roll(20, 5),
      "1d10": roll(10, 5),
      "1d8": roll(8, 5),
      "1d6": roll(6, 5),
      "2d6": d6_pairs,
      "1d4": roll(4, 5),
      "1d3": roll(3, 5),
    };
  }

  private parseResponse(response: string): CombatActionAResult | null {
    try {
      let jsonText = response.trim();
      const codeBlock = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (codeBlock) jsonText = codeBlock[1].trim();
      if (!jsonText.startsWith("{")) {
        const obj = jsonText.match(/\{[\s\S]*\}/);
        if (obj) jsonText = obj[0];
      }
      const parsed = JSON.parse(jsonText) as Partial<CombatActionAResult>;
      return {
        diceUsed: Array.isArray(parsed.diceUsed) ? parsed.diceUsed : [],
        actionLog: Array.isArray(parsed.actionLog) ? parsed.actionLog : [],
        stateUpdate:
          parsed.stateUpdate && typeof parsed.stateUpdate === "object"
            ? parsed.stateUpdate
            : {},
        timeElapsedMinutes:
          typeof parsed.timeElapsedMinutes === "number"
            ? parsed.timeElapsedMinutes
            : 1,
        combatEnded: parsed.combatEnded === true,
        combatEndReason:
          typeof parsed.combatEndReason === "string" ? parsed.combatEndReason : "",
        defeatedNpcs: this.normalizeDefeatedNpcs(parsed.defeatedNpcs),
      };
    } catch {
      return null;
    }
  }

  private buildContext(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    combatNpcIds: string[]
  ): string {
    const state = manager.getSceneRoomState(sceneRoomId);
    const fullGameTime = manager.getSceneRoomFullGameTime(sceneRoomId);

    const combatNpcs = state.npcCharacters
      .filter((npc: any) => combatNpcIds.includes(npc.id))
      .map((npc: any) => ({
        id: npc.id,
        name: npc.name,
        attributes: npc.attributes,
        status: npc.status,
        skills: withCombatSkillDefaults(npc.skills, npc.attributes),
        inventory: npc.inventory || [],
        weapons: (npc as any).weapons || [],
        personality: npc.personality,
        recentActionLog: (npc.actionLog || []).slice(-5),
      }));

    // Build player characters context (all players in sceneRoom)
    const allPlayers: any[] = (state as any).playerCharacters ?? [];
    const roundInputs: any[] =
      (state.temporaryInfo?.contextualData?.roundInputs as any[]) ?? [];
    const playerCharactersContext = allPlayers.map((player: any) => {
      // Determine acting vs skipped from roundInputs
      const input = roundInputs.find(
        (ri: any) => ri.characterId === player.id || ri.playerId === player.id
      );
      const acting =
        input && input.inputType !== "skip" && Boolean(input.content?.trim());
      return {
        id: player.id,
        name: player.name,
        role: acting ? "acting" : "skipped this round",
        attributes: player.attributes,
        status: player.status,
        skills: withCombatSkillDefaults(player.skills, player.attributes),
        inventory: player.inventory || [],
        weapons: (player as any).weapons || [],
        recentActionLog: (player.actionLog || []).slice(-5),
      };
    });

    // Fallback: if playerCharacters is empty, use single playerCharacter
    if (playerCharactersContext.length === 0 && state.playerCharacter) {
      const player = state.playerCharacter;
      playerCharactersContext.push({
        id: player.id,
        name: player.name,
        role: "acting",
        attributes: player.attributes,
        status: player.status,
        skills: withCombatSkillDefaults(player.skills, player.attributes),
        inventory: player.inventory || [],
        weapons: (player as any).weapons || [],
        recentActionLog: (player.actionLog || []).slice(-5),
      });
    }

    // Last 3 turns of conversation history (populated by Memory Agent before combat routing)
    const conversationHistory = (
      (state.temporaryInfo.contextualData?.conversationHistory as Array<{
        turnNumber: number;
        characterInput: string;
        keeperNarrative: string | null;
      }>) ?? []
    ).slice(-3);

    const historyBlock =
      conversationHistory.length > 0
        ? conversationHistory
            .map(
              (t: any) =>
                `[Turn ${t.turnNumber}]\nPlayer: ${t.characterInput}\nKeeper: ${t.keeperNarrative ?? "(no narrative)"}`
            )
            .join("\n\n")
        : "(no prior turns)";

    let ctx = `\n\n=== CURRENT GAME TIME ===\n${fullGameTime}\n=== END GAME TIME ===\n`;
    ctx += `\n\nCurrent Scene: ${state.currentScenario?.location || "Unknown"}\n`;
    ctx += `Scene Description: ${state.currentScenario?.description || ""}\n`;
    ctx += `\n\nPlayer Characters (player faction):\n${JSON.stringify(playerCharactersContext, null, 2)}`;
    ctx += `\n\nCombat NPCs:\n${JSON.stringify(combatNpcs, null, 2)}`;
    ctx += `\n\nCombat Round: ${state.combatState?.round ?? 1}`;
    ctx += `\n\n=== RECENT CONVERSATION (last 3 turns) ===\n${historyBlock}`;

    return ctx;
  }

  async resolvePlayerAttack(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    playerInput: string,
    selectedSkill: string | null,
    language: "en" | "zh"
  ): Promise<CombatActionAResult | null> {
    const state = manager.getSceneRoomState(sceneRoomId);
    const combatState = state.combatState;
    if (!combatState) return null;

    const preRolledDice = this.preRollDice();

    const systemPrompt = buildCombatActionASystemPrompt(
      "attack",
      preRolledDice,
      null,
      selectedSkill,
      playerInput,
      combatState.round,
      language,
      manager.isAnyPlayerFatigued(sceneRoomId)
    );

    const context = this.buildContext(manager, sceneRoomId, combatState.participantNpcIds);
    const fullPrompt = systemPrompt + context;

    const response = await generateText({
      runtime: {},
      context: fullPrompt,
      modelClass: ModelClass.MEDIUM,
    });

    return this.parseResponse(response);
  }

  async resolvePlayerDefense(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    playerInput: string,
    selectedSkill: string | null,
    pendingNpcActions: PendingNpcAction[],
    language: "en" | "zh"
  ): Promise<CombatActionAResult | null> {
    const state = manager.getSceneRoomState(sceneRoomId);
    const combatState = state.combatState;
    if (!combatState) return null;

    const preRolledDice = this.preRollDice();

    const systemPrompt = buildCombatActionASystemPrompt(
      "defend",
      preRolledDice,
      pendingNpcActions,
      selectedSkill,
      playerInput,
      combatState.round,
      language,
      manager.isAnyPlayerFatigued(sceneRoomId)
    );

    const context = this.buildContext(manager, sceneRoomId, combatState.participantNpcIds);
    const fullPrompt = systemPrompt + context;

    const response = await generateText({
      runtime: {},
      context: fullPrompt,
      modelClass: ModelClass.SMALL,
    });

    return this.parseResponse(response);
  }

  /**
   * Apply combat action result directly to the multiplayer manager (no adapter).
   * Used by the multiplayer graph node after resolvePlayerAttack.
   */
  applyResultForSceneRoom(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    result: CombatActionAResult
  ): void {
    const scr = manager.getSceneRoom(sceneRoomId);
    if (!scr) return;

    // Apply HP/condition deltas for each player character
    if (result.stateUpdate?.playerCharacters) {
      for (const pc of result.stateUpdate.playerCharacters) {
        // Find the playerId whose characterId or profile.id matches pc.id
        const matchedPlayerId = scr.memberPlayerIds.find((pid) => {
          const p = manager.getState().players[pid];
          return (
            p?.characterId === pc.id ||
            p?.profile?.id === pc.id ||
            p?.characterName === pc.name
          );
        });
        if (matchedPlayerId && pc.status) {
          if (pc.status.hp !== undefined && pc.status.hp !== null) {
            const player = manager.getState().players[matchedPlayerId];
            if (player?.profile?.status) {
              (player.profile.status as any).hp = Math.max(
                0,
                ((player.profile.status as any).hp ?? 0) + pc.status.hp
              );
            }
          }
          if (pc.status.conditions !== undefined) {
            const player = manager.getState().players[matchedPlayerId];
            if (player?.profile?.status) {
              (player.profile.status as any).conditions = pc.status.conditions;
            }
          }
        }
      }
    }

    // Apply NPC updates
    if (result.stateUpdate?.npcCharacters) {
      for (const npcUpd of result.stateUpdate.npcCharacters) {
        if (npcUpd.status) {
          manager.applyNpcActionUpdate(npcUpd.id, {
            hp: npcUpd.status.hp ?? null,
            conditions: npcUpd.status.conditions,
          });
        }
      }
    }

    // Add actionLog entries
    const fullTime = manager.getFullGameTime();
    const location = scr.currentScenario?.location || "Unknown";
    const playerCharIds = new Set(
      scr.memberPlayerIds.map((pid) => {
        const p = manager.getState().players[pid];
        return p?.characterId ?? p?.profile?.id ?? "";
      })
    );

    for (const entry of result.actionLog || []) {
      const logTime = entry.time || fullTime;
      const logLocation = entry.location || location;

      if (playerCharIds.has(entry.characterId)) {
        // Find the player and push to their profile's actionLog
        const pid = scr.memberPlayerIds.find((memberId) => {
          const p = manager.getState().players[memberId];
          return (
            p?.characterId === entry.characterId ||
            p?.profile?.id === entry.characterId
          );
        });
        if (pid) {
          const player = manager.getState().players[pid];
          if (player?.profile) {
            if (!(player.profile as any).actionLog)
              (player.profile as any).actionLog = [];
            (player.profile as any).actionLog.push({
              time: logTime,
              location: logLocation,
              summary: entry.summary,
              successLevel: entry.successLevel as any,
            });
          }
        }
      } else {
        const npc = manager
          .getState()
          .npcCharacters.find((n) => n.id === entry.characterId);
        if (npc) {
          if (!npc.actionLog) npc.actionLog = [];
          npc.actionLog.push({
            time: logTime,
            location: logLocation,
            summary: entry.summary,
            successLevel: entry.successLevel as any,
          });
        }
      }
    }

    // Advance game time
    if (result.timeElapsedMinutes > 0) {
      manager.advanceGameTime(result.timeElapsedMinutes);
    }
  }
}
