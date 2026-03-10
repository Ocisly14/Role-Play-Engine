import type {
  WorldFeature,
  TickRuntimeContext,
} from "../types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";

// ===== Types =====

export type BoutOfMadnessType =
  | "amnesia" | "psychosomatic_disability" | "violence" | "paranoia"
  | "significant_person" | "faint" | "flee" | "hysterics" | "phobia" | "mania";

export type ActionRestriction =
  | "none" | "incapacitated" | "flee_only" | "attack_only" | "impaired";

export interface ActiveInsanity {
  insanityType: "temporary" | "indefinite";
  boutType: BoutOfMadnessType;
  description: string;
  actionRestriction: ActionRestriction;
  startMinutes: number;
  durationMinutes: number;
  isActive: boolean;
  onsetDelayMinutes?: number;
}

export interface PersistentMentalCondition {
  type: "phobia" | "mania";
  subject: string;
  description: string;
}

export interface SanityCharacterState {
  sanLossLog: Array<{ amount: number; gameTimeMinutes: number }>;
  activeInsanity: ActiveInsanity | null;
  persistentConditions: PersistentMentalCondition[];
}

export interface BoutTableEntry {
  roll: number;
  boutType: BoutOfMadnessType;
  actionRestriction: ActionRestriction;
  persistent?: boolean;
  label: string;
}

// ===== Constants =====

const FEATURE_ID = "sanity";
const SINGLE_LOSS_THRESHOLD = 5;
const HOURLY_WINDOW_MINUTES = 60;
const INSANITY_CONDITION_PREFIX = "[Insanity";

export const BOUT_DESCRIPTIONS: Record<BoutOfMadnessType, string> = {
  amnesia: "Mind goes blank — cannot recall recent events or surroundings",
  psychosomatic_disability: "Body betrays the mind — a limb goes numb, vision blurs, or voice fails",
  violence: "Rational thought shatters — lashing out at anyone nearby in blind rage",
  paranoia: "Trust collapses — everyone is a threat, every shadow hides a conspirator",
  significant_person: "Reality warps — sees a significant person where there is none",
  faint: "Consciousness flickers out — collapses to the ground, unresponsive",
  flee: "Primal terror takes over — desperate to escape, stumbling and screaming",
  hysterics: "Body convulses with uncontrollable laughter, screaming, or sobbing",
  phobia: "A deep irrational fear takes root",
  mania: "An obsessive compulsion seizes the mind",
};

export const BOUT_OF_MADNESS_TABLE: BoutTableEntry[] = [
  { roll: 1,  boutType: "amnesia",                  actionRestriction: "impaired",      label: "Amnesia" },
  { roll: 2,  boutType: "psychosomatic_disability",  actionRestriction: "impaired",      label: "Psychosomatic Disability" },
  { roll: 3,  boutType: "violence",                  actionRestriction: "attack_only",   label: "Violence" },
  { roll: 4,  boutType: "paranoia",                  actionRestriction: "impaired",      label: "Paranoia" },
  { roll: 5,  boutType: "significant_person",        actionRestriction: "impaired",      label: "Significant Person Fixation" },
  { roll: 6,  boutType: "faint",                     actionRestriction: "incapacitated", label: "Faint" },
  { roll: 7,  boutType: "flee",                      actionRestriction: "flee_only",     label: "Flee in Panic" },
  { roll: 8,  boutType: "hysterics",                 actionRestriction: "incapacitated", label: "Physical Hysterics" },
  { roll: 9,  boutType: "phobia",                    actionRestriction: "impaired",      persistent: true, label: "Phobia" },
  { roll: 10, boutType: "mania",                     actionRestriction: "impaired",      persistent: true, label: "Mania" },
];

// ===== Helper functions =====

/**
 * Convert gameDay (1-based) and timeOfDay ("HH:MM") to total minutes since day 1 00:00.
 */
export function computeGameTimeMinutes(gameDay: number, timeOfDay: string): number {
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  return (gameDay - 1) * 1440 + hours * 60 + minutes;
}

/**
 * Create an empty SanityCharacterState.
 */
export function createEmptySanityState(): SanityCharacterState {
  return {
    sanLossLog: [],
    activeInsanity: null,
    persistentConditions: [],
  };
}

/**
 * Get the sanity state for a character from feature state storage.
 */
export function getSanityState(dgsm: DynamicGameStateManager, characterId: string): SanityCharacterState | undefined {
  return dgsm.getFeatureSceneState(FEATURE_ID, characterId) as SanityCharacterState | undefined;
}

/**
 * Set the sanity state for a character in feature state storage.
 */
export function setSanityState(dgsm: DynamicGameStateManager, characterId: string, state: SanityCharacterState): void {
  dgsm.setFeatureSceneState(FEATURE_ID, characterId, state);
}

/**
 * Record a sanity loss event in the character's sanLossLog.
 */
export function recordSanLoss(state: SanityCharacterState, amount: number, gameTimeMinutes: number): void {
  state.sanLossLog.push({ amount, gameTimeMinutes });
}

/**
 * Sum all sanity losses within the last 60-minute window.
 */
export function getHourlyCumulativeLoss(state: SanityCharacterState, currentTimeMinutes: number): number {
  const windowStart = currentTimeMinutes - HOURLY_WINDOW_MINUTES;
  return state.sanLossLog
    .filter((entry) => entry.gameTimeMinutes > windowStart && entry.gameTimeMinutes <= currentTimeMinutes)
    .reduce((sum, entry) => sum + entry.amount, 0);
}

/**
 * Check if a single sanity loss triggers temporary insanity (loss >= 5).
 */
export function checkTemporaryInsanityTrigger(sanLoss: number): boolean {
  return sanLoss >= SINGLE_LOSS_THRESHOLD;
}

/**
 * Check if hourly cumulative loss triggers indefinite insanity (cumulative >= currentSan / 5).
 */
export function checkIndefiniteInsanityTrigger(hourlyCumulativeLoss: number, currentSan: number): boolean {
  return hourlyCumulativeLoss >= currentSan / 5;
}

/**
 * Roll 1d10 on the Bout of Madness table.
 */
export function rollBoutOfMadness(): BoutTableEntry {
  const roll = Math.floor(Math.random() * 10) + 1;
  return BOUT_OF_MADNESS_TABLE[roll - 1];
}

/**
 * Roll temporary insanity duration: 1d10 hours in minutes (60-600).
 */
export function rollTemporaryDuration(): number {
  const roll = Math.floor(Math.random() * 10) + 1;
  return roll * 60;
}

/**
 * Roll indefinite insanity onset delay: 1d6 hours in minutes (60-360).
 */
export function rollIndefiniteOnsetDelay(): number {
  const roll = Math.floor(Math.random() * 6) + 1;
  return roll * 60;
}

/**
 * Roll indefinite insanity duration: 1d10 days in minutes (1440-14400).
 */
export function rollIndefiniteDuration(): number {
  const roll = Math.floor(Math.random() * 10) + 1;
  return roll * 1440;
}

/**
 * Build a condition string for insanity injection.
 *
 * Temporary/indefinite: `[Insanity:temporary] Flee in Panic | restriction:flee_only`
 * Persistent: `[Insanity:phobia] Phobia (tentacles) | persistent`
 */
export function buildInsanityConditionString(
  insanityType: "temporary" | "indefinite" | "phobia" | "mania",
  boutType: BoutOfMadnessType,
  label: string,
  actionRestriction: ActionRestriction,
  subject?: string,
): string {
  if (insanityType === "phobia" || insanityType === "mania") {
    const subjectSuffix = subject ? ` (${subject})` : "";
    return `${INSANITY_CONDITION_PREFIX}:${insanityType}] ${label}${subjectSuffix} | persistent`;
  }
  return `${INSANITY_CONDITION_PREFIX}:${insanityType}] ${label} | restriction:${actionRestriction}`;
}

/**
 * Inject an insanity condition string into a character's conditions array.
 * Player: state.playerCharacter.status.conditions
 * NPC: state.npcCharacters.find(n => n.id === characterId).status.conditions
 */
export function injectInsanityCondition(
  dgsm: DynamicGameStateManager,
  characterId: string,
  conditionString: string,
  isPlayer: boolean,
): void {
  const state = dgsm.getState();

  if (isPlayer) {
    const conditions = state.playerCharacter?.status?.conditions;
    if (!conditions) return;
    conditions.push(conditionString);
  } else {
    const npc = state.npcCharacters?.find((n: any) => n.id === characterId);
    const conditions = npc?.status?.conditions;
    if (!conditions) return;
    conditions.push(conditionString);
  }
}

/**
 * Remove insanity conditions from a character's conditions array.
 * Filters out entries starting with `[Insanity`.
 * With keepPersistent=true, preserves entries containing `| persistent`.
 */
export function removeInsanityCondition(
  dgsm: DynamicGameStateManager,
  characterId: string,
  isPlayer: boolean,
  keepPersistent?: boolean,
): void {
  const state = dgsm.getState();

  let conditions: string[] | undefined;

  if (isPlayer) {
    conditions = state.playerCharacter?.status?.conditions;
  } else {
    const npc = state.npcCharacters?.find((n: any) => n.id === characterId);
    conditions = npc?.status?.conditions;
  }

  if (!conditions) return;

  const filtered = conditions.filter((c: string) => {
    if (!c.startsWith(INSANITY_CONDITION_PREFIX)) return true;
    if (keepPersistent && c.includes("| persistent")) return true;
    return false;
  });

  // Write back
  if (isPlayer) {
    (state.playerCharacter.status as any).conditions = filtered;
  } else {
    const npc = state.npcCharacters?.find((n: any) => n.id === characterId);
    if (npc?.status) {
      (npc.status as any).conditions = filtered;
    }
  }
}

// ===== Core applySanityLoss =====

/**
 * Apply a sanity delta to a character and check for insanity triggers.
 *
 * @param dgsm - DynamicGameStateManager instance
 * @param characterId - the character to affect
 * @param delta - negative for loss, positive for recovery
 * @param isPlayer - true if the character is the player
 * @param gameDay - optional, reads from dgsm state if not provided
 * @param tickTime - optional, reads from dgsm state if not provided
 * @param source - optional description of what caused the loss
 */
export function applySanityLoss(
  dgsm: DynamicGameStateManager,
  characterId: string,
  delta: number,
  isPlayer: boolean,
  gameDay?: number,
  tickTime?: string,
  source?: string,
): void {
  const state = dgsm.getState();

  // 1. Apply SAN delta
  if (isPlayer) {
    state.playerCharacter.status.sanity = Math.max(0, state.playerCharacter.status.sanity + delta);
  } else {
    (dgsm as any).updateNpcSan(characterId, delta);
  }

  // 2. If recovery (delta >= 0), return immediately
  if (delta >= 0) return;

  const lossAmount = Math.abs(delta);
  const day = gameDay ?? state.gameDay ?? 1;
  const time = tickTime ?? state.timeOfDay ?? "00:00";
  const gameTimeMinutes = computeGameTimeMinutes(day, time);

  // 3. Get or create SanityCharacterState
  let charSanState = getSanityState(dgsm, characterId);
  if (!charSanState) {
    charSanState = createEmptySanityState();
  }

  // 4. Record loss in sanLossLog
  recordSanLoss(charSanState, lossAmount, gameTimeMinutes);

  // 5. If activeInsanity already exists, skip trigger checks
  if (charSanState.activeInsanity) {
    setSanityState(dgsm, characterId, charSanState);
    return;
  }

  // 6. Check triggers
  // 6a. Temporary insanity (single loss >= 5)
  if (checkTemporaryInsanityTrigger(lossAmount)) {
    const bout = rollBoutOfMadness();
    const duration = rollTemporaryDuration();

    const activeInsanity: ActiveInsanity = {
      insanityType: "temporary",
      boutType: bout.boutType,
      description: BOUT_DESCRIPTIONS[bout.boutType],
      actionRestriction: bout.actionRestriction,
      startMinutes: gameTimeMinutes,
      durationMinutes: duration,
      isActive: true,
    };
    charSanState.activeInsanity = activeInsanity;

    // Inject condition
    const conditionStr = buildInsanityConditionString(
      "temporary",
      bout.boutType,
      bout.label,
      bout.actionRestriction,
    );
    injectInsanityCondition(dgsm, characterId, conditionStr, isPlayer);

    // If bout is persistent (phobia/mania), also add to persistentConditions
    if (bout.persistent) {
      const subject = extractSubjectFromSource(bout.boutType as "phobia" | "mania", source);
      charSanState.persistentConditions.push({
        type: bout.boutType as "phobia" | "mania",
        subject,
        description: BOUT_DESCRIPTIONS[bout.boutType],
      });

      const persistentCondStr = buildInsanityConditionString(
        bout.boutType as "phobia" | "mania",
        bout.boutType,
        bout.label,
        bout.actionRestriction,
        subject,
      );
      injectInsanityCondition(dgsm, characterId, persistentCondStr, isPlayer);
    }
  } else {
    // 6b. Indefinite insanity (hourly cumulative >= currentSan / 5)
    // Use SAN *before* this loss for the threshold check
    const currentSan = isPlayer
      ? state.playerCharacter.status.sanity + lossAmount
      : ((dgsm as any).getNpcStats(characterId)?.san ?? 0) + lossAmount;

    const hourlyCumulative = getHourlyCumulativeLoss(charSanState, gameTimeMinutes);

    if (checkIndefiniteInsanityTrigger(hourlyCumulative, currentSan)) {
      const bout = rollBoutOfMadness();
      const onsetDelay = rollIndefiniteOnsetDelay();
      const duration = rollIndefiniteDuration();

      const activeInsanity: ActiveInsanity = {
        insanityType: "indefinite",
        boutType: bout.boutType,
        description: BOUT_DESCRIPTIONS[bout.boutType],
        actionRestriction: bout.actionRestriction,
        startMinutes: gameTimeMinutes,
        durationMinutes: duration,
        isActive: false,
        onsetDelayMinutes: onsetDelay,
      };
      charSanState.activeInsanity = activeInsanity;

      // Do NOT inject condition yet (happens when onset delay expires)

      // If bout is persistent, add to persistentConditions
      if (bout.persistent) {
        const subject = extractSubjectFromSource(bout.boutType as "phobia" | "mania", source);
        charSanState.persistentConditions.push({
          type: bout.boutType as "phobia" | "mania",
          subject,
          description: BOUT_DESCRIPTIONS[bout.boutType],
        });
      }
    }
  }

  // 7. Persist state
  setSanityState(dgsm, characterId, charSanState);
}

// ===== LLM Phobia/Mania Subject Generation =====

/**
 * Extract a subject keyword from the trigger source string (sync).
 * Used inline by applySanityLoss for phobia/mania subjects.
 */
function extractSubjectFromSource(type: "phobia" | "mania", source?: string): string {
  if (!source) return type === "phobia" ? "the unknown" : "repetitive behavior";
  const words = source.toLowerCase().split(/\s+/);
  const keywords = words.filter(w => w.length > 4).slice(0, 2);
  if (keywords.length > 0) return keywords.join(" ");
  return type === "phobia" ? "the unknown" : "repetitive behavior";
}

/**
 * Generate a subject for a phobia or mania based on the trigger context.
 * Async version for future LLM integration.
 */
export async function generatePhobiaManiaSubject(
  type: "phobia" | "mania",
  triggerContext: string,
  _sceneId: string,
): Promise<string> {
  return extractSubjectFromSource(type, triggerContext);
}

// ===== Helper: getTrackedCharacters =====

function getTrackedCharacters(dgsm: DynamicGameStateManager): Array<{
  characterId: string;
  isPlayer: boolean;
}> {
  const state = dgsm.getState();
  const result: Array<{ characterId: string; isPlayer: boolean }> = [];
  if (state.playerCharacter?.id) {
    result.push({ characterId: state.playerCharacter.id, isPlayer: true });
  }
  for (const npcId of Object.keys(state.npcLocations)) {
    result.push({ characterId: npcId, isPlayer: false });
  }
  return result;
}

// ===== WorldFeature export =====

export const sanityFeature: WorldFeature = {
  id: FEATURE_ID,
  description: "Sanity and insanity system — tracks per-character sanity loss, temporary/indefinite insanity, bouts of madness, and persistent phobias/manias",

  planningPrompt: `## Sanity / Insanity
- Characters who lose 5+ SAN from a single event may suffer **temporary insanity** (lasts hours).
- Characters who lose ≥1/5 of their current SAN within one game hour may suffer **indefinite insanity** (lasts days, delayed onset).
- Insanity manifests as a Bout of Madness: amnesia, violence, paranoia, fainting, fleeing, hysterics, phobia, or mania.
- Active insanity imposes behavioral restrictions shown in character conditions (e.g. restriction:flee_only, restriction:incapacitated).
- Persistent phobias and manias remain after the insanity episode resolves.
- You do NOT control insanity directly — it is tracked automatically by the sanity system.
- When planning for a character with active insanity, respect their action restriction.`,

  stateDescription(dgsm: DynamicGameStateManager): string {
    const allStates = dgsm.getFeatureState(FEATURE_ID) as Record<string, SanityCharacterState>;
    const lines: string[] = [];

    for (const [characterId, charState] of Object.entries(allStates)) {
      if (!charState) continue;

      // Report active insanity
      if (charState.activeInsanity && charState.activeInsanity.isActive) {
        const ai = charState.activeInsanity;
        lines.push(
          `- ${characterId}: ${ai.insanityType} insanity (${ai.boutType}) — ${ai.description} | restriction:${ai.actionRestriction}`,
        );
      }

      // Report persistent conditions
      for (const pc of charState.persistentConditions) {
        lines.push(`- ${characterId}: ${pc.type} — ${pc.subject}`);
      }
    }

    return lines.length > 0 ? "Mental state:\n" + lines.join("\n") : "";
  },

  getCharacterSkillModifiers(characterId: string, dgsm: DynamicGameStateManager): Array<{ skill: string; delta: number }> {
    const sanState = getSanityState(dgsm, characterId);
    if (!sanState) return [];

    const modifiers: Array<{ skill: string; delta: number }> = [];

    // Active insanity: general impairment
    if (sanState.activeInsanity?.isActive) {
      const restriction = sanState.activeInsanity.actionRestriction;
      if (restriction === "incapacitated") {
        // Cannot act at all — massive penalty to everything
        modifiers.push({ skill: "*", delta: -100 });
      } else if (restriction === "impaired") {
        // General impairment
        modifiers.push({ skill: "*", delta: -15 });
      }
      // flee_only and attack_only: no general penalty, but action restriction handles it
    }

    // Persistent phobias: penalty to relevant perception/awareness skills
    if (sanState.persistentConditions.length > 0) {
      modifiers.push({ skill: "Perception", delta: -10 });
    }

    return modifiers;
  },

  tick(dgsm: DynamicGameStateManager, runtime: TickRuntimeContext): void {
    const characters = getTrackedCharacters(dgsm);
    const currentTimeMinutes = computeGameTimeMinutes(runtime.gameDay, runtime.tickTime);

    for (const { characterId, isPlayer } of characters) {
      let charState = getSanityState(dgsm, characterId);
      if (!charState) continue;

      let changed = false;

      // 1. Indefinite insanity onset check
      if (
        charState.activeInsanity &&
        charState.activeInsanity.isActive === false &&
        charState.activeInsanity.onsetDelayMinutes !== undefined &&
        currentTimeMinutes >= charState.activeInsanity.startMinutes + charState.activeInsanity.onsetDelayMinutes
      ) {
        charState.activeInsanity.isActive = true;
        // Inject condition string
        const ai = charState.activeInsanity;
        const boutEntry = BOUT_OF_MADNESS_TABLE.find(e => e.boutType === ai.boutType);
        const label = boutEntry?.label ?? ai.boutType;
        const conditionStr = buildInsanityConditionString(
          "indefinite",
          ai.boutType,
          label,
          ai.actionRestriction,
        );
        injectInsanityCondition(dgsm, characterId, conditionStr, isPlayer);
        changed = true;
      }

      // 2. Insanity expiry check
      if (charState.activeInsanity && charState.activeInsanity.isActive === true) {
        const ai = charState.activeInsanity;
        let expiryTime: number;
        if (ai.insanityType === "temporary") {
          expiryTime = ai.startMinutes + ai.durationMinutes;
        } else {
          // indefinite: startMinutes + onsetDelayMinutes + durationMinutes
          expiryTime = ai.startMinutes + (ai.onsetDelayMinutes ?? 0) + ai.durationMinutes;
        }

        if (currentTimeMinutes >= expiryTime) {
          // Remove the active insanity condition but preserve persistent phobia/mania conditions
          removeInsanityCondition(dgsm, characterId, isPlayer, true);
          charState.activeInsanity = null;
          changed = true;
        }
      }

      // 3. Cleanup old sanLossLog entries (older than 60 minutes from current time)
      const prevLogLength = charState.sanLossLog.length;
      charState.sanLossLog = charState.sanLossLog.filter(
        (entry) => entry.gameTimeMinutes >= currentTimeMinutes - HOURLY_WINDOW_MINUTES,
      );
      if (charState.sanLossLog.length !== prevLogLength) {
        changed = true;
      }

      // Only persist if something changed
      if (changed) {
        setSanityState(dgsm, characterId, charState);
      }
    }
  },
};
