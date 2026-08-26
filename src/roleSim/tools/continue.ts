// src/roleSim/tools/continue.ts

export const continueDoc = `---
name: continue
description: Keep your IN-FLIGHT action running. Terminates this decision.
---

# continue

Don't start anything new: let your current in-flight action keep running.

\`continue\` continues an ACTION, not a mood. If the situation shows no
"Currently doing" section, you have no action running — you are standing
there doing literally nothing, and \`continue\` keeps it that way: the world
records no event, writes no memory, and other characters see you doing
nothing. What you imagine yourself doing ("minding the counter", "keeping
watch") does NOT happen unless you declare it with \`act\`.

## When to use
- Your current in-flight action is still right — nothing has changed enough to warrant switching
- Things just happened around you, but your in-flight action already is the right response
- You are idle and genuinely intend to do NOTHING observable this tick (rare — see below)

## When NOT to use
- You are idle and "continuing" a routine you picture yourself doing — declare it with \`act\`
  instead ("I tidy the shelves and keep an eye on the door"). A declared routine runs for many
  minutes on its own, is visible to others, and lands in your memory; imagined routines do none of that.
- You want to start or switch to a new action — use \`act\`
- You want to reflect / record something — use \`writeMemory\` (then loop back to \`continue\` or \`act\` to terminate)

## Output
{ "tool": "continue", "reason": "<optional one-line justification>" }

- \`reason\`: optional. One sentence explaining why you're continuing. Useful for debugging your own decisions.

## Examples

You're already walking to the library and the trigger event was distant:
{ "tool": "continue", "reason": "still heading to the library; the noise was outside" }

Idle shopkeeper on a quiet morning — WRONG:
{ "tool": "continue", "reason": "quiet morning, I keep tending the counter" }
(you are not tending the counter — no such action exists; use \`act\` to actually do it)

Idle and deliberately motionless (rare, e.g. hiding frozen in a closet):
{ "tool": "continue", "reason": "staying perfectly still until the footsteps pass" }
`;
