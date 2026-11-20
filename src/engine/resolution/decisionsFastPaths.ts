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
import {
  type ActionCommand,
  type EngineAction,
  HEARING_GRADES,
  SIGHT_GRADES,
  perceivesAnything,
  perceivesSource,
} from "../actions/types.js";
import {
  CHECK_NEED_RULE,
  STATED_ROUTE_RULE,
  TALK_DURATION_RULE,
  renderEndingModes,
} from "../rules/ruleTerms.js";
import { SKILL_CATALOG, catalogSkillName } from "../rules/skillCatalog.js";
import {
  perceiversInput,
  settlementInput,
  startsInput,
} from "./decisionsInputs.js";
import type { EngineResolutionContext } from "./types.js";
import type { RawActionStart, RawOccurrence } from "./worldDeltaSchema.js";
import { resolutionWorklist } from "./worldDeltaValidator.js";
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
/** Each sense's grades from least to most — the order the lean reads. */
const SIGHT_ORDER = [...SIGHT_GRADES].reverse();
const HEARING_ORDER = [...HEARING_GRADES].reverse();

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

/**
 * The most probable answer, however spread the probabilities are. Used for
 * the start fields where a near miss costs little — a duration one bin off,
 * the obvious route, nobody resisting. Measured on a grayhaven run: the top
 * choice matched the model's own answer or fell one bin short, never wide of
 * it, while a 0.8 bar sent most starts back to the model (2026-11-14).
 */
function topPick(
  answers: Map<string, DecisionAnswer>,
  name: string
): string | null {
  return topChoice(answers.get(name))?.value ?? null;
}

type CheckLevel = (typeof CHECK_LEVELS)[number];

/**
 * The check level: the most probable one, leaning toward the dice when the
 * top two are within `nearGap`. Between "none" and a bar → that bar: doubt
 * about whether success is in doubt is itself doubt, and a roll carries it
 * (a wrong roll still mostly succeeds at a high skill; a wrong "none" removes
 * failure altogether). Between two bars → the lower one. Never goes back to
 * the model: measured on grayhaven (2026-11-17/18), the model's answer to an
 * unsure level was the top choice whenever the top two were apart, and the
 * check when they were close. Null only when there is no answer.
 */
export function leanedCheckLevel(
  answer: DecisionAnswer | undefined,
  nearGap: number
): CheckLevel | null {
  const probs = answer?.probabilities ?? {};
  const ranked = CHECK_LEVELS.map((level, idx) => ({
    level,
    idx,
    p: probs[level] ?? 0,
  })).sort((x, y) => y.p - x.p);
  const [best, second] = ranked;
  if (!best || best.p <= 0) return null;
  if (!second || best.p - second.p >= nearGap) return best.level;
  if (best.idx === 0) return second.level;
  if (second.idx === 0) return best.level;
  return best.idx < second.idx ? best.level : second.level;
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
        instructions: `Command ${id} (not travel): how long does it take? ${TALK_DURATION_RULE} The actor's own estimate is ${p.command.proposedDurationTicks} min (advisory).`,
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
        instructions: `Command ${id}: which of these is the route? ${STATED_ROUTE_RULE} "none" if none of them is.`,
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
        instructions: `Command ${id} declares the skill ${p.checkSkill}: what bar does the attempt need? ${CHECK_NEED_RULE} "none" is no check.`,
        choices: CHECK_LEVELS.map((l) => ({ value: l, description: l })),
      });
      if (p.opposedChoices.length > 1) {
        questions.push({
          type: "choice",
          name: `opposed:${id}`,
          instructions: `Command ${id}: who present actively resists the checked task, and with which skill?`,
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
    input: { text: startsInput(context) },
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
      travel = pt >= 0.5;
    }
    const row: RawActionStart = { actionId: id };
    if (travel) {
      const pick = topPick(a, `route:${id}`);
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
        const v = topPick(a, `vehicle:${id}`);
        if (!v) continue;
        if (v !== "on_foot") vehicleId = v;
      }
      row.movement = { route, ...(vehicleId ? { vehicleId } : {}) };
    } else {
      const d = topPick(a, `duration:${id}`);
      if (!d) continue;
      row.resolvedDurationTicks = Number(d);
    }
    if (p.checkSkill) {
      const level = leanedCheckLevel(
        a.get(`check:${id}`),
        thresholdEnv("DECISIONS_CHECK_NEAR_GAP", 0.1)
      );
      if (!level) continue;
      if (level !== "none") {
        row.check = { requiredLevel: level as "regular" | "hard" | "extreme" };
        if (p.opposedChoices.length > 1) {
          const opp = topPick(a, `opposed:${id}`);
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
      instructions: `Action ${id} ("${action.command.description}") ends now${words ? "; its words are delivered verbatim by code" : ""}. The ending modes: ${renderEndingModes()}. Is it an \`outcome\`?`,
    });
  }
  const result = await decide({
    operation: "decisions:endings",
    input: { text: settlementInput(context) },
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
    input: { text: settlementInput(context) },
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
 * Who perceives each row, by sight and by hearing (design §6.7.3). The
 * actors of the row's own actions are not asked about: someone who acted is
 * awake, and knows what they said and did — code lists them clear on both.
 * Every other living character is a candidate, asked two questions, one per
 * sense, against the one grade scale in the input. The answer leans to the
 * clearer grade when it is close (missing a perceiver is the error nobody
 * sees). Null when the request fails or would not fit — the caller then
 * asks the LLM.
 */
export async function decidePerceivers(
  context: EngineResolutionContext,
  rows: readonly RawOccurrence[]
): Promise<RawOccurrence[] | null> {
  const living = context.state.characters.filter((c) => c.alive);
  const actorsOf = (row: RawOccurrence): Set<string> =>
    new Set(
      (Array.isArray(row.actionIds) ? row.actionIds : [])
        .map((id) => endingAction(context, id)?.command.actorId)
        .filter((id): id is string => id !== undefined)
    );
  const others = (row: RawOccurrence) => {
    const actors = actorsOf(row);
    return living.filter((c) => !actors.has(c.id));
  };
  const questions: DecisionQuestion[] = [];
  // One line per question: which row, whom, which sense. The scale is
  // defined once in the input (`perceiversInput`), and nothing here tells
  // Decisions how sight or sound travels — that judgement is what it is
  // asked for.
  rows.forEach((row, i) => {
    for (const c of others(row)) {
      questions.push(
        {
          type: "choice",
          name: `sight:${i}:${c.id}`,
          instructions: `Row ${i}: what does ${c.id} get by seeing it?`,
          choices: SIGHT_ORDER.map((v) => ({ value: v, description: v })),
        },
        {
          type: "choice",
          name: `hearing:${i}:${c.id}`,
          instructions: `Row ${i}: what does ${c.id} get by hearing it?`,
          choices: HEARING_ORDER.map((v) => ({ value: v, description: v })),
        }
      );
    }
  });
  if (questions.length > MAX_QUESTIONS_PER_REQUEST) return null;
  const result =
    questions.length === 0
      ? { ok: true as const, answers: new Map<string, DecisionAnswer>() }
      : await decide({
          operation: "decisions:perceivers",
          input: {
            text: perceiversInput(context),
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
  return rows.map((row, i) => {
    const perceivers: RawOccurrence["perceivers"] = [...actorsOf(row)].map(
      (characterId) => ({ characterId, sight: "clear", hearing: "clear" })
    );
    for (const c of others(row)) {
      const grades = {
        sight: topGrade(result.answers.get(`sight:${i}:${c.id}`), SIGHT_ORDER),
        hearing: topGrade(
          result.answers.get(`hearing:${i}:${c.id}`),
          HEARING_ORDER
        ),
      };
      if (perceivesAnything(grades)) {
        perceivers.push({ characterId: c.id, ...grades });
      }
    }
    return { ...row, perceivers };
  });
}

/**
 * The model wrote the rows (DECISIONS_PERCEIVERS=on): give every row still
 * without perceivers its audience from Decisions, then drop any sanity check
 * on someone who does not perceive that row's source — exposure is
 * perception. Null when Decisions could not answer.
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
  return filled.map(keepSourcedSanityChecks);
}

function keepSourcedSanityChecks(row: RawOccurrence): RawOccurrence {
  const checks = (row as { sanityChecks?: Array<{ characterId?: string }> })
    .sanityChecks;
  if (!Array.isArray(checks) || checks.length === 0) return row;
  const sourced = new Set(
    (row.perceivers ?? []).filter(perceivesSource).map((p) => p.characterId)
  );
  return {
    ...row,
    sanityChecks: checks.filter(
      (c) => typeof c.characterId === "string" && sourced.has(c.characterId)
    ),
  } as RawOccurrence;
}

/** The most probable grade, as it is (design §6.5); "none" when there is no
 *  answer. `order` runs from "none" to the clearest grade. There used to be
 *  two leans toward perceiving — "none" needed 0.7, and two close adjacent
 *  grades took the clearer — and both pushed people out of earshot into a
 *  faint trace (someone 120 m away "heard" a question asked at a door,
 *  2026-11-18); removed. */
export function topGrade<G extends string>(
  answer: DecisionAnswer | undefined,
  order: readonly G[]
): G {
  const probs = answer?.probabilities ?? {};
  let best = order[0];
  for (const g of order) {
    if ((probs[g] ?? 0) > (probs[best] ?? 0)) best = g;
  }
  return best;
}
