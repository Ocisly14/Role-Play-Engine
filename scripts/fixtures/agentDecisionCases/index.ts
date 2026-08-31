// scripts/fixtures/agentDecisionCases/index.ts
//
// Case table for scripts/test-agent-decisions.ts, split by scenario group:
//
//   types.ts  — SimScenario / SimCase / CaseActor / PropKey
//   roster.ts — the 14-NPC actor roster
//   tool.ts   — LAYER 1: agent tools (act · continue · recall · write · map)
//   core.ts   — LAYER 2: core engine action definitions
//   skill.ts  — LAYER 2: skills, five personas per skill
//   multi.ts  — LAYER 3: multi-NPC topology (standoffs, moving together, chases)
//   world.ts  — LAYER 3: world coupling (scene destruction, harm, SAN shocks)
//
// Shape: SCENARIO (one target decision) → 5 CASES. A case is a STAGED SCENE,
// not a canned prompt: it names the scene, the NPCs standing in it, what each
// of them wants, the props on the table, what is wrong with the room, and
// (when the stimulus is something that has to *happen*) an opening event
// injected on tick 1. Then the real tick pipeline runs for a few in-world
// minutes and we look at what the NPCs actually did.
//
// Running the same target decision across five very different personas is the
// point: it separates "the agent understood the situation" from "the agent
// pattern-matched one situation", and shows which personas refuse the obvious
// action in character (a 24-year-old florist really should not answer a knife
// with `pistol`).
//
// NO GRADING. Cases carry no expectations and the harness renders no verdicts —
// each run produces an objective per-case record (tools, definitions, dice,
// positions, HP/SAN, items, scene conditions, memories) for a human to read.
// The only per-scenario metadata is `targetDefs`, which merely names the
// definitions the staging is designed to exercise (used for --full dedup and
// the lint's tick-budget hint).
//
// Goals reach the NPC as a `long_term_intent` memory — the production path.
// {{destName}} / {{destId}} are substituted with a cross-town building the
// harness picks for that case; {{sceneName}} with the staged scene.

import type { SimScenario } from "./types.js";

import { CORE_SCENARIOS } from "./core.js";
import { MULTI_SCENARIOS } from "./multi.js";
import { SKILL_SCENARIOS } from "./skill.js";
import { TOOL_SCENARIOS } from "./tool.js";
import { WORLD_SCENARIOS } from "./world.js";

export type {
  CaseActor,
  PropKey,
  ScenarioGroup,
  SimCase,
  SimScenario,
} from "./types.js";
export { ACTOR_ROSTER } from "./roster.js";
export {
  CORE_SCENARIOS,
  MULTI_SCENARIOS,
  SKILL_SCENARIOS,
  TOOL_SCENARIOS,
  WORLD_SCENARIOS,
};

/** Every scenario, in report order. */
export const ALL_SCENARIOS: SimScenario[] = [
  ...TOOL_SCENARIOS,
  ...CORE_SCENARIOS,
  ...SKILL_SCENARIOS,
  ...MULTI_SCENARIOS,
  ...WORLD_SCENARIOS,
];
