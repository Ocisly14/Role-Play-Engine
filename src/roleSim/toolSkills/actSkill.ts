// src/roleSim/toolSkills/actSkill.ts

export const actSkill = `---
name: act
description: Take a single short physical action in the world. Terminates this decision (consumes a tick).
---

# act

Take ONE short atomic action: move, speak, examine, attack, hide, work, etc.
This consumes a tick — calling \`act\` ends the current decision.

## Action duration: short atomic only

Each \`act\` is one short action that fits within the next tick (~1 game minute).

Multi-step intentions (e.g. "go to the harbor and find Smith") MUST be broken
into multiple decisions across multiple ticks:

  Tick 1: act "leave through the front door"
  Tick 2: act "head down Lane Street toward [Harbor]"
  Tick 3: act "enter [Harbor]"
  Tick 4: now I see Smith → act "approach [Smith]"

Do NOT submit \`act\` for actions that span multiple minutes (e.g. "search the
warehouse thoroughly", "spend the afternoon reading"). Decompose into shorter
observable actions.

## When to use
- You want to start something new and meaningful
- Something just happened and you want to react with a new action
- Your current action is no longer right (calling \`act\` while in-flight CANCELS it and starts new)
- Idle and you've decided what to do next

## When NOT to use
- Your current action is fine — use \`continue\`
- You just want to "think more" — use \`recallMemory\` or \`writeMemory\` (they don't consume a tick)
- The action is purely internal (forming a belief, planning) — use \`writeMemory\`

## Citation syntax for entity references

When your action involves a specific named entity (person, item, scene), you
MUST wrap its name in square brackets, copying the EXACT name as it appears in
the [references] block of your perception narrative:

  Person  → [Smith]                       (KNOWN: canonical name from references)
  Person  → [the gaunt man]               (UNKNOWN: description identifier from references)
  Item    → [the bound ledger]
  Scene   → [Library], [Harbor]

The engine parses brackets to resolve targets. Names must match the references
block exactly — no abbreviation, no fuzzy matching. Cite only entities that
appear in this tick's references block.

## Output
{ "tool": "act", "actionText": "<one sentence with bracketed citations where applicable>" }

## Examples

You see Smith and want to confront him about a letter:
{ "tool": "act", "actionText": "confront [Smith] about [the letter]" }

You're alone and want to leave (no specific entity referenced):
{ "tool": "act", "actionText": "head out the door" }

You see an unknown person in the room and want to greet them:
{ "tool": "act", "actionText": "greet [the gaunt man]" }

You're in the middle of reading and a fire breaks out — interrupt and flee:
{ "tool": "act", "actionText": "drop the book and run for the exit" }

You hand a letter to Smith:
{ "tool": "act", "actionText": "hand [the bound ledger] to [Smith]" }

You move toward an adjacent scene:
{ "tool": "act", "actionText": "walk into [Harbor]" }
`;
