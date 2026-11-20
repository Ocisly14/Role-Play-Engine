// src/engine/rules/ruleTerms.ts
//
// The engine's shared definitions, written once. Several readers judge or
// write against the same terms — the LLM settlement (its tool schemas, phase
// instructions and rule documents), the Decisions fast paths, the validators'
// feedback — and each used to carry its own hand-written wording, which had
// already drifted ("a new objective result" in one place, "a new observable
// result" in another). Every TypeScript reader now prints these strings; the
// rule documents are prose and cannot import them, so
// `__tests__/ruleTerms.test.ts` pins them to the same words.
//
// A definition says what a term IS. It carries no examples and no hints about
// when to choose it — that judgement belongs to whoever is asked.

import type { EndingDecision } from "../resolution/worldResolutionStageSchemas.js";

type EndingMode = EndingDecision["mode"];

/** What each ending mode means. */
export const ENDING_MODE_MEANING: Readonly<Record<EndingMode, string>> = {
  outcome:
    "the action leaves a new objective result; a checked attempt always ends this way",
  pure_speech:
    "an unchecked action that is only its words; code delivers the words verbatim",
  no_change:
    "an unchecked action without words that leaves no new objective result",
};

/** The three modes on one line, in their fixed order. */
export function renderEndingModes(): string {
  return (["outcome", "pure_speech", "no_change"] as const)
    .map((m) => `\`${m}\` — ${ENDING_MODE_MEANING[m]}`)
    .join("; ");
}

/** How long an attempt takes when it speaks. */
export const TALK_DURATION_RULE =
  "Words alone take 1 minute; an action that also does something takes the minutes of what it does, whatever is said while doing it.";

/** What a travel route is. */
export const STATED_ROUTE_RULE =
  "The route is the way the actor's own words state, as ordered place ids — never a leg they did not state.";

/** What the Surroundings section is. */
export const SURROUNDINGS_MEANING =
  "From each place where an action being settled took place: where every living character stands and how far — `meters` is the straight line between the two places' points, through walls, floors and ground alike (0 is the same place); where a place has no point, `walkMinutes` is the walking time by the ways that join them instead (null is not joined). The places they stand in follow; doors, windows and walls are in the descriptions, on either side.";

/** When an attempt is checked at all. */
export const CHECK_NEED_RULE =
  "A check is only for an attempt whose success is genuinely in doubt and that the declared skill covers; an attempt that will very likely succeed, or has no real difficulty, takes no check.";

/** What an item's placement is. */
export const ITEM_PLACEMENT_MEANING =
  'placement: where the thing is within the place, as a short phrase ("beside the till", "in the till drawer"). Required for every item put down at a place; a fixture the place\'s setting cites has none.';

/** What an item's container is. */
export const ITEM_CONTAINER_MEANING =
  "container: the id of the item it sits inside, under or behind, when that item can hide it (a drawer, a closed cabinet, a suitcase, a mattress). Whether it can be seen is that container's own description — open or shut, clear or solid, which way it faces. An open shelf, a knife block or a tray hides nothing and is never a container.";
