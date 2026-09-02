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
  /** Engine-owned runtime annotation: set when this action has a movement
   *  leg. `route` is the path THE ACTOR STATED, grounded to place ids —
   *  ordered waypoints, each topologically adjacent to the previous, the
   *  last being the destination. The Engine never invents an unstated leg:
   *  a character who did not say how to get somewhere has not chosen a way,
   *  and their walk ends where their words end. */
  movement?: { route: string[]; vehicleId?: string };
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

/** One declared sanity check, riding on the occurrence whose perception
 *  caused it. The model declares; code rolls. A PASSED check costs nothing at
 *  all, so there is only a failure loss — no success/failure pair. */
export interface RawSanityCheck {
  characterId: string;
  /** Dice formula for the loss on a FAILED check, e.g. "1", "1d4", "1d10". */
  failureLoss: string;
  /** Candidate severe impairment if the failed roll actually loses at least
   *  5 SAN. Lesser losses change SAN but do not create a condition. */
  consequence?: {
    /** Objective signs and the major impairment they cause. */
    description: string;
    /** Whole in-world minutes; becomes the condition's `expiresAt`. */
    durationMinutes: number;
  };
}

export interface RawOccurrence {
  sourceActionIds: string[];
  locationId?: string;
  facts: Array<{
    type: string;
    content: string;
    entityRefs?: Array<{
      kind: "character" | "item" | "scene" | "connection";
      id: string;
    }>;
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
  sanityChecks?: RawSanityCheck[];
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
  /** The same fields as a strict-compatible JSON Schema fragment, `kind`
   *  excluded. `opSchema` turns each row into one `anyOf` branch, so the
   *  prose the model reads and the grammar the provider enforces come from
   *  one table and cannot disagree. Every nested object must close with
   *  `additionalProperties: false`; no `minimum`/`maximum`/`pattern`. */
  schema: {
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const STR = { type: "string" } as const;
const BOOL = { type: "boolean" } as const;
const STR_LIST = { type: "array", items: STR } as const;

export const CHARACTER_OPS: OperationSpec[] = [
  {
    kinds: ["hp", "san", "fatigue"],
    fields: "delta:number, reason:string",
    schema: {
      properties: { delta: { type: "integer" }, reason: STR },
      required: ["delta", "reason"],
    },
  },
  {
    // Scene only. A road position carries a fraction along the road that only
    // the movement runtime knows how to set; a `position` op that stood a
    // character on a road left the fraction out, and the next route planned
    // from there was NaN and took the whole tick down with it.
    kinds: ["position"],
    fields:
      'position:{type:"scene", sceneId:string} — a displacement that is NOT a walk: boarding or leaving a vehicle (its interior scene), or the consequence of an act that moves a body without a route — out through a window, carried off, dragged, thrown, fallen through. NEVER for going somewhere: a character who walks, runs, sneaks, rides or crawls to another place gets `movement.route` on the action, and this op is refused in your head before it is written. A road is walked, never assigned',
    schema: {
      properties: {
        position: {
          type: "object",
          properties: { type: { const: "scene" }, sceneId: STR },
          required: ["type", "sceneId"],
          additionalProperties: false,
        },
      },
      required: ["position"],
    },
  },
  {
    kinds: ["spot"],
    fields:
      'spot:string — where in the place they now are, one short phrase; "" clears it',
    schema: { properties: { spot: STR }, required: ["spot"] },
  },
  {
    kinds: ["addCondition"],
    fields:
      "condition:{id:string, description:string} — description must state an objective, persistent, independently observable/verifiable state and the important mental or physical function it makes impossible or severely impairs; never a thought, feeling, mood, attitude, opinion, suspicion, relationship stance, or recognition",
    schema: {
      properties: {
        condition: {
          type: "object",
          properties: { id: STR, description: STR },
          required: ["id", "description"],
          additionalProperties: false,
        },
      },
      required: ["condition"],
    },
  },
  {
    kinds: ["removeCondition"],
    fields: "conditionId:string",
    schema: { properties: { conditionId: STR }, required: ["conditionId"] },
  },
  // No `relationship`. What one character thinks of another is theirs to
  // write, through `writeMemory`, and nothing is recorded on their behalf.
  // The Engine had an operation for it, and it did exactly the damage that
  // rule exists to prevent: told to record that Nancy had grown wary of
  // Philip, the code wrote the same score and the SAME NOTE onto Philip's
  // row, inventing his opinion of her out of hers of him.
];

export const SCENE_OPS: OperationSpec[] = [
  {
    // `mechanicalEffect` is not offered: it is a skill-penalty MAP, which a
    // strict schema cannot express, the validator never read it, and only
    // subsystems (fire, sun, stamina) set one — in code.
    kinds: ["addCondition"],
    fields: "condition:{description:string, featureId?:string}",
    schema: {
      properties: {
        condition: {
          type: "object",
          properties: { description: STR, featureId: STR },
          required: ["description"],
          additionalProperties: false,
        },
      },
      required: ["condition"],
    },
  },
  {
    kinds: ["removeCondition"],
    fields:
      "predicate:{id?:string, featureId?:string} — at least one; id removes that one condition, featureId removes every condition that feature owns",
    schema: {
      properties: {
        predicate: {
          type: "object",
          properties: { id: STR, featureId: STR },
          additionalProperties: false,
        },
      },
      required: ["predicate"],
    },
  },
  {
    kinds: ["setDescription"],
    fields:
      "description:string — REPLACES the place's whole prose; keep every still-true [reference-id] citation, drop citations to things no longer visibly here",
    schema: { properties: { description: STR }, required: ["description"] },
  },
  {
    kinds: ["connectionBlock"],
    fields: "connectionId:string, blocked:boolean, reason:string",
    schema: {
      properties: { connectionId: STR, blocked: BOOL, reason: STR },
      required: ["connectionId", "blocked", "reason"],
    },
  },
  {
    kinds: ["connectionDiscovered"],
    fields:
      "connectionId:string, characterIds:string[] — these characters have FOUND a concealed passage. List EVERYONE who could see it happen, not just whoever acted: from now each of them perceives it and may use it, and it stays shut for everyone else. Only for a connection that is hidden. To open it for the whole world instead (a door forced, a wall broken) use connectionHidden with hidden:false",
    schema: {
      properties: { connectionId: STR, characterIds: STR_LIST },
      required: ["connectionId", "characterIds"],
    },
  },
  {
    kinds: ["connectionHidden"],
    fields:
      "connectionId:string, hidden:boolean — false reveals a concealed exit, true conceals one",
    schema: {
      properties: { connectionId: STR, hidden: BOOL },
      required: ["connectionId", "hidden"],
    },
  },
  {
    kinds: ["environmentContribute"],
    fields:
      'quantity:"temperature"|"illumination"|"oxygen"|"noise", value:number',
    schema: {
      properties: {
        quantity: {
          type: "string",
          enum: ["temperature", "illumination", "oxygen", "noise"],
        },
        value: { type: "number" },
      },
      required: ["quantity", "value"],
    },
  },
  {
    kinds: ["environmentHazard"],
    fields: "add?:string[], remove?:string[]",
    schema: { properties: { add: STR_LIST, remove: STR_LIST } },
  },
];

/** Two questions, and they are not the same question.
 *
 *  WHERE an item is and WHETHER it exists are structural: perception lists the
 *  ids in `scene.items` and an inventory, and the citation boundary accepts
 *  exactly those ids. A destroyed thing written up only in prose stays in both
 *  lists — visible, citable, actable — which is the failure this codebase has
 *  already paid for elsewhere. So `create` · `move` · `destroy` stay.
 *
 *  WHAT an item is like is prose plus, for now, two lighting numbers, and
 *  `set` covers all of it. It replaces `modify` and `damage`: damage was only
 *  ever a sentence appended to a description, and it had no way to put out a
 *  lamp it had just smashed — `sun.ts` went on counting the light. */
export const ITEM_OPS: OperationSpec[] = [
  {
    kinds: ["create"],
    fields:
      'name:string, location:<"scene:<placeId>" or characterId>, description?:string, id?:string — stable id; must be unused; omit to auto-generate; ALWAYS pass one for non-Latin names',
    schema: {
      properties: { name: STR, location: STR, description: STR, id: STR },
      required: ["name", "location"],
    },
  },
  {
    kinds: ["move"],
    fields:
      'from:<current holder, exactly as the Items section shows it>, to:<"scene:<placeId>" for a place — a vehicle interior scene included — or a bare characterId> (one holder grammar, same as create.location). If the FROM place\'s prose cites this item, the same submission must rewrite that description (scene setDescription) — the prose must not keep pointing at what left',
    schema: { properties: { from: STR, to: STR }, required: ["from", "to"] },
  },
  {
    kinds: ["destroy"],
    fields:
      "(no fields). If the holder place's prose cites this item, the same submission must rewrite that description (scene setDescription)",
    schema: { properties: {} },
  },
  {
    kinds: ["set"],
    fields:
      "any of — description:string (REPLACES the whole description; write everything still true of the thing) · appendDescription:string (adds one sentence to what is there; how damage is recorded — say who or what did it, and do not repeat what the description already says) · hidden:boolean (false REVEALS a concealed item to characters, true conceals it) · isLightSource:boolean (false when it no longer lights the room, e.g. smashed) · lightLevel:number",
    schema: {
      properties: {
        description: STR,
        appendDescription: STR,
        hidden: BOOL,
        isLightSource: BOOL,
        lightLevel: { type: "number" },
      },
    },
  },
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

/** The grammar the provider enforces: one closed object per kind, chosen by
 *  `kind`'s constant. Replaces the open `additionalProperties: true` object
 *  that strict mode refuses — and that let a misspelt field through to the
 *  validator, a repair round later. */
export function opSchema(ops: OperationSpec[]): { anyOf: unknown[] } {
  return {
    anyOf: ops.flatMap((op) =>
      op.kinds.map((kind) => ({
        type: "object",
        properties: { kind: { const: kind }, ...op.schema.properties },
        required: ["kind", ...(op.schema.required ?? [])],
        additionalProperties: false,
      }))
    ),
  };
}

const ENTITY_REF = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["character", "item", "scene", "connection"],
    },
    id: { type: "string" },
  },
  required: ["kind", "id"],
  additionalProperties: false,
} as const;

const sourcedDelta = (
  idField: string,
  idRequired: boolean,
  ops: OperationSpec[]
) => ({
  type: "object",
  properties: {
    sourceActionId: { type: "string" },
    causalBasis: {
      type: "string",
      description: "Short factual statement of why this change follows.",
    },
    [idField]: { type: "string" },
    // No `description` beside the `anyOf`: the array's description already
    // spells out every kind's fields, and a sibling keyword on a union is
    // the kind of thing a strict grammar compiler may refuse.
    operation: opSchema(ops),
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
        content: {
          type: "string",
          description:
            "The finished fact, third person and world-true. Read by characters, so it carries no reasoning and no corrections — settle who did what before writing it.",
        },
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
  // Declared here, rolled by code. The count and minute bounds live in the
  // validator and in these descriptions, not as schema keywords: strict mode
  // supports neither `maxItems` nor `minimum`/`maximum`.
  sanityChecks: {
    type: "array",
    description:
      "Involuntary sanity checks caused by perceiving THIS occurrence — at most 8. Rare — see the sanity guidance for the closed list of things that warrant one. Code reads the character's SAN, rolls d100 and settles it; a passed check costs nothing at all. Do not also write a character `san` change for the same exposure.",
    items: {
      type: "object",
      properties: {
        characterId: {
          type: "string",
          description:
            "Must be one of this occurrence's perceiverCharacterIds — exposure is perception.",
        },
        failureLoss: {
          type: "string",
          description:
            'SAN lost when the check FAILS: "1", "1d4", "1d6" or "1d10". There is no success loss — passing is free. A flat zero is refused.',
        },
        consequence: {
          type: "object",
          description:
            "Optional candidate condition for a severe failed reaction. Code applies it only when actual SAN loss is at least 5. Omit it for a reaction that would only be fear, distress, unease, or another inner feeling.",
          properties: {
            description: {
              type: "string",
              description:
                "One objective present-tense description combining signs another observer could see or independently verify with the important mental or physical function now impossible or severely impaired. Never first-person inner narration, thoughts, feelings, mood, attitude, or opinion. If no major impairment exists, omit the whole consequence.",
            },
            durationMinutes: {
              type: "integer",
              description:
                "Whole in-world minutes it lasts, from 5 to 1440. Nothing but the clock can revoke it.",
            },
          },
          required: ["description", "durationMinutes"],
          additionalProperties: false,
        },
      },
      required: ["characterId", "failureLoss"],
      additionalProperties: false,
    },
  },
} as const;

const OCCURRENCE_REQUIRED = ["facts", "participants", "perceiverCharacterIds"];

export const submitResolutionTool: ToolSpec = {
  name: "submit_resolution",
  // NOT strict, and not for want of trying. Without a grammar the model has
  // handed back `starting` as a JSON string, a whole submission as one
  // string, and once a submission shattered into seven parallel calls — each
  // a repair round, a full re-send of the world. The schema was brought
  // inside Anthropic's strict subset for exactly that (closed objects, an
  // `anyOf` per operation kind, no numeric keywords — kept, because the
  // model reads it either way), and the API refused it on a limit the docs
  // do not mention: at most 24 OPTIONAL parameters across every strict tool
  // in the request, counted through every nesting level. This tool alone has
  // 44 — six top-level lists, a dozen genuinely optional fields on starts
  // and endings, the occurrence body twice — and repair has 67. Squeezing
  // under 24 means "required but nullable" on most of them, which is a
  // dozen `null`s per entry. The lint in schemaAgreement.test.ts keeps the
  // subset and counts the optionals, so the day the limit moves this is one
  // flag flip. Until then `normalizeList` reads the string shapes back.
  strict: false,
  description:
    "Terminal: submit the complete resolution of this tick — one entry per triggering action (its duration and difficulty when it starts, its result when it resolves), sourced world deltas grouped by domain, and objective occurrences with perceiver character ids.",
  inputSchema: {
    type: "object",
    properties: {
      starting: {
        type: "array",
        description:
          "Actions that BEGIN this tick — the ids the trigger section lists under `starting`. For a non-travel action: how long it should take and how hard it is. For travel: only the route (and vehicle) — the clock is derived from it. Never an outcome: its time has not been spent yet.",
        items: {
          type: "object",
          properties: {
            actionId: { type: "string" },
            resolvedDurationTicks: {
              type: "integer",
              description:
                "How long the action SHOULD take, a whole number of minutes, at least 1. REQUIRED for a non-travel action; OMIT when `movement` is set — travel time is derived from the route and anything you write here is overridden. You never state elapsed time — code advances progress from the clock.",
            },
            timingReason: {
              type: "string",
              description:
                "Optional: the objective reason for the chosen duration, for the log.",
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
                "REQUIRED whenever the action crosses a scene boundary — a 40-minute haul or one step into the next room alike; a single adjacent waypoint is a complete route. A duration alone moves nobody, and facts must not put hands on what the position cannot reach. `route` = the path the ACTOR STATED, grounded to place ids: ordered waypoints, each adjacent to the previous, last = destination. Ground only what their words carry (stepping out of the current room onto its street is an implied first hop). NEVER invent an unstated leg — a character who did not say how to get somewhere walks only as far as their words go, and re-decides there. Code derives the travel time from the route (walk or drive) and sets the clock itself: omit resolvedDurationTicks for pure travel.",
              properties: {
                route: {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                },
                vehicleId: {
                  type: "string",
                  description:
                    "Set when the actor DRIVES: the vehicle moves along the route (drivable roads only) and everyone in its interior scene rides along. The driver must be inside the vehicle; whether they may drive it is yours to judge.",
                },
              },
              required: ["route"],
              additionalProperties: false,
            },
          },
          required: ["actionId"],
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
                'What happened, objectively — the FINISHED account, not your working. It is read downstream and narrated to the actor, so it carries no reasoning, no corrections, no second thoughts, no addressing yourself: never "wait", "actually", "let me reconsider", or a note about which character is which. Settle all of that before you write, then write only the outcome. The check result you were given is input: never restate or contradict it.',
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
              description:
                "Only to revise the estimate — a whole number of minutes, at least 1.",
            },
            timingReason: {
              type: "string",
              description: "Optional: why the estimate changed, for the log.",
            },
          },
          required: ["actionId", "reason", "occurrence"],
          additionalProperties: false,
        },
      },
      characterChanges: {
        type: "array",
        description: `Persistent character-state changes only; descriptive results belong in occurrences. \`operation\` is one of, with exactly these fields: ${renderOps(CHARACTER_OPS)}.`,
        items: sourcedDelta("characterId", true, CHARACTER_OPS),
      },
      sceneChanges: {
        type: "array",
        description: `Scene-state changes. \`operation\` is one of, with exactly these fields: ${renderOps(SCENE_OPS)}.`,
        items: sourcedDelta("sceneId", true, SCENE_OPS),
      },
      itemChanges: {
        type: "array",
        description: `Item changes; itemId is required except for create. \`operation\` is one of, with exactly these fields: ${renderOps(ITEM_OPS)}.`,
        items: sourcedDelta("itemId", false, ITEM_OPS),
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
          description:
            "The index quoted in the error (0 or more). Omit to append.",
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
  // See submitResolutionTool: 67 optional parameters against a limit of 24.
  strict: false,
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
        sourcedDelta("characterId", true, CHARACTER_OPS),
        "Character changes"
      ),
      sceneChanges: repairable(
        sourcedDelta("sceneId", true, SCENE_OPS),
        "Scene changes"
      ),
      itemChanges: repairable(
        sourcedDelta("itemId", false, ITEM_OPS),
        "Item changes"
      ),
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

/**
 * LLM-facing declarations of the deterministic code tools. Execution runs
 * through the CodeToolRegistry; results are trusted and recorded.
 *
 * One tool, because a turn is not cheap. Every tool call spends a round trip
 * of the whole world context — measured at ~60k tokens on a full town — so a
 * tool only earns its place by answering something the request cannot say.
 * Four did not, and were removed:
 *
 *   `pathfinding` / `movementCost` — the World Graph section already renders
 *     every top-level place with its exits and each road's walking minutes,
 *     so both answered from data the model was holding. Worse, neither could
 *     change an outcome: the actor's stated route is the only route, and code
 *     (`placesAdjacent`) is the authority on whether a stated hop exists. In
 *     one measured ten-tick run they took 11 of 14 tool calls and about a
 *     third of the run's entire prompt budget, checking a route hop by hop, a
 *     turn at a time.
 *   `inventoryValidation` — replaced by putting the answer in the request:
 *     a command that names a person, or an item a person holds, now pulls
 *     that person's pockets into the Items section (contextBuilder).
 *   `sanityCheck` — a roll is still code's to make, but it did not have to be
 *     a TOOL. Stateless and non-idempotent, it returned a fresh d100 and
 *     `ok: true` to every repeat, so nothing in the payload ever signalled
 *     that an exposure was settled. Over 30 full-injection ticks, five spent
 *     the entire session budget re-rolling the same (actionId, characterId)
 *     and never submitted — the whole tick dropped, five times. It is now
 *     DECLARED on the occurrence that caused it (`sanityChecks`) and rolled
 *     during finalization, which makes the loop structurally impossible: the
 *     model submits once.
 *
 * `damageRoll` stays. A roll is the one thing the model must never do itself,
 * and damage — unlike sanity — is asked for mid-resolution, after the Engine
 * has decided a blow landed.
 */
export const CODE_TOOL_SPECS: ToolSpec[] = [
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
