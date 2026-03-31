import type { PlanNode } from "../../dynamicworldagent/dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../dynamicworldagent/state/DynamicGameState.js";
import type { Item } from "../../dynamicworldagent/state/types.js";
import type {
  ActivateResult,
  NodeStartBlockedResult,
  TickRuntimeContext,
  WorldFeature,
} from "../types.js";
import { applySanityLoss } from "./sanityFeature.js";

// ===== Types =====

type EventTriggerConditionType = "daily" | "cumulative" | "prerequisite";

interface EventTriggerConditionDefinition {
  conditionId: string;
  label: string;
  type: EventTriggerConditionType;
  triggerType: string;

  // daily
  failAfterMissed?: number;

  // cumulative
  requiredCount?: number;

  // prerequisite
  check?: {
    location?: string;
    item?: string;
    mode: "manual" | "passive";
  };
}

interface EventTriggerDefinition {
  eventTriggerId: string;
  label: string;
  conductorNpcId: string;
  siteSceneId: string;
  invokeType: string;
  autoInvoke: boolean;
  conditions: EventTriggerConditionDefinition[];
  completionEffect?: {
    sceneConditions?: Array<{ sceneId: string; description: string }>;
    witnessSanLoss?: number;
    globalSanLoss?: number;
  };
  failureEffect?: {
    sceneConditions?: Array<{ sceneId: string; description: string }>;
    witnessSanLoss?: number;
  };
}

interface DailyConditionState {
  type: "daily";
  fulfilledToday: boolean;
  lastFulfilledDay: number;
  consecutiveMissed: number;
}

interface CumulativeConditionState {
  type: "cumulative";
  currentCount: number;
  requiredCount: number;
}

interface PrerequisiteConditionState {
  type: "prerequisite";
  mode: "manual" | "passive";
  fulfilled: boolean;
}

type ConditionState =
  | DailyConditionState
  | CumulativeConditionState
  | PrerequisiteConditionState;

interface EventTriggerInstanceState {
  eventTriggerId: string;
  status: "active" | "completed" | "failed";
  conditionStates: Record<string, ConditionState>;
  lastCheckedDay: number;
}

// ===== Constants =====

const FEATURE_ID = "event_trigger";

// ===== Helper functions =====

function getEventTriggerState(
  dgsm: DynamicGameStateManager,
  eventTriggerId: string
): EventTriggerInstanceState | undefined {
  return dgsm.getFeatureSceneState(FEATURE_ID, eventTriggerId) as
    | EventTriggerInstanceState
    | undefined;
}

function setEventTriggerState(
  dgsm: DynamicGameStateManager,
  eventTriggerId: string,
  state: EventTriggerInstanceState
): void {
  dgsm.setFeatureSceneState(FEATURE_ID, eventTriggerId, state);
}

function getEventTriggerPresets(
  dgsm: DynamicGameStateManager
): EventTriggerDefinition[] {
  return (
    ((dgsm.getState() as any).moduleSetup?.eventTriggerPresets as
      | EventTriggerDefinition[]
      | undefined) ?? []
  );
}

function findDefinition(
  dgsm: DynamicGameStateManager,
  eventTriggerId: string
): EventTriggerDefinition | undefined {
  return getEventTriggerPresets(dgsm).find(
    (d) => d.eventTriggerId === eventTriggerId
  );
}

/**
 * Check whether an NPC has an item by Item.name (exact match).
 * Searches NPC inventory and current scene items, excluding items
 * inside locked containers.
 */
function hasItem(
  dgsm: DynamicGameStateManager,
  npcId: string,
  itemName: string
): boolean {
  // 1. NPC inventory
  const inventory = dgsm.getNpcInventory(npcId);
  if (inventory.some((i) => i.name === itemName)) return true;

  // 2. Current scene items (excluding locked container contents)
  const pos = dgsm.getCharacterPosition(npcId);
  if (!pos) return false;
  const locationId = dgsm.resolveLocationId(pos);
  const scene = dgsm.getScene(locationId);
  if (!scene?.items) return false;

  for (const item of scene.items) {
    if (item.name === itemName) return true;
    // Check storedItems only if the container is NOT locked
    if (
      item.type === "container" &&
      item.containerStats?.storedItems &&
      !item.containerStats.locked
    ) {
      if (
        item.containerStats.storedItems.some((si: Item) => si.name === itemName)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check a single prerequisite condition (passive mode).
 * Returns true if all check criteria are satisfied.
 */
function checkPrerequisitePassive(
  dgsm: DynamicGameStateManager,
  condDef: EventTriggerConditionDefinition,
  conductorNpcId: string
): boolean {
  const check = condDef.check;
  if (!check) return true;

  if (check.location) {
    const pos = dgsm.getCharacterPosition(conductorNpcId);
    if (!pos) return false;
    const locationId = dgsm.resolveLocationId(pos);
    if (locationId !== check.location) return false;
  }

  if (check.item) {
    if (!hasItem(dgsm, conductorNpcId, check.item)) return false;
  }

  return true;
}

/**
 * Shared check: evaluate whether ALL conditions of an event trigger are met.
 * Used by invoke, autoInvoke, and tick autoInvoke.
 */
function checkAllConditions(
  definition: EventTriggerDefinition,
  state: EventTriggerInstanceState,
  dgsm: DynamicGameStateManager
): boolean {
  for (const condDef of definition.conditions) {
    const cs = state.conditionStates[condDef.conditionId];
    if (!cs) return false;

    switch (cs.type) {
      case "daily":
        if (!cs.fulfilledToday) return false;
        break;
      case "cumulative":
        if (cs.currentCount < cs.requiredCount) return false;
        break;
      case "prerequisite":
        if (cs.mode === "passive") {
          if (
            !checkPrerequisitePassive(dgsm, condDef, definition.conductorNpcId)
          )
            return false;
        } else {
          // manual
          if (!cs.fulfilled) return false;
        }
        break;
    }
  }
  return true;
}

/**
 * Apply completion effects: scene conditions, witness SAN loss, global SAN loss.
 */
function applyCompletionEffect(
  definition: EventTriggerDefinition,
  dgsm: DynamicGameStateManager,
  runtime?: TickRuntimeContext
): void {
  const effect = definition.completionEffect;
  if (!effect) return;

  const gameDay = runtime?.gameDay ?? dgsm.getState().gameDay ?? 1;
  const tickTime = runtime?.tickTime ?? dgsm.getState().timeOfDay ?? "00:00";

  // Scene conditions
  if (effect.sceneConditions) {
    for (const sc of effect.sceneConditions) {
      dgsm.appendSceneCondition(sc.sceneId, { description: sc.description });
      dgsm.pushWorldEvent({
        type: "scene_updated",
        location: sc.sceneId,
        gameTime: tickTime,
        description: sc.description,
        data: {
          source: "event_trigger",
          eventTriggerId: definition.eventTriggerId,
        },
      });
    }
  }

  // Feature triggered event
  dgsm.pushWorldEvent({
    type: "feature_triggered",
    location: definition.siteSceneId,
    gameTime: tickTime,
    description: `${definition.label} — completed`,
    data: {
      eventTriggerId: definition.eventTriggerId,
      label: definition.label,
      outcome: "completed",
    },
  });

  // Witness SAN loss: all characters at siteSceneId except conductor
  if (effect.witnessSanLoss && effect.witnessSanLoss > 0) {
    const witnesses = dgsm.getCharactersInScene(definition.siteSceneId);
    for (const charId of witnesses) {
      if (charId === definition.conductorNpcId) continue;
      applySanityLoss(
        dgsm,
        charId,
        -effect.witnessSanLoss,
        gameDay,
        tickTime,
        `Witnessed event trigger completion: ${definition.label}`
      );
    }
  }

  // Global SAN loss: all alive NPCs + player characters
  if (effect.globalSanLoss && effect.globalSanLoss > 0) {
    const state = dgsm.getState();
    const allCharIds = Object.keys(state.characterPositions);
    for (const charId of allCharIds) {
      if (!dgsm.isNpcAlive(charId)) continue;
      applySanityLoss(
        dgsm,
        charId,
        -effect.globalSanLoss,
        gameDay,
        tickTime,
        `Event trigger completed: ${definition.label}`
      );
    }
  }
}

/**
 * Apply failure effects: scene conditions, witness SAN loss.
 */
function applyFailureEffect(
  definition: EventTriggerDefinition,
  dgsm: DynamicGameStateManager,
  runtime?: TickRuntimeContext
): void {
  const effect = definition.failureEffect;
  if (!effect) return;

  const gameDay = runtime?.gameDay ?? dgsm.getState().gameDay ?? 1;
  const tickTime = runtime?.tickTime ?? dgsm.getState().timeOfDay ?? "00:00";

  // Scene conditions
  if (effect.sceneConditions) {
    for (const sc of effect.sceneConditions) {
      dgsm.appendSceneCondition(sc.sceneId, { description: sc.description });
      dgsm.pushWorldEvent({
        type: "scene_updated",
        location: sc.sceneId,
        gameTime: tickTime,
        description: sc.description,
        data: {
          source: "event_trigger",
          eventTriggerId: definition.eventTriggerId,
        },
      });
    }
  }

  // Feature triggered event
  dgsm.pushWorldEvent({
    type: "feature_triggered",
    location: definition.siteSceneId,
    gameTime: tickTime,
    description: `${definition.label} — failed`,
    data: {
      eventTriggerId: definition.eventTriggerId,
      label: definition.label,
      outcome: "failed",
    },
  });

  // Witness SAN loss: all characters at siteSceneId except conductor
  if (effect.witnessSanLoss && effect.witnessSanLoss > 0) {
    const witnesses = dgsm.getCharactersInScene(definition.siteSceneId);
    for (const charId of witnesses) {
      if (charId === definition.conductorNpcId) continue;
      applySanityLoss(
        dgsm,
        charId,
        -effect.witnessSanLoss,
        gameDay,
        tickTime,
        `Witnessed event trigger failure: ${definition.label}`
      );
    }
  }
}

/**
 * Create initial condition states from an event trigger definition.
 */
function createInitialConditionStates(
  definition: EventTriggerDefinition
): Record<string, ConditionState> {
  const states: Record<string, ConditionState> = {};
  for (const cond of definition.conditions) {
    switch (cond.type) {
      case "daily":
        states[cond.conditionId] = {
          type: "daily",
          fulfilledToday: false,
          lastFulfilledDay: 0,
          consecutiveMissed: 0,
        };
        break;
      case "cumulative":
        states[cond.conditionId] = {
          type: "cumulative",
          currentCount: 0,
          requiredCount: cond.requiredCount ?? 1,
        };
        break;
      case "prerequisite":
        states[cond.conditionId] = {
          type: "prerequisite",
          mode: cond.check?.mode ?? "manual",
          fulfilled: false,
        };
        break;
    }
  }
  return states;
}

/**
 * Initialize all event trigger states from presets. Called on first tick when featureState is empty.
 */
function initEventTriggersFromPresets(
  dgsm: DynamicGameStateManager,
  gameDay: number
): void {
  const presets = getEventTriggerPresets(dgsm);
  for (const def of presets) {
    const eventTriggerState: EventTriggerInstanceState = {
      eventTriggerId: def.eventTriggerId,
      status: "active",
      conditionStates: createInitialConditionStates(def),
      lastCheckedDay: gameDay,
    };
    setEventTriggerState(dgsm, def.eventTriggerId, eventTriggerState);
  }
}

// ===== Exported feature =====

export const eventTriggerFeature: WorldFeature = {
  id: FEATURE_ID,
  description:
    "Event trigger tracking system — tracks condition fulfillment and invocation for module-defined event triggers",

  planningPrompt: `## 事件触发系统
当你的行动与下方列出的任何事件触发条件相关时——无论有意或无意——在 PlanNode 上附加：
- eventTriggerId：事件触发标识符
- eventTriggerType：行为分类
- eventTriggerConditionId：具体条件 ID
你不需要管条件是否满足，系统自动追踪和判定。`,

  planNodeSchema: {
    requiredFields: [
      {
        field: "eventTriggerId",
        type: "string",
        description: "此行动关联的事件触发标识符",
      },
    ],
    optionalFields: [
      {
        field: "eventTriggerType",
        type: "string",
        description: "事件触发行为类型（具体值见事件触发条件标记参考）",
      },
      {
        field: "eventTriggerConditionId",
        type: "string",
        description: "具体条件 ID",
      },
    ],
    exampleNode: {
      type: "action",
      action: "perform maintenance ritual at the altar",
      eventTriggerId: "example_event_trigger",
      eventTriggerType: "maintain",
      eventTriggerConditionId: "altar_maintenance",
    },
  },

  stateDescription(dgsm: DynamicGameStateManager): string {
    const allStates = dgsm.getFeatureState(FEATURE_ID) as Record<
      string,
      EventTriggerInstanceState
    >;
    if (!allStates || Object.keys(allStates).length === 0) return "";

    const presets = getEventTriggerPresets(dgsm);
    if (presets.length === 0) return "";

    const sections: string[] = [];

    for (const def of presets) {
      const state = allStates[def.eventTriggerId];
      if (!state || state.status !== "active") continue;

      const lines: string[] = [];

      for (const condDef of def.conditions) {
        // Only show daily and cumulative conditions
        if (condDef.type === "prerequisite") continue;

        const cs = state.conditionStates[condDef.conditionId];
        if (!cs) continue;

        if (cs.type === "daily") {
          const mark = cs.fulfilledToday ? "\u2713" : "\u2717";
          lines.push(
            `- [daily] ${condDef.conditionId} ${condDef.label} ${mark} \u2192 eventTriggerType="${condDef.triggerType}", eventTriggerConditionId="${condDef.conditionId}"`
          );
        } else if (cs.type === "cumulative") {
          lines.push(
            `- [cumulative] ${condDef.conditionId} ${condDef.label} ${cs.currentCount}/${cs.requiredCount} \u2192 eventTriggerType="${condDef.triggerType}", eventTriggerConditionId="${condDef.conditionId}"`
          );
        }
      }

      // Add invoke line
      lines.push(`- 启动事件触发 \u2192 eventTriggerType="${def.invokeType}"`);

      if (lines.length > 0) {
        sections.push(
          `### ${def.eventTriggerId}（${def.label}）\n${lines.join("\n")}`
        );
      }
    }

    if (sections.length === 0) return "";

    return (
      `## 事件触发条件标记参考（仅用于判断行为是否与事件触发相关，规划行动时请依据你自身的记忆和正常注入的信息，不要参考此处内容）\n\n` +
      sections.join("\n\n")
    );
  },

  onNodeStart(
    node: PlanNode,
    dgsm: DynamicGameStateManager
  ): NodeStartBlockedResult | void {
    const nodeAny = node as Record<string, unknown>;
    const eventTriggerId = nodeAny.eventTriggerId as string | undefined;
    if (!eventTriggerId) return;

    const eventTriggerConditionId = nodeAny.eventTriggerConditionId as
      | string
      | undefined;
    if (!eventTriggerConditionId) return;

    const definition = findDefinition(dgsm, eventTriggerId);
    if (!definition) return;

    const state = getEventTriggerState(dgsm, eventTriggerId);
    if (!state || state.status !== "active") return;

    const condDef = definition.conditions.find(
      (c) => c.conditionId === eventTriggerConditionId
    );
    if (!condDef) return;

    const cs = state.conditionStates[eventTriggerConditionId];
    if (!cs || cs.type !== "prerequisite" || cs.mode !== "manual") return;

    // Check prerequisite (location/item) at action start time
    const fulfilled = checkPrerequisitePassive(
      dgsm,
      condDef,
      definition.conductorNpcId
    );
    cs.fulfilled = fulfilled;
    setEventTriggerState(dgsm, eventTriggerId, state);

    if (!fulfilled) {
      const missing: string[] = [];
      if (condDef.check?.location)
        missing.push(`location: ${condDef.check.location}`);
      if (condDef.check?.item) missing.push(`item: ${condDef.check.item}`);
      return {
        blocked: true,
        reason: `Prerequisite not met for "${definition.label}" — missing ${missing.join(", ")}`,
      };
    }
  },

  activate(
    node: PlanNode,
    dgsm: DynamicGameStateManager
  ): ActivateResult | void {
    const nodeAny = node as Record<string, unknown>;
    const eventTriggerId = nodeAny.eventTriggerId as string | undefined;
    if (!eventTriggerId) return;

    const eventTriggerType = nodeAny.eventTriggerType as string | undefined;
    const eventTriggerConditionId = nodeAny.eventTriggerConditionId as
      | string
      | undefined;

    // Find definition
    const definition = findDefinition(dgsm, eventTriggerId);
    if (!definition) {
      console.warn(
        `[event_trigger] No definition found for eventTriggerId="${eventTriggerId}"`
      );
      return;
    }

    // Get runtime state
    const state = getEventTriggerState(dgsm, eventTriggerId);
    if (!state) return;

    // Status check: only process active event triggers
    if (state.status !== "active") return;

    // Step 1: Invoke check (eventTriggerType matches invokeType and NOT autoInvoke)
    if (eventTriggerType === definition.invokeType && !definition.autoInvoke) {
      const allMet = checkAllConditions(definition, state, dgsm);
      if (allMet) {
        state.status = "completed";
        setEventTriggerState(dgsm, eventTriggerId, state);
        applyCompletionEffect(definition, dgsm);
        return;
      }
      // Conditions not met — nothing happened
      return {
        outcomeNote: `"${definition.label}" — nothing happened.`,
      };
    }

    // Step 2: Update specific condition
    if (!eventTriggerConditionId) return;

    const condDef = definition.conditions.find(
      (c) => c.conditionId === eventTriggerConditionId
    );
    if (!condDef) {
      console.warn(
        `[event_trigger] No condition "${eventTriggerConditionId}" found in event trigger "${eventTriggerId}"`
      );
      return;
    }

    const cs = state.conditionStates[eventTriggerConditionId];
    if (!cs) return;

    const gameDay = dgsm.getState().gameDay ?? 1;

    switch (cs.type) {
      case "daily":
        cs.fulfilledToday = true;
        cs.lastFulfilledDay = gameDay;
        break;
      case "cumulative":
        if (cs.currentCount < cs.requiredCount) {
          cs.currentCount += 1;
        }
        break;
      case "prerequisite":
        // manual: location/item already checked at action start via onNodeStart
        // passive: checked in real-time by checkAllConditions during invoke/autoInvoke
        break;
    }

    setEventTriggerState(dgsm, eventTriggerId, state);

    // Step 3: autoInvoke check after condition update
    if (definition.autoInvoke) {
      const allMet = checkAllConditions(definition, state, dgsm);
      if (allMet) {
        state.status = "completed";
        setEventTriggerState(dgsm, eventTriggerId, state);
        applyCompletionEffect(definition, dgsm);
      }
    }
  },

  tick(dgsm: DynamicGameStateManager, runtime: TickRuntimeContext): void {
    // Step 1: Init on first tick when featureState is empty
    const allStates = dgsm.getFeatureState(FEATURE_ID);
    if (Object.keys(allStates).length === 0) {
      initEventTriggersFromPresets(dgsm, runtime.gameDay);
      return;
    }

    // Step 2: Process all active event triggers
    const presets = getEventTriggerPresets(dgsm);
    for (const def of presets) {
      const state = getEventTriggerState(dgsm, def.eventTriggerId);
      if (!state || state.status !== "active") continue;

      let changed = false;

      // 2a. Day change handling
      if (runtime.gameDay > state.lastCheckedDay) {
        const dayGap = runtime.gameDay - state.lastCheckedDay;

        for (const condDef of def.conditions) {
          const cs = state.conditionStates[condDef.conditionId];
          if (!cs || cs.type !== "daily") continue;

          if (!cs.fulfilledToday) {
            cs.consecutiveMissed += dayGap;
          } else {
            cs.consecutiveMissed = 0;
          }

          // Reset for the new day
          cs.fulfilledToday = false;

          // Check failAfterMissed
          if (
            condDef.failAfterMissed !== undefined &&
            cs.consecutiveMissed >= condDef.failAfterMissed
          ) {
            state.status = "failed";
            setEventTriggerState(dgsm, def.eventTriggerId, state);
            applyFailureEffect(def, dgsm, runtime);
            changed = true;
            break; // This event trigger is now failed, stop processing its conditions
          }

          changed = true;
        }

        // If event trigger failed from a condition check above, skip further processing
        if (state.status === "failed") continue;

        state.lastCheckedDay = runtime.gameDay;
        changed = true;
      }

      // 2b. autoInvoke check
      if (def.autoInvoke && state.status === "active") {
        const allMet = checkAllConditions(def, state, dgsm);
        if (allMet) {
          state.status = "completed";
          setEventTriggerState(dgsm, def.eventTriggerId, state);
          applyCompletionEffect(def, dgsm, runtime);
          continue;
        }
      }

      if (changed) {
        setEventTriggerState(dgsm, def.eventTriggerId, state);
      }
    }
  },
};
