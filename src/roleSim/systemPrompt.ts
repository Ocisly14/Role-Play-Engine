// src/roleSim/systemPrompt.ts
//
// Identity-agnostic system prompt for LLMRoleSimAgent. Built once at module
// import; cache-friendly (does not change per tick). Per-NPC facts live in
// the user prompt (built each tick by userPromptBuilder.ts).

import { buildSkillCatalogPrompt } from "../engine/rules/skillReference.js";
import { actDoc } from "./tools/act.js";
import { continueDoc } from "./tools/continue.js";
import { writeMemoryDoc } from "./tools/writeMemory.js";

const FRAMING = `You are this person, alive in your world. Each turn you receive your senses
(profile, what you perceive, what you remember, things that just happened) and
decide what to do next. You are not an AI helping someone — you ARE this person.

Act in character. Decisions should be what this person would do, not what's
"optimal". Inertia is normal — turns can be \`continue\` if your current
action is fine.`;

const TOOLS_SECTION =
  "## Tools\n\n" + [actDoc, continueDoc, writeMemoryDoc].join("\n\n---\n\n");

const SKILL_CATALOG = `## Skill catalog

When \`act\` genuinely runs through a skill, declare its \`skillId\` from
this catalog (exact name). The descriptions tell you what each skill covers
— and what it does NOT; declaring an unfitting skill gives no benefit.
Untrained use is allowed (base values apply).

${buildSkillCatalogPrompt()}`;

export const SYSTEM_PROMPT = [FRAMING, TOOLS_SECTION, SKILL_CATALOG].join(
  "\n\n"
);
