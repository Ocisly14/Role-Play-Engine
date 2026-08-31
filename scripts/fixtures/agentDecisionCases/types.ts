// scripts/fixtures/agentDecisionCases/types.ts
//
// Shared shapes for the case table. See index.ts for the authoring rules.

import type { NpcMemoryType } from "@prisma/client";

export type ScenarioGroup = "tool" | "core" | "skill" | "multi" | "world";

/** Props the harness can inject. Ids are assigned per case. */
export type PropKey =
  | "notebook"
  | "symbol"
  | "lockpick"
  | "pistol"
  | "kit"
  | "key"
  | "watch";

export interface CaseActor {
  /** NPC id from ACTOR_ROSTER. The FIRST actor is the protagonist the case is
   *  staged around (default scene, report ordering). */
  npc: string;
  /** Seeded as long_term_intent; this is what the NPC is trying to do. */
  goal: string;
  hp?: number;
  san?: number;
  /** Character conditions, e.g. "左腿动脉出血，正在快速失血". */
  conditions?: string[];
  /** Props placed in this NPC's inventory. */
  items?: PropKey[];
  /** Written on an earlier day. Memory is injected whole, so these reach the
   *  prompt like any other. */
  recallSeeds?: Array<{ type: NpcMemoryType; content: string; date: string }>;
  /** Shows up in "## Today's memories" from the first decision on. */
  todayMemories?: Array<{
    type: "general" | "plan" | "secret" | "relationship";
    content: string;
  }>;
}

export interface SimCase {
  label: string;
  /** In-world minutes to run. Default 3: tick1 decide+submit, tick2 resolve,
   *  tick3 react to the result. Give travel and tracking more. */
  ticks?: number;
  /** Scene-name hint (substring, case-insensitive). Default: the
   *  protagonist's own scene from the module. */
  scene?: string;
  actors: CaseActor[];
  sceneItems?: PropKey[];
  sceneConditions?: string[];
  /** Perceptible trigger injected on tick 1 — for stimuli no static state can
   *  express ("货架塌下来了"). Impact: 1=targeted 2=same scene 3=building. */
  openingEvent?: {
    description: string;
    impact?: 0 | 1 | 2 | 3 | 4 | 5;
    by?: string;
    /** Ticks to wait before the trigger lands (default 0 = tick 1). */
    afterTicks?: number;
    /** Real state damage the event inflicts when it lands (deltas negative
     *  for harm), applied through the scripted-event runner — the same path a
     *  module's own hazards take. Without this, "货架塌了" is only ever a
     *  perception; with it, the world actually hits back. */
    harm?: {
      target: string;
      hp?: number;
      san?: number;
      conditions?: string[];
    };
  };
}

export interface SimScenario {
  id: string;
  group: ScenarioGroup;
  title: string;
  /** NON-grading metadata: the definitions this staging is designed to
   *  exercise. Used only to skip auto-generated scenarios under --full and
   *  for the lint's tick-budget hint — never to judge a case. */
  targetDefs?: string[];
  cases: SimCase[];
}
