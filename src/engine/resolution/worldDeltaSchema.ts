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
/** An action that BEGINS this tick: how long it should take, and how hard it
 *  is. Never its outcome — that comes when its time is spent. */
export interface RawActionStart {
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
  /** Engine-owned runtime annotation: set when this action has a movement leg
   *  the deterministic movement executor should advance tick by tick. The
   *  destination must have been checked with the pathfinding tool. */
  movement?: { destinationId: string };
}

export interface RawCheck {
  requiredLevel: "regular" | "hard" | "extreme";
  basis: string;
}

/**
 * An action that FINISHES this tick.
 *
 * Split from {@link RawActionStart} rather than sharing one optional-everything
 * shape, because the shape is what the model reasons from. When both moments
 * were one type, "an action that is starting has no result yet" and "the bar
 * cannot change mid-flight" were rules the validator enforced against a type
 * that permitted exactly what it then rejected — the model had to look up the
 * action's status in a DIFFERENT section of the prompt to know which half of
 * the type it was allowed to fill in. Six of sixteen rejections in one
 * measured run were that lookup going wrong.
 */
export interface RawActionEnd {
  actionId: string;
  /** REQUIRED when the action carried no check. When it did, code has already
   *  decided success from the roll and this field is refused. The trigger
   *  section names exactly which ids need it. */
  outcome?: "success" | "partial" | "failure" | "blocked";
  /** What happened, objectively. */
  reason: string;
  /** The trace this ending leaves in the world. Required here rather than
   *  cross-referenced from the `occurrences` array: "every action that ends
   *  leaves an occurrence" is unenforceable in a schema when the two live in
   *  different arrays, and it was the third-most-common rejection. The source
   *  is this action, so it is not restated. */
  occurrence: Omit<RawOccurrence, "sourceActionIds">;
  /** Revised estimate, when the Engine now knows it ran longer or shorter. */
  resolvedDurationTicks?: number;
  timingReason?: string;
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
  /** The two moments. Both optional on the wire — a tick with nothing ending
   *  simply omits `ending` — and `normalizeRawResolution` fills the gaps
   *  before anything reads them. An action that is merely still running
   *  appears in neither: silence already means "keeps running". */
  starting?: RawActionStart[];
  ending?: RawActionEnd[];
  characterChanges?: RawCharacterChange[];
  sceneChanges?: RawSceneChange[];
  itemChanges?: RawItemChange[];
  occurrences?: RawOccurrence[];
}

// ==================== Terminal tool schema ====================

/**
 * The `operation` contract, per domain, in one place.
 *
 * `operation` cannot be a proper discriminated union in the tool schema — it is
 * declared `additionalProperties: true` with only `kind` required — so the
 * field names reach the model as prose. That prose and the validator's list of
 * accepted kinds used to be written out separately, which is the same
 * arrangement that let `result.outcome` be optional in one place and mandatory
 * in the other. Both now come from these rows.
 *
 * The per-field checks stay in the validator: those are judgements about the
 * world (does this character exist, does the holder match), not declarations.
 */
export interface OperationSpec {
  /** Kinds sharing one field list. */
  kinds: string[];
  /** Field list exactly as the model should write it, `kind` excluded. */
  fields: string;
}

export const CHARACTER_OPS: OperationSpec[] = [
  { kinds: ["hp", "san", "fatigue"], fields: "delta:number, reason:string" },
  {
    kinds: ["position"],
    fields:
      'position:{type:"scene"|"junction"|"road", sceneId|junctionId|roadId}',
  },
  {
    kinds: ["addCondition"],
    fields: "condition:{id:string, description:string}",
  },
  { kinds: ["removeCondition"], fields: "conditionId:string" },
  {
    kinds: ["relationship"],
    fields: "toCharacterId:string, delta?:number, note?:string",
  },
];

export const SCENE_OPS: OperationSpec[] = [
  {
    kinds: ["addCondition"],
    fields:
      "condition:{description:string, featureId?:string, mechanicalEffect?:object}",
  },
  { kinds: ["removeCondition"], fields: "predicate:{featureId:string}" },
  {
    kinds: ["connectionBlock"],
    fields: "connectionId:string, blocked:boolean, reason:string",
  },
  {
    kinds: ["environmentContribute"],
    fields:
      'quantity:"temperature"|"illumination"|"oxygen"|"noise", value:number',
  },
  {
    kinds: ["environmentHazard"],
    fields: "add?:string[], remove?:string[]",
  },
];

export const ITEM_OPS: OperationSpec[] = [
  {
    kinds: ["create"],
    fields:
      "name:string, location:<sceneId or characterId>, properties?:object",
  },
  {
    kinds: ["move"],
    fields: "from:<current holder>, to:<sceneId or characterId>",
  },
  { kinds: ["modify"], fields: "description:string" },
  { kinds: ["damage"], fields: "damagedBy:string, reason:string" },
  { kinds: ["destroy"], fields: "" },
];

/** The prose the model reads. */
function renderOps(ops: OperationSpec[]): string {
  return ops
    .map(
      (op) =>
        `{kind:${op.kinds.map((k) => `"${k}"`).join("|")}${
          op.fields ? `, ${op.fields}` : ""
        }}`
    )
    .join(" · ");
}

/** The set the validator accepts. Same rows, so they cannot disagree. */
export function opKinds(ops: OperationSpec[]): ReadonlySet<string> {
  return new Set(ops.flatMap((op) => op.kinds));
}

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
      description:
        "Shape depends on `kind` — see the exact field list on the array this delta belongs to. Field names are literal: a wrong one is a rejection, not a synonym.",
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

/** Everything an occurrence is, minus who caused it. Hoisted so the same
 *  shape can be embedded in an ending (where the cause is the action itself)
 *  and listed standalone (where it has to be named). */
const OCCURRENCE_BODY = {
  locationId: { type: "string" },
  facts: {
    type: "array",
    minItems: 1,
    items: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: 'e.g. "speech", "sound", "movement", "action_result"',
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
  perceiverCharacterIds: { type: "array", items: { type: "string" } },
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
} as const;

const OCCURRENCE_REQUIRED = ["facts", "participants", "perceiverCharacterIds"];

export const submitResolutionTool: ToolSpec = {
  name: "submit_resolution",
  description:
    "Terminal: submit the complete resolution of this tick — one entry per triggering action (its duration and difficulty when it starts, its result when it resolves), sourced world deltas grouped by domain, and objective occurrences with perceiver character ids.",
  inputSchema: {
    type: "object",
    properties: {
      starting: {
        type: "array",
        description:
          "Actions that BEGIN this tick — the ids the trigger section lists under `starting`. How long each should take and how hard it is. Never an outcome: its time has not been spent yet.",
        items: {
          type: "object",
          properties: {
            actionId: { type: "string" },
            resolvedDurationTicks: {
              type: "integer",
              minimum: 1,
              description:
                "How long the action SHOULD take. You never state elapsed time — code advances progress from the clock.",
            },
            timingReason: {
              type: "string",
              description: "Objective reason for the chosen duration.",
            },
            check: {
              type: "object",
              description:
                "The bar for the skill the actor declared, set BEFORE any roll exists. Omit entirely when the declared skill does not fit the attempt or no check is needed: an omitted check means the skill grants nothing, and the action is settled on its own merits. Never raise the bar to punish a poor skill choice. An actor who declared NO skill cannot be checked at all.",
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
                "Set when someone actively resists: the character and the defense skill they resist with. Code rolls both sides and compares levels; you choose who defends and with what, never who wins. Needs `check`.",
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
            movement: {
              type: "object",
              description:
                "Set when the action has a movement leg: the deterministic movement executor will walk the character there tick by tick. Verify the destination with the pathfinding tool first.",
              properties: { destinationId: { type: "string" } },
              required: ["destinationId"],
              additionalProperties: false,
            },
          },
          required: ["actionId", "resolvedDurationTicks", "timingReason"],
          additionalProperties: false,
        },
      },
      ending: {
        type: "array",
        description:
          "Actions that FINISH this tick — the ids the trigger section lists under `ending`. What happened, and the trace it leaves. The bar was set when the action started and cannot be revisited here.",
        items: {
          type: "object",
          properties: {
            actionId: { type: "string" },
            outcome: {
              type: "string",
              enum: ["success", "partial", "failure", "blocked"],
              description:
                "REQUIRED for every id the trigger section lists under `endingNeedsOutcome` — those actions carried no check, so there is no roll to derive success from and you decide it. For any other ending, code has already decided success from the roll against your bar and this field is refused.",
            },
            reason: {
              type: "string",
              description:
                "What happened, objectively. The check result you were given is input: never restate or contradict it.",
            },
            occurrence: {
              type: "object",
              description:
                "The objective trace this ending leaves. Every action that ends leaves one — that is why it lives here rather than in the `occurrences` array.",
              properties: { ...OCCURRENCE_BODY },
              required: OCCURRENCE_REQUIRED,
              additionalProperties: false,
            },
            resolvedDurationTicks: {
              type: "integer",
              minimum: 1,
              description:
                "Only to revise the estimate — say so in timingReason.",
            },
            timingReason: { type: "string" },
          },
          required: ["actionId", "reason", "occurrence"],
          additionalProperties: false,
        },
      },
      characterChanges: {
        type: "array",
        description: `Persistent character-state changes only; descriptive results belong in occurrences. \`operation\` is one of, with exactly these fields: ${renderOps(CHARACTER_OPS)}.`,
        items: sourcedDelta("characterId", true),
      },
      sceneChanges: {
        type: "array",
        description: `Scene-state changes. \`operation\` is one of, with exactly these fields: ${renderOps(SCENE_OPS)}.`,
        items: sourcedDelta("sceneId", true),
      },
      itemChanges: {
        type: "array",
        description: `Item changes; itemId is required except for create. \`operation\` is one of, with exactly these fields: ${renderOps(ITEM_OPS)}.`,
        items: sourcedDelta("itemId", false),
      },
      occurrences: {
        type: "array",
        description:
          "Objective things that happened this tick that are NOT an action ending — speech, noises, a visible attempt in progress. An ending's trace goes on the ending itself. Facts are world-true, third-person, no character-perspective wording. perceiverCharacterIds = every character physically/sensorially able to perceive it.",
        items: {
          type: "object",
          properties: {
            sourceActionIds: { type: "array", items: { type: "string" } },
            ...OCCURRENCE_BODY,
          },
          required: ["sourceActionIds", ...OCCURRENCE_REQUIRED],
          additionalProperties: false,
        },
      },
    },
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
/** Where a repair item lands. Carried INSIDE the item, so every field of the
 *  repair tool is a plain array exactly like the submission it repairs —
 *  index-keyed objects next to arrays is what made the model send one where
 *  the other belonged. */
export interface RepairAddress {
  /** Replaces the element the error quoted (`characterChange:2` → 2). Absent
   *  means this is a new element to append. */
  index?: number;
  /** With `index`, withdraws that element instead of replacing it. */
  remove?: boolean;
}

/** Partial: a withdrawal carries only `index` and `remove`, and every
 *  replacement is re-validated against the real contract after the merge. */
export type RepairItem<T> = Partial<T> & RepairAddress;

export interface RawResolutionRepair {
  /** Each replaces the entry with the same actionId in its own list; a new
   *  actionId appends. Moving an action between lists is done by sending it
   *  in the list it belongs in — the merge drops it from the others. */
  starting?: RawActionStart[];
  ending?: RawActionEnd[];
  characterChanges?: Array<RepairItem<RawCharacterChange>>;
  sceneChanges?: Array<RepairItem<RawSceneChange>>;
  itemChanges?: Array<RepairItem<RawItemChange>>;
  occurrences?: Array<RepairItem<RawOccurrence>>;
}

/** Same array shape as the submission, plus the address fields. `required` is
 *  dropped: a withdrawal carries only `index` and `remove`, and every
 *  replacement is re-validated against the real contract anyway. */
const repairable = (itemSchema: unknown, what: string) => {
  const item = itemSchema as {
    type: string;
    properties: Record<string, unknown>;
  };
  return {
    type: "array",
    description: `${what} to fix. Each item says where it goes: "index" replaces the element the error quoted (characterChange:2 → index 2); no "index" appends a new element; "remove": true withdraws the one at "index".`,
    items: {
      ...item,
      properties: {
        ...item.properties,
        index: {
          type: "integer",
          minimum: 0,
          description: "The index quoted in the error. Omit to append.",
        },
        remove: {
          type: "boolean",
          description: "With index: withdraw that element.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  };
};

export const repairResolutionTool: ToolSpec = {
  name: "repair_resolution",
  description:
    "Fix ONLY the elements named in the errors. Everything you do not mention stays exactly as you submitted it — do not re-send correct parts, and do not re-send the whole resolution.",
  inputSchema: {
    type: "object",
    properties: {
      ...Object.fromEntries(
        (["starting", "ending"] as const).map((moment) => [
          moment,
          {
            type: "array",
            description: `Corrected \`${moment}\` entries. Each replaces the one with the same actionId; sending an action here also removes it from the other list, which is how an action moves between moments.`,
            items: (
              submitResolutionTool.inputSchema as {
                properties: Record<string, { items: unknown }>;
              }
            ).properties[moment].items,
          },
        ])
      ),
      characterChanges: repairable(
        sourcedDelta("characterId", true),
        "Character changes"
      ),
      sceneChanges: repairable(sourcedDelta("sceneId", true), "Scene changes"),
      itemChanges: repairable(sourcedDelta("itemId", false), "Item changes"),
      occurrences: repairable(
        (
          submitResolutionTool.inputSchema as {
            properties: { occurrences: { items: unknown } };
          }
        ).properties.occurrences.items,
        "Occurrences"
      ),
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
