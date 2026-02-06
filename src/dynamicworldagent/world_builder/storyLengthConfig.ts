/**
 * Story Length Config
 * Short / Medium / Long module scale: target counts and template guidance
 * Short: scenarios + NPCs ~10; Medium ~15; Long 20+
 */

export type StoryLength = "short" | "medium" | "long";

export interface StoryLengthConfig {
  /** Display label */
  label: string;
  /** Target total (scenarios + NPCs), approximate range */
  targetTotal: string;
  /** Target scenarios, approximate range */
  targetScenarios: string;
  /** Truth events count range */
  truthEventsRange: string;
  /** Key locations count range */
  keyLocationsRange: string;
  /** Knowledge matrix PLACE holders (map to scenarios) */
  placeHoldersRange: string;
  /** ROLE + ORGANIZATION holders combined, approximate range (1–2 NPCs per holder) */
  roleOrgHoldersRange: string;
  /** Red herrings count range */
  redHerringsRange: string;
}

const SHORT_CONFIG: StoryLengthConfig = {
  label: "Short Story",
  targetTotal: "10-15",
  targetScenarios: "5-7",
  truthEventsRange: "3-5",
  keyLocationsRange: "3-4",
  placeHoldersRange: "3-5",
  roleOrgHoldersRange: "5-7",
  redHerringsRange: "1-2",
};

const MEDIUM_CONFIG: StoryLengthConfig = {
  label: "Medium Story",
  targetTotal: "15-20",
  targetScenarios: "9-12",
  truthEventsRange: "5-8",
  keyLocationsRange: "5-7",
  placeHoldersRange: "6-8",
  roleOrgHoldersRange: "7-12",
  redHerringsRange: "2-4",
};

const LONG_CONFIG: StoryLengthConfig = {
  label: "Long Story",
  targetTotal: "20+",
  targetScenarios: "10-15",
  truthEventsRange: "8-12",
  keyLocationsRange: "8-12",
  placeHoldersRange: "9-12",
  roleOrgHoldersRange: "10-15",
  redHerringsRange: "3-5",
};

export function getStoryLengthConfig(length: StoryLength): StoryLengthConfig {
  switch (length) {
    case "short":
      return SHORT_CONFIG;
    case "medium":
      return MEDIUM_CONFIG;
    case "long":
      return LONG_CONFIG;
    default:
      return MEDIUM_CONFIG;
  }
}

/** For Macro Step 1: key locations count guidance */
export function getStoryLengthMacroGuidance(length: StoryLength): string {
  const c = getStoryLengthConfig(length);
  return `
### Module scale (story length): ${c.label}
- **Target total (scenarios + NPCs)**: about **${c.targetTotal}** (this module is ${c.label})
- **Key Locations**: Generate **${c.keyLocationsRange}** key locations that will serve as the scenario skeleton; keep total scale so scenarios + NPCs sum to about ${c.targetTotal}.
`.trim();
}

/** For Truth Timeline: truth events count sentence */
export function getStoryLengthTruthEventsSentence(length: StoryLength): string {
  const c = getStoryLengthConfig(length);
  return `Generate ${c.truthEventsRange} truth events that form the objective reality of CURRENT/RECENT events in this scenario.`;
}

/** For Knowledge Matrix: PLACE/ROLE count guidance */
export function getStoryLengthKnowledgeMatrixGuidance(
  length: StoryLength
): string {
  const c = getStoryLengthConfig(length);
  return `
### Module scale (story length): ${c.label}
- **Target total (scenarios + NPCs)**: about **${c.targetTotal}** (scenarios ${c.targetScenarios}, ROLE+ORGANIZATION holders ${c.roleOrgHoldersRange})
- **PLACE holders (scenarios)**: Generate about **${c.placeHoldersRange}** PLACE-type holders; each PLACE maps to one scenario
- **ROLE + ORGANIZATION holders (combined)**: Generate about **${c.roleOrgHoldersRange}** ROLE or ORGANIZATION holders in total; each will be instantiated as 1–2 NPCs later
- Keep total scale so scenarios + NPCs sum to about ${c.targetTotal} (${c.label})
`.trim();
}

/** For Red Herrings */
export function getStoryLengthRedHerringsSentence(length: StoryLength): string {
  const c = getStoryLengthConfig(length);
  return `Generate ${c.redHerringsRange} red herrings that investigators might plausibly believe.`;
}

/** For Scenario Builder: scenario count and total scale */
export function getStoryLengthScenarioGuidance(length: StoryLength): string {
  const c = getStoryLengthConfig(length);
  return `
### Module scale (story length): ${c.label}
- **Target scenarios**: about **${c.targetScenarios}** scenarios (including connector scenarios)
- **Total (scenarios + NPCs)**: This module aims for **${c.targetTotal}** total; do not over-expand
- Each scenario must correspond to one PLACE holder in the knowledge matrix; you may add a few connector scenarios (streets, corridors, etc.) to link locations
`.trim();
}

/** For NPC Builder: ROLE+ORGANIZATION holder count and total scale */
export function getStoryLengthNpcGuidance(length: StoryLength): string {
  const c = getStoryLengthConfig(length);
  return `
### Module scale (story length): ${c.label}
- **ROLE + ORGANIZATION holders (combined)**: about **${c.roleOrgHoldersRange}** in total; instantiate 1–2 NPCs per holder
- **Total (scenarios + NPCs)**: This module aims for **${c.targetTotal}** total; do not exceed scale
- Instantiate NPCs only from ROLE and ORGANIZATION holders; keep ROLE+ORGANIZATION holder count in the range ${c.roleOrgHoldersRange}
`.trim();
}
