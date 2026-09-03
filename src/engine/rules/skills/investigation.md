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
up. This is the domain that turns a scene into facts. What the actor can find
is limited to what is actually there.

## Applicability

- Accepted for perception checks, deliberate searches, eavesdropping,
  tracking and shadowing, and research through records the actor can reach.
- Rejected for interpreting what is found once it is in hand — that is
  Knowledge & Craft, Science & Nature, or Occult by subject.
- Nothing is found that the world does not hold. A success against an empty
  room correctly returns the absence, and the absence is itself a fact worth
  emitting.
- When the search is a QUESTION put to a person — reading how much they saw,
  drawing out what they know — the finding is not yours to write. A met
  check is carried to that person by code as pressure before they decide;
  what they let slip, if anything, is their own next command. Your facts
  describe the asking, never the answer.

## Success levels

- **Regular** — The obvious is found: the object present, the fragment of
  conversation, the direction the trail runs.
- **Hard** — The concealed is found, or the detail that distinguishes it: the
  compartment, the name inside the overheard sentence, how old the tracks are.
- **Extreme** — The actor also gets the connection — the two facts that only
  mean something together, the thing that was removed rather than never there.

## Failure

- Nothing found this attempt. The evidence may still be present; the actor
  simply did not get it, and a repeat search of the same ground costs the same
  time again for no better odds unless something changed.
- **Fumble** — The actor disturbs what they were examining or is noticed doing
  it: tracks trampled, a document torn, a shadowed target now aware they are
  followed. Emit that as an occurrence others can perceive.

## Output shape

Findings are objective occurrence facts with real ids. Do NOT write what the
character concluded or remembered — the character decides that for itself.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is an occurrence
fact, not a state change.

- Usually NOTHING. What was found is an occurrence fact with real ids and the
  searcher as perceiver — that is the whole output of a successful search.
- `item.move` — something picked up, pocketed, or shifted while looking.
- `scene.addCondition` — the room is visibly searched, the trail is trampled,
  a drawer is left open for the next person to notice.
- `character.position` — following or shadowing actually moved the actor.
