import { randomUUID } from "crypto";
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
import { filterDiceForCharacter } from "../../../shared/state/index.js";
import type {
  CombatState,
  HeartbeatAction,
  PendingNpcAction,
} from "../../state/DynamicGameState.js";
import type { DynamicGameState } from "../../state/index.js";
import { DynamicGameStateManager } from "../../state/index.js";
import {
  getLatestActionLogEntryWithLocation,
  parseGameTime,
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

  private sanitizeSuccessLevels(parsed: Record<string, unknown>, playerCharacterName?: string | null): void {
    const diceForPlayer = playerCharacterName && Array.isArray(parsed.diceUsed)
      ? filterDiceForCharacter(parsed.diceUsed as string[], playerCharacterName)
      : parsed.diceUsed;
    const playerUsedSkill = this.hasSkillCheckFromDice(diceForPlayer);
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

  private parseHeartbeatDueActionsContext(
    raw: unknown
  ): Array<{
    heartbeatId: string;
    npcId: string;
    scheduledGameTime: string;
    status: "due" | "overdue";
    npcName: string;
    task: string;
    location: string;
  }> {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const data = item as Record<string, unknown>;
        const heartbeatId =
          typeof data.heartbeatId === "string" ? data.heartbeatId.trim() : "";
        const npcId = typeof data.npcId === "string" ? data.npcId.trim() : "";
        const scheduledGameTime =
          typeof data.scheduledGameTime === "string"
            ? data.scheduledGameTime.trim()
            : "";
        const status = data.status;
        const npcName = typeof data.npcName === "string" ? data.npcName : "";
        const task = typeof data.task === "string" ? data.task : "";
        const location =
          typeof data.location === "string" ? data.location : "";
        if (
          !heartbeatId ||
          !npcId ||
          !scheduledGameTime ||
          (status !== "due" && status !== "overdue") ||
          !npcName ||
          !task ||
          !location
        ) {
          return null;
        }
        return {
          heartbeatId,
          npcId,
          scheduledGameTime,
          status,
          npcName,
          task,
          location,
        } as const;
      })
      .filter(
        (
          item
        ): item is {
          heartbeatId: string;
          npcId: string;
          scheduledGameTime: string;
          status: "due" | "overdue";
          npcName: string;
          task: string;
          location: string;
        } => item !== null
      );
  }

  private extractHeartbeatRelatedNpcs(
    dynamicState: DynamicGameState,
    heartbeatDueActions: Array<{
      heartbeatId: string;
      npcId: string;
      scheduledGameTime: string;
      status: "due" | "overdue";
      npcName: string;
      task: string;
      location: string;
    }>
  ): any[] {
    if (!Array.isArray(heartbeatDueActions) || heartbeatDueActions.length === 0) {
      return [];
    }

    const grouped = new Map<string, { npcId: string; npcName: string }>();
    for (const item of heartbeatDueActions) {
      const key =
        item.npcId.trim().length > 0
          ? `id:${item.npcId.trim()}`
          : `name:${item.npcName.trim().toLowerCase()}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          npcId: item.npcId,
          npcName: item.npcName,
        });
      }
    }

    const out: any[] = [];
    const seenNpcIds = new Set<string>();
    for (const group of grouped.values()) {
      const npc =
        dynamicState.npcCharacters.find((candidate) => candidate.id === group.npcId) ||
        dynamicState.npcCharacters.find(
          (candidate) =>
            candidate.name.toLowerCase() === group.npcName.toLowerCase()
        );
      if (!npc) continue;
      if (seenNpcIds.has(npc.id)) continue;
      seenNpcIds.add(npc.id);
      out.push(this.toActionContextNpc(npc));
    }

    return out;
  }

  private parseHeartbeatActionsFromModel(
    raw: unknown,
    dynamicState: Readonly<DynamicGameState>,
    sourceTurnId: string | null | undefined
  ): HeartbeatAction[] {
    if (!Array.isArray(raw)) return [];
    if (!sourceTurnId || sourceTurnId.trim().length === 0) {
      console.warn(
        "⚠️ [Action Agent] heartbeatActions returned but sourceTurnId missing; skipping heartbeat persistence."
      );
      return [];
    }

    const currentGameTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
    const npcById = new Map(dynamicState.npcCharacters.map((npc) => [npc.id, npc]));
    const normalizedTurnId = sourceTurnId.trim();

    return raw
      .map((item): HeartbeatAction | null => {
        if (!item || typeof item !== "object") return null;
        const data = item as Record<string, unknown>;
        const scheduledGameTime =
          typeof data.scheduledGameTime === "string"
            ? data.scheduledGameTime.trim()
            : "";
        const npcIdRaw = typeof data.npcId === "string" ? data.npcId.trim() : "";
        const npcNameRaw =
          typeof data.npcName === "string" ? data.npcName.trim() : "";
        const task = typeof data.task === "string" ? data.task.trim() : "";
        const location =
          typeof data.location === "string" ? data.location.trim() : "";

        if (!scheduledGameTime || !task || !location) {
          return null;
        }
        if (!parseGameTime(scheduledGameTime)) {
          return null;
        }

        let npcId = npcIdRaw;
        let npcName = npcNameRaw;
        if (!npcId && npcName) {
          const npc = dynamicState.npcCharacters.find(
            (candidate) =>
              candidate.name.toLowerCase() === npcName.toLowerCase()
          );
          if (npc) {
            npcId = npc.id;
            npcName = npc.name;
          }
        }

        if (!npcId || !npcById.has(npcId)) {
          return null;
        }
        if (!npcName) {
          npcName = npcById.get(npcId)?.name || npcId;
        }

        const existingByFingerprint = (dynamicState.heartbeatActions || []).find(
          (existing) =>
            (existing.status === "scheduled" ||
              existing.status === "due" ||
              existing.status === "overdue") &&
            existing.npcId === npcId &&
            existing.scheduledGameTime === scheduledGameTime &&
            existing.task.trim().toLowerCase() === task.toLowerCase() &&
            existing.location.trim().toLowerCase() === location.toLowerCase()
        );

        return {
          heartbeatId:
            (typeof data.heartbeatId === "string" &&
            data.heartbeatId.trim().length > 0
              ? data.heartbeatId.trim()
              : existingByFingerprint?.heartbeatId) ||
            `heartbeat-${Date.now()}-${randomUUID().slice(0, 8)}`,
          scheduledGameTime,
          npcId,
          npcName,
          task,
          location,
          status: "scheduled" as HeartbeatAction["status"],
          createdAtGameTime:
            existingByFingerprint?.createdAtGameTime || currentGameTime,
          sourceTurnId: existingByFingerprint?.sourceTurnId || normalizedTurnId,
          ...(existingByFingerprint?.triggeredAtGameTime
            ? { triggeredAtGameTime: existingByFingerprint.triggeredAtGameTime }
            : {}),
        };
      })
      .filter((item): item is HeartbeatAction => item !== null);
  }

  private consumeDueHeartbeatActionsFromContext(
    gameStateManager: DynamicGameStateManager
  ): void {
    const state = gameStateManager.getState();
    const dueRaw = state.temporaryInfo.contextualData?.heartbeatDueActions;
    if (!Array.isArray(dueRaw) || dueRaw.length === 0) return;

    const dueIds = new Set(
      dueRaw
        .map((item) =>
          item && typeof item === "object" && typeof item.heartbeatId === "string"
            ? item.heartbeatId.trim()
            : ""
        )
        .filter((id) => id.length > 0)
    );
    if (dueIds.size === 0) return;

    const current = Array.isArray(state.heartbeatActions)
      ? state.heartbeatActions
      : [];
    const next = current.filter((item) => !dueIds.has(item.heartbeatId));
    const removedCount = current.length - next.length;
    if (removedCount <= 0) return;

    gameStateManager.setHeartbeatActions(next);
    console.log(
      `🫀 [Action Agent] Consumed heartbeat actions for this turn: removed=${removedCount}`
    );
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

  private hasRestIntent(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    if (!normalized) return false;
    return /(休息|睡觉|睡覺|小睡|打盹|午睡|补觉|補覺|过夜|過夜|休整|歇会|歇會|眯一会|眯一會|\brest\b|\bsleep\b|\bnap\b|\bpower nap\b|\btake a break\b|\bturn in\b|\bovernight\b)/i.test(
      normalized
    );
  }

  private normalizeDurationText(text: string): string {
    if (!text) return "";
    return text
      .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 65248))
      .replace(/：/g, ":")
      .replace(/，/g, ",")
      .replace(/。/g, ".")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  private parseChineseNumber(token: string): number | null {
    const normalized = token
      .trim()
      .replace(/兩/g, "两")
      .replace(/〇/g, "零")
      .replace(/[个個余餘多來来约約左右]/g, "");
    if (!normalized) return null;
    if (normalized === "半") return 0.5;

    const digitMap: Record<string, number> = {
      零: 0,
      一: 1,
      二: 2,
      两: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
    };
    const unitMap: Record<string, number> = {
      十: 10,
      百: 100,
    };

    if (normalized.includes("点")) {
      const [intPartRaw, decimalPartRaw] = normalized.split("点");
      const intPart = this.parseChineseNumber(intPartRaw || "零");
      if (intPart === null) return null;
      const decimalDigits = [...(decimalPartRaw || "")]
        .map((char) => digitMap[char])
        .filter((digit) => digit !== undefined);
      if (decimalDigits.length === 0) return null;
      const decimalValue = Number(`0.${decimalDigits.join("")}`);
      return intPart + decimalValue;
    }

    const allDigits = [...normalized].every((char) => digitMap[char] !== undefined);
    if (allDigits) {
      const joined = [...normalized].map((char) => digitMap[char]).join("");
      const value = Number(joined);
      return Number.isFinite(value) ? value : null;
    }

    let result = 0;
    let current = 0;
    let seen = false;
    for (const char of normalized) {
      if (digitMap[char] !== undefined) {
        current = digitMap[char];
        seen = true;
        continue;
      }
      if (unitMap[char] !== undefined) {
        const unit = unitMap[char];
        result += (current || 1) * unit;
        current = 0;
        seen = true;
        continue;
      }
      return null;
    }

    if (!seen) return null;
    return result + current;
  }

  private parseNumericToken(token: string): number | null {
    const normalized = token.trim().replace(/[个個余餘多來来约約左右]/g, "");
    if (!normalized) return null;
    if (normalized === "半") return 0.5;
    const asNumber = Number(normalized);
    if (Number.isFinite(asNumber)) {
      return asNumber;
    }
    return this.parseChineseNumber(normalized);
  }

  private parseDurationMinutes(text: string): number | null {
    const normalized = this.normalizeDurationText(text);
    if (!normalized) return null;

    const hourUnits = "(?:个?\\s*小时|個?\\s*小時|小时|小時|hours?|hrs?|hr|h)";
    const minuteUnits = "(?:分钟|分鐘|minutes?|mins?|min|m)";
    const numberToken = "(?:\\d+(?:\\.\\d+)?|[零〇一二两兩三四五六七八九十百半点]+)";

    let working = normalized;
    let totalMinutes = 0;
    let matched = false;

    const addMinutes = (value: number | null, multiplier: number): void => {
      if (value !== null && Number.isFinite(value) && value > 0) {
        totalMinutes += value * multiplier;
        matched = true;
      }
    };

    const halfAfterHours = new RegExp(`(${numberToken})\\s*${hourUnits}\\s*半`, "gi");
    working = working.replace(halfAfterHours, (_full, token: string) => {
      const hours = this.parseNumericToken(token);
      addMinutes(hours, 60);
      totalMinutes += 30;
      matched = true;
      return " ";
    });

    const halfBeforeHours = new RegExp(`(${numberToken})\\s*(?:个?\\s*)?半\\s*${hourUnits}`, "gi");
    working = working.replace(halfBeforeHours, (_full, token: string) => {
      const hours = this.parseNumericToken(token);
      addMinutes(hours, 60);
      totalMinutes += 30;
      matched = true;
      return " ";
    });

    const plainHalfHour = new RegExp(`(^|[^\\w])半\\s*${hourUnits}`, "gi");
    working = working.replace(plainHalfHour, (_full, prefix: string) => {
      totalMinutes += 30;
      matched = true;
      return `${prefix} `;
    });

    const hourRegex = new RegExp(`(${numberToken})\\s*${hourUnits}`, "gi");
    let hourMatch: RegExpExecArray | null;
    while ((hourMatch = hourRegex.exec(working)) !== null) {
      const hours = this.parseNumericToken(hourMatch[1]);
      addMinutes(hours, 60);
    }

    const minuteRegex = new RegExp(`(${numberToken})\\s*${minuteUnits}`, "gi");
    let minuteMatch: RegExpExecArray | null;
    while ((minuteMatch = minuteRegex.exec(working)) !== null) {
      const minutes = this.parseNumericToken(minuteMatch[1]);
      addMinutes(minutes, 1);
    }

    if (matched) {
      return Math.max(1, Math.min(1440, Math.round(totalMinutes)));
    }

    if (
      /(overnight|all night|through the night|sleep until morning|过夜|整晚|一晚|一宿|睡到天亮|睡到早上)/i.test(
        normalized
      )
    ) {
      return 480;
    }

    if (/(half day|半天)/i.test(normalized)) {
      return 720;
    }

    if (/(all day|full day|整天|全天|一整天|一天)/i.test(normalized)) {
      return 720;
    }

    if (
      /(power nap|nap|short while|for a while|a bit|小睡|午睡|眯一会|眯一會|一会儿|一會兒|一会|一會|片刻|歇会|歇會)/i.test(
        normalized
      )
    ) {
      return 30;
    }

    const compactHourMinuteMatch = normalized.match(
      /(\d{1,2})\s*:\s*(\d{1,2})/
    );
    if (compactHourMinuteMatch) {
      const hours = Number(compactHourMinuteMatch[1]);
      const minutes = Number(compactHourMinuteMatch[2]);
      if (
        Number.isFinite(hours) &&
        Number.isFinite(minutes) &&
        hours >= 0 &&
        minutes >= 0
      ) {
        return Math.max(1, Math.min(1440, Math.round(hours * 60 + minutes)));
      }
    }

    return null;
  }

  private resolveRestMinutes(
    originalUserInput: string | null | undefined,
    actionAnalysis: ActionAnalysis | null | undefined,
    parsed: Record<string, unknown>
  ): number | null {
    const candidates = [
      originalUserInput,
      actionAnalysis?.action,
      actionAnalysis?.target?.intent,
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

    const hasRestIntent = candidates.some((value) => this.hasRestIntent(value));
    if (!hasRestIntent) return null;

    for (const candidate of candidates) {
      const parsedMinutes = this.parseDurationMinutes(candidate);
      if (parsedMinutes !== null) {
        return parsedMinutes;
      }
    }

    const modelMinutes = parsed.timeElapsedMinutes;
    if (typeof modelMinutes === "number" && Number.isFinite(modelMinutes) && modelMinutes > 0) {
      return Math.max(1, Math.min(1440, Math.round(modelMinutes)));
    }

    return null;
  }

  private getRestTimeConsumption(restMinutes: number): ActionResult["timeConsumption"] {
    if (restMinutes >= 480) return "very long";
    if (restMinutes >= 240) return "long";
    if (restMinutes >= 60) return "medium";
    return "short";
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
      targetCharacter?: DynamicCharacterProfile | null;
      selectedSkill?: string | null;
      skillSelectionMode?: "auto" | "manual";
      language?: "en" | "zh";
      sourceTurnId?: string | null;
    },
    gameStateManager: DynamicGameStateManager,
    originalUserInput?: string | null
  ): Promise<DynamicGameState> {
    const {
      targetCharacter,
      selectedSkill,
      skillSelectionMode,
      sourceTurnId,
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
    const sceneNPCs = this.extractSceneNPCsForAction(dynamicState).filter(
      (npc) =>
        !targetCharacter ||
        (npc.id !== targetCharacter.id && npc.name !== targetCharacter.name)
    );
    const targetIntent =
      dynamicState.temporaryInfo.currentActionAnalysis?.target?.intent ?? "";

    // Build system prompt using template
    const fatigueActive = gameStateManager.isFatigued();
    const baseSystemPrompt = buildActionSystemPrompt(
      originalUserInput,
      actionDescription,
      preRolledDice,
      existingSceneChangeRequest,
      sceneNPCs,
      selectedSkill ?? null,
      skillSelectionMode,
      targetIntent,
      language,
      fatigueActive
    );

    const systemPrompt = baseSystemPrompt;

    // Single call - no tool loop needed with pre-rolled dice
    const context = this.buildContext(
      dynamicState,
      character,
      { targetCharacter },
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
        this.sanitizeSuccessLevels(parsed as Record<string, unknown>, character.name);
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
      { targetCharacter, sourceTurnId },
      gameStateManager,
      originalUserInput
    );
  }

  async processAction(
    runtime: any,
    gameStateManager: DynamicGameStateManager,
    userMessage: string,
    selectedSkill?: string | null,
    skillSelectionMode?: "auto" | "manual",
    language?: "en" | "zh",
    currentTurnId?: string | null
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
        targetCharacter,
        selectedSkill: selectedSkill ?? null,
        skillSelectionMode,
        language,
        sourceTurnId: currentTurnId ?? null,
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

  private toActionContextNpc(npc: DynamicNPCProfile): Record<string, unknown> {
    const filtered = this.filterCharacterForContext(npc);
    return {
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
      last3ActionLog: (npc.actionLog || []).slice(-3),
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
      out.push(this.toActionContextNpc(npc));
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
      targetCharacter?: DynamicCharacterProfile | null;
    },
    gameStateManager?: DynamicGameStateManager
  ): string {
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

    if (hasValidSceneChangeRequest) {
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

    const heartbeatDueActions = this.parseHeartbeatDueActionsContext(
      dynamicState.temporaryInfo.contextualData?.heartbeatDueActions
    );
    if (heartbeatDueActions.length > 0) {
      context +=
        "\n\n=== HEARTBEAT DUE ACTIONS ===\n" +
        JSON.stringify(heartbeatDueActions, null, 2) +
        "\nRules:\n" +
        "- These are scheduled appointments/actions that are now due or overdue.\n" +
        "- Your actionLog should reflect whether the investigator keeps, delays, misses, reschedules, or ignores these items.\n" +
        "- Do not force player behavior; preserve player agency while maintaining timeline consistency.\n" +
        "=== END HEARTBEAT DUE ACTIONS ===\n";

      const heartbeatRelatedNpcs = this.extractHeartbeatRelatedNpcs(
        dynamicState,
        heartbeatDueActions
      );
      if (heartbeatRelatedNpcs.length > 0) {
        context +=
          "\n\n=== HEARTBEAT RELATED NPCS (DEDUPED, SAME SHAPE AS SCENE NPCS) ===\n" +
          JSON.stringify(heartbeatRelatedNpcs, null, 2) +
          "\nUse this NPC context when resolving due/overdue heartbeat actions.\n" +
          "=== END HEARTBEAT RELATED NPCS ===\n";
      }
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
      `\n\nCharacter:\n` +
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
      targetCharacter?: DynamicCharacterProfile | null;
      sourceTurnId?: string | null;
    },
    gameStateManager: DynamicGameStateManager,
    originalUserInput?: string | null
  ): Promise<DynamicGameState> {
    const { targetCharacter, sourceTurnId } = options;
    const actionAnalysis = dynamicState.temporaryInfo.currentActionAnalysis;
    const parsedRecord =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    const detectedRestMinutes =
      this.resolveRestMinutes(originalUserInput, actionAnalysis, parsedRecord);
    let restSummary: string | null = null;
    let restType: "none" | "short" | "long" | null = null;
    let restHpRestored = 0;
    let restSanRestored = 0;

    if (detectedRestMinutes !== null) {
      const restResult = gameStateManager.applyRest(detectedRestMinutes);
      restSummary = restResult.summary;
      restType = restResult.restType;
      restHpRestored = restResult.hpRestored;
      restSanRestored = restResult.sanRestored;
    }

    // Apply the state update from LLM result
    if (parsed.stateUpdate) {
      gameStateManager.applyActionUpdate(parsed.stateUpdate);
    }

    // Once due heartbeat actions are injected for this turn and action agent runs,
    // treat them as consumed and remove from persistent state.
    this.consumeDueHeartbeatActionsFromContext(gameStateManager);

    const heartbeatActions = this.parseHeartbeatActionsFromModel(
      parsed.heartbeatActions,
      gameStateManager.getState(),
      sourceTurnId ?? null
    );
    if (heartbeatActions.length > 0) {
      gameStateManager.upsertHeartbeatActions(heartbeatActions);
      console.log(
        `🫀 [Action Agent] Persisted ${heartbeatActions.length} heartbeat action(s)`
      );
    }

    // Handle combat entry detection (only for player actions, not NPC reactions)
    if (parsed.entersCombat === true) {
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
      timeElapsedMinutes:
        detectedRestMinutes ??
        (typeof parsed.timeElapsedMinutes === "number"
          ? parsed.timeElapsedMinutes
          : 0),
      location: dynamicState.currentScenario?.location || "Unknown location",
      character: character.name,
      result:
        restSummary ||
        parsed.summary ||
        (Array.isArray(parsed.actionLog) &&
        typeof parsed.actionLog[0]?.summary === "string"
          ? parsed.actionLog[0].summary
          : undefined) ||
        "performed an action",
      diceRolls: toolLogs.map((log) => log), // toolLogs already contain "expression -> result" format
      timeConsumption:
        detectedRestMinutes !== null
          ? this.getRestTimeConsumption(detectedRestMinutes)
          : parsed.timeConsumption || "instant", // Default to instant if not specified
      scenarioChanges: scenarioChanges.length > 0 ? scenarioChanges : undefined,
    };

    // Add to action results
    gameStateManager.addActionResult(actionResult);

    // Record full action output for downstream prompts (keeper)
    const detailedResult = this.buildDetailedActionResult(
      character,
      parsed,
      toolLogs
    );
    if (detectedRestMinutes !== null) {
      detailedResult.rest = {
        minutes: detectedRestMinutes,
        restType,
        hpRestored: restHpRestored,
        sanRestored: restSanRestored,
        summary: restSummary,
      };
    }
    gameStateManager.addActionResultDetail(detailedResult);

    // Log detailed action result
    console.log(`\n📊 [Action Result] Detailed execution result:`);
    console.log(`   Character: ${actionResult.character}`);
    console.log(`   Location: ${actionResult.location}`);
    console.log(`   Game Time: ${actionResult.gameTime}`);
    console.log(
      `   Time Elapsed: ${actionResult.timeElapsedMinutes || 0} minutes`
    );
    console.log(`   Time Consumption: ${actionResult.timeConsumption}`);
    console.log(`   Result: ${actionResult.result}`);
    if (actionResult.diceRolls && actionResult.diceRolls.length > 0) {
      console.log(
        `   Dice Rolls (${actionResult.diceRolls.length}):`
      );
      actionResult.diceRolls.forEach((roll, index) => {
        console.log(`     [${index + 1}] ${roll}`);
      });
    } else {
      console.log(`   Dice Rolls: None`);
    }
    if (
      actionResult.scenarioChanges &&
      actionResult.scenarioChanges.length > 0
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
      const oldDay = dynamicState.gameDay;
      const oldTime = dynamicState.timeOfDay;
      gameStateManager.updateGameTime(actionResult.timeElapsedMinutes);
      if (detectedRestMinutes === null) {
        gameStateManager.addFatigueMinutes(actionResult.timeElapsedMinutes);
      }
      const updatedState = gameStateManager.getState();
      const newDay = updatedState.gameDay;
      const fullTime = gameStateManager.getFullGameTime();

      console.log(
        `⏰ Time advanced by ${actionResult.timeElapsedMinutes} minutes (Player action)`
      );
      if (newDay > oldDay) {
        console.log(`   Day ${oldDay}, ${oldTime} → ${fullTime} 🌅`);
      } else {
        console.log(`   ${oldTime} → ${fullTime}`);
      }
    }

    // Process NPC responses if this is a player action
    if (parsed.npcResponses && Array.isArray(parsed.npcResponses)) {
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

    // Filter dice to only this player's rolls for accurate skill-check detection
    const playerDiceForSkillCheck: unknown = (() => {
      if (!character.name || !Array.isArray(parsed.diceUsed)) return parsed.diceUsed;
      const filtered = filterDiceForCharacter(parsed.diceUsed as string[], character.name);
      return filtered.length > 0 ? filtered : parsed.diceUsed;
    })();

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
            targetCharacter = updatedState.playerCharacter;

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
              this.hasSkillCheckFromDice(playerDiceForSkillCheck) &&
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
      const actorInState: DynamicCharacterProfile | undefined = updatedState.playerCharacter;

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
          successLevel: this.hasSkillCheckFromDice(playerDiceForSkillCheck)
            ? "unknown"
            : undefined,
        };
        actorInState.actionLog.push(fallbackLogEntry);
        console.log(
          `   ⚠️  LLM did not generate actionLog, added fallback entry to player ${actorInState.name} with location: ${locationName}`
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
    toolLogs: string[]
  ): Record<string, unknown> {
    const parsedObject =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    const detailedResult: Record<string, unknown> = {
      character: character.name,
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
    gameStateManager: DynamicGameStateManager
  ): DynamicGameState {
    console.error(`\n❌ [Action Agent] Error handling: ${errorMessage}`);
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
      result: `[Error] action processing failed: ${errorMessage}`,
      diceRolls: toolLogs.length > 0 ? toolLogs : [],
      timeConsumption: "instant",
      scenarioChanges: [`Error: ${errorMessage}`],
    };

    // Add error result to action results
    stateManager.addActionResult(errorActionResult);

    // Record detailed error output for downstream prompts (keeper)
    const errorDetail: Record<string, unknown> = {
      character: character.name,
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

}
