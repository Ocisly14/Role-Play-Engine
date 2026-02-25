import { generateText } from "../../../models/index.js";
import { ModelClass } from "../../../models/types.js";
import type { ActionLogEntry } from "../../../shared/agents/models/gameTypes.js";
import type {
  ActionType,
  NPCResponseAnalysis,
} from "../../../shared/state/index.js";
import { composeTemplateWithImages } from "../../../template.js";
import type { MultiplayerDynamicGameStateManager } from "../../multiplayerState/MultiplayerDynamicGameState.js";
import {
  getLatestActionLogEntryWithLocation,
  isTimeAfter,
} from "../../utils/gameTime.js";
import type { DynamicCharacterProfile } from "../../world_builder/types.js";
import type { DynamicNPCProfile } from "../../world_builder/types.js";
import { getCharacterTemplate } from "./characterTemplate.js";

/**
 * Character Agent class - handles NPC response analysis (Multiplayer Native)
 */
export class CharacterAgent {
  /**
   * Analyze NPC responses to character actions
   * Uses MultiplayerDynamicGameStateManager + sceneRoomId natively.
   */
  async analyzeNPCResponses(
    _runtime: any,
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    _language: "en" | "zh" = "zh"
  ): Promise<NPCResponseAnalysis[]> {
    const state = manager.getState();
    const sceneRoom = manager.getSceneRoom(sceneRoomId);
    if (!sceneRoom) return [];

    const template = getCharacterTemplate();

    // 1. All players' action results from this round (from sceneRoom.temporaryInfo)
    const investigatorActionResults =
      this.getInvestigatorActionResults(sceneRoom, state);

    // 2. Current game time
    const gameTime = manager.getFullGameTime();

    // 3. Scene snapshot (name, location, description, conditions, connections)
    const sceneSnapshot = this.extractSceneSnapshotForTemplate(sceneRoom, state);

    // 4. Characters in scene (restricted fields)
    const sceneCharacters = this.extractSceneCharactersForTemplate(sceneRoom, state);

    if (sceneCharacters.length === 0) {
      console.log(
        "📝 [Character Agent] No NPCs in current scene, skipping response analysis"
      );
      return [];
    }

    // 5. Last 3 action logs per character (all investigator players + each scene NPC)
    const recentActionLogPerCharacter = this.getLast3ActionLogPerCharacter(
      manager,
      sceneRoomId,
      sceneCharacters
    );

    const templateContext = {
      investigatorActionResults:
        investigatorActionResults.length > 0 ? investigatorActionResults : null,
      investigatorActionResultsJson:
        investigatorActionResults.length > 0
          ? JSON.stringify(investigatorActionResults, null, 2)
          : "",
      gameTime,
      sceneSnapshot,
      sceneCharactersJson: JSON.stringify(sceneCharacters, null, 2),
      recentActionLogPerCharacter:
        recentActionLogPerCharacter.length > 0
          ? recentActionLogPerCharacter
          : null,
      recentActionLogPerCharacterJson:
        recentActionLogPerCharacter.length > 0
          ? JSON.stringify(recentActionLogPerCharacter, null, 2)
          : "",
    };

    const { content: context, images } = composeTemplateWithImages(
      template,
      // Only used for optional scenario image collection; multiplayer state is not a full DynamicGameState.
      { dynamicGameState: ({ currentScenario: sceneRoom.currentScenario } as any) },
      templateContext,
      "handlebars"
    );

    console.log("\n🎭 [Character Agent] Analyzing NPC responses...");
    console.log(`   Scene: ${sceneSnapshot?.location ?? "Unknown"}`);
    console.log(`   NPCs to analyze: ${sceneCharacters.length}`);

    const response = await generateText({
      runtime: {},
      context,
      images,
      modelClass: ModelClass.SMALL,
    });

    return this.parseNPCResponseAnalyses(response);
  }

  /**
   * Get all player action results from sceneRoom temporaryInfo (investigator = any player).
   */
  private getInvestigatorActionResults(
    sceneRoom: ReturnType<MultiplayerDynamicGameStateManager["getSceneRoom"]>,
    state: ReturnType<MultiplayerDynamicGameStateManager["getState"]>
  ): any[] {
    if (!sceneRoom) return [];
    const actionResults = sceneRoom.temporaryInfo.actionResults;
    if (!actionResults || actionResults.length === 0) return [];

    // Collect all player character names in this sceneRoom
    const playerNames = new Set(
      sceneRoom.memberPlayerIds
        .map((id) => state.players[id]?.characterName)
        .filter(Boolean)
    );

    return actionResults
      .filter(
        (r: { character?: string }) =>
          !r.character || playerNames.has(r.character)
      )
      .map((r: any) => ({
        gameTime: r.gameTime,
        timeElapsedMinutes: r.timeElapsedMinutes,
        location: r.location,
        character: r.character,
        result: r.result,
        timeConsumption: r.timeConsumption,
        scenarioChanges: r.scenarioChanges || [],
      }));
  }

  /**
   * Scene snapshot for template: name, location, description, conditions, connections.
   */
  private extractSceneSnapshotForTemplate(
    sceneRoom: ReturnType<MultiplayerDynamicGameStateManager["getSceneRoom"]>,
    state: ReturnType<MultiplayerDynamicGameStateManager["getState"]>
  ): { name: string; location: string; description: string; conditionsJson: string; connectionsJson: string } | null {
    if (!sceneRoom) return null;
    const scenario = sceneRoom.currentScenario;
    if (!scenario) return null;

    const outline = state.scenarioOutlines.find((o) => o.id === scenario.id);
    const conditions = scenario.conditions || [];
    const connections = outline?.connections || [];

    return {
      name: scenario.name ?? "",
      location: scenario.location ?? "",
      description: scenario.description ?? "",
      conditionsJson: JSON.stringify(conditions, null, 2),
      connectionsJson: JSON.stringify(connections, null, 2),
    };
  }

  /**
   * Characters in scene for template.
   */
  private extractSceneCharactersForTemplate(
    sceneRoom: ReturnType<MultiplayerDynamicGameStateManager["getSceneRoom"]>,
    state: ReturnType<MultiplayerDynamicGameStateManager["getState"]>
  ): any[] {
    if (!sceneRoom) return [];
    const scenario = sceneRoom.currentScenario;
    if (!scenario?.location) return [];

    const scenarioLocation = scenario.location;
    const snapshotTime =
      (scenario as any).gameTime ??
      `Day ${state.gameDay}, ${state.timeOfDay}`;
    const out: any[] = [];
    const seen = new Set<string>();

    const add = (
      npc: DynamicCharacterProfile,
      locationInScene: string | null,
      scenarioStatus?: string
    ) => {
      const key = this.normalizeName(npc.name);
      if (seen.has(key)) return;
      seen.add(key);
      const npcProfile = npc as DynamicNPCProfile;
      out.push({
        name: npc.name,
        status: scenarioStatus ?? npc.status,
        location: locationInScene ?? scenarioLocation,
        age: npcProfile.age ?? null,
        gender: (npcProfile as { gender?: string }).gender ?? null,
        appearance: npcProfile.appearance ?? null,
        personality: npcProfile.personality ?? null,
        goals: npcProfile.goals ?? [],
        secrets: npcProfile.secrets ?? [],
        background: npcProfile.background ?? null,
        inventory: npc.inventory ?? [],
        relationship: npcProfile.relationships ?? [],
      });
    };

    const alreadyAdded = (name: string) =>
      out.some((c) => this.isNameSimilar(c.name, name));

    for (const sc of scenario.characters || []) {
      const npc = state.npcCharacters.find((n) =>
        this.isNameSimilar(n.name, sc.name)
      );
      if (!npc) continue;
      const latest = getLatestActionLogEntryWithLocation(npc.actionLog);
      if (
        latest &&
        isTimeAfter(latest.time, snapshotTime) &&
        latest.location.toLowerCase() !== scenarioLocation.toLowerCase()
      ) {
        continue;
      }
      add(npc, sc.location ?? null, sc.status);
    }

    for (const npc of state.npcCharacters) {
      if (alreadyAdded(npc.name)) continue;
      const latest = getLatestActionLogEntryWithLocation(
        (npc as DynamicNPCProfile).actionLog
      );
      if (
        latest &&
        isTimeAfter(latest.time, snapshotTime) &&
        latest.location.toLowerCase() === scenarioLocation.toLowerCase()
      ) {
        add(npc, latest.location, undefined);
      }
    }

    return out;
  }

  /**
   * Last 3 action logs per character (all investigator players + each scene NPC).
   */
  private getLast3ActionLogPerCharacter(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    sceneCharacters: { name: string }[]
  ): { characterName: string; last3ActionLog: ActionLogEntry[] }[] {
    const state = manager.getState();
    const sceneRoom = manager.getSceneRoom(sceneRoomId);
    const out: { characterName: string; last3ActionLog: ActionLogEntry[] }[] = [];

    // All players in this sceneRoom
    if (sceneRoom) {
      for (const playerId of sceneRoom.memberPlayerIds) {
        const player = state.players[playerId];
        if (!player) continue;
        const playerLog = (player.profile.actionLog || []).slice(-3);
        out.push({ characterName: player.characterName, last3ActionLog: playerLog });
      }
    }

    for (const sc of sceneCharacters) {
      const npc = state.npcCharacters.find((n) =>
        this.isNameSimilar(n.name, sc.name)
      );
      if (!npc) continue;
      const log = (npc.actionLog || []).slice(-3);
      out.push({ characterName: npc.name, last3ActionLog: log });
    }

    return out;
  }

  /**
   * Normalize name (for fuzzy matching)
   */
  private normalizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ")
      .trim();
  }

  /**
   * Calculate Levenshtein distance
   */
  private levenshtein(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      Array(n + 1).fill(0)
    );

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
      }
    }
    return dp[m][n];
  }

  /**
   * Determine if two names are similar (similarity >= 80%)
   */
  private isNameSimilar(name1: string, name2: string): boolean {
    const na = this.normalizeName(name1);
    const nb = this.normalizeName(name2);
    if (!na || !nb) return false;
    if (na === nb) return true;

    const tokensA = na.split(/\s+/);
    const tokensB = nb.split(/\s+/);
    if (tokensA[0] && tokensA[0] === tokensB[0]) return true;

    const dist = this.levenshtein(na, nb);
    const maxLen = Math.max(na.length, nb.length);
    if (maxLen === 0) return false;
    const similarity = 1 - dist / maxLen;
    return similarity >= 0.8;
  }

  /**
   * Parse and validate NPC response analyses from LLM response
   */
  private parseNPCResponseAnalyses(response: string): NPCResponseAnalysis[] {
    let parsed;
    try {
      let jsonText = response.trim();

      const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (codeBlockMatch) {
        jsonText = codeBlockMatch[1].trim();
      }

      if (!jsonText.startsWith("{") && !jsonText.startsWith("[")) {
        const jsonObjectMatch = jsonText.match(/\{[\s\S]*\}/);
        if (jsonObjectMatch) {
          jsonText = jsonObjectMatch[0];
        }
      }

      parsed = JSON.parse(jsonText);
    } catch (error) {
      console.error(`❌ [Character Agent] JSON parsing error:`, error);
      return [];
    }

    const analyses: NPCResponseAnalysis[] = [];

    const validActionTypes: ActionType[] = [
      "exploration",
      "social",
      "stealth",
      "combat",
      "chase",
      "mental",
      "environmental",
      "narrative",
    ];

    if (
      parsed.npcResponseAnalyses &&
      Array.isArray(parsed.npcResponseAnalyses)
    ) {
      for (const analysis of parsed.npcResponseAnalyses) {
        if (analysis.npcName && typeof analysis.willRespond === "boolean") {
          let responseType: ActionType | "none" | null = null;
          if (analysis.willRespond) {
            if (analysis.responseType === "none") {
              responseType = "none";
            } else if (
              analysis.responseType &&
              validActionTypes.includes(analysis.responseType as ActionType)
            ) {
              responseType = analysis.responseType as ActionType;
            } else {
              responseType = null;
            }
          }

          const validated: NPCResponseAnalysis = {
            npcName: analysis.npcName,
            willRespond: analysis.willRespond,
            responseType: responseType,
            responseDescription: analysis.responseDescription || "",
            executionOrder:
              typeof analysis.executionOrder === "number"
                ? analysis.executionOrder
                : 999,
            targetCharacter: analysis.targetCharacter || null,
          };

          analyses.push(validated);
          console.log(
            `   ✓ ${validated.npcName}: ${validated.willRespond ? validated.responseType : "no response"}`
          );
        }
      }
    }

    console.log(
      `\n✅ [Character Agent] Analyzed ${analyses.length} NPC responses`
    );

    return analyses;
  }
}
