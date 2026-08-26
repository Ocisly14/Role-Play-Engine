// src/roleSim/tools/act.ts

export const actDoc = `---
name: act
description: Declare the ONE thing you now set out to do in the world. Terminates this decision (consumes a tick).
---

# act

Declare what you now set out to do. You express INTENT — what you attempt,
with what, on whom, roughly how long you expect it to take. The world engine
alone decides what actually happens: whether you succeed, how long it truly
takes, how others react, what gets damaged. Never narrate outcomes as facts.

## Fields

- \`description\` (required): one or two sentences, in-character, describing
  the action you undertake. Open-ended and composite actions are fine
  ("I wedge the crowbar under the lid while keeping my voice low to calm
  the boy"). Describe your attempt and manner — NOT its result. Wrong:
  "I pick the lock open." Right: "I try to pick the lock with my picks."
- \`objectRefs\` (required, may be empty \`[]\`): the entities your action
  involves, as structured references:
  \`{ "kind": "character"|"item"|"scene", "id": "<id>", "role"?: "target"|"tool"|"destination"|"recipient" }\`
  - \`id\` MUST come from this tick's perception (it lists every id you may
    cite). Inventing an id gets the action rejected.
  - \`role\` says how YOU use the entity: \`target\` (acted upon),
    \`tool\` (used to act), \`destination\` (moved toward),
    \`recipient\` (given/told something).
- \`proposedDurationTicks\` (required): how many ticks (1 tick = 1 in-world
  minute) you expect or are willing to invest. This is YOUR estimate only —
  the engine sets the real duration and may shorten or extend it.
- \`skillId\` (optional): the skill you consciously bring to bear, by its
  exact name from the Skill catalog section of this prompt (e.g.
  "Locksmith", "Persuade"). The catalog descriptions tell you what each
  skill covers. Declare it ONLY when the action genuinely runs through that
  skill. Never pick an unrelated high skill for advantage — the engine
  checks whether the skill fits and an unfitting skill gives no benefit.
  You never supply values, difficulties or rolls.
- \`utterance\` (optional): the EXACT words you speak, verbatim, in your
  character's voice. Omit when you say nothing. Paraphrase goes in
  \`description\`; the literal line goes here.

## Granularity

One \`act\` = one coherent undertaking, from a single glance up to a long
task (search a room, walk across town, repair an engine). Don't slice an
undertaking into per-minute fragments — declare it once with an honest
\`proposedDurationTicks\` and let it run; the engine advances it and tells
you when it ends or when something interrupts.

A pure body-language twitch (clearing your throat, shifting weight) is not
an act — fold it into your next real action's description, or \`continue\`.

## In-flight actions

Calling \`act\` while an action is in flight REPLACES it: the engine
resolves the interruption of the old action (keeping partial progress) and
the start of the new one together. You never need to cancel first.

## Names vs ids

- \`description\`/\`utterance\` are your in-character voice: use only names
  you actually know in-game. If perception calls a stranger "the tall pale
  man", call them that.
- \`objectRefs.id\` is the system handle. An id may "leak" a canonical name
  (e.g. \`Hollins\`); that is meta-knowledge and must NOT surface in your
  in-character wording.

## Examples

\`act\` is a function call — you invoke the tool with these arguments (no
wrapper object, no "tool" field).

Try a lock with a skill and a tool:
act({
  "description": "I kneel at the cabinet and work the lock with my picks, listening for the tumblers.",
  "objectRefs": [
    { "kind": "item", "id": "cabinet_lock", "role": "target" },
    { "kind": "item", "id": "ITEM_SCN2_7", "role": "tool" }
  ],
  "proposedDurationTicks": 3,
  "skillId": "Locksmith"
})

Speak to someone present:
act({
  "description": "I lean toward the tall pale man and press him quietly about tonight's discovery.",
  "objectRefs": [ { "kind": "character", "id": "Hollins", "role": "target" } ],
  "proposedDurationTicks": 1,
  "utterance": "今晚到底发现了什么？地点和通报人？"
})

Head somewhere:
act({
  "description": "I set off through the drizzle toward the library, keeping to the lit side of the street.",
  "objectRefs": [ { "kind": "scene", "id": "SCN_LIBRARY", "role": "destination" } ],
  "proposedDurationTicks": 12
})
`;
