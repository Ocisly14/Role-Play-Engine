// src/engine/resolution/worldResolutionStageSchemas.ts
//
// The six phase tools of the World Action Engine, one per domain, offered to
// the model one at a time. The Engine has two functions, each a session of
// its own with its own world context:
//
//   the start judgement — one phase, `starts` — run the minute a command
//   arrives, before any world time has passed on it;
//   the settlement — `endings → characterChanges → itemChanges → sceneChanges
//   → occurrences` — run when actions end.
//
// Each tool takes ONE required top-level array and nothing else. That is the
// whole point of the split. The retired arrangement was two terminal tools
// called together in one turn — an `starting`+`ending` half that compiled
// strict, and an effects half carrying all 19 `anyOf` branches of the three
// operation unions at once, which the Anthropic grammar compiler refuses; that
// half therefore shipped unconstrained, and its contract was left to prose and
// to the validator. Cut the same six arrays into six requests and each one is
// small enough to compile — the operation unions arrive at 7, 8 and 4 branches
// instead of 19 together, and every phase can ask for `strict: true`.
//
// Nothing here restates an element shape. Five of the six arrays ARE the
// objects `worldDeltaSchema.ts` defines (`STARTING_LIST` and friends), so the
// row shape the model is shown and the row shape the validator judges come from
// one table and cannot drift apart. The sixth — endings — is deliberately its
// own schema: see ENDING_DECISION_ITEM.

import { createHash } from "node:crypto";
import type { ToolSpec } from "../../models/providers/types.js";
import {
  CHARACTER_CHANGES_LIST,
  ITEM_CHANGES_LIST,
  OCCURRENCES_LIST,
  OCCURRENCES_LIST_CODE_PERCEIVERS,
  type RawActionStart,
  type RawCharacterChange,
  type RawItemChange,
  type RawOccurrence,
  type RawSceneChange,
  SCENE_CHANGES_LIST,
  STARTING_LIST,
} from "./worldDeltaSchema.js";

// ==================== Phases ====================

/** Every phase, in execution order. Within a session a phase reads every
 *  earlier phase's accepted output as a fact and never revisits it; the array
 *  is also the rewind ordering, so its index is meaningful (see `phaseIndex`
 *  in the stage validator). The start judgement is the first entry alone;
 *  the settlement is the rest, contiguous. */
export const RESOLUTION_PHASES = [
  "starts",
  "endings",
  "characterChanges",
  "itemChanges",
  "sceneChanges",
  "occurrences",
] as const;

export type ResolutionPhase = (typeof RESOLUTION_PHASES)[number];

/**
 * The Engine's two functions. A start is judged the minute its command
 * arrives — the clock, the bar, the route — before any world time has passed
 * on it, so what code then executes counts from the minute the actor decided.
 * A settlement is judged when actions end: what came of them, and what that
 * did to the world. Each is its own session over its own world context, and
 * a session runs only its own phases.
 */
export type EngineSessionKind = "start" | "settlement";

export const SESSION_PHASES: Record<
  EngineSessionKind,
  readonly ResolutionPhase[]
> = {
  start: ["starts"],
  settlement: [
    "endings",
    "characterChanges",
    "itemChanges",
    "sceneChanges",
    "occurrences",
  ],
};

/** Which of the two functions a phase belongs to. Every phase belongs to
 *  exactly one, so a phase alone says which session it is in. */
export function sessionOfPhase(phase: ResolutionPhase): EngineSessionKind {
  return phase === "starts" ? "start" : "settlement";
}

/** The phases of the session this phase is in, in order. */
export function sessionPhasesOf(
  phase: ResolutionPhase
): readonly ResolutionPhase[] {
  return SESSION_PHASES[sessionOfPhase(phase)];
}

/** The wire name of each phase's tool. */
export const PHASE_TOOL_NAMES: Record<ResolutionPhase, string> = {
  endings: "submit_endings",
  starts: "submit_starts",
  characterChanges: "submit_character_changes",
  itemChanges: "submit_item_changes",
  sceneChanges: "submit_scene_changes",
  occurrences: "submit_occurrences",
};

/** The one required top-level array of each phase's tool. Only `endings`
 *  differs from its phase name, and only `starts` differs from the field the
 *  assembled `RawTickResolution` carries: the resolution's list is `starting`,
 *  and the phase is named for the moment, not the field. */
export const PHASE_FIELDS: Record<ResolutionPhase, string> = {
  endings: "endings",
  starts: "starting",
  characterChanges: "characterChanges",
  itemChanges: "itemChanges",
  sceneChanges: "sceneChanges",
  occurrences: "occurrences",
};

/**
 * One decision about one ending action.
 *
 * This intermediate contract requires a decision for every ending id.
 * outcome accounts for a new objective result; pure_speech is delivered by
 * its speech occurrence; no_change closes the lifecycle without new prose,
 * deltas or events. Assembly preserves no_change as an explicit null outcome.
 */
export type EndingDecision =
  | { actionId: string; mode: "outcome"; outcome: string }
  | { actionId: string; mode: "pure_speech" }
  | { actionId: string; mode: "no_change" };

/** What has been ACCEPTED so far, phase by phase. A phase key is absent until
 *  its validator accepted it — an absent key and an accepted empty array are
 *  different states, and the prompt builder shows only the latter. */
export interface AcceptedResolutionDraft {
  endings?: EndingDecision[];
  starting?: RawActionStart[];
  characterChanges?: RawCharacterChange[];
  itemChanges?: RawItemChange[];
  sceneChanges?: RawSceneChange[];
  occurrences?: RawOccurrence[];
}

// ==================== The endings array ====================

/**
 * Closed branches make the choice explicit before any prose is generated.
 * no_change has no outcome field: ordinary observation or waiting must not
 * require a personal recap just to close its clock.
 */
const ENDING_DECISION_ITEM = {
  anyOf: [
    {
      type: "object",
      properties: {
        mode: { const: "outcome" },
        actionId: {
          type: "string",
          description: "An id from the trigger's `ending` list.",
        },
        outcome: {
          type: "string",
          description:
            "The new objective result of this action, third-person, final and without model reasoning. State world facts, never a personal account of what someone saw, heard, understood or learned over an interval. Ordinary observation and waiting use no_change when there is no new result to settle. If this action also changes the world, account only for that change, not a recap of surrounding events. A supplied `diceRoll` constrains the attempt; never restate it or invent another actor's reply, silence, belief or reaction. Pending speech cannot be paraphrased here. Route newly exposed evidence through occurrences with actual perceivers and clarity; character interpretation belongs to the character.",
        },
      },
      required: ["mode", "actionId", "outcome"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        mode: { const: "pure_speech" },
        actionId: {
          type: "string",
          description: "An id from the trigger's `ending` list.",
        },
      },
      required: ["mode", "actionId"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        mode: { const: "no_change" },
        actionId: {
          type: "string",
          description:
            "An ending id with no new result, check or utterance to settle. Routine observation or waiting ends without a retrospective account.",
        },
      },
      required: ["mode", "actionId"],
      additionalProperties: false,
    },
  ],
} as const;

const ENDINGS_LIST = {
  type: "array",
  description:
    "One decision for every id the trigger lists under `ending`, and no others. outcome carries a new objective result, including a checked attempt. pure_speech carries no outcome and is only for an unchecked action whose whole result is its `utterance`. no_change carries no outcome and closes an action with no new objective result, no check and no utterance; ordinary observation or waiting does not require a retrospective summary. no_change must source no changes or occurrences. Events perceived during a wait retain their own source actions and are already routed when they happen.",
  items: ENDING_DECISION_ITEM,
} as const;

// ==================== The six tools ====================

/** Said at the end of every phase description, because it is the same demand
 *  every time: the array is not optional, and history is not editable. */
const PHASE_CONTRACT =
  "The array is REQUIRED — a domain with nothing to say this tick sends `[]`, and never omits the list. Anything accepted in an earlier phase is shown to you as a settled, read-only fact of this tick: read it, do not restate it, and do not try to revise it here.";

const PHASE_DESCRIPTIONS: Record<ResolutionPhase, string> = {
  starts:
    "The START JUDGEMENT — the Engine's first function, one phase. One entry for every action id the trigger lists under `starting`, and only those: for a non-travel action how long it should take and how hard it is — judged by what it ATTEMPTS, not by whether it speaks: plain talk takes 1 minute and no check, an attempt made while speaking takes the attempt's minutes and a check where the declared skill covers it — for travel the route the actor stated (and the vehicle, when they drive). Never an outcome — a starting action's time has not been spent yet, and a starting action's `utterance` is not spoken yet either. What comes of it is the settlement's business, on the tick its time runs out.",
  endings:
    "Phase 1 of 5 of the SETTLEMENT — ENDINGS. One decision for every finishing action: outcome for a new objective result; pure_speech for an unchecked action consisting only of its utterance; no_change for an unchecked action with no utterance and no new result. no_change closes the clock without generating a personal observation recap, changes or occurrences. A checked attempt always needs outcome. This phase writes no state changes or events. Roll actual damage with the deterministic tool before deciding; never invent damage.",
  characterChanges:
    "Phase 2 of 5 of the SETTLEMENT — CHARACTER CHANGES. The persistent changes this tick's actions make to characters — one row per change, each sourced to the action that caused it. A result that is merely described, and leaves no state behind, is not a change and belongs to the occurrence phase.",
  itemChanges:
    "Phase 3 of 5 of the SETTLEMENT — ITEM CHANGES. What this tick's actions do to things: what came into being, what moved and to whom, what stopped existing, and what an item is now like — one row per change, each sourced to the action that caused it.",
  sceneChanges:
    "Phase 4 of 5 of the SETTLEMENT — SCENE CHANGES. What this tick's actions do to places and to the passages between them — one row per change, each sourced to the action that caused it. This is also where a place's prose is brought back into agreement with the items that left it or ceased to exist.",
  occurrences:
    "Phase 5 of 5 of the SETTLEMENT — OCCURRENCES. Every objective thing that happened this tick that somebody could perceive, one flat row and one paragraph each, tied by `actionIds` to the actions it is the trace of. Every outcome decision needs a speech:false row, and every pure-speech decision needs a speech:true row. A no_change decision must not source a row: elapsed observation or waiting creates no new event. Route actual events when they happen, citing their own source actions.",
};

/** The array schema each tool wraps. Five are the very objects the terminal
 *  submission tools carry; `endings` is this file's own. */
const PHASE_LISTS: Record<ResolutionPhase, unknown> = {
  endings: ENDINGS_LIST,
  starts: STARTING_LIST,
  characterChanges: CHARACTER_CHANGES_LIST,
  itemChanges: ITEM_CHANGES_LIST,
  sceneChanges: SCENE_CHANGES_LIST,
  occurrences: OCCURRENCES_LIST,
};

/** One phase's arguments: a closed object over exactly one required array.
 *  Nothing optional at the top level, which is what keeps every phase's
 *  optional-parameter count inside Anthropic's per-request budget of 24 even
 *  though the six of them together still spend what the old pair spent. */
function phaseSchema(phase: ResolutionPhase): Record<string, unknown> {
  const field = PHASE_FIELDS[phase];
  return {
    type: "object",
    properties: { [field]: PHASE_LISTS[phase] },
    required: [field],
    additionalProperties: false,
  };
}

/** One entry per phase, built in `RESOLUTION_PHASES` order, so a phase added
 *  to that list cannot be forgotten by any of the tables below. */
function byPhase<T>(
  make: (phase: ResolutionPhase) => T
): Record<ResolutionPhase, T> {
  const out = {} as Record<ResolutionPhase, T>;
  for (const phase of RESOLUTION_PHASES) out[phase] = make(phase);
  return out;
}

const PHASE_SCHEMAS: Record<ResolutionPhase, Record<string, unknown>> = byPhase(
  phaseSchema
);

/** STRICT. Each of these compiles: the largest operation union any one of them
 *  carries is eight branches, against the nineteen that arrive together when
 *  the four effect lists share one tool. */
export const PHASE_TOOLS: Record<ResolutionPhase, ToolSpec> = byPhase(
  (phase) => ({
    name: PHASE_TOOL_NAMES[phase],
    strict: true,
    description: `${PHASE_DESCRIPTIONS[phase]} ${PHASE_CONTRACT}`,
    inputSchema: PHASE_SCHEMAS[phase],
  })
);

/**
 * The same tools with the flag off, for the one narrow fallback the runner is
 * allowed: a provider that deterministically refuses to COMPILE the grammar.
 * Name, description and schema are the same — the schema object is literally
 * shared, so a downgraded phase asks for exactly what the strict one asked for
 * and its fingerprint is unchanged. It is not a fallback for bad output,
 * transport errors or validation failures; those are answered with a
 * correction, not by loosening the contract.
 */
export const PHASE_TOOLS_NON_STRICT: Record<ResolutionPhase, ToolSpec> =
  byPhase((phase) => ({ ...PHASE_TOOLS[phase], strict: false }));

/**
 * The occurrences tool without `perceivers` (DECISIONS_PERCEIVERS=on): the
 * model writes what happened; code and the Decisions API decide who
 * perceives each row. A schema of its own, with its own fingerprint.
 */
export const OCCURRENCES_TOOL_CODE_PERCEIVERS: ToolSpec = {
  name: PHASE_TOOL_NAMES.occurrences,
  strict: true,
  description: `${PHASE_DESCRIPTIONS.occurrences} Perceivers are NOT part of your answer here: code decides who perceives each row, and how clearly, after you submit. ${PHASE_CONTRACT}`,
  inputSchema: {
    type: "object",
    properties: { occurrences: OCCURRENCES_LIST_CODE_PERCEIVERS },
    required: ["occurrences"],
    additionalProperties: false,
  },
};
export const OCCURRENCES_TOOL_CODE_PERCEIVERS_NON_STRICT: ToolSpec = {
  ...OCCURRENCES_TOOL_CODE_PERCEIVERS,
  strict: false,
};

export function phaseTool(
  phase: ResolutionPhase,
  opts?: { strict?: boolean }
): ToolSpec {
  return opts?.strict === false
    ? PHASE_TOOLS_NON_STRICT[phase]
    : PHASE_TOOLS[phase];
}

export const PHASE_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  RESOLUTION_PHASES.map((phase) => PHASE_TOOL_NAMES[phase])
);

const PHASE_BY_TOOL_NAME = new Map<string, ResolutionPhase>(
  RESOLUTION_PHASES.map((phase): [string, ResolutionPhase] => [
    PHASE_TOOL_NAMES[phase],
    phase,
  ])
);

/** Which phase a tool name belongs to, or `undefined` when the model called
 *  something else entirely — a distinction the runner answers differently from
 *  "called the wrong phase's tool". */
export function phaseOfTool(toolName: string): ResolutionPhase | undefined {
  return PHASE_BY_TOOL_NAME.get(toolName);
}

// ==================== Schema fingerprints ====================

/** JSON with every object's keys in sorted order, so the same schema always
 *  serializes to the same string. Arrays keep their order: it is part of the
 *  schema (an `anyOf`'s branches, an `enum`'s members). */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

/**
 * Identifies "this tool's schema, asked of this model at this vendor".
 *
 * The runner remembers a strict downgrade under this key, so the key has to
 * survive a restart and has to change when any of the four things change —
 * a different vendor, a different model, a different tool, or an edited
 * schema. Nothing process-random goes in: a fingerprint that changed every
 * run would remember nothing, and one that ignored the schema would go on
 * downgrading a tool that was since made to compile.
 */
export function schemaFingerprint(
  provider: string,
  model: string,
  tool: ToolSpec
): string {
  return createHash("sha256")
    .update(
      `${provider}\n${model}\n${tool.name}\n${canonicalJson(tool.inputSchema)}`
    )
    .digest("hex");
}
