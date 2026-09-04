# Character Changes

Character changes represent persistent, objective state. Each entry names the
action that caused it with `sourceActionId` and the affected `characterId`.
Momentary description belongs in an occurrence.

## Available operations

- `hp {delta, reason}` — physical injury or healing.
- `fatigue {delta, reason}` — persistent exertion or recovery not already owned
  by a deterministic subsystem.
- `position {position:{type:"scene", sceneId}}` — non-travel displacement only;
  follow `movement-and-position.md`.
- `spot {spot}` — position within the current place.
- `addCondition {condition:{id, description}}` — a persistent, objectively
  verifiable major impairment.
- `removeCondition {conditionId}` — remove a real existing condition when the
  supplied world and action establish that it ended.
- `setAppearance {appearance}` — replace the character's complete persistent
  appearance description.

## Conditions

`character.addCondition` has a strict objective threshold. Inner activity is never a condition.

A character condition must satisfy all three tests:

1. it persists across ticks;
2. another observer can see it or independently verify it;
3. it makes an important mental or physical function impossible or severely
   impaired.

Its description states both the objective condition and its functional impact.
Examples include unconsciousness, a fracture preventing use of a limb, severe
bleeding, poisoning, hypothermia, catatonia or disorientation so profound that
the person cannot act coherently.

Thoughts, feelings, moods, suspicion, recognition, resolve and relationship
stances are not conditions. They belong to the character's own perception and
memory pipeline.

## Appearance

`setAppearance` replaces the whole persistent appearance, so preserve every
part that remains true and change only what the action permanently altered.
Use it for durable changes such as a new scar, shaved hair or a lasting bodily
alteration.

Temporary visible states—wet clothing, fresh blood, a bandage—remain
conditions when they satisfy the persistence and functional rules. Do not turn
a one-tick visual detail into permanent appearance.

## SAN

There is no `san` operation. SAN changes only through an occurrence's
`sanityChecks` (see `sanity-check.md`): declare the exposure, and code rolls
and writes the loss. Nothing else you write moves SAN — not treatment, not
recovery, not what a conversation or a text did to someone. Record what
happened as an occurrence and, where it meets the threshold above, as a
condition.
