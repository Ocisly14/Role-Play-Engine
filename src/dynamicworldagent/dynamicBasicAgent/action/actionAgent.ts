import { generateText } from "../../../models/index.js";
import { ModelClass } from "../../../models/types.js";
import type { ScenarioLoader } from "../../../shared/agents/memory/scenarioloader/index.js";
import type {
  ActionLogEntry,
  NPCRelationship,
} from "../../../shared/agents/models/gameTypes.js";
import type {
  ActionAnalysis,
  ActionResult,
  NPCResponseAnalysis,
  SceneChangeRequest,
} from "../../../shared/state/index.js";
import type {
  CombatState,
  PendingNpcAction,
} from "../../state/DynamicGameState.js";
import type { DynamicGameState } from "../../state/index.js";
import { DynamicGameStateManager } from "../../state/index.js";
import {
  getLatestActionLogEntryWithLocation,
  isTimeAfter,
} from "../../utils/gameTime.js";
import type { DynamicCharacterProfile } from "../../world_builder/types.js";
import type { DynamicNPCProfile } from "../../world_builder/types.js";
import { getStaticSkillDefaults } from "../skillDefaults.js";
import { buildActionSystemPrompt } from "./actionTemplate.js";

/**
 * Action Agent class - handles action resolution and skill checks
 */
export class ActionAgent {
  private scenarioLoader?: ScenarioLoader;

  constructor(scenarioLoader?: ScenarioLoader) {
    this.scenarioLoader = scenarioLoader;
  }

  private clampAttitude(value: unknown): number | null {
    if (typeof value !== "number" || Number.isNaN(value)) return null;
    const rounded = Math.round(value);
    if (rounded > 100) return 100;
    if (rounded < -100) return -100;
    return rounded;
  }

  private hasSkillCheckFromDice(diceUsed: unknown): boolean {
    if (!Array.isArray(diceUsed)) return false;
    return diceUsed.some((entry) => {
      if (typeof entry !== "string") return false;
      const text = entry.toLowerCase();
      return text.includes("1d100") || /\b\d+%/.test(text);
    });
  }

  private sanitizeActionLogsBySkillUsage(
    actionLogs: unknown,
    hasSkillCheck: boolean
  ): unknown {
    if (!Array.isArray(actionLogs)) return actionLogs;
    return actionLogs.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const cleaned = { ...(entry as Record<string, unknown>) };
      if (!hasSkillCheck && "successLevel" in cleaned) {
        delete cleaned.successLevel;
      }
      return cleaned;
    });
  }

  private sanitizeSuccessLevels(parsed: Record<string, unknown>): void {
    const playerUsedSkill = this.hasSkillCheckFromDice(parsed.diceUsed);
    parsed.actionLog = this.sanitizeActionLogsBySkillUsage(
      parsed.actionLog,
      playerUsedSkill
    );

    if (Array.isArray(parsed.npcResponses)) {
      parsed.npcResponses = parsed.npcResponses.map((response) => {
        if (!response || typeof response !== "object") return response;
        const cleaned = { ...(response as Record<string, unknown>) };
        const npcUsedSkill = this.hasSkillCheckFromDice(cleaned.diceUsed);
        cleaned.actionLog = this.sanitizeActionLogsBySkillUsage(
          cleaned.actionLog,
          npcUsedSkill
        );
        return cleaned;
      });
    }
  }

  private parseOpeningPendingNpcActions(raw: unknown): PendingNpcAction[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const data = item as Record<string, unknown>;
        const npcId = data.npcId;
        const npcName = data.npcName;
        const actionNarrative = data.actionNarrative;
        if (
          typeof npcId !== "string" ||
          typeof npcName !== "string" ||
          typeof actionNarrative !== "string"
        ) {
          return null;
        }
        const cleanedNarrative = actionNarrative.trim();
        if (!cleanedNarrative) return null;
        return {
          npcId,
          npcName,
          actionNarrative: cleanedNarrative,
        } satisfies PendingNpcAction;
      })
      .filter((item): item is PendingNpcAction => item !== null);
  }

  private parseJsonFromModelResponse(
    response: string,
    label: string
  ): Record<string, unknown> | null {
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

      const parsed = JSON.parse(jsonText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      console.error(`❌ [Action Agent] Failed to parse ${label} JSON:`, error);
      return null;
    }
  }

  /**
   * Apply relationship changes already embedded in the main action parsed response.
   * Replaces the old separate LLM call for relationship updates.
   */
  private applyRelationshipChangesFromParsed(
    parsed: Record<string, unknown>,
    gameStateManager: DynamicGameStateManager
  ): void {
    try {
      const rawUpdates = parsed.relationshipChanges;
      if (!Array.isArray(rawUpdates) || rawUpdates.length === 0) {
        return;
      }

      const dynamicState = gameStateManager.getState();
      const allNpcs = dynamicState.npcCharacters;

      const npcById = new Map<string, DynamicNPCProfile>();
      for (const npc of allNpcs) {
        npcById.set(npc.id, npc);
      }
      // Also allow player as a target
      const playerChar = dynamicState.playerCharacter;

      // Group raw updates by sourceNpcId
      const updatesBySource = new Map<string, NPCRelationship[]>();

      for (const item of rawUpdates) {
        if (!item || typeof item !== "object") continue;
        const raw = item as Record<string, unknown>;
        const sourceNpcId = raw.sourceNpcId;
        const targetId = raw.targetId;
        if (typeof sourceNpcId !== "string" || typeof targetId !== "string")
          continue;
        if (!npcById.has(sourceNpcId)) continue;
        if (sourceNpcId === targetId) continue;

        const targetName =
          typeof raw.targetName === "string" && raw.targetName.trim()
            ? raw.targetName.trim()
            : (npcById.get(targetId)?.name ?? playerChar.name);

        const rel: NPCRelationship = {
          targetId,
          targetName,
          relationshipType: (typeof raw.relationshipType === "string" &&
          raw.relationshipType.trim()
            ? raw.relationshipType.trim()
            : "neutral") as NPCRelationship["relationshipType"],
          attitude: this.clampAttitude(raw.attitude) ?? 0,
          ...(typeof raw.description === "string" && raw.description.trim()
            ? { description: raw.description.trim() }
            : {}),
        };

        if (!updatesBySource.has(sourceNpcId)) {
          updatesBySource.set(sourceNpcId, []);
        }
        updatesBySource.get(sourceNpcId)!.push(rel);
      }

      if (updatesBySource.size === 0) return;

      const npcCharactersUpdate = [...updatesBySource.entries()].map(
        ([id, relationships]) => ({
          id,
          name: npcById.get(id)!.name,
          relationships,
        })
      );

      // updateCharacter() in applyActionUpdate handles the upsert merge by targetId
      gameStateManager.applyActionUpdate({
        npcCharacters: npcCharactersUpdate,
      });
      console.log(
        `   ✓ Relationship updates applied: ${rawUpdates.length} changes across ${npcCharactersUpdate.length} NPCs`
      );
    } catch (error) {
      console.warn(
        "   ⚠️ [Action Agent] Relationship update generation failed, skipped:",
        error
      );
    }
  }

  /**
   * Unified method to process any character's action (player or NPC)
   */
  private async processCharacterAction(
    runtime: any,
    dynamicState: DynamicGameState,
    character: DynamicCharacterProfile,
    actionDescription: string,
    options: {
      isNPC: boolean;
      npcResponse?: NPCResponseAnalysis;
      targetCharacter?: DynamicCharacterProfile | null;
      selectedSkill?: string | null;
      skillSelectionMode?: "auto" | "manual";
      language?: "en" | "zh";
    },
    gameStateManager: DynamicGameStateManager,
    originalUserInput?: string | null
  ): Promise<DynamicGameState> {
    const {
      isNPC,
      npcResponse,
      targetCharacter,
      selectedSkill,
      skillSelectionMode,
    } = options;
    const language =
      options.language === "en" || options.language === "zh"
        ? options.language
        : "zh";

    // Pre-roll dice
    const preRolledDice = this.preRollDice();

    // Get existing scene change request
    const existingSceneChangeRequest =
      dynamicState.temporaryInfo.sceneChangeRequest;

    // Extract scene NPCs for player actions (for NPC response analysis)
    // Exclude the target character to avoid duplicating data already injected as Target NPC
    const sceneNPCs = !isNPC
      ? this.extractSceneNPCsForAction(dynamicState).filter(
          (npc) =>
            !targetCharacter ||
            (npc.id !== targetCharacter.id && npc.name !== targetCharacter.name)
        )
      : null;
    const targetIntent = !isNPC
      ? (dynamicState.temporaryInfo.currentActionAnalysis?.target?.intent ?? "")
      : "";

    // Build system prompt using template
    const baseSystemPrompt = buildActionSystemPrompt(
      originalUserInput,
      actionDescription,
      preRolledDice,
      isNPC,
      existingSceneChangeRequest,
      sceneNPCs,
      !isNPC ? (selectedSkill ?? null) : null,
      !isNPC ? skillSelectionMode : undefined,
      targetIntent,
      language
    );

    const systemPrompt = baseSystemPrompt;

    // Single call - no tool loop needed with pre-rolled dice
    const context = this.buildContext(
      dynamicState,
      character,
      { isNPC, npcResponse, targetCharacter },
      gameStateManager
    );
    const fullPrompt = systemPrompt + context;

    const response = await generateText({
      runtime,
      context: fullPrompt,
      modelClass: ModelClass.MEDIUM,
    });

    // Parse JSON response
    let parsed;
    try {
      let jsonText = response.trim();

      const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (codeBlockMatch) {
        jsonText = codeBlockMatch[1].trim();
        console.log(
          `📝 [Action Agent] Detected markdown code block, extracted JSON content`
        );
      }

      if (!jsonText.startsWith("{") && !jsonText.startsWith("[")) {
        const jsonObjectMatch = jsonText.match(/\{[\s\S]*\}/);
        if (jsonObjectMatch) {
          jsonText = jsonObjectMatch[0];
          console.log(`📝 [Action Agent] Extracted JSON object from text`);
        }
      }

      parsed = JSON.parse(jsonText);
      if (parsed && typeof parsed === "object") {
        this.sanitizeSuccessLevels(parsed as Record<string, unknown>);
      }
    } catch (error) {
      console.error(`❌ [Action Agent] JSON parsing error:`, error);
      console.error(
        `   Error type: ${error instanceof Error ? error.constructor.name : typeof error}`
      );
      console.error(
        `   Error message: ${error instanceof Error ? error.message : String(error)}`
      );
      console.error(
        `   Original response (first 500 chars): ${response.substring(0, 500)}${response.length > 500 ? "..." : ""}`
      );
      console.error(
        `   Original response length: ${response.length} characters`
      );
      return this.buildErrorResult(
        dynamicState,
        character,
        `Invalid JSON response from model: ${error instanceof Error ? error.message : String(error)}`,
        [],
        isNPC,
        gameStateManager
      );
    }

    // Extract dice usage from response
    const diceUsed = parsed.diceUsed || [];

    // Return final result
    return await this.buildFinalResult(
      runtime,
      dynamicState,
      character,
      parsed,
      diceUsed,
      { isNPC, npcResponse, targetCharacter },
      gameStateManager
    );
  }

  async processAction(
    runtime: any,
    gameStateManager: DynamicGameStateManager,
    userMessage: string,
    selectedSkill?: string | null,
    skillSelectionMode?: "auto" | "manual",
    language?: "en" | "zh"
  ): Promise<void> {
    const dynamicState = gameStateManager.getState();
    const actionAnalysis = dynamicState.temporaryInfo.currentActionAnalysis;
    const targetCharacter = this.findTargetCharacter(
      dynamicState,
      actionAnalysis
    );

    const updatedState = await this.processCharacterAction(
      runtime,
      dynamicState,
      dynamicState.playerCharacter,
      userMessage,
      {
        isNPC: false,
        targetCharacter,
        selectedSkill: selectedSkill ?? null,
        skillSelectionMode,
        language,
      },
      gameStateManager,
      userMessage // Pass original user input
    );

    // The state has been updated through the manager in buildFinalResult
    // No need to do anything else here
  }

  /**
   * Pre-roll common dice expressions
   */
  private preRollDice() {
    const rollDice = (sides: number, count = 1): number[] => {
      return Array.from(
        { length: count },
        () => Math.floor(Math.random() * sides) + 1
      );
    };

    // Pre-roll 1d100: 10 results
    const d100_results = rollDice(100, 10);

    // Pre-roll 1d100_opposed: 5 results
    const d100_opposed_results = rollDice(100, 5);

    // Pre-roll other dice types: 5 results each
    const d20_results = rollDice(20, 5);
    const d10_results = rollDice(10, 5);
    const d8_results = rollDice(8, 5);
    const d6_results = rollDice(6, 5);
    const d4_results = rollDice(4, 5);
    const d3_results = rollDice(3, 5);

    // For 2d6, roll 5 pairs and sum each pair
    const d6_pairs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const pair = rollDice(6, 2);
      d6_pairs.push(pair[0] + pair[1]);
    }

    return {
      "1d100": d100_results, // 10 results for single skill checks
      "1d100_opposed": d100_opposed_results, // 5 results for opposed checks
      "1d20": d20_results, // 5 results
      "1d10": d10_results, // 5 results
      "1d8": d8_results, // 5 results
      "1d6": d6_results, // 5 results
      "2d6": d6_pairs, // 5 results (sum of 2d6)
      "1d4": d4_results, // 5 results
      "1d3": d3_results, // 5 results
    };
  }

  /**
   * Find target character based on action analysis or NPC response
   */
  private findTargetCharacter(
    dynamicState: DynamicGameState,
    actionAnalysis?: ActionAnalysis | null,
    npcResponse?: NPCResponseAnalysis
  ): DynamicCharacterProfile | null {
    let targetName: string | null = null;

    if (npcResponse?.targetCharacter) {
      targetName = npcResponse.targetCharacter;
    } else if (actionAnalysis?.target?.name) {
      targetName = actionAnalysis.target.name;
    }

    if (!targetName) {
      return null;
    }

    const targetLower = targetName.toLowerCase();

    // Check if target is player
    if (dynamicState.playerCharacter.name.toLowerCase().includes(targetLower)) {
      return dynamicState.playerCharacter;
    }

    // Check NPCs
    const targetNpc = dynamicState.npcCharacters.find(
      (npc) =>
        npc.name.toLowerCase().includes(targetLower) ||
        npc.id.toLowerCase().includes(targetLower)
    );

    return targetNpc || null;
  }

  /**
   * Filter character profile to remove unnecessary fields for action context
   * Removes: backstory, background, clues, instantiatedFrom,
   * inheritsKnowledge, actionLog
   * Keeps: occupation, notes, and all core fields (id, name, attributes, status, inventory, skills, weapons, derivedAttributes, etc.)
   */
  private filterCharacterForContext(
    character: DynamicCharacterProfile
  ): Partial<DynamicCharacterProfile> {
    const {
      backstory,
      background,
      clues,
      instantiatedFrom,
      inheritsKnowledge,
      actionLog,
      ...filteredCharacter
    } = character as any;

    return {
      ...filteredCharacter,
      // Only include skills explicitly set in the character file.
      // Missing skills fall back to the shared default table injected in buildContext.
      skills: filteredCharacter.skills ?? {},
    };
  }

  /**
   * Extract NPCs in current scene for action context
   * Returns filtered NPC information (only essential fields)
   */
  private extractSceneNPCsForAction(dynamicState: DynamicGameState): any[] {
    const scenario = dynamicState.currentScenario;
    if (!scenario?.location) return [];

    const scenarioLocation = scenario.location;
    const snapshotTime =
      scenario.gameTime ??
      `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
    const out: any[] = [];
    const seen = new Set<string>();

    // Helper to normalize names for deduplication
    const normalizeName = (name: string): string => {
      return name
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ")
        .trim();
    };

    // Helper to check if names are similar
    const isNameSimilar = (name1: string, name2: string): boolean => {
      const na = normalizeName(name1);
      const nb = normalizeName(name2);
      if (!na || !nb) return false;
      if (na === nb) return true;
      const tokensA = na.split(/\s+/);
      const tokensB = nb.split(/\s+/);
      if (tokensA[0] && tokensA[0] === tokensB[0]) return true;
      return false;
    };

    const addNPC = (npc: DynamicNPCProfile) => {
      const key = normalizeName(npc.name);
      if (seen.has(key)) return;
      seen.add(key);

      // Filter NPC to only include essential fields
      const filtered = this.filterCharacterForContext(npc);

      // Get last 3 actionLog entries
      const last3ActionLog = (npc.actionLog || []).slice(-3);

      out.push({
        id: filtered.id,
        name: filtered.name,
        appearance: filtered.appearance ?? null,
        age: filtered.age ?? null,
        gender: filtered.gender ?? null,
        personality: filtered.personality ?? null,
        attributes: filtered.attributes,
        status: filtered.status,
        skills: filtered.skills,
        inventory: filtered.inventory || [],
        occupation: filtered.occupation || null,
        notes: filtered.notes || null,
        goals: npc.goals || [],
        secrets: npc.secrets || [],
        relationships: npc.relationships || [],
        last3ActionLog: last3ActionLog, // Add last 3 actionLog entries
      });
    };

    // 1. From scenario.characters: include unless we can prove they "left" (latest actionLog
    //    after snapshot time and location !== current scene). If no actionLog → use scene NPC as authority (include).
    for (const sc of scenario.characters || []) {
      const npc = dynamicState.npcCharacters.find((n) =>
        isNameSimilar(n.name, sc.name)
      );
      if (!npc) continue;
      const latest = getLatestActionLogEntryWithLocation(npc.actionLog);
      if (
        latest &&
        isTimeAfter(latest.time, snapshotTime) &&
        latest.location.toLowerCase() !== scenarioLocation.toLowerCase()
      ) {
        // NPC's latest actionLog is after snapshot and they're elsewhere → left, don't inject
        continue;
      }
      addNPC(npc);
    }

    // 2. From all NPCs: include only if we have actionLog showing they "arrived" (latest after snapshot and at current scene). If no actionLog, do not add here (scene NPC list is the authority).
    for (const npc of dynamicState.npcCharacters) {
      const latest = getLatestActionLogEntryWithLocation(npc.actionLog);
      if (
        latest &&
        isTimeAfter(latest.time, snapshotTime) &&
        latest.location.toLowerCase() === scenarioLocation.toLowerCase()
      ) {
        addNPC(npc);
      }
    }

    return out;
  }

  /**
   * Unified method to build context for any character action
   */
  private buildContext(
    dynamicState: DynamicGameState,
    character: DynamicCharacterProfile,
    options: {
      isNPC: boolean;
      npcResponse?: NPCResponseAnalysis;
      targetCharacter?: DynamicCharacterProfile | null;
    },
    gameStateManager?: DynamicGameStateManager
  ): string {
    const { isNPC, npcResponse } = options;
    const { targetCharacter } = options;

    // Add current game time information for actionLog generation
    const fullGameTime = gameStateManager
      ? gameStateManager.getFullGameTime()
      : `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
    let context = `\n\n=== CURRENT GAME TIME ===\n${fullGameTime}\n=== END OF GAME TIME ===\n`;

    // Inject skill defaults once — character skill fields only list explicitly set values.
    // For any skill not present in a character's skills object, use these base values.
    // Dodge default = character DEX ÷ 2.
    const skillDefaults = getStaticSkillDefaults();
    context += `\n=== DEFAULT SKILL VALUES (for skills not listed in a character's profile) ===\n${JSON.stringify(skillDefaults)}\nDodge: character DEX ÷ 2\n=== END DEFAULT SKILL VALUES ===\n`;
    context += "\n\nCurrent Scenario:\n";
    if (dynamicState.currentScenario) {
      // Find the corresponding scenario outline to get connections
      const scenarioOutline = dynamicState.scenarioOutlines.find(
        (outline) => outline.id === dynamicState.currentScenario!.id
      );

      const scenarioInfo = {
        name: dynamicState.currentScenario.name,
        location: dynamicState.currentScenario.location,
        description: dynamicState.currentScenario.description,
        conditions: dynamicState.currentScenario.conditions,
        connections: scenarioOutline?.connections || [], // Array of {scenarioName, relationshipType, description} - only "leads_to" connections allow scene change
      };
      context += JSON.stringify(scenarioInfo, null, 2);
    } else {
      context += "No current scenario";
    }

    // Add scene change information only if there's a valid scene change request from orchestrator
    const existingSceneChangeRequest =
      dynamicState.temporaryInfo.sceneChangeRequest;
    const hasValidSceneChangeRequest =
      existingSceneChangeRequest?.shouldChange === true &&
      existingSceneChangeRequest?.targetSceneName;

    if (hasValidSceneChangeRequest && !isNPC) {
      context += `\n\n=== SCENE CHANGE REQUEST ===`;
      context += `\nTarget Scene: ${existingSceneChangeRequest.targetSceneName}`;
      context += `\nReason: ${existingSceneChangeRequest.reason || "Scene change requested"}`;
      context += `\nYour task: Determine if the current action enables this scene change (check for obstructions, skill requirements, etc.)`;
      context += `\n=== END OF SCENE CHANGE REQUEST ===\n`;
    }

    // Add temporary rules if any
    if (dynamicState.temporaryInfo.rules.length > 0) {
      context += "\n\nTemporary Rules:\n";
      dynamicState.temporaryInfo.rules.forEach((rule, index) => {
        context += `${index + 1}. ${rule}\n`;
      });
    }

    const defeatedNpcHistory = Array.isArray(dynamicState.defeatedNpcHistory)
      ? dynamicState.defeatedNpcHistory
          .filter(
            (entry): entry is { name: string; count: number } =>
              !!entry &&
              typeof entry.name === "string" &&
              typeof entry.count === "number" &&
              entry.name.trim().length > 0 &&
              Number.isFinite(entry.count) &&
              entry.count > 0
          )
          .map((entry) => ({
            name: entry.name.trim(),
            count: Math.floor(entry.count),
          }))
      : [];

    context +=
      "\n\n=== DEFEATED NPC HISTORY (name + times defeated) ===\n" +
      (defeatedNpcHistory.length > 0
        ? JSON.stringify(defeatedNpcHistory, null, 2)
        : "[]") +
      "\n=== END DEFEATED NPC HISTORY ===\n";

    // Add acting character (filtered to remove unnecessary fields)
    const filteredCharacter = this.filterCharacterForContext(character);
    context +=
      `\n\n${isNPC ? "NPC (acting character)" : "Character"}:\n` +
      JSON.stringify(filteredCharacter, null, 2);

    // Add target character if applicable (filtered to remove unnecessary fields)
    if (targetCharacter) {
      const isPlayerTarget =
        targetCharacter.id === dynamicState.playerCharacter.id ||
        targetCharacter.name === dynamicState.playerCharacter.name;
      const filteredTargetCharacter =
        this.filterCharacterForContext(targetCharacter);
      context +=
        `\n\nTarget ${isPlayerTarget ? "Character (Player)" : "NPC"}:\n` +
        JSON.stringify(filteredTargetCharacter, null, 2);
    }

    // Add NPC response context if NPC action
    if (isNPC && npcResponse) {
      context += "\n\nNPC Response Context:\n";
      context += JSON.stringify(
        {
          responseDescription: npcResponse.responseDescription,
          executionOrder: npcResponse.executionOrder,
        },
        null,
        2
      );
    }

    return context;
  }

  /**
   * Unified method to build final result for any character action
   */
  private async buildFinalResult(
    runtime: any,
    dynamicState: DynamicGameState,
    character: DynamicCharacterProfile,
    parsed: any,
    toolLogs: string[],
    options: {
      isNPC: boolean;
      npcResponse?: NPCResponseAnalysis;
      targetCharacter?: DynamicCharacterProfile | null;
    },
    gameStateManager: DynamicGameStateManager
  ): Promise<DynamicGameState> {
    const { isNPC, npcResponse, targetCharacter } = options;

    // Apply the state update from LLM result
    if (parsed.stateUpdate) {
      gameStateManager.applyActionUpdate(parsed.stateUpdate);
    }

    // Handle combat entry detection (only for player actions, not NPC reactions)
    if (!isNPC && parsed.entersCombat === true) {
      const participantIds: string[] = Array.isArray(
        parsed.combatParticipantIds
      )
        ? (parsed.combatParticipantIds as string[]).filter(
            (id) => typeof id === "string"
          )
        : [];
      const initiatedBy: CombatState["initiatedBy"] =
        parsed.combatInitiatedBy === "npc" ? "npc" : "player";

      // Only enter combat if we're not already in battle
      const currentState = gameStateManager.getState();
      if (!currentState.isBattle) {
        gameStateManager.setCombatState({
          round: 1,
          participantNpcIds: participantIds,
          initiatedBy,
          pendingNpcActions: null,
        });

        // Reset opening-combat contextual data for this turn
        gameStateManager.setContextualData("openingPendingNpcActions", null);

        // For NPC-initiated combat, carry opening pending actions from normal action output.
        if (initiatedBy === "npc") {
          const openingPending = this.parseOpeningPendingNpcActions(
            parsed.openingPendingNpcActions
          );
          if (openingPending.length > 0) {
            gameStateManager.setContextualData(
              "openingPendingNpcActions",
              openingPending
            );
          }
        }

        // Set flag so the graph can detect this turn just entered combat
        gameStateManager.setContextualData("justEnteredCombat", true);
        console.log(
          `⚔️  [Action Agent] Combat entered! Participants: [${participantIds.join(", ")}], initiated by: ${initiatedBy}`
        );
      }
    }

    // Handle scene change modification from Action Agent
    // Action Agent modifies the existing sceneChangeRequest from Orchestrator
    const currentSceneChangeRequest =
      dynamicState.temporaryInfo.sceneChangeRequest;
    if (parsed.sceneChange && currentSceneChangeRequest) {
      // Update the existing sceneChangeRequest based on action result
      const updatedRequest: SceneChangeRequest = {
        shouldChange: parsed.sceneChange.shouldChange,
        targetSceneName:
          parsed.sceneChange.targetSceneName ||
          currentSceneChangeRequest.targetSceneName,
        reason: parsed.sceneChange.reason || currentSceneChangeRequest.reason,
        timestamp: currentSceneChangeRequest.timestamp,
      };
      gameStateManager.setSceneChangeRequest(updatedRequest);

      if (!isNPC) {
        // Player scene change: log the result
        if (parsed.sceneChange.shouldChange) {
          console.log(
            `Action Agent: Action succeeded, scene change to ${updatedRequest.targetSceneName} will proceed`
          );
        } else {
          console.log(
            `Action Agent: Action failed, scene change blocked - ${parsed.sceneChange.reason || "Unknown reason"}`
          );
        }
      }
    } else if (
      parsed.sceneChange &&
      isNPC &&
      parsed.sceneChange.shouldChange &&
      parsed.sceneChange.targetSceneName
    ) {
      // NPC scene change: create new request for NPC
      const targetSceneName = parsed.sceneChange.targetSceneName;
      console.log(
        `\n📍 [Action Agent] NPC ${character.name} requested scene transition: ${targetSceneName}`
      );

      if (this.scenarioLoader) {
        const searchResult = await this.scenarioLoader.searchScenarios({
          name: targetSceneName,
        });

        if (searchResult.scenarios.length > 0) {
          const currentState = gameStateManager.getState();
          const npcInState = currentState.npcCharacters.find(
            (n) => n.id === character.id
          );

          if (npcInState) {
            // Location is tracked via actionLog
            console.log(
              `   ✓ NPC ${character.name} scene change requested: ${targetSceneName} (location tracked via actionLog)`
            );
          } else {
            console.warn(
              `   ⚠️  NPC ${character.name} (ID: ${character.id}) not found in dynamicState`
            );
          }
        } else {
          console.warn(`   ⚠️  Scene "${targetSceneName}" not found`);
        }
      } else {
        console.warn(
          `   ⚠️  ScenarioLoader not initialized, unable to find scene location`
        );
      }
    }

    // Apply scenario updates if provided (clues handled by Keeper)
    const scenarioChanges: string[] = [];
    const scenarioUpdate = parsed.scenarioUpdate
      ? { ...parsed.scenarioUpdate }
      : null;
    if (scenarioUpdate && "clues" in scenarioUpdate) {
      delete scenarioUpdate.clues;
    }
    if (scenarioUpdate) {
      gameStateManager.updateScenarioState(scenarioUpdate);

      // Generate scenario change descriptions for action results
      if (scenarioUpdate.description) {
        scenarioChanges.push("Environment description updated");
      }

      if (scenarioUpdate.conditions && scenarioUpdate.conditions.length > 0) {
        scenarioChanges.push(
          `Environmental conditions changed: ${scenarioUpdate.conditions.map((c: any) => c.description).join(", ")}`
        );
      }
    }

    // Create structured action result
    const actionResult: ActionResult = {
      timestamp: new Date(),
      gameTime: dynamicState.timeOfDay || "Unknown time",
      timeElapsedMinutes: parsed.timeElapsedMinutes || 0,
      location: dynamicState.currentScenario?.location || "Unknown location",
      character: character.name,
      result:
        parsed.summary ||
        (Array.isArray(parsed.actionLog) &&
        typeof parsed.actionLog[0]?.summary === "string"
          ? parsed.actionLog[0].summary
          : undefined) ||
        (isNPC && npcResponse?.responseDescription) ||
        "performed an action",
      diceRolls: toolLogs.map((log) => log), // toolLogs already contain "expression -> result" format
      timeConsumption: parsed.timeConsumption || "instant", // Default to instant if not specified
      scenarioChanges: scenarioChanges.length > 0 ? scenarioChanges : undefined,
    };

    // Add to action results
    gameStateManager.addActionResult(actionResult);

    // Record full action output for downstream prompts (keeper)
    const detailedResult = this.buildDetailedActionResult(
      character,
      parsed,
      isNPC,
      toolLogs
    );
    gameStateManager.addActionResultDetail(detailedResult);

    // Log detailed action result
    const logPrefix = isNPC
      ? `📊 [NPC Action Result] ${character.name}`
      : `📊 [Action Result] Detailed execution result`;
    console.log(`\n${logPrefix}:`);
    if (!isNPC) {
      console.log(`   Character: ${actionResult.character}`);
      console.log(`   Location: ${actionResult.location}`);
      console.log(`   Game Time: ${actionResult.gameTime}`);
      console.log(
        `   Time Elapsed: ${actionResult.timeElapsedMinutes || 0} minutes`
      );
      console.log(`   Time Consumption: ${actionResult.timeConsumption}`);
    }
    console.log(`   Result: ${actionResult.result}`);
    if (isNPC && npcResponse) {
      console.log(`   Type: ${npcResponse.responseType}`);
    }
    if (actionResult.diceRolls && actionResult.diceRolls.length > 0) {
      console.log(
        `   Dice Rolls${isNPC ? "" : ` (${actionResult.diceRolls.length})`}: ${isNPC ? actionResult.diceRolls.join(", ") : ""}`
      );
      if (!isNPC) {
        actionResult.diceRolls.forEach((roll, index) => {
          console.log(`     [${index + 1}] ${roll}`);
        });
      }
    } else if (!isNPC) {
      console.log(`   Dice Rolls: None`);
    }
    if (
      actionResult.scenarioChanges &&
      actionResult.scenarioChanges.length > 0 &&
      !isNPC
    ) {
      console.log(
        `   Scenario Changes (${actionResult.scenarioChanges.length}):`
      );
      actionResult.scenarioChanges.forEach((change, index) => {
        console.log(`     [${index + 1}] ${change}`);
      });
    }

    // Update game time based on elapsed time
    // IMPORTANT: Only player actions advance game time, NPC reactions do not
    if (
      actionResult.timeElapsedMinutes &&
      actionResult.timeElapsedMinutes > 0
    ) {
      if (!isNPC) {
        // Only advance time for player actions
        const oldDay = dynamicState.gameDay;
        const oldTime = dynamicState.timeOfDay;
        gameStateManager.updateGameTime(actionResult.timeElapsedMinutes);
        const updatedState = gameStateManager.getState();
        const newDay = updatedState.gameDay;
        const newTime = updatedState.timeOfDay;
        const fullTime = gameStateManager.getFullGameTime();

        console.log(
          `⏰ Time advanced by ${actionResult.timeElapsedMinutes} minutes (Player action)`
        );
        if (newDay > oldDay) {
          console.log(`   Day ${oldDay}, ${oldTime} → ${fullTime} 🌅`);
        } else {
          console.log(`   ${oldTime} → ${fullTime}`);
        }
      } else {
        // NPC actions have time elapsed but don't advance game time
        console.log(
          `⏰ NPC action time: ${actionResult.timeElapsedMinutes} minutes (not counted in game time)`
        );
      }
    }

    // Process NPC responses if this is a player action
    if (!isNPC && parsed.npcResponses && Array.isArray(parsed.npcResponses)) {
      const npcResponses = parsed.npcResponses
        .filter(
          (r: any) =>
            r.willRespond && r.responseType && r.responseType !== "none"
        )
        .sort(
          (a: any, b: any) =>
            (a.executionOrder || 999) - (b.executionOrder || 999)
        );

      if (npcResponses.length > 0) {
        console.log(
          `\n🎭 [Action Agent] Processing ${npcResponses.length} NPC responses...`
        );

        const currentState = gameStateManager.getState();
        const fullGameTime = gameStateManager.getFullGameTime();

        for (const npcResponse of npcResponses) {
          const npc = currentState.npcCharacters.find(
            (n) =>
              n.id === npcResponse.npcId ||
              n.name.toLowerCase() === npcResponse.npcName.toLowerCase()
          );

          if (!npc) {
            console.warn(
              `⚠️ [Action Agent] NPC not found: ${npcResponse.npcName} (ID: ${npcResponse.npcId})`
            );
            continue;
          }

          console.log(
            `\n🎭 [Action Agent] Processing NPC response [${npcResponse.executionOrder}]: ${npc.name} (${npcResponse.responseType})`
          );

          // Create ActionResult for NPC response
          const npcActionResult: ActionResult = {
            timestamp: new Date(),
            gameTime: currentState.timeOfDay || "Unknown time",
            timeElapsedMinutes: 0, // NPC reactions don't advance time
            location:
              currentState.currentScenario?.location || "Unknown location",
            character: npc.name,
            result: npcResponse.summary || `${npc.name} responds`,
            diceRolls: npcResponse.diceUsed || [],
            timeConsumption: "instant",
            scenarioChanges: undefined,
          };

          gameStateManager.addActionResult(npcActionResult);

          // Update NPC state if provided
          if (npcResponse.stateUpdate) {
            const npcStateUpdate: any = {
              npcCharacters: [
                {
                  id: npc.id,
                  name: npc.name,
                  ...npcResponse.stateUpdate,
                },
              ],
            };
            gameStateManager.applyActionUpdate(npcStateUpdate);
          }

          // Add actionLog entries for NPC
          if (npcResponse.actionLog && Array.isArray(npcResponse.actionLog)) {
            const updatedStateAfterUpdate = gameStateManager.getState();
            const npcInState = updatedStateAfterUpdate.npcCharacters.find(
              (n) => n.id === npc.id
            );

            if (npcInState) {
              if (!npcInState.actionLog) {
                npcInState.actionLog = [];
              }

              for (const logEntry of npcResponse.actionLog) {
                if (logEntry.time && logEntry.location && logEntry.summary) {
                  const npcUsedSkill = this.hasSkillCheckFromDice(
                    npcResponse.diceUsed
                  );
                  const actionLogEntry: ActionLogEntry = {
                    time: logEntry.time,
                    location: logEntry.location,
                    summary: logEntry.summary,
                    successLevel:
                      npcUsedSkill && typeof logEntry.successLevel === "string"
                        ? logEntry.successLevel
                        : undefined,
                  };
                  npcInState.actionLog.push(actionLogEntry);
                }
              }
            }
          } else {
            // Fallback: create a basic actionLog entry
            const updatedStateAfterUpdate = gameStateManager.getState();
            const npcInState = updatedStateAfterUpdate.npcCharacters.find(
              (n) => n.id === npc.id
            );

            if (npcInState) {
              if (!npcInState.actionLog) {
                npcInState.actionLog = [];
              }

              const locationName =
                currentState.currentScenario?.location || "Unknown location";
              const fallbackLogEntry: ActionLogEntry = {
                time: fullGameTime,
                location: locationName,
                summary: npcResponse.summary || `${npc.name} responds`,
                successLevel: this.hasSkillCheckFromDice(npcResponse.diceUsed)
                  ? "unknown"
                  : undefined,
              };
              npcInState.actionLog.push(fallbackLogEntry);
            }
          }

          console.log(
            `   ✓ NPC ${npc.name} response processed: ${npcResponse.responseDescription}`
          );
        }

        console.log(
          `\n✅ [Action Agent] Completed processing ${npcResponses.length} NPC responses`
        );
      }
    }

    // Append actionLog entries generated by LLM to the corresponding character
    // LLM generates actionLog entries in the response
    const updatedState = gameStateManager.getState();

    // Get actionLog entries from LLM response and add to the corresponding character based on characterId
    if (parsed.actionLog && Array.isArray(parsed.actionLog)) {
      // Process each actionLog entry and add to the corresponding character based on characterId
      for (const logEntry of parsed.actionLog) {
        if (logEntry.time && logEntry.location && logEntry.summary) {
          // Find the character by characterId if provided, otherwise use acting character
          let targetCharacter: DynamicCharacterProfile | undefined;

          if (logEntry.characterId) {
            // Find character by ID
            if (logEntry.characterId === updatedState.playerCharacter.id) {
              targetCharacter = updatedState.playerCharacter;
            } else {
              targetCharacter = updatedState.npcCharacters.find(
                (npc) => npc.id === logEntry.characterId
              );
            }

            if (!targetCharacter) {
              console.warn(
                `   ⚠️  Character with ID "${logEntry.characterId}" not found, skipping actionLog entry`
              );
              continue;
            }
          } else {
            // Fallback: use acting character if characterId not provided (backward compatibility)
            if (isNPC) {
              targetCharacter = updatedState.npcCharacters.find(
                (npc) => npc.id === character.id
              );
            } else {
              targetCharacter = updatedState.playerCharacter;
            }

            if (!targetCharacter) {
              console.warn(
                `   ⚠️  Acting character not found, skipping actionLog entry`
              );
              continue;
            }
          }

          // Initialize actionLog array if needed
          if (!targetCharacter.actionLog) {
            targetCharacter.actionLog = [];
          }

          // Create ActionLogEntry without characterId (not stored in the entry)
          const actionLogEntry: ActionLogEntry = {
            time: logEntry.time,
            location: logEntry.location,
            summary: logEntry.summary,
            successLevel:
              this.hasSkillCheckFromDice(parsed.diceUsed) &&
              typeof logEntry.successLevel === "string"
                ? logEntry.successLevel
                : undefined,
          };

          targetCharacter.actionLog.push(actionLogEntry);
        }
      }

      if (parsed.actionLog.length > 0) {
        console.log(
          `   ✓ Processed ${parsed.actionLog.length} actionLog entries`
        );
      }
    } else {
      // Fallback: if LLM didn't generate actionLog, create a basic entry
      const fullTime = gameStateManager.getFullGameTime();

      // Find the acting character in the current state
      let actorInState: DynamicCharacterProfile | undefined;
      if (isNPC) {
        actorInState = updatedState.npcCharacters.find(
          (npc) => npc.id === character.id
        );
        if (!actorInState) {
          console.warn(
            `   ⚠️  NPC ${character.name} (ID: ${character.id}) not found in state, cannot add fallback actionLog`
          );
        }
      } else {
        actorInState = updatedState.playerCharacter;
      }

      if (actorInState) {
        if (!actorInState.actionLog) {
          actorInState.actionLog = [];
        }

        // Use location name for actionLog location field
        const locationName =
          updatedState.currentScenario?.location || "Unknown location";

        const fallbackLogEntry: ActionLogEntry = {
          time: fullTime,
          location: locationName,
          summary: actionResult.result,
          successLevel: this.hasSkillCheckFromDice(parsed.diceUsed)
            ? "unknown"
            : undefined,
        };
        actorInState.actionLog.push(fallbackLogEntry);
        console.log(
          `   ⚠️  LLM did not generate actionLog, added fallback entry to ${isNPC ? "NPC" : "player"} ${actorInState.name} with location: ${locationName}`
        );
      }
    }

    // Note: Target character actionLog should be generated by LLM if the action affects them
    // The LLM can include actionLog entries for target characters in the response if needed

    this.applyRelationshipChangesFromParsed(
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {},
      gameStateManager
    );

    // Return the updated game state
    return gameStateManager.getState();
  }

  /**
   * Build a normalized detailed action result payload for keeper prompts.
   */
  private buildDetailedActionResult(
    character: DynamicCharacterProfile,
    parsed: unknown,
    isNPC: boolean,
    toolLogs: string[]
  ): Record<string, unknown> {
    const parsedObject =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    const detailedResult: Record<string, unknown> = {
      character: character.name,
      isNPC,
      ...parsedObject,
    };

    if ("sceneChange" in detailedResult) {
      delete detailedResult.sceneChange;
    }

    if ("diceUsed" in detailedResult) {
      delete detailedResult.diceUsed;
    }

    const stripActionLogLocation = (entries: unknown): unknown => {
      if (!Array.isArray(entries)) return entries;
      return entries.map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const cleaned = { ...(entry as Record<string, unknown>) };
        if ("location" in cleaned) {
          delete cleaned.location;
        }
        return cleaned;
      });
    };

    if ("actionLog" in detailedResult) {
      detailedResult.actionLog = stripActionLogLocation(
        detailedResult.actionLog
      );
    }

    if (Array.isArray(detailedResult.npcResponses)) {
      detailedResult.npcResponses = detailedResult.npcResponses.map(
        (response) => {
          if (!response || typeof response !== "object") return response;
          const cleaned = { ...(response as Record<string, unknown>) };
          if ("summary" in cleaned) {
            delete cleaned.summary;
          }
          if ("diceUsed" in cleaned) {
            delete cleaned.diceUsed;
          }
          if ("actionLog" in cleaned) {
            cleaned.actionLog = stripActionLogLocation(cleaned.actionLog);
          }
          return cleaned;
        }
      );
    }

    return detailedResult;
  }

  /**
   * Unified method to build error result for any character action
   */
  private buildErrorResult(
    dynamicState: DynamicGameState,
    character: DynamicCharacterProfile,
    errorMessage: string,
    toolLogs: string[],
    isNPC: boolean,
    gameStateManager: DynamicGameStateManager
  ): DynamicGameState {
    const logPrefix = isNPC
      ? `NPC action processing error (${character.name})`
      : `Error handling`;
    console.error(`\n❌ [Action Agent] ${logPrefix}: ${errorMessage}`);
    console.error(
      `   Current game state: Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`
    );
    console.error(
      `   Location: ${dynamicState.currentScenario?.location || "Unknown"}`
    );
    console.error(`   Character: ${character.name}`);
    if (toolLogs.length > 0) {
      console.error(`   Executed tool calls (${toolLogs.length}):`);
      toolLogs.forEach((log, index) => {
        console.error(`     [${index + 1}] ${log}`);
      });
    }

    const stateManager = new DynamicGameStateManager(dynamicState);

    // Create an error action result to record the failure
    const errorActionResult: ActionResult = {
      timestamp: new Date(),
      gameTime: dynamicState.timeOfDay || "Unknown time",
      timeElapsedMinutes: 0, // No time elapsed on error
      location: dynamicState.currentScenario?.location || "Unknown location",
      character: character.name,
      result: `[Error] ${isNPC ? "NPC " : ""}action processing failed: ${errorMessage}`,
      diceRolls: toolLogs.length > 0 ? toolLogs : [],
      timeConsumption: "instant",
      scenarioChanges: [`Error: ${errorMessage}`],
    };

    // Add error result to action results
    stateManager.addActionResult(errorActionResult);

    // Record detailed error output for downstream prompts (keeper)
    const errorDetail: Record<string, unknown> = {
      character: character.name,
      isNPC,
      timeElapsedMinutes: 0,
      timeConsumption: "instant",
      error: errorMessage,
    };
    stateManager.addActionResultDetail(errorDetail);

    console.error(`\n📊 [Action Result] Error result recorded:`);
    console.error(`   Character: ${errorActionResult.character}`);
    console.error(`   Location: ${errorActionResult.location}`);
    console.error(`   Error: ${errorActionResult.result}`);

    // Return valid DynamicGameState with error recorded
    return stateManager.getState();
  }

  /**
   * Process NPC actions based on response analyses (for listenerGraph only)
   * This method is kept for backward compatibility with listenerGraph which processes
   * NPC responses to recent actions rather than a single action.
   * For regular player actions, NPC responses are handled directly in buildFinalResult.
   */
  async processNPCActions(
    runtime: any,
    gameStateManager: DynamicGameStateManager,
    language?: "en" | "zh"
  ): Promise<void> {
    const dynamicState = gameStateManager.getState();
    const npcResponseAnalyses =
      dynamicState.temporaryInfo.npcResponseAnalyses || [];

    // Filter NPCs that will respond and sort by executionOrder
    const respondingNPCs = npcResponseAnalyses
      .filter(
        (analysis) =>
          analysis.willRespond &&
          analysis.responseType &&
          analysis.responseType !== "none"
      )
      .sort((a, b) => a.executionOrder - b.executionOrder);

    if (respondingNPCs.length === 0) {
      console.log(
        "📝 [Action Agent] No NPCs will respond, skipping NPC action processing"
      );
      return;
    }

    console.log(
      `\n🎭 [Action Agent] Processing ${respondingNPCs.length} NPC actions in order...`
    );

    // Process each NPC action sequentially in executionOrder
    for (const npcResponse of respondingNPCs) {
      const currentState = gameStateManager.getState();
      const npc = currentState.npcCharacters.find(
        (n) => n.name.toLowerCase() === npcResponse.npcName.toLowerCase()
      );

      if (!npc) {
        console.warn(`⚠️ [Action Agent] NPC not found: ${npcResponse.npcName}`);
        continue;
      }

      console.log(
        `\n🎭 [Action Agent] Processing NPC action [${npcResponse.executionOrder}]: ${npcResponse.npcName} (${npcResponse.responseType})`
      );

      // Process this NPC's action using processCharacterAction
      const npcActionDescription =
        npcResponse.responseDescription ||
        `${npc.name} performs a ${npcResponse.responseType} action`;
      const targetCharacter = this.findTargetCharacter(
        currentState,
        null,
        npcResponse
      );

      await this.processCharacterAction(
        runtime,
        currentState,
        npc,
        npcActionDescription,
        {
          isNPC: true,
          npcResponse,
          targetCharacter,
          language,
        },
        gameStateManager,
        null // NPC actions don't have original user input
      );
    }

    console.log(
      `\n✅ [Action Agent] Completed processing ${respondingNPCs.length} NPC actions`
    );
  }
}
