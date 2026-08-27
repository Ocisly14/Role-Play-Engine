// src/engine/resolution/worldDeltaSchema.ts
//
// LLM-facing tool schemas for the unified World Action Engine session: the
// deterministic code tools it may consult mid-session, and the single
// terminal `submit_resolution` tool whose arguments are the raw
// TickResolution. One schema for every action — no per-definition or
// per-action-kind variants (plan D8). The schema stays deliberately loose
// where enumeration would explode; worldDeltaValidator enforces the real
// contract in code.

import type { ToolSpec } from "../../models/providers/types.js";

// ==================== Raw (model-shaped) resolution ====================

/** What the model actually emits. Code turns this into a validated
 *  TickResolution: occurrence/fact ids are assigned by code, progress and
 *  lifecycle come from the clock, and every check is rolled and adjudicated
 *  deterministically against the bar set here. */
export interface RawActionResolution {
  actionId: string;
  /** Set when the action starts, or when the Engine revises how long it will
   *  take. The actor's proposedDurationTicks is advisory. */
  resolvedDurationTicks?: number;
  timingReason?: string;
  /** The bar for the skill the actor declared, set BEFORE any roll exists.
   *  Omitted when the declared skill does not fit, or no check is needed. */
  check?: RawCheck;
  /** Active resistance: who defends and with which skill. Code rolls both
   *  sides and compares levels. */
  opposedBy?: Array<{ characterId: string; skillId: string }>;
  /** Present ONLY on the resolving call: what happened once the duration was
   *  spent (or the world reached the action first). Its presence ends the
   *  action — code labels it completed or interrupted from the progress. */
  result?: RawActionResult;
  /** Engine-owned runtime annotation: set when this action has a movement leg
   *  the deterministic movement executor should advance tick by tick. The
   *  destination must have been checked with the pathfinding tool. */
  movement?: { destinationId: string };
}

export interface RawCheck {
  requiredLevel: "regular" | "hard" | "extreme";
  basis: string;
}

export interface RawActionResult {
  /** Required only when the action carried no check — with a check, code
   *  derives success from the roll against the bar. */
  outcome?: "success" | "partial" | "failure" | "blocked";
  reason: string;
}

export interface RawSourcedDelta {
  sourceActionId: string;
  causalBasis: string;
  operation: Record<string, unknown> & { kind: string };
}

export interface RawCharacterChange extends RawSourcedDelta {
  characterId: string;
}
export interface RawSceneChange extends RawSourcedDelta {
  sceneId: string;
}
export interface RawItemChange extends RawSourcedDelta {
  itemId?: string;
}

export interface RawOccurrence {
  sourceActionIds: string[];
  locationId?: string;
  facts: Array<{
    type: string;
    content: string;
    entityRefs?: Array<{ kind: "character" | "item" | "scene"; id: string }>;
  }>;
  participants: Array<{
    characterId: string;
    role: "actor" | "target" | "directly_affected";
  }>;
  perceiverCharacterIds: string[];
  signals?: Array<{
    /** Indexes into `facts` this signal carries. Omitted = all facts. */
    factIndexes?: number[];
    channel: "visual" | "sound" | "smell" | "touch" | "direct";
    originLocationId?: string;
    intensity?: number;
  }>;
}

export interface RawTickResolution {
  actions: RawActionResolution[];
  characterChanges?: RawCharacterChange[];
  sceneChanges?: RawSceneChange[];
  itemChanges?: RawItemChange[];
  occurrences?: RawOccurrence[];
}

// ==================== Terminal tool schema ====================

const ENTITY_REF = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["character", "item", "scene"] },
    id: { type: "string" },
  },
  required: ["kind", "id"],
  additionalProperties: false,
} as const;

const sourcedDelta = (idField: string, idRequired: boolean) => ({
  type: "object",
  properties: {
    sourceActionId: { type: "string" },
    causalBasis: {
      type: "string",
      description: "Short factual statement of why this change follows.",
    },
    [idField]: { type: "string" },
    operation: {
      type: "object",
      properties: { kind: { type: "string" } },
      required: ["kind"],
      additionalProperties: true,
    },
  },
  required: [
    "sourceActionId",
    "causalBasis",
    ...(idRequired ? [idField] : []),
    "operation",
  ],
  additionalProperties: false,
});

export const submitResolutionTool: ToolSpec = {
  name: "submit_resolution",
  description:
    "Terminal: submit the complete resolution of this tick — one entry per triggering action (its duration and difficulty when it starts, its result when it resolves), sourced world deltas grouped by domain, and objective occurrences with perceiver character ids.",
  inputSchema: {
    type: "object",
    properties: {
      actions: {
        type: "array",
        description:
          "Exactly one entry per triggering action (new commands and due/affected active actions).",
        items: {
          type: "object",
          properties: {
            actionId: { type: "string" },
            resolvedDurationTicks: {
              type: "integer",
              minimum: 1,
              description:
                "How long the action SHOULD take. REQUIRED when the action starts; send it again only to revise the estimate. You never state elapsed time — code advances progress from the clock.",
            },
            timingReason: {
              type: "string",
              description:
                "Objective reason for the chosen or revised duration. Required with resolvedDurationTicks.",
            },
            check: {
              type: "object",
              description:
                "The bar for the skill the actor declared, set when the action STARTS — before any roll exists. Omit entirely when the declared skill does not fit the attempt or no check is needed: an omitted check means the skill grants nothing, and the action is settled on its own merits. Never raise the bar to punish a poor skill choice.",
              properties: {
                requiredLevel: {
                  type: "string",
                  enum: ["regular", "hard", "extreme"],
                },
                basis: {
                  type: "string",
                  description:
                    "Factual reason this situation demands that level. No roll exists yet.",
                },
              },
              required: ["requiredLevel", "basis"],
              additionalProperties: false,
            },
            opposedBy: {
              type: "array",
              description:
                "Set when someone actively resists: the character and the defense skill they resist with. Code rolls both sides and compares levels; you choose who defends and with what, never who wins.",
              items: {
                type: "object",
                properties: {
                  characterId: { type: "string" },
                  skillId: { type: "string" },
                },
                required: ["characterId", "skillId"],
                additionalProperties: false,
              },
            },
            result: {
              type: "object",
              description:
                "What happened, sent ONLY on the call where the action resolves. Its presence ends the action. The check result you were given is input: never restate or contradict it.",
              properties: {
                outcome: {
                  type: "string",
                  enum: ["success", "partial", "failure", "blocked"],
                  description:
                    "Required only for an action with NO check. With a check, code derives success from the roll against your bar.",
                },
                reason: { type: "string" },
              },
              required: ["reason"],
              additionalProperties: false,
            },
            movement: {
              type: "object",
              description:
                "Set when the action has a movement leg: the deterministic movement executor will walk the character there tick by tick. Verify the destination with the pathfinding tool first.",
              properties: { destinationId: { type: "string" } },
              required: ["destinationId"],
              additionalProperties: false,
            },
          },
          required: ["actionId"],
          additionalProperties: false,
        },
      },
      characterChanges: {
        type: "array",
        description:
          "Persistent character-state changes only (hp/san/fatigue/position/addCondition/removeCondition/relationship). Descriptive results belong in occurrences.",
        items: sourcedDelta("characterId", true),
      },
      sceneChanges: {
        type: "array",
        description:
          "Scene-state changes (addCondition/removeCondition/connectionBlock/environmentContribute/environmentHazard).",
        items: sourcedDelta("sceneId", true),
      },
      itemChanges: {
        type: "array",
        description:
          "Item changes (create/move/modify/damage/destroy). itemId required except for create.",
        items: sourcedDelta("itemId", false),
      },
      occurrences: {
        type: "array",
        description:
          "Objective things that happened this tick (speech, noises, visible attempts, action results). Facts are world-true, third-person, no character-perspective wording. perceiverCharacterIds = every character physically/sensorially able to perceive it.",
        items: {
          type: "object",
          properties: {
            sourceActionIds: { type: "array", items: { type: "string" } },
            locationId: { type: "string" },
            facts: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    description:
                      'e.g. "speech", "sound", "movement", "action_result"',
                  },
                  content: { type: "string" },
                  entityRefs: { type: "array", items: ENTITY_REF },
                },
                required: ["type", "content"],
                additionalProperties: false,
              },
            },
            participants: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  characterId: { type: "string" },
                  role: {
                    type: "string",
                    enum: ["actor", "target", "directly_affected"],
                  },
                },
                required: ["characterId", "role"],
                additionalProperties: false,
              },
            },
            perceiverCharacterIds: {
              type: "array",
              items: { type: "string" },
            },
            signals: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  factIndexes: { type: "array", items: { type: "integer" } },
                  channel: {
                    type: "string",
                    enum: ["visual", "sound", "smell", "touch", "direct"],
                  },
                  originLocationId: { type: "string" },
                  intensity: { type: "number" },
                },
                required: ["channel"],
                additionalProperties: false,
              },
            },
          },
          required: [
            "sourceActionIds",
            "facts",
            "participants",
            "perceiverCharacterIds",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["actions"],
    additionalProperties: false,
  },
};

// ==================== Incremental repair ====================

/**
 * A patch over the previous submission, addressed by the same targets the
 * errors used. Only the flagged elements are re-sent; everything else stands.
 *
 * Deltas and occurrences are addressed by index, and indexes stay stable
 * across repair rounds — a withdrawn element leaves a hole rather than
 * compacting the array, so an address quoted in round 1 still means the same
 * element in round 2.
 */
export interface RawResolutionRepair {
  /** Replaces the transition with the same actionId. */
  actions?: RawActionResolution[];
  /** index (as a string key) → replacement, or null to withdraw. */
  characterChanges?: Record<string, RawCharacterChange | null>;
  sceneChanges?: Record<string, RawSceneChange | null>;
  itemChanges?: Record<string, RawItemChange | null>;
  occurrences?: Record<string, RawOccurrence | null>;
  /** Appended, for elements the resolution was missing entirely. */
  addCharacterChanges?: RawCharacterChange[];
  addSceneChanges?: RawSceneChange[];
  addItemChanges?: RawItemChange[];
  addOccurrences?: RawOccurrence[];
}

const patchMap = (itemSchema: unknown, what: string) => ({
  type: "object",
  description: `${what} to replace, keyed by the index quoted in the error (e.g. "2"). Use null to withdraw one.`,
  additionalProperties: itemSchema,
});

export const repairResolutionTool: ToolSpec = {
  name: "repair_resolution",
  description:
    "Fix ONLY the elements named in the errors. Everything you do not mention stays exactly as you submitted it — do not re-send correct parts, and do not re-send the whole resolution.",
  inputSchema: {
    type: "object",
    properties: {
      actions: {
        type: "array",
        description:
          "Corrected transitions. Each replaces the existing transition with the same actionId.",
        items: (submitResolutionTool.inputSchema as {
          properties: { actions: { items: unknown } };
        }).properties.actions.items,
      },
      characterChanges: patchMap(
        sourcedDelta("characterId", true),
        "Character changes"
      ),
      sceneChanges: patchMap(sourcedDelta("sceneId", true), "Scene changes"),
      itemChanges: patchMap(sourcedDelta("itemId", false), "Item changes"),
      occurrences: patchMap(
        (submitResolutionTool.inputSchema as {
          properties: { occurrences: { items: unknown } };
        }).properties.occurrences.items,
        "Occurrences"
      ),
      addCharacterChanges: {
        type: "array",
        description: "New character changes the resolution was missing.",
        items: sourcedDelta("characterId", true),
      },
      addSceneChanges: {
        type: "array",
        description: "New scene changes the resolution was missing.",
        items: sourcedDelta("sceneId", true),
      },
      addItemChanges: {
        type: "array",
        description: "New item changes the resolution was missing.",
        items: sourcedDelta("itemId", false),
      },
      addOccurrences: {
        type: "array",
        description: "New occurrences the resolution was missing.",
        items: (submitResolutionTool.inputSchema as {
          properties: { occurrences: { items: unknown } };
        }).properties.occurrences.items,
      },
    },
    required: [],
    additionalProperties: false,
  },
};

// ==================== Code-tool schemas for the session ====================

/** LLM-facing declarations of the deterministic code tools. Execution runs
 *  through the CodeToolRegistry; results are trusted and recorded. */
export const CODE_TOOL_SPECS: ToolSpec[] = [
  {
    name: "pathfinding",
    description:
      "Plan the route from a character's current position to a destination id (scene/junction/road). Returns reachability, leg summary and total minutes.",
    inputSchema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        destinationId: { type: "string" },
      },
      required: ["characterId", "destinationId"],
      additionalProperties: false,
    },
  },
  {
    name: "movementCost",
    description:
      "Estimate travel time (minutes/ticks) from a character's current position to a destination id.",
    inputSchema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        destinationId: { type: "string" },
      },
      required: ["characterId", "destinationId"],
      additionalProperties: false,
    },
  },
  {
    name: "inventoryValidation",
    description:
      "Locate an item (scene or inventory), check unique ownership, and optionally whether an actor holds/can reach it.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        actorId: { type: "string" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "opposedRoll",
    description:
      "Roll a DEFENDER's chosen defense skill for an opposed check (real value, penalties applied). The actor's roll already exists on the command — never re-roll it.",
    inputSchema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        skillId: { type: "string" },
      },
      required: ["characterId", "skillId"],
      additionalProperties: false,
    },
  },
  {
    name: "damageRoll",
    description:
      'Roll a damage formula (e.g. "1d6+1") plus an optional CoC damage-bonus string ("+1d4").',
    inputSchema: {
      type: "object",
      properties: {
        formula: { type: "string" },
        damageBonus: { type: "string" },
      },
      required: ["formula"],
      additionalProperties: false,
    },
  },
];
