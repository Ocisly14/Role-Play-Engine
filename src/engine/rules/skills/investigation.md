---
id: investigation
title: "Investigation"
description: "Notice, listen for, research, follow, and connect evidence or clues."
durationGuidance:
  default: 5
  range: "1-120"
  notes: "a glance across a room or an overheard fragment 1-3 min; a focused search of a desk or a fresh trail 5-10 min; a cold trail, a shadowing run, or a thorough archive trawl 30-120 min"
---

# Investigation guidance

Use for noticing, searching, listening, following, and looking things
up. This domain finds evidence already supported by the world. What the actor can find
is limited to what is actually there.

## Applicability

- Accepted for perception checks, deliberate searches, eavesdropping,
  tracking and shadowing, and research through records the actor can reach.
- Rejected for interpreting what is found once it is in hand — that is
  Knowledge & Craft, Science & Nature, or Occult by subject.
- Nothing is found that the world does not hold. An adequately searched, explicitly empty area can yield an absence.
  Missing detail in the input or a failed search is only a limit on the finding,
  not proof that the room contains nothing.
- Questions put to a person and attempts to read their sincerity are
  interpersonal actions without a check. Deliver the question through speech.
  Any answer comes from the other person's own action, and the observer
  interprets the behavior they perceive.

## Success levels

- **Regular** — The obvious is found: the object present, the fragment of
  conversation, the direction the trail runs.
- **Hard** — The concealed is found, or the detail that distinguishes it: the
  compartment, the name inside the overheard sentence, how old the tracks are.
- **Extreme** — The search exposes a subtle supported relationship between
  existing clues. Distinguish an inference from a finding; do not invent a
  removed object, hidden compartment or missing conversation to reward the roll.

## Failure

- Nothing found this attempt. The evidence may still be present; the actor
  simply did not get it, and a repeat search of the same ground costs the same
  time again for no better odds unless something changed.
- **Fumble** — The actor disturbs what they were examining or exposes
  their search: tracks trampled, a document torn, a sound from cover. Route
  the evidence by actual sensory access; do not assert that a target recognized
  a pursuer, chose to look back or raised an alarm.

## Output shape

Watching another actor never executes that actor's pending command. Use
only established evidence for any checked discovery. It cannot manufacture
conversation, an answer, chosen silence or completion of another task.
Routine unchecked watching receives events through their ordinary perceiver
routing and ends with no_change if there is no new result. Do not summarize
what the observer experienced over the interval. For a checked search, settle
the objective result and route any actually exposed evidence; do not write
the searcher's conclusion or a retrospective room narrative.

Put findings in objective occurrence `content` and cite the source action in
`actionIds`. Do NOT write what the character concluded or remembered — the
character decides that for itself.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is occurrence
`content`, not a state change.

- Usually NOTHING. What was found is occurrence `content` with the searcher
  at the supported clarity. Nearby observers may see the search without learning
  its finding; private knowledge does not require an item to be globally revealed.
- `item.move` — something picked up, pocketed, or shifted while looking.
- `scene.addCondition` — the room is visibly searched, the trail is trampled,
  a drawer is left open for the next person to notice.
- `character.position` — following or shadowing actually moved the actor.
