// src/engine/resolution/worldDeltaSchema.ts
//
// The raw (model-shaped) resolution types, the per-domain array schemas the
// six phase tools are built from, and the deterministic code tool the endings
// phase may consult. One schema for every action — no per-definition or
// per-action-kind variants (plan D8). The schema stays deliberately loose
// where enumeration would explode; worldDeltaValidator enforces the real
// contract in code.
//
// The phase tools themselves live in `worldResolutionStageSchemas.ts`. They
// wrap the array objects exported below (`STARTING_LIST`,
// `CHARACTER_CHANGES_LIST` and the rest) by REFERENCE, so the row shape the
// model is shown and the row shape the validator judges come from one table
// and cannot drift apart.

import type { ToolSpec } from "../../models/providers/types.js";
import {
  HEARING_GRADES,
  HEARING_GRADE_MEANING,
  SIGHT_GRADES,
  SIGHT_GRADE_MEANING,
} from "../actions/types.js";
import type { HearingGrade, SightGrade } from "../actions/types.js";
import {
  CHECK_NEED_RULE,
  ITEM_CONTAINER_MEANING,
  ITEM_PLACEMENT_MEANING,
  STATED_ROUTE_RULE,
} from "../rules/ruleTerms.js";

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
   *  take. The actor's proposedDurationTicks is advisory. Optional for an
   *  action whose command carries an `utterance` and is nothing but its words:
   *  code clocks that talk at one minute. A command that also attempts
   *  something is clocked by what the Engine writes here, words or no words. */
  resolvedDurationTicks?: number;
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
   *  and their walk ends where their words end. `passBlockedConnectionId`
   *  is the Engine's one-use grant for THIS walk to cross one specifically
   *  named blocked passage without opening it. */
  movement?: {
    route: string[];
    vehicleId?: string;
    passBlockedConnectionId?: string;
    /** One-use grant to cross a concealed passage the actor's words name. */
    viaConcealedConnectionId?: string;
  };
}

/** The bar alone. It used to carry a `basis` sentence too — a justification
 *  nothing at runtime read, required all the same, and paid for on every
 *  start. The level is the whole decision. */
export interface RawCheck {
  requiredLevel: "regular" | "hard" | "extreme";
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
/**
 * Two scalars. The trace an ending leaves is NOT here: it is an entry in
 * `occurrences` whose `actionIds` cite this action, and the validator refuses
 * an outcome ending nothing cites; an explicit null outcome is a no_change
 * ending with no new event. It used to be a nested `occurrence` object on this
 * entry, and that nesting was where DeepSeek lost count of its braces.
 *
 * What the entry lost since (measured over a 30-tick run, 188 repair lines):
 * an `outcome` ENUM (success/partial/failure/blocked) that nothing downstream
 * read — the clock decides completed vs interrupted, the prose decides what
 * the actor learns — and whose conditional rules (required without a check,
 * refused with one, waived for talk) were 81 of those lines; a `replacedBy`
 * id that code already knew from the command's `replacesActionId`; and a
 * `reason` beside the enum. `outcome` is now that prose, and the only thing
 * an ending says.
 *
 * A pure-speech action never becomes one of these rows at all: the endings
 * phase decides it `mode: "pure_speech"`, and its `speech: true` occurrence is
 * the whole answer (who was addressed, who heard, and code carries the words).
 * Talk is delivered, not judged — but an action that carried a check was an
 * attempt, not talk, and it gets a result row. An unchecked, non-speaking
 * action with no new result gets an explicit null outcome and no occurrence.
 */
export interface RawActionEnd {
  actionId: string;
  /** Objective result, or explicit null for a no_change ending. Null closes
   *  the action without inventing a result or requiring an occurrence. */
  outcome: string | null;
}

export interface RawSourcedDelta {
  sourceActionId: string;
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
/** The bars a starting check may set. One list for the schema enum and the
 *  validator, so the two cannot drift. */
export const CHECK_LEVELS = ["regular", "hard", "extreme"] as const;

/** The only failure losses a sanity check may declare — the closed ladder in
 *  `sanity-check.md`. One list for the description and the validator. */
export const SANITY_LOSS_FORMULAS = ["1", "1d4", "1d6", "1d10"] as const;

export interface RawSanityCheck {
  characterId: string;
  /** The loss on a FAILED check — one of `SANITY_LOSS_FORMULAS`. */
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

/**
 * One flat row per moment, and one paragraph per row.
 *
 * Everything on it either routes perception or IS perception. What it lost
 * (measured over a 30-tick run): `locationId` — every row cited an action, so
 * the actor's place is the row's place and code fills it; `actorId`, same
 * reason; `affectedIds` and `signals` — a paragraph already says who was hit
 * and whether it was heard or seen; a `facts[]` array of typed rows with
 * `refIds` — the type's one consumer was the outcome-waiver rule that no
 * longer exists, and the model kept typing rows `utterance` to hand-copy the
 * line (29 rejections) or left the array empty when the line was all there
 * was (2 dead ticks). Now the line is code's, the paragraph is the model's,
 * and `speech` says which kind of row this is. What came back is one narrow
 * field: per-perceiver grades, one for sight and one for hearing (they
 * travel differently: a closed door stops a look, not a shout) — not a
 * per-character subset of the facts. The paragraph stays single and
 * objective; the grades tell the renderer how much of it to let through.
 */
export interface RawPerceiver {
  characterId: string;
  /** clear / partial / glimpse / none — see `SIGHT_GRADES`. */
  sight: SightGrade;
  /** clear / muffled / faint / none — see `HEARING_GRADES`. */
  hearing: HearingGrade;
}

export interface RawOccurrence {
  /** The actions this is the trace of — at least one. Every outcome or pure-speech ending
   *  must be cited; a no_change ending must not be cited. Two rows cite the same action
   *  only when
   *  the audiences receive different FACTS in different places (the departure
   *  in one room, the landing in the courtyard); different degrees of one
   *  fact are ONE row with per-perceiver grades. These ids also address
   *  precise validation feedback about the row. */
  actionIds: string[];
  /** `true`: this row IS a spoken line being delivered, and it is the whole
   *  trace of an action the endings phase decided `mode: "pure_speech"`. Code
   *  attaches the cited command's `utterance` verbatim; `content` is optional
   *  (how it was said). Only for an action whose command carries an utterance,
   *  and only when that action ends this tick. `false`: something happened —
   *  `content` is required, and an action the endings phase gave an `outcome`
   *  must be cited by a row of this kind. A moment that is both (a line spoken
   *  while a cup changes hands) is two rows. */
  speech: boolean;
  /** Who it was said or done to. Required on a speech row (an empty list =
   *  the room); on any other row code derives it from the command's target
   *  refs when omitted. */
  targetIds?: string[];
  /** Everyone who receives any evidence of this row, one entry per character,
   *  each with the sight and hearing they actually reach. `content` is written
   *  at full objective detail regardless; the renderer degrades per grade. */
  perceivers: RawPerceiver[];
  sanityChecks?: RawSanityCheck[];
  /** The objective, third-person paragraph. On a speech row: what the words
   *  were NOT — how they were said, what the hands did, who turned. */
  content?: string;
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
 * `operation` is generated as a closed discriminated union by `opSchema`.
 * These rows also generate the prose field list and the validator's accepted
 * kinds, so all three surfaces share one source of truth.
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
    // No `san` here. SAN moves through an occurrence's `sanityChecks` and
    // nowhere else: code rolls and writes the loss. A direct delta beside the
    // declaration charged the character twice for one exposure, and there is
    // no other SAN change the Engine is entitled to write.
    kinds: ["hp", "fatigue"],
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
    kinds: ["setAppearance"],
    fields:
      "appearance:string — REPLACES the character's whole appearance prose (what anyone looking at them sees: build, face, hair, clothes, marks). Keep every part still true, change only what really changed — a shaved beard, a scar that will stay, a coat they now wear. A passing state (blood on the hands, soaked clothes, a bandage) is a condition, not something to add here — but when the appearance you were given already states a bodily state and this tick undid it (a wound now dressed, a face now washed), rewriting that sentence here is the only way the world stops reading the old claim as current",
    schema: { properties: { appearance: STR }, required: ["appearance"] },
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
    // subsystems (sun, stamina) set one — in code.
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
    kinds: ["setSetting"],
    fields:
      "setting:string — REPLACES the place's whole setting; only when the place itself physically changed (a window smashed, a fixture torn out or put in); keep every still-true [reference-id] citation, drop a fixture that is gone. Loose things never need it — they carry their own placement",
    schema: { properties: { setting: STR }, required: ["setting"] },
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
    kinds: ["connectionConcealed"],
    fields:
      "connectionId:string, concealed:boolean — the passage's PHYSICAL state, the same for everyone: false when it is laid open (the bookshelf pushed aside, the wall broken), true when it is covered again. Someone merely finding a concealed passage changes nothing here — that is an occurrence they perceive, and their own knowledge",
    schema: {
      properties: { connectionId: STR, concealed: BOOL },
      required: ["connectionId", "concealed"],
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
    fields: "add?:string[], remove?:string[] — at least one of them",
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
    fields: `name:string, location:<"scene:<placeId>" or characterId>, placement:string, container:string, description?:string, id?:string, quantity?:integer — stable id; must be unused; omit to auto-generate; ALWAYS pass one for non-Latin names. quantity is how many identical things it stands for (default 1). At a place, placement says where it is and container is "" unless it was made inside something that hides it; on a character both are "". ${ITEM_PLACEMENT_MEANING} ${ITEM_CONTAINER_MEANING} The occurrence that shows it coming into being names it with its [id], so whoever perceives that can point at it`,
    schema: {
      properties: {
        name: STR,
        location: STR,
        placement: STR,
        container: STR,
        description: STR,
        id: STR,
        quantity: { type: "integer" },
      },
      required: ["name", "location", "placement", "container"],
    },
  },
  {
    kinds: ["move"],
    fields:
      "from:<current holder, exactly as the Items section shows it>, to:<\"scene:<placeId>\" for a place — a vehicle interior scene included — or a bare characterId> (one holder grammar, same as create.location), placement:string, container:string — to a place: placement is where it was set down (\"on the counter\", \"in the road\") and container is \"\" unless it was put inside something that hides it; to a character: both \"\". What sits in a moved container goes with it by itself. If the item is a FIXTURE the FROM place's setting cites, the same submission must rewrite that setting (scene setSetting) — the setting must not keep pointing at what left",
    schema: {
      properties: { from: STR, to: STR, placement: STR, container: STR },
      required: ["from", "to", "placement", "container"],
    },
  },
  {
    kinds: ["place"],
    fields:
      "placement:string, container:string — the item stays at its place but is now somewhere else in it: moved along the counter, put into a drawer (container = the drawer's item id), taken out of one (container \"\"). Opening or shutting a container is a set {description} on the container, not this. A fixture given a placement becomes a loose thing: the same submission rewrites the setting (scene setSetting) to drop its citation",
    schema: {
      properties: { placement: STR, container: STR },
      required: ["placement", "container"],
    },
  },
  {
    kinds: ["destroy"],
    fields:
      "(no fields). If the item is a fixture its place's setting cites, the same submission must rewrite that setting (scene setSetting). What sat in it stays where it was, loose",
    schema: { properties: {} },
  },
  {
    kinds: ["set"],
    fields:
      "any of — description:string (REPLACES the whole description; write everything still true of the thing — for a container, whether it is open or shut is part of it) · appendDescription:string (adds a supported detail only when the existing description remains true; replace description instead if damage or displacement made an old claim false) · isLightSource:boolean (false when it no longer lights the room, e.g. smashed) · lightLevel:number · quantity:integer (how many identical things it now stands for, >= 1). Taking some of a stack is set {quantity: what is left} on it plus create for what was taken (with its own quantity); taking all of it is a move; using the last of it is destroy",
    schema: {
      properties: {
        description: STR,
        appendDescription: STR,
        isLightSource: BOOL,
        lightLevel: { type: "number" },
        quantity: { type: "integer" },
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
 *  validator, a correction round later. */
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

/** One row of a change list: who or what it lands on, which action caused it,
 *  and the closed operation union for that domain. Exported so a phase tool
 *  can be built from the same builder rather than a second copy of it. */
export const sourcedDelta = (
  idField: string,
  idRequired: boolean,
  ops: OperationSpec[]
) => ({
  type: "object",
  properties: {
    sourceActionId: { type: "string" },
    [idField]: { type: "string" },
    // No `description` beside the `anyOf`: the array's description already
    // spells out every kind's fields, and a sibling keyword on a union is
    // the kind of thing a strict grammar compiler may refuse.
    operation: opSchema(ops),
  },
  // No `causalBasis`: a required sentence of justification that only ever
  // reached the log, and the source action already says what caused this.
  required: ["sourceActionId", ...(idRequired ? [idField] : []), "operation"],
  additionalProperties: false,
});

/** One occurrence row: ids and flags first, the paragraph last, so the model
 *  never has to close a deep object and then return to a sibling scalar —
 *  the exact place DeepSeek miscounted braces when the occurrence was nested
 *  inside an ending entry. */
export const OCCURRENCE_ITEM = {
  type: "object",
  properties: {
    actionIds: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description:
        "The action(s) this is the trace of — at least one. Every id under the trigger's `ending` MUST be cited by at least one occurrence, of the kind its endings-phase decision calls for — a decision nothing cites is refused. Separate rows may cite one action for distinct facts (its speech and physical result, or the shove in one room and landing elsewhere); different grades of the same fact belong in ONE row.",
    },
    speech: {
      type: "boolean",
      description:
        "true = a spoken line delivered THIS tick — only for an id under the trigger's `endingWithUtterance` (its command carries the words and it ends now; a starting action's words are not said yet). Code attaches the cited command's `utterance` word for word, `content` is optional (how it was said), and this row is the WHOLE trace of an action the endings phase decided `mode: \"pure_speech\"` — the words are delivered, not judged; whatever the action attempted besides speaking was judged in its outcome. false = something happened: `content` is required, and an action the endings phase gave an `outcome` must be cited by a row of this kind. A line spoken while a hand does something is TWO rows, one of each.",
    },
    targetIds: {
      type: "array",
      items: { type: "string" },
      description:
        "Who it was said or done to. REQUIRED on a speech row — the people addressed; an empty list means the room. Elsewhere optional: omitted, code takes the command's target refs.",
    },
    perceivers: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          characterId: {
            type: "string",
            description: "A character who receives some evidence of this row.",
          },
          sight: {
            type: "string",
            enum: [...SIGHT_GRADES],
            description: `What they get by seeing. ${SIGHT_GRADES.map((g) => `${g}: ${SIGHT_GRADE_MEANING[g]}`).join(". ")}.`,
          },
          hearing: {
            type: "string",
            enum: [...HEARING_GRADES],
            description: `What they get by hearing. ${HEARING_GRADES.map((g) => `${g}: ${HEARING_GRADE_MEANING[g]}`).join(". ")}.`,
          },
        },
        required: ["characterId", "sight", "hearing"],
        additionalProperties: false,
      },
      description:
        "Everyone who receives ANY evidence of this row, one entry per character, each with a sight and a hearing grade (never both none). Geography, environment, barriers, the concrete action and observer conditions decide both the list and the grades — sight needs a line of sight and light, hearing passes walls and closed doors weakened and is masked by noise; target and participant do not imply perceiver. Write `content` at FULL objective detail regardless of who is listed — the renderer degrades it per grade. Never split a row by degree: rows are split only when audiences receive different FACTS (the shove in one room, the landing in the courtyard). On a speech row: the listener beside her → sight clear, hearing clear; an onlooker who saw her lean close but caught nothing → sight clear, hearing muffled or faint; someone through the wall → sight none, hearing faint; someone in the dark room → sight none, hearing clear.",
    },
    // Declared here, rolled by code. The count and minute bounds live in the
    // validator and in these descriptions, not as schema keywords: strict mode
    // supports neither `maxItems` nor `minimum`/`maximum`.
    sanityChecks: {
      type: "array",
      description:
        "Involuntary sanity checks caused by perceiving THIS occurrence — at most 8. Rare — see the sanity guidance for the closed list of things that warrant one. Code reads the character's SAN, rolls d100 and settles it; a passed check costs nothing at all. This is the ONLY way SAN changes — there is no `san` character operation.",
      items: {
        type: "object",
        properties: {
          characterId: {
            type: "string",
            description:
              "Must be one of this occurrence's `perceivers` who perceives its source — sight clear or partial, or hearing clear or muffled. Exposure is perception: a glimpse or a faint sound with no source cannot shock.",
          },
          failureLoss: {
            type: "string",
            description: `SAN lost when the check FAILS — exactly one of ${SANITY_LOSS_FORMULAS.map((f) => `"${f}"`).join(", ")}, nothing else. There is no success loss — passing is free.`,
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
    content: {
      type: "string",
      description:
        "Write this LAST. One objective, third-person paragraph of what happened — world-true, no character-perspective wording, no reasoning, no corrections: settle who did what before writing it. REQUIRED when speech is false. On a speech row, optional: what the words were NOT — the speaker's supported delivery or accompanying gesture. A listener turning to look needs its own established source. Never the words themselves: code adds them, and never an invented reply. No summary of pending speech, replay of an earlier event, or unsupported completion of an ongoing plan. Position and ownership claims must agree with the accepted state. When this row shows an item coming into being (`create`) or an unnoticed item being found, write its [id] right after its name — that tag is the only way the people who perceive this row can point at it afterwards.",
    },
  },
  required: ["actionIds", "speech", "perceivers"],
  additionalProperties: false,
} as const;

/**
 * The five domain lists of one tick resolution, written once here.
 *
 * Each is the one required array of a phase tool in
 * `worldResolutionStageSchemas.ts`, which wraps these objects by reference
 * rather than copying them. The sixth phase, endings, submits DECISIONS rather
 * than final rows and owns its own schema there. Why a resolution is six small
 * tools rather than one large one — the compiled-grammar ceiling, measured —
 * is written at the head of that file and pinned in `schemaAgreement.test.ts`.
 */
const SUBMISSION_PROPERTIES = {
  starting: {
    type: "array",
    description:
      "Actions that BEGIN this tick — the ids the trigger section lists under `starting`. For a non-travel action: how long it should take and how hard it is. For travel: only the route (and vehicle) — the clock is derived from it. Never an outcome: its time has not been spent yet. A starting action's `utterance` is not spoken yet either: it is delivered when the action ends and the id returns under `endingWithUtterance`, not necessarily next minute. Write no occurrence for a starting id.",
    items: {
      type: "object",
      properties: {
        actionId: { type: "string" },
        resolvedDurationTicks: {
          type: "integer",
          description:
            "How long the action SHOULD take, a whole number of minutes, at least 1. REQUIRED for every non-travel action. Judge the ATTEMPT, not the sentence: a command that is nothing but its words takes 1; a command that also does something — treats a wound, works a lock, pries, deceives, watches — takes the attempt's minutes, whatever it says while doing it. OMIT when `movement` is set — travel time is derived from the route and anything you write here is overridden. You never state elapsed time — code advances progress from the clock.",
        },
        check: {
          type: "object",
          description: `The bar for the skill the actor declared, set BEFORE any roll exists. ${CHECK_NEED_RULE} An omitted check means the skill grants nothing, and the action is settled on its own merits. Never raise the bar to punish a poor skill choice. A check requires a declared skill from the catalog.`,
          properties: {
            requiredLevel: {
              type: "string",
              enum: [...CHECK_LEVELS],
            },
          },
          required: ["requiredLevel"],
          additionalProperties: false,
        },
        opposedBy: {
          type: "array",
          description:
            "Set when someone actively resists: the character and the defense skill they resist with. `skillId` must be one of the ability domains from the skill reference (never `Languages` — nobody defends in a tongue). Code rolls both sides and compares levels; you choose who defends and with what, never who wins. Needs `check`.",
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
          description: `REQUIRED whenever the actor deliberately travels along the world's connected ways — a 40-minute haul or one step into the next room alike; a single adjacent waypoint is a complete route. Forced or discontinuous displacement (thrown, dragged, knocked through an opening, falling, jumping directly through a window) uses a character position change instead. A duration alone moves nobody, and no outcome or occurrence may put hands on what the applied position cannot reach. ${STATED_ROUTE_RULE} Each waypoint is adjacent to the previous; the last is the destination. Ground only what their words carry (stepping out of the current room onto its street is an implied first hop). A character who did not say how to get somewhere walks only as far as their words go, and re-decides there. Code derives travel time from the route (walk or drive): omit resolvedDurationTicks for pure travel.`,
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
            viaConcealedConnectionId: {
              type: "string",
              description:
                'Set when the actor\'s own words say how they get through a CONCEALED passage (connections flagged `concealed` under Detailed Places) — "push the bookshelf aside and slip through" — and the route takes it. A passage nobody named stays shut to the route: someone who only said where they were going walks the open ways. One-use; names the exact connectionId.',
            },
            passBlockedConnectionId: {
              type: "string",
              description:
                "The exact connectionId from exitsFromHere when the actor GETS PAST that blocked passage — climbs the fallen tree, wades the flooded ford, pushes on through the blizzard — without removing what blocks it. This one-use grant is consumed at that edge; later blocked edges still stop the route. Use it only when you can decide passage directly, with no check on this starting entry. Omit it when the obstacle stops them. When the act REMOVES the obstacle, write connectionBlock blocked:false instead.",
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
      "Every objective thing that happened this tick, one flat row and one paragraph each: the trace of every outcome or pure-speech decision (never cite a no_change ending; otherwise cite its action in `actionIds` — an `outcome` decision no `speech: false` row cites is refused), one `speech: true` row for each id under `endingWithUtterance` (those are the only spoken lines delivered this tick — the row IS the answer for that action, code adds the words; a starting action's utterance is not said yet and gets no row), and anything else worth perceiving (speech false) — a noise, a visible attempt in progress. Write each row's `content` last. Content is world-true, third-person, no character-perspective wording.",
    items: OCCURRENCE_ITEM,
  },
} as const;

/**
 * The five arrays, addressable one at a time.
 *
 * These are not copies: each name below is a reference into the table above,
 * so the phase tool that carries `STARTING_LIST` and the validator that judges
 * a `starting` row are reading one schema, not two that happen to match today.
 * The element schemas are exported beside the lists for callers that wrap a
 * row in a different array.
 */
// Two closed wire branches make the timing choice structural. New non-travel
// submissions explicitly carry 1 for plain talk or the assessed duration for
// an attempt, whether or not the command also carries words.
const { movement, resolvedDurationTicks, ...startCommon } =
  SUBMISSION_PROPERTIES.starting.items.properties;
export const STARTING_ITEM = {
  anyOf: [
    {
      type: "object",
      properties: { ...startCommon, resolvedDurationTicks },
      required: ["actionId", "resolvedDurationTicks"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { ...startCommon, movement },
      required: ["actionId", "movement"],
      additionalProperties: false,
    },
  ],
} as const;
export const STARTING_LIST = {
  ...SUBMISSION_PROPERTIES.starting,
  items: STARTING_ITEM,
};
export const CHARACTER_CHANGES_LIST = SUBMISSION_PROPERTIES.characterChanges;

/**
 * The occurrence row with no `perceivers` (DECISIONS_PERCEIVERS=on, design
 * §6.3 step 5): the model writes what happened, and who perceives each row is
 * decided afterwards by code + the Decisions API. A sanity check names a
 * character the model expects to perceive the row clearly; code drops the
 * check if that character turns out not to.
 */
const {
  perceivers: _perceiversDecidedByCode,
  sanityChecks: occurrenceSanity,
  ...occurrenceKept
} = OCCURRENCE_ITEM.properties;
export const OCCURRENCE_ITEM_CODE_PERCEIVERS = {
  ...OCCURRENCE_ITEM,
  properties: {
    ...occurrenceKept,
    sanityChecks: {
      ...occurrenceSanity,
      items: {
        ...occurrenceSanity.items,
        properties: {
          ...occurrenceSanity.items.properties,
          characterId: {
            type: "string",
            description:
              "A character who perceives THIS occurrence clearly (full or limited). Who perceives each row is decided by code after you submit; a check on someone who turns out not to perceive it clearly is dropped.",
          },
        },
      },
    },
  },
  required: ["actionIds", "speech"],
};
export const OCCURRENCES_LIST_CODE_PERCEIVERS = {
  ...SUBMISSION_PROPERTIES.occurrences,
  description: `${SUBMISSION_PROPERTIES.occurrences.description} Do NOT write perceivers: code decides who perceives each row, and how clearly, after you submit — write each row's content at full objective detail.`,
  items: OCCURRENCE_ITEM_CODE_PERCEIVERS,
};
export const SCENE_CHANGES_LIST = SUBMISSION_PROPERTIES.sceneChanges;
export const ITEM_CHANGES_LIST = SUBMISSION_PROPERTIES.itemChanges;
export const OCCURRENCES_LIST = SUBMISSION_PROPERTIES.occurrences;

export const CHARACTER_CHANGE_ITEM =
  SUBMISSION_PROPERTIES.characterChanges.items;
export const SCENE_CHANGE_ITEM = SUBMISSION_PROPERTIES.sceneChanges.items;
export const ITEM_CHANGE_ITEM = SUBMISSION_PROPERTIES.itemChanges.items;

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
