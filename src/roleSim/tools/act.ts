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
  \`{ "id": "<id>", "role"?: "target"|"tool"|"destination"|"recipient" }\`
  - \`id\` MUST be a bracketed tag from what you perceive this tick, copied
    exactly and without its brackets. Something you perceive with no tag is
    something you cannot act on this minute; inventing an id gets the action
    rejected.
  - \`role\` says how YOU use the entity: \`target\` (acted upon),
    \`tool\` (used to act), \`destination\` (moved toward),
    \`recipient\` (given/told something).
- \`proposedDurationTicks\` (required): how many ticks (1 tick = 1 in-world
  minute) you expect or are willing to invest. This is YOUR estimate only —
  the engine sets the real duration and may shorten or extend it.
- \`skillId\` (optional): the skill you consciously bring to bear, chosen
  from the list the tool offers — the same 17 in the Skill catalog section.
  Declare it whenever your training is what you are relying on: talking
  someone round, moving unseen, forcing a lock, reading a document, landing
  a blow. **Omitting it is a choice with a cost.** An action with no
  declared skill is settled on its own merits — your training counts for
  nothing on it, and cannot be brought to bear afterwards.
  Declare it even when you are poor at it. Missing a check costs you the
  minutes and that particular angle, nothing more; only a genuine fumble
  takes something lasting away. What you must not do is reach for an
  unrelated skill you happen to be good at: the engine judges whether the
  skill fits what you actually described, and one that does not fit grants
  nothing. You never supply values, difficulties or rolls.
- \`language\` (only with \`skillId: "Languages"\`): which tongue you are
  reading or speaking. "Languages" is a domain, not one number — name the
  language exactly as it is listed under **What you can do**. The tongues you
  grew up in are not a skill: to use one, declare no \`skillId\` at all and
  simply speak. A tongue on neither list is one you do not have, and trying is
  not a harder attempt — it is one you cannot make.
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
- \`objectRefs.id\` is the system handle for the same thing: the tag you
  read in the narrative. Someone you know is tagged by their own id; a
  stranger is tagged \`stranger_a\`, an alias that means nothing on its own
  — the words it sits beside are what tell you which person it is. Either way
  it belongs in \`objectRefs\` and never in your prose.

## Examples

Try a lock with a skill and a tool:
act({
  "description": "I kneel at the cabinet and work the lock with my picks, listening for the tumblers.",
  "objectRefs": [
    { "id": "cabinet_lock", "role": "target" },
    { "id": "ITEM_SCN2_7", "role": "tool" }
  ],
  "proposedDurationTicks": 3,
  "skillId": "Stealth & Security"
})

Speak to someone present:
act({
  "description": "I lean toward the tall pale man and press him quietly about tonight's discovery.",
  "objectRefs": [ { "id": "stranger_a", "role": "target" } ],
  "proposedDurationTicks": 1,
  "utterance": "今晚到底发现了什么？地点和通报人？"
})

Head somewhere:
act({
  "description": "I set off through the drizzle toward the library, keeping to the lit side of the street.",
  "objectRefs": [ { "id": "SCN_LIBRARY", "role": "destination" } ],
  "proposedDurationTicks": 12
})
`;
