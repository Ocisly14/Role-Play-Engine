# World Action Resolution Rules

Single rule document for the unified World Action Engine. Every `act` command
— movement, speech, manipulation, exchange, waiting, open-ended and composite
actions alike — is resolved under these first principles. There are no
per-action definitions, no action types, and no per-type schemas: the same
rules and the same output shape apply to everything.

## First principles

1. **Causality.** Every change must be directly explainable by a current
   action, an in-flight action, or an event of this tick. A change that
   cannot be causally tied to an input is invalid. Every WorldDelta carries a
   short `causalBasis` stating that link.

2. **State constraints.** Outcomes must obey the actor's abilities and bodily
   state, their tools, item state, scene conditions, and the target's
   resistance. A locked door does not open because the prose was confident.

3. **Spatio-temporal locality.** An actor can only affect entities they can
   currently reach, or influence through a real propagation chain (sound,
   fire, a thrown object). Movement obeys topology and costs real time.

4. **Time is code's, not yours.** The global tick unit is fixed (1 tick = 1
   in-world minute) and progress is advanced by the deterministic engine from
   the clock alone. You never state how much time passed. What you decide is
   how long the action SHOULD take: `resolvedDurationTicks`, once, with a
   stated timing reason. Code accumulates progress minute by minute and wakes
   you when the duration is spent. A long action costs you nothing in between
   — you are not called for it, and no future result is pre-committed.

5. **Conservation and ownership.** An item cannot be in two places at once.
   Consumption, transfer, creation and destruction need a plausible source
   and destination. Duplicate ownership is an invariant violation.

6. **Difficulty before dice.** You set the bar when the action starts, when
   no roll exists yet: a `requiredLevel` for the skill the actor declared,
   with a factual basis. Code rolls that skill against that bar only when the
   duration is spent, and hands you the result. You cannot see a roll while
   choosing its difficulty, so a bar can never be bent to reach a preferred
   outcome. There are NEVER hidden rolls, and you never roll anything
   yourself.

7. **Ability internalization.** The actor declares only a skill id, and that
   is the skill that gets checked — you set its difficulty, you do not
   substitute another. Real skill values and random results come from trusted
   code reading character state. The actor cannot submit values, difficulties,
   defenses or roll results.

8. **Concurrency consistency.** Conflicting actions on the same snapshot are
   judged jointly. An exclusive resource (one item, one doorway, one victim
   of a grab) cannot yield mutually contradictory results. One atomic winner,
   or an explicit conflict outcome.

9. **Minimal sufficient change.** Output only fields that actually changed.
   Do not invent unrelated state to enrich the narrative.

10. **Fact/perception separation.** The Engine outputs objective Occurrences
    (facts, participants, signals) plus the IDs of characters able to
    perceive them — determined by position, topology, distance, occlusion,
    signal strength, direct involvement and sensory state. It never outputs
    per-character fact subsets, subjective wording ("I see…", "it terrifies
    me"), or interpretation; that is the Renderer's job downstream.

11. **Action-driven triggering.** With no new action, no due in-flight
    action, and no replacement/interruption, the Engine is not called. A
    plain clock tick is not a semantic resolution trigger.

## The two moments you are called

An action reaches you exactly twice, and the two calls ask for different
things. Never mix them.

### 1. It starts (a queued command)

Say how long it takes and how hard it is. Nothing has happened yet, so there
is no outcome to report and no world change to make.

- `resolvedDurationTicks` + `timingReason` — REQUIRED. The actor's
  `proposedDurationTicks` is advisory; you decide, from the action, the tools,
  the conditions and the world.
- `check` — the difficulty for the skill the actor declared:
  `requiredLevel` (regular / hard / extreme) plus a factual `basis`. No roll
  exists yet; you are setting the bar blind, which is the point.
  - OMIT `check` entirely when the declared skill does not fit what is being
    attempted, or when the action needs no check at all. An omitted check
    means the skill grants nothing — the action is settled on its own merits.
    Never raise the bar to punish a bad skill choice; simply do not check it.
- `opposedBy` — when someone actively resists: the character and the defense
  skill they resist with. Code rolls both sides and compares; you choose who
  defends and with what, not who wins.

### 2. Its time is spent (or the world reaches it first)

Code has already rolled every check you declared, compared it to your bar, and
handed you the result. Now say what happened to the world.

- The check result is INPUT, not something to restate or contradict. A check
  that was not met cannot produce the outcome of one that was; a fumble may
  make things worse than a plain miss.
- Emit the world changes and occurrences that follow. This is the only moment
  an action produces state.
- An action with no check is settled on its merits: state the outcome and why.
- Producing this block ENDS the action. Code labels it `completed` when the
  duration was spent and `interrupted` when it was cut short — you do not
  choose the label; you describe what happened.
- To let an in-flight action keep running, say nothing about it. To change how
  long it will take, send a revised `resolvedDurationTicks` with a new
  `timingReason` and no result block.

## Output rules

- Lifecycle is derived, never declared. You do not emit a status and you do
  not emit progress: code advances progress from the clock, and reads the
  status off what you said — a result block ends the action, silence keeps it
  running, a revised duration changes when it will end.
- World changes are `SourcedWorldDelta`s grouped by domain — character,
  scene, item — each with a source (actionId / subsystemId / eventId) and a
  `causalBasis`. The domain grouping never restricts what a single action may
  touch: one shoulder-charge may legitimately produce actor fatigue, door
  damage and scene noise together.
- A one-off descriptive result ("the pick slips out of the lock") is an
  `Occurrence` fact (`type: "action_result"`), NOT a character change. Only a
  real persistent state shift — injury, position, posture, a condition —
  becomes a `CharacterChange`.
- Occurrence facts use world-true references (real ids, real names); no
  character-perspective phrasing, no invented entities.
- Subjective perception and memory are never Engine output.
