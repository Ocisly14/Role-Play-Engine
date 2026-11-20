import { isDeepStrictEqual } from "node:util";
import { renderEndingModes } from "../rules/ruleTerms.js";
// src/engine/resolution/worldResolutionStageValidator.ts
//
// Phase-local validation for the staged World Action Engine: one validator per
// phase, run the moment that phase submits, plus the assembly of the accepted
// draft into the `RawTickResolution` the final gate still judges.
//
// The split is about WHEN a fault is reported, never about WHETHER it is. Every
// check here is a call into `worldDeltaValidator.ts` — the same function the
// whole-resolution gate calls — so a phase and the gate cannot come to
// different verdicts about the same row. A phase runs the checks it has the
// facts for; `validateRawResolution` runs all of them again, including the ones
// a phase already ran, and it remains the only authority that lets a resolution
// reach the Applier. Nothing is dropped from it to pay for this file.
//
// One thing a phase deliberately does NOT judge: the endings phase cannot
// check that an ending is traced by an occurrence, since occurrences are
// submitted four phases later. It checks everything else `validateEnd` checks
// (`validateEndingTarget` + `validateEndOutcome`).
//
// A session runs only its own phases — the start judgement is `starts` alone,
// the settlement the other five — so nothing here spans the two: a start is a
// settled fact of an earlier minute by the time anything is settled.

import type { EngineResolutionContext, ResolutionError } from "./types.js";
import type {
  RawActionStart,
  RawCharacterChange,
  RawItemChange,
  RawOccurrence,
  RawSceneChange,
  RawTickResolution,
} from "./worldDeltaSchema.js";
import {
  type Lookup,
  type ResolutionWorklist,
  buildLookup,
  citedActionIds,
  duplicateSanityChecks,
  isRecord,
  isSpeechRow,
  missingSpeechActionIds,
  missingSpeechMessage,
  normalizeList,
  notAChangeMessages,
  notARowMessage,
  notAnEntryMessage,
  occurrencesCiting,
  resolutionWorklist,
  staleCitations,
  validateCharacterChange,
  validateEndOutcome,
  validateEndingTarget,
  validateItemChange,
  validateNoChangeEnding,
  validateOccurrence,
  validateSceneChange,
  validateStart,
} from "./worldDeltaValidator.js";
import {
  type AcceptedResolutionDraft,
  type EngineSessionKind,
  PHASE_FIELDS,
  PHASE_TOOL_NAMES,
  RESOLUTION_PHASES,
  type ResolutionPhase,
  SESSION_PHASES,
} from "./worldResolutionStageSchemas.js";

export type {
  AcceptedResolutionDraft,
  EndingDecision,
  EngineSessionKind,
  ResolutionPhase,
} from "./worldResolutionStageSchemas.js";

/** Index of a phase in the execution order. The order is also the rewind
 *  ordering, so "earliest" is "smallest index". */
export function phaseIndex(phase: ResolutionPhase): number {
  return RESOLUTION_PHASES.indexOf(phase);
}

// ==================== Reading an untrusted payload ====================

/**
 * The phase's one array, out of whatever the tool call carried.
 *
 * `normalizeList` recovers the shapes a provider without a compiled grammar
 * still produces (a serialized array, an index-keyed object), but it cannot
 * tell "an empty list sent in the wrong shape" from "nothing readable": both
 * come back as `[]`. An empty phase is spelled `[]` on the wire, so the
 * ambiguous case is reported as unreadable and asked for again — re-sending
 * `[]` costs the model one turn and nothing else, where silently accepting an
 * empty phase would cost the tick a whole domain.
 */
function readPhaseRows(
  phase: ResolutionPhase,
  payload: unknown
): { rows: unknown[] } | { error: string } {
  const field = PHASE_FIELDS[phase];
  const tool = PHASE_TOOL_NAMES[phase];
  if (!isRecord(payload)) {
    return {
      error: `nothing readable arrived for this phase. ${tool} takes exactly one field, "${field}": the complete array for this phase. Call ${tool} again with {"${field}": [ ... ]}, or {"${field}": []} if this phase changes nothing`,
    };
  }
  const value = payload[field];
  if (value === undefined || value === null) {
    return {
      error: `"${field}" is missing. ${tool} takes exactly one required field, "${field}": the complete array for this phase. Send {"${field}": []} if this phase changes nothing`,
    };
  }
  if (Array.isArray(value)) return { rows: value };
  const recovered = normalizeList<unknown>(value, field);
  if (recovered.length > 0) return { rows: recovered };
  return {
    error: `"${field}" arrived as ${typeof value} and could not be read as a list. Send it as a plain JSON array — {"${field}": [ ... ]} — never as a string containing one, and {"${field}": []} if this phase changes nothing`,
  };
}

/** The phase's array out of an untrusted payload, or undefined when nothing
 *  readable arrived. The runner merges on this before it validates. */
export function phaseRows(
  phase: ResolutionPhase,
  payload: unknown
): unknown[] | undefined {
  const read = readPhaseRows(phase, payload);
  return "rows" in read ? read.rows : undefined;
}

/**
 * The normalized array of a payload `validatePhase` has already accepted.
 *
 * Only ever called after `validatePhase` returned `[]`, which means
 * `readPhaseRows` succeeded, so the fallback here is unreachable in the
 * runner; it exists so this stays a total function rather than a throw.
 */
export function acceptedPhaseValue(
  phase: ResolutionPhase,
  payload: unknown
): AcceptedResolutionDraft[keyof AcceptedResolutionDraft] {
  const read = readPhaseRows(phase, payload);
  const rows = "rows" in read ? read.rows : [];
  return rows as AcceptedResolutionDraft[keyof AcceptedResolutionDraft];
}

// ==================== Per-phase validation ====================

/** Collects addressed errors the way `validateRawResolution` does: the piece
 *  validators return plain messages, and only the caller knows the address. */
function collector(): {
  errors: ResolutionError[];
  at: (target: ResolutionError["target"], messages: string[]) => void;
} {
  const errors: ResolutionError[] = [];
  return {
    errors,
    at: (target, messages) => {
      for (const message of messages) errors.push({ target, message });
    },
  };
}

/** The action id of a row, or undefined when the row is not an entry at all. */
function entryActionId(row: unknown): string | undefined {
  if (!isRecord(row)) return undefined;
  const id = row.actionId;
  return typeof id === "string" && id.trim() ? id : undefined;
}

function validateEndingsPhase(
  rows: unknown[],
  lookup: Lookup,
  worklist: ResolutionWorklist
): ResolutionError[] {
  const { errors, at } = collector();
  const seen = new Set<string>();
  for (const [i, row] of rows.entries()) {
    const actionId = entryActionId(row);
    if (actionId === undefined || !isRecord(row)) {
      at({ kind: "resolution" }, [notAnEntryMessage("endings", i)]);
      continue;
    }
    const target: ResolutionError["target"] = { kind: "action", actionId };
    if (seen.has(actionId)) {
      at(target, [
        `appears more than once in "endings" — one decision per action, and every id the trigger lists under \`ending\` takes exactly one. Send it ONCE. Do NOT drop it — this action must be answered this tick`,
      ]);
      continue;
    }
    seen.add(actionId);
    // Membership is this: an id outside the ending worklist is either unknown,
    // or queued (it starts, it does not end), or still running. All three are
    // what `validateEndingTarget` already names, in the words the final gate
    // uses. A misfiled entry gets that one instruction and no field review.
    const misfiled = validateEndingTarget(actionId, lookup);
    if (misfiled.length > 0) {
      at(target, misfiled);
      continue;
    }
    const mode = row.mode;
    if (mode !== "outcome" && mode !== "pure_speech" && mode !== "no_change") {
      at(target, [
        `mode must be "outcome" or "pure_speech" or "no_change" — got ${JSON.stringify(mode)}. The modes: ${renderEndingModes()}`,
      ]);
      continue;
    }
    if (mode === "outcome") {
      at(target, validateEndOutcome(row.outcome));
      continue;
    }
    if (mode === "no_change") {
      at(target, validateNoChangeEnding(actionId, lookup));
      if ("outcome" in row) {
        at(target, [
          "no_change carries no outcome field — do not add an observation recap or a no-new-information finding",
        ]);
      }
      continue;
    }
    if (typeof row.outcome === "string" && row.outcome.trim()) {
      at(target, [
        `mode is "pure_speech" but this decision carries an outcome. If anything happened besides the words, decide it as mode "outcome" and keep the paragraph; if the whole of it was the words, drop "outcome"`,
      ]);
    }
    // The other half of pure speech — that the whole result WAS the words —
    // cannot be seen from here: it is a claim about the occurrences, which are
    // five phases away. The occurrences phase checks it, and the final gate
    // checks it again (a pure-speech action with no ending row and a
    // speech:false row citing it reads there as unanswered).
    const known = lookup.actionById.get(actionId);
    if (!known?.command.utterance?.trim()) {
      at(target, [
        `mode is "pure_speech", but this action's command carries no utterance — there are no words for it to have been. Decide it as mode "outcome" with one objective paragraph of what came of it`,
      ]);
    } else if (known.checkOutcome || known.check) {
      // Action before speech: a check was set at start, so this was an
      // attempt and the dice have answered it. Whatever it said while trying,
      // what came of the attempt is an outcome, and the words still get their
      // speech row in the occurrences phase.
      at(target, [
        `mode is "pure_speech", but this action carried a check — it attempted something even if no diceRoll is available. Decide it as mode "outcome": one objective paragraph of what came of the attempt, consistent with any supplied roll (the actor's delivery, any exposed tell, what the hands achieved — never an invented target reply or reaction). Its words are still delivered by their own speech:true row later`,
      ]);
    }
  }
  for (const required of worklist.ending) {
    if (seen.has(required)) continue;
    at({ kind: "resolution" }, [
      `ending action "${required}" has no decision — every id under \`ending\` takes exactly one entry, in one of the modes: ${renderEndingModes()}`,
    ]);
  }
  return errors;
}

function validateStartsPhase(
  rows: unknown[],
  lookup: Lookup,
  worklist: ResolutionWorklist
): ResolutionError[] {
  const { errors, at } = collector();
  const startingIds = new Set(worklist.starting);
  const seen = new Set<string>();
  for (const [i, row] of rows.entries()) {
    const actionId = entryActionId(row);
    if (actionId === undefined) {
      at({ kind: "resolution" }, [notAnEntryMessage("starting", i)]);
      continue;
    }
    const target: ResolutionError["target"] = { kind: "action", actionId };
    if (seen.has(actionId)) {
      at(target, [
        `appears more than once in "starting" — an action begins once. Send it ONCE. Do NOT drop it — this action must be answered this tick`,
      ]);
      continue;
    }
    seen.add(actionId);
    if (!startingIds.has(actionId)) {
      // An id the tick cannot address at all is better named by `validateStart`
      // itself, which lists the addressable ids; a known id that simply is not
      // starting gets the worklist it should have read.
      at(
        target,
        lookup.actionById.has(actionId)
          ? [
              `this action does not start this tick — the trigger lists under \`starting\` only: ${worklist.starting.join(", ") || "(nothing)"}. Drop this entry`,
            ]
          : validateStart(row as RawActionStart, lookup)
      );
      continue;
    }
    at(target, validateStart(row as RawActionStart, lookup));
  }
  for (const required of worklist.starting) {
    if (seen.has(required)) continue;
    at({ kind: "resolution" }, [
      `triggering action "${required}" was not answered — it starts this tick and needs a "starting" entry`,
    ]);
  }
  return errors;
}

function validateCharacterChangesPhase(
  rows: unknown[],
  lookup: Lookup
): ResolutionError[] {
  const { errors, at } = collector();
  rows.forEach((d, i) => {
    at(
      { kind: "characterChange", index: i },
      isRecord(d)
        ? validateCharacterChange(d as unknown as RawCharacterChange, lookup)
        : notAChangeMessages("characterId")
    );
  });
  return errors;
}

function validateItemChangesPhase(
  rows: unknown[],
  lookup: Lookup
): ResolutionError[] {
  const { errors, at } = collector();
  // The same two sets the gate threads through its item pass: they carry the
  // unique-ownership and same-tick-id rules across the rows of one payload.
  const movedItemIds = new Set<string>();
  const createdItemIds = new Set<string>();
  rows.forEach((d, i) => {
    at(
      { kind: "itemChange", index: i },
      isRecord(d)
        ? validateItemChange(
            d as unknown as RawItemChange,
            lookup,
            movedItemIds,
            createdItemIds
          )
        : notAChangeMessages("itemId")
    );
  });
  return errors;
}

function validateSceneChangesPhase(
  rows: unknown[],
  lookup: Lookup,
  draft: AcceptedResolutionDraft
): ResolutionError[] {
  const { errors, at } = collector();
  rows.forEach((d, i) => {
    at(
      { kind: "sceneChange", index: i },
      isRecord(d)
        ? validateSceneChange(d as unknown as RawSceneChange, lookup)
        : notAChangeMessages("sceneId")
    );
  });
  // The gate addresses this at the item change that orphans the prose; here
  // the item changes are accepted and the fix is a setSetting in THIS
  // array, so it is addressed at the phase.
  for (const stale of staleCitations(draft.itemChanges ?? [], rows, lookup)) {
    at({ kind: "resolution" }, [stale.message]);
  }
  return errors;
}

function validateOccurrencesPhase(
  rows: unknown[],
  lookup: Lookup,
  worklist: ResolutionWorklist,
  draft: AcceptedResolutionDraft
): ResolutionError[] {
  const { errors, at } = collector();
  const endingIds = new Set(worklist.ending);
  for (const [i, o] of rows.entries()) {
    if (!isRecord(o)) {
      at({ kind: "resolution" }, [notARowMessage(i)]);
      continue;
    }
    at(
      { kind: "occurrence", actionIds: citedActionIds(o) },
      // `endingIds` is also what refuses a speech row citing an action that
      // only STARTS this tick: its words are delivered next minute.
      validateOccurrence(o as unknown as RawOccurrence, lookup, endingIds)
    );
  }
  // Result and speech decisions need traces; no_change must have none. The modes
  // are traceable in opposite ways. Same rule the gate enforces through
  // `validateEnd` and its unanswered-trigger sweep, stated here in the terms
  // the model is working in — the decision it made in the first phase.
  for (const decision of draft.endings ?? []) {
    const trace = occurrencesCiting(decision.actionId, rows as RawOccurrence[]);
    const physical = trace.filter((o) => !isSpeechRow(o));
    const spoken = trace.filter(isSpeechRow);
    const target: ResolutionError["target"] = {
      kind: "occurrence",
      actionIds: [decision.actionId],
    };
    if (decision.mode === "no_change") {
      if (trace.length > 0) {
        at(target, [
          "no_change must not source an occurrence — actual events retain their own source actions; do not turn them into an observer's recap",
        ]);
      }
      continue;
    }
    if (decision.mode === "outcome") {
      if (physical.length === 0) {
        at(target, [
          `"${decision.actionId}" was decided as an ending with an outcome, but no speech:false row cites it — the required routed trace of this result is missing. Add a speech:false row with this actionId in its "actionIds", stating what happened`,
        ]);
      }
      continue;
    }
    if (spoken.length === 0) {
      at(target, [
        `"${decision.actionId}" was decided as pure speech, but no speech:true row cites it — the words are then never delivered and the action has no answer at all. Add a speech:true row with this actionId in its "actionIds"`,
      ]);
    }
    if (physical.length > 0) {
      at(target, [
        `"${decision.actionId}" was decided as pure speech, but a speech:false row cites it — that row says hands did something, which is not pure speech. Drop the speech:false row if the whole of it was words; if something physical really happened, this action's ending decision has to change to mode "outcome"`,
      ]);
    }
  }
  const outcomeIds = new Set(
    (draft.endings ?? [])
      .filter((d) => d.mode === "outcome")
      .map((d) => d.actionId)
  );
  for (const actionId of missingSpeechActionIds(
    outcomeIds,
    rows as RawOccurrence[],
    lookup
  )) {
    at({ kind: "occurrence", actionIds: [actionId] }, [
      missingSpeechMessage(actionId),
    ]);
  }
  for (const duplicate of duplicateSanityChecks(rows)) {
    at({ kind: "occurrence", actionIds: duplicate.actionIds }, [
      duplicate.message,
    ]);
  }
  return errors;
}

/**
 * Validate ONE phase's payload against the world and the accepted upstream
 * draft. Never throws: a payload of the wrong shape comes back as an addressed
 * error the phase can be asked to correct.
 */
export function validatePhase(
  phase: ResolutionPhase,
  payload: unknown,
  context: EngineResolutionContext,
  draft: AcceptedResolutionDraft
): ResolutionError[] {
  const read = readPhaseRows(phase, payload);
  if ("error" in read) {
    return [{ target: { kind: "resolution" }, message: read.error }];
  }
  const rows = read.rows;
  const lookup = buildLookup(context);
  const worklist = resolutionWorklist(context);
  if (["characterChanges", "itemChanges", "sceneChanges"].includes(phase)) {
    const noChange = new Set(
      (draft.endings ?? [])
        .filter((d) => d.mode === "no_change")
        .map((d) => d.actionId)
    );
    const conflicts: ResolutionError[] = [];
    for (const row of rows) {
      if (
        isRecord(row) &&
        typeof row.sourceActionId === "string" &&
        noChange.has(row.sourceActionId)
      ) {
        conflicts.push({
          target: { kind: "action", actionId: row.sourceActionId },
          message:
            "no_change must not source a new world change — the ending decision must account for an actual result",
        });
      }
    }
    if (conflicts.length > 0) return conflicts;
  }
  switch (phase) {
    case "endings":
      return validateEndingsPhase(rows, lookup, worklist);
    case "starts":
      return validateStartsPhase(rows, lookup, worklist);
    case "characterChanges":
      return validateCharacterChangesPhase(rows, lookup);
    case "itemChanges":
      return validateItemChangesPhase(rows, lookup);
    case "sceneChanges":
      return validateSceneChangesPhase(rows, lookup, draft);
    case "occurrences":
      return validateOccurrencesPhase(rows, lookup, worklist, draft);
    default: {
      // A new phase must be given a validator, not silently accepted.
      const exhaustive: never = phase;
      return [
        {
          target: { kind: "resolution" },
          message: `no validator for phase ${String(exhaustive)}`,
        },
      ];
    }
  }
}

// ==================== Retention and merge ====================
//
// A correction used to be the COMPLETE array again, and measured over a
// ten-tick run the model answered that demand by shrinking: six start entries
// became two, four occurrence rows became two with "placeholder" for content,
// and a missing field was "fixed" by deleting the action it was missing from
// (tick 9 and tick 7 of the 2026-09-04 tlou2 run). The two phases whose rows
// have a natural key — a start is addressed by its actionId, an occurrence by
// the actions it cites and its speech flag — are therefore corrected by
// merging: code keeps every row that passes on its own, tells the model which
// rows it kept, and asks only for what is still owed. The merged array is
// validated WHOLE, exactly as a full resubmission would be, and the tool and
// its one array are unchanged — this is not a patch tool; the schema budget
// and the "patch against a resolution the Engine no longer holds" problem
// that retired `repair_resolution` do not return, because code holds the rows.
// The three change phases address rows by index and keep the full-array rule.

/** The phases a correction merges into instead of replacing. */
export const MERGE_PHASES: ReadonlySet<ResolutionPhase> = new Set([
  "starts",
  "occurrences",
]);

/** One thing the occurrences phase owes: at least one row citing `actionId`
 *  with this `speech` flag. An action that both spoke and did something owes
 *  two of these. */
export interface OccurrenceObligation {
  actionId: string;
  speech: boolean;
}

/** Everything the occurrences phase must cover, derived from the accepted
 *  endings and the trigger — the same facts `validateOccurrencesPhase` judges,
 *  so the checklist shown to the model and the check applied to its answer
 *  cannot disagree. Order: facts first, then speech. */
export function occurrenceObligations(
  context: EngineResolutionContext,
  draft: AcceptedResolutionDraft
): OccurrenceObligation[] {
  const worklist = resolutionWorklist(context);
  const endings = draft.endings ?? [];
  const facts = endings
    .filter((d) => d.mode === "outcome")
    .map((d) => ({ actionId: d.actionId, speech: false }));
  const speechIds = new Set<string>([
    ...worklist.endingWithUtterance,
    ...endings.filter((d) => d.mode === "pure_speech").map((d) => d.actionId),
  ]);
  return [
    ...facts,
    ...[...speechIds].map((actionId) => ({ actionId, speech: true })),
  ];
}

function covers(rows: unknown[], o: OccurrenceObligation): boolean {
  return occurrencesCiting(o.actionId, rows as RawOccurrence[]).some(
    (r) => isSpeechRow(r) === o.speech
  );
}

/** The obligations no row in `rows` satisfies yet. */
export function unmetOccurrenceObligations(
  rows: unknown[],
  context: EngineResolutionContext,
  draft: AcceptedResolutionDraft
): OccurrenceObligation[] {
  return occurrenceObligations(context, draft).filter((o) => !covers(rows, o));
}

/** The starting ids no retained row answers. */
export function unansweredStarts(
  retained: unknown[],
  context: EngineResolutionContext
): string[] {
  const answered = new Set(
    retained.map(entryActionId).filter((id): id is string => id !== undefined)
  );
  return resolutionWorklist(context).starting.filter((id) => !answered.has(id));
}

function sanityCheckCharacterIds(occ: RawOccurrence): string[] {
  const list = (occ as { sanityChecks?: unknown }).sanityChecks;
  if (!Array.isArray(list)) return [];
  return list
    .map((s) =>
      isRecord(s) && typeof s.characterId === "string" ? s.characterId : ""
    )
    .filter((id) => id.length > 0);
}

/**
 * Split a rejected merge-phase array into the rows that pass on their own and
 * the rows that do not. A row is judged exactly as the phase validator judges
 * it — the same helper calls, the same upstream facts — minus the coverage
 * checks, which are about rows that are ABSENT and so cannot fault a row that
 * is present. For any other phase nothing is retained: the whole array is
 * faulty in the sense that the whole array is asked for again.
 */
export function retainedRows(
  phase: ResolutionPhase,
  rows: unknown[],
  context: EngineResolutionContext,
  draft: AcceptedResolutionDraft
): { retained: unknown[]; faulty: unknown[] } {
  if (!MERGE_PHASES.has(phase)) return { retained: [], faulty: rows };
  const lookup = buildLookup(context);
  const worklist = resolutionWorklist(context);
  const retained: unknown[] = [];
  const faulty: unknown[] = [];
  if (phase === "starts") {
    const startingIds = new Set(worklist.starting);
    const seen = new Set<string>();
    for (const row of rows) {
      const id = entryActionId(row);
      const ok =
        id !== undefined &&
        startingIds.has(id) &&
        !seen.has(id) &&
        validateStart(row as RawActionStart, lookup).length === 0;
      if (id !== undefined) seen.add(id);
      (ok ? retained : faulty).push(row);
    }
    return { retained, faulty };
  }
  const endingIds = new Set(worklist.ending);
  const pureSpeech = new Set(
    (draft.endings ?? [])
      .filter((d) => d.mode === "pure_speech")
      .map((d) => d.actionId)
  );
  const noChange = new Set(
    (draft.endings ?? [])
      .filter((d) => d.mode === "no_change")
      .map((d) => d.actionId)
  );
  const shocked = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) {
      faulty.push(row);
      continue;
    }
    const occ = row as unknown as RawOccurrence;
    let ok = validateOccurrence(occ, lookup, endingIds).length === 0;
    if (ok && citedActionIds(occ).some((id) => noChange.has(id))) ok = false;
    // A speech:false row citing a pure-speech decision is the one conflict
    // the phase reports at the DECISION rather than at the row.
    if (ok && !isSpeechRow(occ)) {
      ok = !citedActionIds(occ).some((id) => pureSpeech.has(id));
    }
    // One sanity roll per character per tick: the first exposure keeps it.
    if (ok) {
      const ids = sanityCheckCharacterIds(occ);
      if (ids.some((id) => shocked.has(id))) ok = false;
      else for (const id of ids) shocked.add(id);
    }
    (ok ? retained : faulty).push(row);
  }
  return { retained, faulty };
}

/** Starts have a unique action key. Occurrence coverage pairs are deliberately
 * not used as identity: distinct facts can cite the same action and flag. */
function rowKey(_phase: ResolutionPhase, row: unknown): string | undefined {
  return entryActionId(row);
}

/** Keep valid starts by actionId and append new occurrence facts. Exact repeats
 * of retained occurrences are ignored; other submitted rows are validated as
 * part of the whole candidate, never allowed to erase a retained event. */
export function mergeRows(
  phase: ResolutionPhase,
  retained: unknown[],
  submitted: unknown[],
  context: EngineResolutionContext,
  draft: AcceptedResolutionDraft
): unknown[] {
  if (!MERGE_PHASES.has(phase) || retained.length === 0) return submitted;
  // Coverage is not identity: the shove and the landing may cite the same
  // action and flag. Retained occurrences are immutable during repair; append
  // new facts and only deduplicate exact repeats of rows already kept.
  if (phase === "occurrences") {
    return [
      ...retained,
      ...submitted.filter(
        (row) => !retained.some((kept) => isDeepStrictEqual(kept, row))
      ),
    ];
  }
  const out = [...retained];
  const replaceable = new Set(retained.map((_, i) => i));
  for (const row of submitted) {
    const key = rowKey(phase, row);
    const i =
      key === undefined
        ? -1
        : out.findIndex(
            (r, j) => replaceable.has(j) && rowKey(phase, r) === key
          );
    if (i < 0) {
      out.push(row);
      continue;
    }
    replaceable.delete(i);
    if (retainedRows(phase, [row], context, draft).retained.length === 1) {
      out[i] = row;
    }
  }
  return out;
}

// ==================== Assembly ====================

/**
 * The six accepted phases as the one shape the final gate, `finalizeResolution`
 * and the Applier already understand.
 *
 * Endings are converted: no_change becomes an explicit null outcome, while
 * a `pure_speech` decision produces NO
 * ending row. That is what the intermediate `EndingDecision` exists for — the
 * final resolution has no way to say "answered by talk alone" except by the
 * absence of a row, and an absence is not a thing the model can be corrected
 * about precisely.
 *
 * An absent phase key assembles as `[]`. The runner only calls this with every
 * phase accepted, so that is a defensive default, not a supported state.
 */
export function assembleRawResolution(
  draft: AcceptedResolutionDraft
): RawTickResolution {
  return {
    starting: draft.starting ?? [],
    ending: (draft.endings ?? []).flatMap((d) =>
      d.mode === "pure_speech"
        ? []
        : [
            {
              actionId: d.actionId,
              outcome: d.mode === "outcome" ? d.outcome : null,
            },
          ]
    ),
    characterChanges: draft.characterChanges ?? [],
    itemChanges: draft.itemChanges ?? [],
    sceneChanges: draft.sceneChanges ?? [],
    occurrences: draft.occurrences ?? [],
  };
}

// ==================== Rewind ====================

/**
 * Which phase can fix one global error.
 *
 * The table is plan §Error Ownership. The only entry that is not a straight
 * domain mapping is `action:<id>`: an id the trigger lists under `ending` is
 * answered by the endings phase, and anything else by the starts phase — which
 * is why this needs the context at all.
 */
function phaseForTarget(
  target: ResolutionError["target"],
  endingIds: ReadonlySet<string>,
  /** The session's phases: "the resolution as a whole" is owned by whichever
   *  phase opens it. */
  phases: readonly ResolutionPhase[]
): ResolutionPhase {
  switch (target.kind) {
    // "the resolution as a whole" — an unanswered trigger, a list element that
    // is not an element. The earliest phase is the only one that can rebuild
    // from scratch, and every later phase is rerun behind it anyway.
    case "resolution":
      return phases[0];
    case "action":
      return endingIds.has(target.actionId) ? "endings" : "starts";
    case "characterChange":
      return "characterChanges";
    case "itemChange":
      return "itemChanges";
    case "sceneChange":
      return "sceneChanges";
    case "occurrence":
      return "occurrences";
    default: {
      // A new ResolutionError target kind fails to compile here rather than
      // silently rewinding to whatever the fallback happens to be.
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

/**
 * The earliest phase of this session that can fix this set of global errors.
 * Rewinding there discards it and every phase after it; everything earlier
 * stays accepted.
 *
 * A fault owned by a phase the session does not run — an `action:<id>` the
 * settlement cannot place, say — goes to the session's opening phase, which
 * is the only one that can rebuild from scratch. With no errors there is
 * nothing to fix, and the answer is the session's last phase — the least
 * destructive thing to rerun. The runner never asks in that state.
 */
export function rewindPhaseFor(
  errors: ResolutionError[],
  context: EngineResolutionContext,
  session: EngineSessionKind = "settlement"
): ResolutionPhase {
  const phases = SESSION_PHASES[session];
  const endingIds = new Set(resolutionWorklist(context).ending);
  let earliest: ResolutionPhase = phases[phases.length - 1];
  for (const error of errors) {
    const owner = phaseForTarget(error.target, endingIds, phases);
    const phase = phases.includes(owner) ? owner : phases[0];
    if (phaseIndex(phase) < phaseIndex(earliest)) earliest = phase;
  }
  return earliest;
}
