import type { ActionLogEntry } from "../../../shared/agents/models/gameTypes.js";
import type { DynamicGameState } from "../../state/index.js";
import {
  getLatestActionLogEntryWithLocation,
  isTimeAfter,
} from "../../utils/gameTime.js";
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
   * Scene snapshot for template: name, location, description, conditions, connections.
   */
  extractSceneSnapshotForTemplate(dynamicState: DynamicGameState): {
    name: string;
    location: string;
    description: string;
    conditionsJson: string;
    connectionsJson: string;
  } | null {
    const scenario = dynamicState.currentScenario;
    if (!scenario) return null;

    const outline = dynamicState.scenarioOutlines.find(
      (o) => o.id === scenario.id
    );
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
   * Characters in scene for template: name, status, location, age, gender, appearance,
   * personality, goals, secrets, background, inventory, relationship only.
   * No actionLog -> use scenario.characters as authority; exclude left, include arrived.
   */
  extractSceneCharactersForTemplate(dynamicState: DynamicGameState): any[] {
    const scenario = dynamicState.currentScenario;
    if (!scenario?.location) return [];

    const scenarioLocation = scenario.location;
    const snapshotTime =
      scenario.gameTime ??
      `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
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

    // 1. From scenario.characters: exclude only if we can prove they left.
    for (const sc of scenario.characters || []) {
      const npc = dynamicState.npcCharacters.find((n) =>
        this.isNameSimilar(n.name, sc.name)
      );
      if (!npc) continue;
      const latest = getLatestActionLogEntryWithLocation(npc.actionLog);
      if (
        latest &&
        isTimeAfter(latest.time, snapshotTime) &&
        latest.location.toLowerCase() !== scenarioLocation.toLowerCase()
      ) {
        continue; // left, don't add
      }
      add(npc, sc.location ?? null, sc.status);
    }

    // 2. From all NPCs: include only if actionLog shows arrived.
    for (const npc of dynamicState.npcCharacters) {
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
    const currentScenario = dynamicState.currentScenario;

    if (!currentScenario) {
      return {
        hasScenario: false,
        message: "No current scenario loaded",
      };
    }

    const scenarioOutline = dynamicState.scenarioOutlines.find(
      (outline) => outline.id === currentScenario.id
    );

    return {
      id: currentScenario.id,
      name: currentScenario.name,
      location: currentScenario.location,
      description: currentScenario.description,
      characters: currentScenario.characters || [],
      clues: currentScenario.clues || [],
      conditions: currentScenario.conditions || [],
      connections: scenarioOutline?.connections || [],
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
   * Extract NPCs in current scene location.
   * - If NPC has no actionLog (or no entry with time+location), use scenario.characters as the authority.
   * - From scenario.characters: exclude only when latest actionLog is after snapshot time and location !== current scene (left).
   * - From all NPCs: include when latest actionLog is after snapshot time and location === current scene (arrived).
   */
  extractSceneNPCs(dynamicState: DynamicGameState): any[] {
    const currentScenario = dynamicState.currentScenario;

    if (!currentScenario || !currentScenario.location) {
      return [];
    }

    const scenarioLocation = currentScenario.location;
    const snapshotTime =
      currentScenario.gameTime ??
      `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
    const sceneNpcs: any[] = [];
    let addedBySnapshot = 0;
    let excludedLeft = 0;
    let addedByArrived = 0;

    console.log(
      `\n[Extract Scene NPCs] Current location: "${scenarioLocation}"`
    );
    console.log(`[Extract Scene NPCs] Snapshot time: "${snapshotTime}"`);
    console.log(
      `[Extract Scene NPCs] Scenario characters list: ${currentScenario.characters?.map((c) => c.name).join(", ") || "none"}`
    );
    console.log(
      `[Extract Scene NPCs] Total NPCs in game: ${dynamicState.npcCharacters.length}`
    );

    const alreadyInScene = (name: string) =>
      sceneNpcs.some((sn) => this.isNameSimilar(sn.name, name));

    // 1. From scenario.characters: include unless we can prove they "left".
    for (const scenarioChar of currentScenario.characters || []) {
      const matchingNpc = dynamicState.npcCharacters.find((npc) =>
        this.isNameSimilar(npc.name, scenarioChar.name)
      );

      if (!matchingNpc) {
        console.log(
          `   No match found for scenario character: "${scenarioChar.name}"`
        );
        continue;
      }

      const latest = getLatestActionLogEntryWithLocation(matchingNpc.actionLog);
      if (
        latest &&
        isTimeAfter(latest.time, snapshotTime) &&
        latest.location.toLowerCase() !== scenarioLocation.toLowerCase()
      ) {
        console.log(
          `   Excluded (left): "${matchingNpc.name}" (latest: ${latest.location} at ${latest.time})`
        );
        excludedLeft++;
        continue;
      }

      sceneNpcs.push(this.extractNPCInfo(matchingNpc));
      console.log(`   Added from scenario.characters: "${matchingNpc.name}"`);
      addedBySnapshot++;
    }

    // 2. From all NPCs: include only if actionLog shows they "arrived".
    for (const npc of dynamicState.npcCharacters) {
      if (alreadyInScene(npc.name)) continue;

      const latest = getLatestActionLogEntryWithLocation(
        (npc as DynamicNPCProfile).actionLog
      );
      if (
        latest &&
        isTimeAfter(latest.time, snapshotTime) &&
        latest.location.toLowerCase() === scenarioLocation.toLowerCase()
      ) {
        sceneNpcs.push(this.extractNPCInfo(npc));
        console.log(
          `   Added by actionLog (arrived): "${npc.name}" (location: "${latest.location}" at ${latest.time})`
        );
        addedByArrived++;
      }
    }

    console.log(`\n[Extract Scene NPCs] Summary:`);
    console.log(`   From scenario.characters (not left): ${addedBySnapshot}`);
    console.log(`   Excluded (left): ${excludedLeft}`);
    console.log(`   From actionLog (arrived): ${addedByArrived}`);
    console.log(`   Total NPCs in scene: ${sceneNpcs.length}\n`);

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
      clues: npcProfile.clues || [],
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
