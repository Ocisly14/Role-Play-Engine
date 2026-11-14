// src/engine/resolution/decisionsFastPaths.ts
//
// The Engine's judgements that are a pick from a closed set, answered by the
// OpenAI Decisions API instead of a full model session (design:
// docs/superpowers/specs/2026-11-13-decisions-api-fast-paths-design.md §6.2,
// §6.3). Every function returns what it is SURE of and nothing else — a
// question answered below its threshold sends that action back to the LLM
// path, which is the existing path, unchanged.
//
// Nothing here writes world state. The rows it builds go through the same
// validators (`validatePhase`, `validateRawResolution`, `finalizeResolution`)
// as a model's would.

import {
  type DecisionAnswer,
  type DecisionQuestion,
  MAX_QUESTIONS_PER_REQUEST,
  decide,
  thresholdEnv,
  topChoice,
} from "../../models/decisions.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { actionIdForCommand } from "../actions/actionStore.js";
import { placesAdjacent } from "../actions/movementRuntime.js";
import type { ActionCommand, EngineAction } from "../actions/types.js";
import { SKILL_CATALOG, catalogSkillName } from "../rules/skillCatalog.js";
import type { EngineResolutionContext } from "./types.js";
import type { RawActionStart, RawOccurrence } from "./worldDeltaSchema.js";
import { resolutionWorklist } from "./worldDeltaValidator.js";
import { renderContextSegments } from "./worldResolutionStagePrompts.js";
import type {
  AcceptedResolutionDraft,
  EndingDecision,
} from "./worldResolutionStageSchemas.js";

// ==================== Shared ====================

/** 43 bins: minutes up to an hour, hourly to a day, six-hourly to three
 *  days, daily to a week (design §6.2). */
export const DURATION_BINS: readonly number[] = [
  1,
  2,
  3,
  5,
  10,
  15,
  30,
  60,
  ...Array.from({ length: 23 }, (_, i) => (i + 2) * 60),
  ...Array.from({ length: 8 }, (_, i) => 1440 + (i + 1) * 360),
  5760,
  7200,
  8640,
  10080,
];

const CHECK_LEVELS = ["none", "regular", "hard", "extreme"] as const;
const CLARITY_CHOICES = ["none", "trace", "limited", "full"] as const;

function contextText(context: EngineResolutionContext): string[] {
  const { stable, volatile } = renderContextSegments(context);
  return [stable, volatile];
}

function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${minutes / 60} h`;
  if (minutes % 1440 === 0) return `${minutes / 1440} day(s)`;
  return `${minutes / 60} h`;
}

function minConfidence(): number {
  return thresholdEnv("DECISIONS_MIN_CONFIDENCE", 0.8);
}

/** P(true) for a predicate, or undefined. */
function prob(
  answers: Map<string, DecisionAnswer>,
  name: string
): number | undefined {
  return answers.get(name)?.probability;
}

/** A confident pick, or null when below threshold / missing. */
function confident(
  answers: Map<string, DecisionAnswer>,
  name: string
): string | null {
  const top = topChoice(answers.get(name));
  return top && top.probability >= minConfidence() ? top.value : null;
}

// ==================== Starts (§6.2) ====================

export interface DecidedStarts {
  /** Rows for the commands every field was confidently answered for. */
  rows: RawActionStart[];
  /** Their action ids. Every other new command goes to the LLM. */
  decided: Set<string>;
}

interface StartPlan {
  actionId: string;
  command: ActionCommand;
  checkSkill?: string;
  travel: "yes" | "no" | "ask";
  routes: string[][];
  vehicleId?: string;
  opposedChoices: Array<{ value: string; description: string }>;
}

/** The ways the actor's own cited places can be walked from where they
 *  stand — no pathfinding: only what their words carry. */
export function routeCandidates(
  dgsm: DynamicGameStateManager,
  startId: string | undefined,
  cited: readonly string[]
): string[][] {
  if (!startId || cited.length === 0) return [];
  const out: string[][] = [];
  const key = (r: string[]) => r.join(">");
  const seen = new Set<string>();
  const push = (r: string[]) => {
    if (r.length === 0 || seen.has(key(r))) return;
    seen.add(key(r));
    out.push(r);
  };
  const walkable = (chain: string[]): string[] => {
    const route: string[] = [];
    let from = startId;
    for (const place of chain) {
      if (place === from) continue;
      if (!placesAdjacent(dgsm, from, place)) break;
      route.push(place);
      from = place;
    }
    return route;
  };
  // 1. The cited places in order, cut where the way runs out.
  push(walkable([...cited]));
  // 2. The same, with the implied first step onto the street: one place
  //    joining where they stand to their first cited place.
  const first = cited[0];
  if (!placesAdjacent(dgsm, startId, first)) {
    const here = dgsm.getScene(startId);
    for (const c of here?.connections ?? []) {
      if (c.concealed) continue;
      if (placesAdjacent(dgsm, c.targetId, first)) {
        const rest = walkable([...cited]);
        const route = [c.targetId];
        let from = c.targetId;
        for (const place of cited) {
          if (!placesAdjacent(dgsm, from, place)) break;
          route.push(place);
          from = place;
        }
        push(route.length > rest.length ? route : rest);
      }
    }
  }
  // 3. Any single cited place one step away.
  for (const place of cited) {
    if (place !== startId && placesAdjacent(dgsm, startId, place)) {
      push([place]);
    }
  }
  return out;
}

function startPlan(
  context: EngineResolutionContext,
  dgsm: DynamicGameStateManager,
  command: ActionCommand
): StartPlan {
  const actionId = actionIdForCommand(command.commandId);
  // A cited place may be where the actor is going or only what they are
  // looking at; refs no longer say which, so a place ref leaves travel to
  // the question and only its absence settles "no".
  const placeRefs = command.objectRefs.filter((r) => r.kind === "scene");
  const actor = context.state.characters.find((c) => c.id === command.actorId);
  const startId = actor?.locationId;
  const routes = routeCandidates(
    dgsm,
    startId,
    placeRefs.map((r) => r.id)
  );
  const vehicle = startId ? dgsm.getVehicleByInterior?.(startId) : null;
  const opposedChoices: StartPlan["opposedChoices"] = [
    { value: "none", description: "Nobody actively resists." },
  ];
  const checkSkill = catalogSkillName(command.declaredSkillId ?? "");
  if (checkSkill) {
    for (const other of context.state.characters) {
      if (
        other.id === command.actorId ||
        !other.alive ||
        other.locationId !== startId
      ) {
        continue;
      }
      for (const skill of SKILL_CATALOG) {
        if (skill.name === "Languages") continue;
        opposedChoices.push({
          value: `${other.id}|${skill.name}`,
          description: `${other.id} actively resists with ${skill.name}`,
        });
      }
    }
  }
  return {
    actionId,
    command,
    checkSkill,
    travel: placeRefs.length === 0 ? "no" : "ask",
    routes,
    ...(vehicle ? { vehicleId: vehicle.id } : {}),
    opposedChoices,
  };
}

/**
 * Judge each new command's start by Decisions. A command whose every field
 * is answered with confidence gets a row; the rest are left for the LLM. A
 * travel command whose cited way does not walk, or whose first step is
 * blocked, is always left for the LLM (it can grant passage).
 */
export async function decideStarts(
  context: EngineResolutionContext,
  dgsm: DynamicGameStateManager
): Promise<DecidedStarts> {
  const plans = context.actions.newCommands.map((c) =>
    startPlan(context, dgsm, c)
  );
  const questions: DecisionQuestion[] = [];
  for (const p of plans) {
    const id = p.actionId;
    if (p.travel === "ask") {
      questions.push({
        type: "predicate",
        name: `travel:${id}`,
        instructions: `Command ${id}: does the actor set off to go to another place (rather than act where they are)?`,
      });
    }
    if (p.travel !== "yes") {
      questions.push({
        type: "choice",
        name: `duration:${id}`,
        instructions: `Command ${id} (not travel): how long should this attempt take? Judge the ATTEMPT, not the sentence: words alone take 1 minute; an attempt made while speaking takes the attempt's time. The actor's own estimate is ${p.command.proposedDurationTicks} min (advisory).`,
        choices: DURATION_BINS.map((m) => ({
          value: String(m),
          description: durationLabel(m),
        })),
      });
    }
    if (p.travel !== "no" && p.routes.length > 0) {
      questions.push({
        type: "choice",
        name: `route:${id}`,
        instructions: `Command ${id}: which of these routes is the way the actor's OWN words describe? Never more than they said; "none" if none matches.`,
        choices: [
          ...p.routes.map((r, i) => ({
            value: `r${i}`,
            description: r.join(" → "),
          })),
          { value: "none", description: "None of these is what they said." },
        ],
      });
      if (p.vehicleId) {
        questions.push({
          type: "choice",
          name: `vehicle:${id}`,
          instructions: `Command ${id}: the actor is inside vehicle ${p.vehicleId}. Do they drive it there, or go on foot?`,
          choices: [
            { value: "on_foot", description: "On foot." },
            { value: p.vehicleId, description: `Drives ${p.vehicleId}.` },
          ],
        });
      }
    }
    if (p.checkSkill) {
      questions.push({
        type: "choice",
        name: `check:${id}`,
        instructions: `Command ${id} declares the skill ${p.checkSkill}. Pick "none" for an interpersonal attempt such as persuading, questioning, deceiving, intimidating, negotiating or reading a person's intent, and when the skill does not fit or no check is needed. An independently uncertain task such as treating a wound, translating a learned language or attacking can be checked even when another person is involved.`,
        choices: CHECK_LEVELS.map((l) => ({ value: l, description: l })),
      });
      if (p.opposedChoices.length > 1) {
        questions.push({
          type: "choice",
          name: `opposed:${id}`,
          instructions: `Command ${id}: does anyone present actively resist the checked task, and with which defense skill? Pick "none" for a person's choice about how to respond in conversation.`,
          choices: p.opposedChoices,
        });
      }
    }
  }
  const empty: DecidedStarts = { rows: [], decided: new Set() };
  if (questions.length === 0 || questions.length > MAX_QUESTIONS_PER_REQUEST) {
    return empty;
  }
  const result = await decide({
    operation: "decisions:starts",
    input: { text: contextText(context) },
    questions,
    cacheKey: "engine:starts",
  });
  if (!result.ok) return empty;
  const a = result.answers;

  const rows: RawActionStart[] = [];
  const decided = new Set<string>();
  for (const p of plans) {
    const id = p.actionId;
    let travel = p.travel === "yes";
    if (p.travel === "ask") {
      const pt = prob(a, `travel:${id}`);
      if (pt === undefined) continue;
      if (pt >= minConfidence()) travel = true;
      else if (pt <= 1 - minConfidence()) travel = false;
      else continue;
    }
    const row: RawActionStart = { actionId: id };
    if (travel) {
      const pick = confident(a, `route:${id}`);
      if (!pick || pick === "none") continue;
      const route = p.routes[Number(pick.slice(1))];
      if (!route) continue;
      const actor = context.state.characters.find(
        (c) => c.id === p.command.actorId
      );
      if (
        actor?.locationId &&
        dgsm.getConnectionBlockReason(actor.locationId, route[0])
      ) {
        continue; // a blocked first step may need a grant: the LLM's call
      }
      let vehicleId: string | undefined;
      if (p.vehicleId) {
        const v = confident(a, `vehicle:${id}`);
        if (!v) continue;
        if (v !== "on_foot") vehicleId = v;
      }
      row.movement = { route, ...(vehicleId ? { vehicleId } : {}) };
    } else {
      const d = confident(a, `duration:${id}`);
      if (!d) continue;
      row.resolvedDurationTicks = Number(d);
    }
    if (p.checkSkill) {
      const level = confident(a, `check:${id}`);
      if (!level) continue;
      if (level !== "none") {
        row.check = { requiredLevel: level as "regular" | "hard" | "extreme" };
        if (p.opposedChoices.length > 1) {
          const opp = confident(a, `opposed:${id}`);
          if (!opp) continue;
          if (opp !== "none") {
            const [characterId, skillId] = opp.split("|");
            row.opposedBy = [{ characterId, skillId }];
          }
        }
      }
    }
    rows.push(row);
    decided.add(id);
  }
  return { rows, decided };
}

// ==================== Ending modes (§6.3 step 1) ====================

function endingAction(
  context: EngineResolutionContext,
  id: string
): EngineAction | undefined {
  return context.actions.activeActions.find((x) => x.id === id);
}

/**
 * The endings decided without a model, when EVERY ending this minute is
 * confidently words-alone or no-new-result. Null otherwise — a checked
 * action always needs an outcome written, so one is enough to say null.
 */
export async function decideEndingModes(
  context: EngineResolutionContext
): Promise<EndingDecision[] | null> {
  const ending = resolutionWorklist(context).ending;
  if (ending.length === 0) return null;
  const questions: DecisionQuestion[] = [];
  for (const id of ending) {
    const action = endingAction(context, id);
    if (!action || action.check) return null;
    const words = action.command.utterance?.trim();
    questions.push({
      type: "predicate",
      name: `result:${id}`,
      instructions: words
        ? `Action ${id} ("${action.command.description}") ends now; its words are delivered verbatim by code. Besides speaking, did it do anything with a new observable result, such as laying out evidence or visibly making a threat? Do not count anyone else's unissued reply or reaction as a result.`
        : `Action ${id} ("${action.command.description}") ends now, unchecked and silent. Did it produce a new observable result, such as something changing, moving, being found or being shown? Time spent watching, waiting or trying to read someone's intent is not a new result.`,
    });
  }
  const result = await decide({
    operation: "decisions:endings",
    input: { text: contextText(context) },
    questions,
    cacheKey: "engine:settlement",
  });
  if (!result.ok) return null;
  const maxYes = 1 - minConfidence();
  const out: EndingDecision[] = [];
  for (const id of ending) {
    const p = prob(result.answers, `result:${id}`);
    if (p === undefined || p > maxYes) return null;
    const words = endingAction(context, id)?.command.utterance?.trim();
    out.push({ actionId: id, mode: words ? "pure_speech" : "no_change" });
  }
  return out;
}

// ==================== Change plan (§6.3 step 3) ====================

export type ChangePhase = "characterChanges" | "itemChanges" | "sceneChanges";
const CHANGE_DOMAINS: Record<ChangePhase, string> = {
  characterChanges:
    "a persistent change to a character (injury, fatigue, a lasting condition, appearance, a displacement that is not a walk)",
  itemChanges:
    "a change to an item (created, moved to another holder, destroyed, or what it is like)",
  sceneChanges:
    "a change to a place or a passage (its prose, a condition, a blocked or concealed passage, the environment)",
};

/** The change phases every outcome this minute confidently leaves untouched. */
export async function decideUnchangedPhases(
  context: EngineResolutionContext,
  draft: AcceptedResolutionDraft
): Promise<Set<ChangePhase>> {
  const outcomes = (draft.endings ?? []).filter(
    (d): d is Extract<EndingDecision, { mode: "outcome" }> =>
      d.mode === "outcome"
  );
  const none = new Set<ChangePhase>();
  if (outcomes.length === 0) return none;
  const questions: DecisionQuestion[] = [];
  for (const d of outcomes) {
    for (const [phase, what] of Object.entries(CHANGE_DOMAINS)) {
      questions.push({
        type: "predicate",
        name: `${phase}:${d.actionId}`,
        instructions: `Action ${d.actionId} ended with this outcome: "${d.outcome}". Does it leave ${what}?`,
      });
    }
  }
  const result = await decide({
    operation: "decisions:phase-plan",
    input: { text: contextText(context) },
    questions,
    cacheKey: "engine:settlement",
  });
  if (!result.ok) return none;
  const maxYes = 1 - thresholdEnv("PHASE_SKIP_MIN_CONFIDENCE", 0.9);
  for (const phase of Object.keys(CHANGE_DOMAINS) as ChangePhase[]) {
    if (
      outcomes.every((d) => {
        const p = prob(result.answers, `${phase}:${d.actionId}`);
        return p !== undefined && p <= maxYes;
      })
    ) {
      none.add(phase);
    }
  }
  return none;
}

// ==================== Speech rows + perceivers (§6.3 steps 4–5) ====================

/** One speech row per pure-speech ending, built by code: the words are the
 *  command's, the addressees its target / recipient characters. Perceivers
 *  are left empty for `decidePerceivers`. */
export function speechRows(
  context: EngineResolutionContext,
  endings: readonly EndingDecision[]
): RawOccurrence[] {
  const rows: RawOccurrence[] = [];
  for (const d of endings) {
    if (d.mode !== "pure_speech") continue;
    const action = endingAction(context, d.actionId);
    if (!action) continue;
    // Pure speech: the people its command cites are the people it is said to.
    const targetIds = action.command.objectRefs
      .filter((r) => r.kind === "character")
      .map((r) => r.id);
    rows.push({
      actionIds: [d.actionId],
      speech: true,
      targetIds,
      perceivers: [],
    });
  }
  return rows;
}

/**
 * Who perceives each row and how clearly. The actor of a row's action always
 * perceives it fully; every other living character is a candidate, and the
 * answer leans to the clearer grade when it is close (missing a perceiver is
 * the error nobody sees). Null when the request fails or would not fit —
 * the caller then asks the LLM.
 */
export async function decidePerceivers(
  context: EngineResolutionContext,
  rows: readonly RawOccurrence[]
): Promise<RawOccurrence[] | null> {
  const actorOf = (row: RawOccurrence): string | undefined => {
    const first = Array.isArray(row.actionIds) ? row.actionIds[0] : undefined;
    return first ? endingAction(context, first)?.command.actorId : undefined;
  };
  const candidates = context.state.characters.filter((c) => c.alive);
  const questions: DecisionQuestion[] = [];
  rows.forEach((row, i) => {
    const actor = actorOf(row);
    for (const c of candidates) {
      if (c.id === actor) continue;
      questions.push({
        type: "choice",
        name: `p:${i}:${c.id}`,
        instructions: `Row ${i} (${row.speech ? "a spoken line" : "an event"} by ${actor ?? "someone"} — ${row.content ?? "see the action"}): how much of it reaches ${c.id}, where they are now? full = the event and its detail, words made out; limited = the kind of event and its immediate result, a speaker seen whose words do not carry; trace = only that something happened; none = nothing reaches them.`,
        choices: CLARITY_CHOICES.map((v) => ({ value: v, description: v })),
      });
    }
  });
  if (questions.length > MAX_QUESTIONS_PER_REQUEST) return null;
  const result =
    questions.length === 0
      ? { ok: true as const, answers: new Map<string, DecisionAnswer>() }
      : await decide({
          operation: "decisions:perceivers",
          input: {
            text: contextText(context),
            json: rows.map((r, i) => ({
              row: i,
              actionIds: r.actionIds,
              speech: r.speech,
              ...(r.content ? { content: r.content } : {}),
            })),
          },
          questions,
          cacheKey: "engine:settlement",
        });
  if (!result.ok) return null;
  const nearGap = thresholdEnv("PERCEIVER_NEAR_GAP", 0.15);
  const noneMin = thresholdEnv("PERCEIVER_NONE_MIN", 0.7);
  return rows.map((row, i) => {
    const actor = actorOf(row);
    const perceivers: RawOccurrence["perceivers"] = actor
      ? [{ characterId: actor, clarity: "full" }]
      : [];
    for (const c of candidates) {
      if (c.id === actor) continue;
      const grade = biasedClarity(
        result.answers.get(`p:${i}:${c.id}`),
        nearGap,
        noneMin
      );
      if (grade !== "none")
        perceivers.push({ characterId: c.id, clarity: grade });
    }
    return { ...row, perceivers };
  });
}

/**
 * The model wrote the rows (DECISIONS_PERCEIVERS=on): give every row still
 * without perceivers its audience from Decisions, then drop any sanity check
 * on someone who does not perceive that row clearly (full or limited) —
 * exposure is perception. Null when Decisions could not answer.
 */
export async function withDecidedPerceivers(
  context: EngineResolutionContext,
  rows: readonly RawOccurrence[]
): Promise<RawOccurrence[] | null> {
  const missing = rows
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) => !Array.isArray(row.perceivers) || row.perceivers.length === 0
    );
  const filled = [...rows];
  if (missing.length > 0) {
    const decided = await decidePerceivers(
      context,
      missing.map(({ row }) => ({ ...row, perceivers: [] }))
    );
    if (!decided) return null;
    missing.forEach(({ index }, k) => {
      filled[index] = decided[k];
    });
  }
  return filled.map(keepClearSanityChecks);
}

function keepClearSanityChecks(row: RawOccurrence): RawOccurrence {
  const checks = (row as { sanityChecks?: Array<{ characterId?: string }> })
    .sanityChecks;
  if (!Array.isArray(checks) || checks.length === 0) return row;
  const clear = new Set(
    (row.perceivers ?? [])
      .filter((p) => p.clarity === "full" || p.clarity === "limited")
      .map((p) => p.characterId)
  );
  return {
    ...row,
    sanityChecks: checks.filter(
      (c) => typeof c.characterId === "string" && clear.has(c.characterId)
    ),
  } as RawOccurrence;
}

/** Most probable grade, leaning clearer (design §6.5): two adjacent grades
 *  within `nearGap` → the clearer; "none" needs `noneMin`, else trace. */
export function biasedClarity(
  answer: DecisionAnswer | undefined,
  nearGap: number,
  noneMin: number
): (typeof CLARITY_CHOICES)[number] {
  const probs = answer?.probabilities ?? {};
  const ranked = CLARITY_CHOICES.map((g, idx) => ({
    g,
    idx,
    p: probs[g] ?? 0,
  })).sort((x, y) => y.p - x.p);
  let best = ranked[0];
  const second = ranked[1];
  if (
    second &&
    Math.abs(best.idx - second.idx) === 1 &&
    best.p - second.p < nearGap &&
    second.idx > best.idx
  ) {
    best = second;
  }
  if (best.g === "none" && best.p < noneMin) return "trace";
  return best.g;
}
