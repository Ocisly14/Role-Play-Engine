// src/engine/resolution/worldResolutionStageSchemas.ts
//
// The six phase tools of a staged tick resolution, one per domain, offered to
// the model one at a time and in this order:
//
//   endings → starts → characterChanges → itemChanges → sceneChanges
//           → occurrences
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
  type RawActionStart,
  type RawCharacterChange,
  type RawItemChange,
  type RawOccurrence,
  type RawSceneChange,
  SCENE_CHANGES_LIST,
  STARTING_LIST,
} from "./worldDeltaSchema.js";

// ==================== Phases ====================

/** Execution order. A phase reads every earlier phase's accepted output as a
 *  fact and never revisits it; the array is also the rewind ordering, so its
 *  index is meaningful (see `phaseIndex` in the stage validator). */
export const RESOLUTION_PHASES = [
  "endings",
  "starts",
  "characterChanges",
  "itemChanges",
  "sceneChanges",
  "occurrences",
] as const;

export type ResolutionPhase = (typeof RESOLUTION_PHASES)[number];

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
 * This is an INTERMEDIATE contract, not a `RawActionEnd`. The final resolution
 * has no row at all for an action that was nothing but words — its whole answer
 * is a `speech: true` occurrence — and an absent row is a thing the model
 * cannot be corrected about precisely: "you left one out" and "you decided it
 * was pure speech" look identical on the wire. So the phase demands a decision
 * for every id and names the two kinds, and `assembleRawResolution` drops the
 * pure-speech ones on the way to `ending`.
 */
export type EndingDecision =
  | { actionId: string; mode: "outcome"; outcome: string }
  | { actionId: string; mode: "pure_speech" };

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
 * Two closed branches chosen by `mode`, rather than one object with an optional
 * `outcome`. Optional-and-conditionally-required is the shape this codebase has
 * already paid for once (`RawActionStart`/`RawActionEnd` were split for the same
 * reason): a grammar cannot express "required unless", so the field silently
 * goes missing and the validator punishes the model for reading the schema. Two
 * branches make the choice explicit and let the grammar close both.
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
            'What came of it, objectively — the FINISHED account, not your working. It is narrated to the actor and kept in the log, so it is third-person and final: no reasoning, no corrections, no second thoughts, no addressing yourself — never "wait", "actually", "let me reconsider", or a note about which character is which. Settle all of that before you write, then write only the result. A `diceRoll` you were given is input: never restate it and never contradict it. Never the target\'s reply or reaction — that is theirs, next minute.',
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
  ],
} as const;

const ENDINGS_LIST = {
  type: "array",
  description:
    'One decision for every id the trigger lists under `ending` — exactly one per id, every one of them, and no id that is not on that list. An action that is merely still running is not an ending and gets no entry. Choose `mode: "pure_speech"` only for an action whose command carries an `utterance` and whose whole result was those words; anything the action also DID makes it `mode: "outcome"`, and an action that carried a `check` (a `diceRoll` on its row) is always `mode: "outcome"` — the dice answered an attempt, and the outcome says what came of it. A pure-speech decision writes no outcome: the line is delivered later as its own occurrence, and code attaches the words.',
  items: ENDING_DECISION_ITEM,
} as const;

// ==================== The six tools ====================

/** Said at the end of every phase description, because it is the same demand
 *  every time: the array is not optional, and history is not editable. */
const PHASE_CONTRACT =
  "The array is REQUIRED — a domain with nothing to say this tick sends `[]`, and never omits the list. Anything accepted in an earlier phase is shown to you as a settled, read-only fact of this tick: read it, do not restate it, and do not try to revise it here.";

const PHASE_DESCRIPTIONS: Record<ResolutionPhase, string> = {
  endings:
    "Phase 1 of 6 — ENDINGS. Decide what became of every action that finishes this tick, and nothing else: no starts, no world changes, no occurrences. Each decision is one of two shapes, chosen by `mode`. `outcome` — the action produced something to account for, and `outcome` is that account: objective, third-person, final, never a restatement of or an argument with a `diceRoll` you were given. `pure_speech` — the action's command carries an `utterance` and its whole result was those words, so there is nothing to account for; never for an action that carried a `check`, whose dice decided an attempt. Roll damage with the deterministic tool before you decide; a damage number is never yours to invent.",
  starts:
    "Phase 2 of 6 — STARTS. One entry for every action id the trigger lists under `starting`, and only those: for a non-travel action how long it should take and how hard it is — judged by what it ATTEMPTS, not by whether it speaks: plain talk takes 1 minute and no check, an attempt made while speaking takes the attempt's minutes and a check where the declared skill covers it — for travel the route the actor stated (and the vehicle, when they drive). Never an outcome — a starting action's time has not been spent yet, and a starting action's `utterance` is not spoken yet either.",
  characterChanges:
    "Phase 3 of 6 — CHARACTER CHANGES. The persistent changes this tick's actions make to characters — one row per change, each sourced to the action that caused it. A result that is merely described, and leaves no state behind, is not a change and belongs to the occurrence phase.",
  itemChanges:
    "Phase 4 of 6 — ITEM CHANGES. What this tick's actions do to things: what came into being, what moved and to whom, what stopped existing, and what an item is now like — one row per change, each sourced to the action that caused it.",
  sceneChanges:
    "Phase 5 of 6 — SCENE CHANGES. What this tick's actions do to places and to the passages between them — one row per change, each sourced to the action that caused it. This is also where a place's prose is brought back into agreement with the items that left it or ceased to exist.",
  occurrences:
    "Phase 6 of 6 — OCCURRENCES. Every objective thing that happened this tick that somebody could perceive, one flat row and one paragraph each, tied by `actionIds` to the actions it is the trace of. Every ending accepted in phase 1 must be cited by at least one row here, and every pure-speech decision must have its `speech: true` row.",
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
