import type { ActionLogEntry } from "../../../shared/agents/models/gameTypes.js";
import type { DynamicGameState } from "../../state/index.js";
import type { DynamicCharacterProfile } from "../../world_builder/types.js";
import type { DynamicNPCProfile } from "../../world_builder/types.js";

/**
 * Character Agent class - NPC profile loading and scene character utilities.
 *
 * NPC response analysis (NPCResponseAnalysis generation) has been removed;
 * that responsibility is now handled by the TickProcessor's impact gate.
 */
export class CharacterAgent {
  /**
   * Scene data for template: name, location, description, conditions, connections.
   */
  extractSceneForTemplate(dynamicState: DynamicGameState): {
    name: string;
    location: string;
    description: string;
    conditionsJson: string;
    connectionsJson: string;
  } | null {
    const currentSceneId = dynamicState.currentSceneId;
    if (!currentSceneId) return null;

    const scene = dynamicState.scenes.get(currentSceneId);
    if (!scene) return null;

    const outline = dynamicState.scenarioOutlines.find(
      (o) => o.id === currentSceneId
    );
    const conditions = scene.conditions || [];
    const connections = scene.connections || [];

    return {
      name: scene.name ?? "",
      location: currentSceneId,
      description: scene.description ?? "",
      conditionsJson: JSON.stringify(conditions, null, 2),
      connectionsJson: JSON.stringify(connections, null, 2),
    };
  }

  /**
   * Characters in scene for template: id, name, role, status, location.
   * NPC presence is derived from npcLocations (single source of truth).
   */
  extractSceneCharactersForTemplate(dynamicState: DynamicGameState): any[] {
    const currentSceneId = dynamicState.currentSceneId;
    if (!currentSceneId) return [];

    return dynamicState.npcCharacters
      .filter(npc => dynamicState.npcLocations[npc.id] === currentSceneId)
      .map(npc => ({
        id: npc.id,
        name: npc.name,
        role: npc.occupation || "unknown",
        status: npc.status || "active",
        location: currentSceneId,
      }));
  }

  /**
   * Last 3 action logs per character (investigator + each scene NPC).
   */
  getLast3ActionLogPerCharacter(
    dynamicState: DynamicGameState,
    sceneCharacters: { name: string }[]
  ): { characterName: string; last3ActionLog: ActionLogEntry[] }[] {
    const out: { characterName: string; last3ActionLog: ActionLogEntry[] }[] =
      [];

    const player = dynamicState.playerCharacter;
    const playerLog = (player.actionLog || []).slice(-3);
    out.push({ characterName: player.name, last3ActionLog: playerLog });

    for (const sc of sceneCharacters) {
      const npc = dynamicState.npcCharacters.find((n) =>
        this.isNameSimilar(n.name, sc.name)
      );
      if (!npc) continue;
      const log = (npc.actionLog || []).slice(-3);
      out.push({ characterName: npc.name, last3ActionLog: log });
    }

    return out;
  }

  /**
   * Extract scenario information
   */
  extractScenarioInfo(dynamicState: DynamicGameState): any {
    const currentSceneId = dynamicState.currentSceneId;
    if (!currentSceneId) {
      return {
        hasScenario: false,
        message: "No current scenario loaded",
      };
    }

    const scene = dynamicState.scenes.get(currentSceneId);
    if (!scene) {
      return {
        hasScenario: false,
        message: "No current scene found",
      };
    }

    const scenarioOutline = dynamicState.scenarioOutlines.find(
      (outline) => outline.id === currentSceneId
    );

    // Characters in scene derived from npcLocations
    const sceneCharacters = dynamicState.npcCharacters
      .filter(npc => dynamicState.npcLocations[npc.id] === currentSceneId)
      .map(npc => ({ id: npc.id, name: npc.name, status: npc.status }));

    return {
      id: currentSceneId,
      name: scene.name,
      location: currentSceneId,
      description: scene.description,
      characters: sceneCharacters,
      conditions: scene.conditions || [],
      connections: scene.connections || [],
    };
  }

  /**
   * Extract character information (basic attributes)
   */
  extractCharacterInfo(character: DynamicCharacterProfile): any {
    return {
      id: character.id,
      name: character.name,
      attributes: character.attributes,
      status: character.status,
      skills: character.skills,
      inventory: character.inventory || [],
      notes: character.notes || "",
    };
  }

  /**
   * Extract NPCs in current scene.
   * NPC presence is derived from npcLocations (single source of truth).
   */
  extractSceneNPCs(dynamicState: DynamicGameState): any[] {
    const currentSceneId = dynamicState.currentSceneId;
    if (!currentSceneId) return [];

    const sceneNpcs = dynamicState.npcCharacters
      .filter(npc => dynamicState.npcLocations[npc.id] === currentSceneId);

    console.log(
      `\n[Extract Scene NPCs] Current scene: "${currentSceneId}"`
    );
    console.log(
      `[Extract Scene NPCs] Total NPCs in game: ${dynamicState.npcCharacters.length}`
    );
    console.log(
      `[Extract Scene NPCs] NPCs in scene: ${sceneNpcs.length} — ${sceneNpcs.map(n => n.name).join(", ") || "none"}\n`
    );

    return sceneNpcs;
  }

  /**
   * Get current location from actionLog (latest entry with location)
   */
  getCurrentLocationFromActionLog(
    actionLog?: ActionLogEntry[]
  ): string | null {
    if (!actionLog || actionLog.length === 0) {
      return null;
    }

    for (let i = actionLog.length - 1; i >= 0; i--) {
      if (actionLog[i].location) {
        return actionLog[i].location;
      }
    }

    return null;
  }

  /**
   * Extract NPC information (basic attributes)
   */
  extractNPCInfo(npc: DynamicCharacterProfile): any {
    const npcProfile = npc as DynamicNPCProfile;

    // Get recent actionLog (last 15 entries, roughly 3 turns)
    const npcActionLog = npc.actionLog || [];
    const recentActionLog = npcActionLog.slice(-15);

    return {
      id: npc.id,
      name: npc.name,
      occupation: npcProfile.occupation || "Unknown",
      age: npcProfile.age || "Unknown",
      appearance: npcProfile.appearance || "No description",
      personality: npcProfile.personality || "Unknown personality",
      background: npcProfile.background || "Unknown background",
      goals: npcProfile.goals || [],
      secrets: npcProfile.secrets || [],
      attributes: npc.attributes,
      status: npc.status,
      skills: npc.skills,
      inventory: npc.inventory || [],
      knowledge: npcProfile.knowledge || [],
      relationships: npcProfile.relationships || [],
      notes: npc.notes || "",
      recentActionLog: recentActionLog,
    };
  }

  /**
   * Normalize name (for fuzzy matching)
   */
  normalizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ")
      .trim();
  }

  /**
   * Calculate Levenshtein distance (edit distance) between two strings
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
  isNameSimilar(name1: string, name2: string): boolean {
    const na = this.normalizeName(name1);
    const nb = this.normalizeName(name2);
    if (!na || !nb) return false;
    if (na === nb) return true;

    // If first word is the same, consider similar
    const tokensA = na.split(/\s+/);
    const tokensB = nb.split(/\s+/);
    if (tokensA[0] && tokensA[0] === tokensB[0]) return true;

    // Calculate Levenshtein distance and convert to similarity
    const dist = this.levenshtein(na, nb);
    const maxLen = Math.max(na.length, nb.length);
    if (maxLen === 0) return false;
    const similarity = 1 - dist / maxLen;
    return similarity >= 0.8; // 80% similarity threshold
  }
}
