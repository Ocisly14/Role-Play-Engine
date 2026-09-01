// src/roleSim/tools/continue.ts

export const continueDoc = `---
name: continue
description: Keep your IN-FLIGHT action running. Terminates this decision.
---

# continue

Don't start anything new: let your current in-flight action keep running.

\`continue\` continues an ACTION, not a mood. If the situation shows no
"Currently doing" section, you have no action running — you are standing
there doing literally nothing, and \`continue\` keeps it that way.

## When to use
- Your current in-flight action is still right — nothing has changed enough to warrant switching
- Things just happened around you, but your in-flight action already is the right response
- You are idle and genuinely intend to do NOTHING observable this tick (rare — see below)


## Examples

You're already walking to the library and the trigger event was distant:
continue({ "reason": "still heading to the library; the noise was outside" })

A shopkeeper who wants to tend the counter on a quiet morning has no action
to continue — tending the counter is something they take up, so it is \`act\`
that does it. \`continue\` only carries on what is already running.

Idle and deliberately motionless (rare, e.g. hiding frozen in a closet):
continue({ "reason": "staying perfectly still until the footsteps pass" })
`;
