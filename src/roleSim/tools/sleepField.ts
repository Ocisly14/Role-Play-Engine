// src/roleSim/tools/sleepField.ts
//
// The one field the player character's `act` has and nobody else's does. The
// engine has no "sleeping" state and no action types, so going to sleep is an
// ordinary act the character marks as such; the mark is what autosave keys
// off. NPC `act` never carries it, so NPC prompts are unaffected.

export const sleepFieldDoc = `---
name: act.sleep
description: Mark an act that is you going to sleep.
---

# act: \`sleep\`

Your \`act\` takes one more optional field, \`sleep\` (boolean).

Set \`sleep: true\` only when this action IS you going to sleep — settling
down to sleep, lying down for the night. Leave it out for everything else,
including resting, sitting quietly or waiting with your eyes shut.`;

/** Field-level text for the schema property; the prose above is the guidance. */
export const SLEEP_FIELD_DESCRIPTION =
  "Optional: true only when this action is you going to sleep (settling down to sleep, lying down for the night). Omit for everything else, including resting or waiting.";
