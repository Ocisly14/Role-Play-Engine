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

4. **Time and progress.** The global tick unit is fixed (1 tick = 1 in-world
   minute). The actor submits only `proposedDurationTicks` (intent); the
   Engine decides `resolvedDurationTicks` and `nextWakeAt` from the action
   and world state, with a stated timing reason. A long action accumulates
   progress until its resolution point — no future results are pre-committed.

5. **Conservation and ownership.** An item cannot be in two places at once.
   Consumption, transfer, creation and destruction need a plausible source
   and destination. Duplicate ownership is an invariant violation.

6. **Roll first, assess after.** When a command carries a skill the actor
   owns, the roll was already made at intake and is immutable. The Engine
   then judges — with the roll in hand — whether the skill semantically
   applies, what success level the situation objectively requires, and the
   final result. Without a declared skill the Engine judges directly; there
   are NEVER hidden rolls.

7. **Ability internalization.** The actor declares only a skill id. Real
   skill values, thresholds and random results come from trusted code
   reading character state. The actor cannot submit values, difficulties,
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

## Skill checks

- A declared skill's `SkillRollRecord` (value, roll, success level) is
  immutable input. Retries, tick retries and rehydration reuse the same
  rollId; a second actor roll never exists for the same command.
- Applicability is judged on facts: what the action does, with what tool, on
  what target, under what conditions. State the basis. An irrelevant skill —
  however high, however lucky the roll — is `applicability: "rejected"`: the
  roll stays in the trace but grants no success benefit, and no
  requiredLevel/checkType is fabricated for it.
- When applicable, the Engine sets `requiredLevel` (regular/hard/extreme)
  from the objective difficulty of the situation — stated BEFORE reasoning
  from the roll's outcome, with a factual basis, so "seeing the roll and
  bending the bar" is auditable.
- Opposed checks: the Engine chooses the defender(s) and their defense
  skill; the defender roll is executed by the deterministic opposed-roll
  tool. Higher success level wins; the defender wins ties. The actor's roll
  is never re-rolled for the comparison.
- The deterministic outcome of the check (met / not met / fumble / critical,
  per-defender results) is computed by code from the records. The Engine's
  final resolution must be consistent with it: a failed check cannot yield
  the success outcome, a fumble can worsen it.

## Output rules

- Lifecycle: every triggering action gets exactly one `ActionTransition`
  (started, completed, failed, interrupted, …) with progress delta and, when
  first resolved, the authoritative duration and timing reason.
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
