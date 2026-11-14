// src/roleSim/tools/act.ts

export const actDoc = `---
name: act
description: Declare ONE atomic action you now attempt in the world. Terminates this decision (consumes a tick).
---

# act

Declare what you now set out to do. You express INTENT — what you attempt,
with what, on whom, roughly how long you expect it to take. The world engine
alone decides what actually happens: whether you succeed, how long it truly
takes and what physical effects follow. Other people choose their own
responses; neither your command nor your skill chooses their speech or beliefs.
Never narrate outcomes as facts.

## Fields

- \`description\` (required): one or two sentences, in-character, describing
  ONE action with one immediate objective and an independently settleable
  result. Do not bundle a sequence of separately completable tasks under a
  common goal. Incidental manner or posture can accompany the attempt
  ("I brace myself and work the crowbar against this lid"); a separate
  move, transfer, speech exchange or subsequent watch needs its own act.
  Describe your attempt and manner — NOT its result. Wrong:
  "I pick the lock open." Right: "I try to pick the lock with my picks."
  When you travel, SAY YOUR ROUTE through the places you know ("out to the
  street, north to the crossroads, up the lane to the house") — the world
  walks you exactly as far as the route you state. Naming only a distant
  destination gets you only as far as your words carry; what you cannot
  describe, you do not know the way to.
  To DRIVE a vehicle you must already be inside it when driving starts.
  If outside, first declare boarding; after it resolves, declare driving with
  your route. Stepping out at the far end is another action.
- \`objectRefs\` (required, may be empty \`[]\`): the entities your action
  involves, as structured references: \`{ "id": "<id>" }\`
  - \`id\` MUST be a bracketed tag from what you perceive this tick, copied
    exactly and without its brackets. Something you perceive with no tag is
    something you cannot act on this minute. **Never invent an id**
  - How you use each one belongs in \`description\`, not here.
- \`proposedDurationTicks\` (required): how many ticks (1 tick = 1 in-world
  minute) you expect or are willing to invest in THIS one action, not the
  total time of a future plan. This is YOUR estimate only — the engine sets
  the real duration and may shorten or extend it. Atomic does not mean one tick.
- \`skillId\` (optional): the skill you consciously bring to bear, chosen
  from the list the tool offers.
  Declare it for tasks such as moving unseen, forcing a lock, translating
  a document or landing a blow. For persuasion, questioning, deception,
  intimidation, negotiation and reading people, describe your approach and
  omit \`skillId\`.
  You can still declare it even when you are poor at it. Ordinary attempts spend
  time and real resources; a fumble can cause additional harm, and independently
  established hazards still apply. What you must not do is reach for an
  unrelated skill: the engine judges whether the
  skill fits what you actually described, and one that does not fit grants
  nothing.
- \`language\` (only with \`skillId: "Languages"\`): which tongue you are
  reading or speaking. "Languages" is a domain, not one number — name the
  language exactly as it is listed under **What you can do**. The tongues you
  grew up in need no Languages declaration.
- \`utterance\` (optional): the EXACT words you intend to say, verbatim, in your
  character's voice. They are delivered when this action ends, not when you
  submit it. Omit when silent; a paraphrase in \`description\` alone delivers
  no speech. A later reply based on something you have not yet heard is a
  future decision, not part of this utterance. A brief remark may accompany
  this same action only if delivery at its END is intended. If the words must
  precede work or a long watch, submit the speech first as its own short act.

## Granularity

One \`act\` = one atomic action: one immediate objective that can be settled
independently. You choose the boundary when submitting. Do not submit a large
plan and expect the engine to split it into actions or execute its later parts.
After this action ends, read the new perception and choose the next action.

Split at an independently meaningful result, a new task, a prerequisite that
must finish first, or a response you have not heard yet. Sharing a larger goal,
a scene or a sentence does not make several tasks one action. "Then", "while"
and "and" are not tests by themselves: use the actual dependencies and results.

Examples of sequences to submit ONE action at a time:
- "Thank Owen, make a bed, then keep watch" → thank Owen now; after it ends,
  decide whether to lay out the bed; only after that decide whether to watch.
- "Check the windows and doors, fetch wood, then feed the fire" → choose the
  next specific inspection or handling task now. Do not submit the whole round.
- "Sit beside Abby, take food, and watch the strangers for three minutes" →
  take the next necessary physical action first. Once situated, submit the
  watch separately if it is still what you want to do.
- "Wait, and if nobody comes, return to my room" → wait now. Whether to return
  is a later decision after you see what happened.
These are examples of decisions, not pre-authorized queues of future actions.

Atomic does NOT mean one minute, one verb or a separate call for each hand
motion. A single lock-picking attempt, dressing one wound, examining one drawer,
walking a stated route or maintaining a watch may span several ticks. Give
that one action an honest \`proposedDurationTicks\`; keep it running with
\`continue\`. Do not reissue it every minute or split it into meaningless
motions. Travel follows the route you state; boarding before driving and a
task after arrival are separate actions.

An incidental gesture (clearing your throat, shifting weight) can accompany
your real action. It does not justify inserting another objective or assuming
another person's response. A short remark may accompany the same task if its
words should arrive at completion. An announcement needed before a long task
must be spoken in a preceding act; attaching it to a 90-minute watch withholds
the words until the watch ends.

## In-flight actions

Calling \`act\` while an action is in flight interrupts it and starts a
replacement. Only established partial effects remain; the unfinished goal
is not automatically completed or transferred. Use \`continue\` to keep
working instead of reissuing the same action. The completion of one action
never automatically starts a later task from your plan. Choose that next act
from the perception you receive after completion.

## Names vs ids

- \`description\`/\`utterance\` are your in-character voice: use only names
  you actually know in-game. If perception calls a stranger "the tall pale
  man", call them that.
- \`objectRefs.id\` is the system handle for the same thing: the tag you
  read in the narrative. Someone you know is tagged by their own id; an alias that means nothing on its own
  — the words it sits beside are what tell you which person it is. Either way
  it belongs in \`objectRefs\` and never in your prose.

## Examples

Try a lock with a skill and a tool:
act({
  "description": "I kneel at the cabinet and work the lock with my picks, listening for the tumblers.",
  "objectRefs": [
    { "id": "item.clinic_exam.cabinet" },
    { "id": "item.susan.nurse_bag" }
  ],
  "proposedDurationTicks": 3,
  "skillId": "Stealth & Security"
})

Speak to someone present:
act({
  "description": "I lean toward the tall pale man and press him quietly about what was found at the harbour.",
  "objectRefs": [ { "id": "stranger_a" } ],
  "proposedDurationTicks": 1,
  "utterance": "今晚到底发现了什么？地点和通报人？"
})

Head somewhere:
act({
  "description": "I set off through the drizzle toward the clinic, keeping to the lit side of the street.",
  "objectRefs": [ { "id": "SCN_clinic_waiting" } ],
  "proposedDurationTicks": 12
})
`;
