// src/roleSim/toolSkills/continueSkill.ts

export const continueSkill = `---
name: continue
description: Keep doing your current action / let time pass. Terminates this decision.
---

# continue

Don't start anything new. If you have an in-flight action, let it keep running. If you're idle, let the tick pass.

## When to use
- Your current action is still right — nothing has changed enough to warrant switching
- You're idle and have nothing meaningful to do this tick (resting, waiting, observing passively)
- Things just happened around you, but they don't actually demand a reaction from someone like you

## When NOT to use
- You want to start a new action — use \`act\`
- You want to reflect / record something — use \`writeMemory\` (then loop back to \`continue\` or \`act\` to terminate)

## Usage
{ "tool": "continue", "reason": "<optional one-line justification>" }

- \`reason\`: optional. One sentence explaining why you're continuing. Useful for debugging your own decisions.

## Examples

You're already walking to the library and the trigger event was distant:
{ "tool": "continue", "reason": "still heading to the library; the noise was outside" }

Idle, nothing to do:
{ "tool": "continue" }
`;
