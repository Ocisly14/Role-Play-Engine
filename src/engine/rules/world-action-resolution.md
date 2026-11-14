# World Action Resolution

This is the root contract for the World Action Engine. Every `act` command is
resolved under these invariants. Domain-specific judgement lives in the
companion documents below; they are parts of one contract, not optional
recipes.

## Rule modules

One tick's resolution is decided in six ordered phases, one request each. This
root contract is present in every one of them. The domain modules are not:
each phase receives only the documents its own judgement needs, so a module
absent from this request is not this phase's concern — and never a gap it
should fill by guessing.

1. `world/action-adjudication.md` — action timing, checks, outcomes and
   concurrency.
2. `world/movement-and-position.md` — routes, reachability, vehicles and spots.
3. `world/character-changes.md` — health, fatigue, conditions and appearance.
4. `world/item-changes.md` — ownership, transfer, damage, breakage and
   destruction.
5. `world/scene-changes.md` — place descriptions, conditions, passages and the
   environment.
6. `world/perception.md` — sensory reach, observer capability and
   per-perceiver clarity.
7. `world/occurrences-and-dialogue.md` — occurrence encoding, speech and
   character agency.
8. `sanity-check.md` — involuntary horror exposure and SAN loss.

`session-protocol.md` is the transport contract — what a phase is, what it may
call, and what a rejection asks for. It is present in every phase and is not a
world-rule module.

## Cross-domain invariants

1. **Causality.** Every change and occurrence must follow directly from a
   current action or an objective event supplied in this tick. Every model-made
   change names its `sourceActionId`. A source is attribution, not permission to
   invent an unrelated consequence.

2. **State constraints.** Outcomes obey bodies, abilities, tools, item state,
   scene conditions, topology and active resistance. Confident prose cannot
   open a locked door or put a hand on an unreachable object.

3. **Code owns mechanics.** Code owns elapsed time, lifecycle status, route
   traversal and every dice result. The Engine sets only the judgement the
   schema asks it to set, then accepts deterministic results as facts.

4. **Declared ability only.** A check may use only the skill the actor
   declared. If no skill was declared, or that skill does not cover the
   attempt, omit the check. Interpersonal influence, questioning and reading
   someone's intent are settled without a check. Keep checks for independently
   uncertain tasks such as treatment, combat or learned-language comprehension.

5. **Failure is bounded.** A plain failed check means the attempt did not work
   and its time was spent. Only a fumble licenses an additional lasting cost
   such as injury, a broken tool or an alarm, unless the input already contains
   an independent cause for that cost. Follow the declared skill document's
   success and failure guidance.

6. **Concurrency is atomic.** Resolve actions on the shared snapshot together.
   One exclusive item, passage or target cannot produce contradictory winners.
   Choose one consistent world result.

7. **Conservation.** A character or item occupies one valid place at a time.
   Transfer, creation, destruction and displacement need a real source and a
   valid destination where applicable.

8. **Minimal sufficient change.** Emit only persistent fields that actually
   changed. Persistent means retained across ticks, not permanent. A descriptive moment belongs in an occurrence, not in state merely
   to make the result feel richer.

9. **The request is the evidence.** Report what the supplied world and this
   tick's actions support. Absence is a valid finding. Introducing an object or
   a lasting mark requires the corresponding create or state-change operation;
   atmosphere is not evidence.

10. **Fact and perception stay separate.** The Engine states objective events
    and identifies who could perceive each one. It never writes a character's
    subjective interpretation, memory, opinion or emotional conclusion.
    The Renderer supplies the personal perspective. Ordinary observation and
    waiting receive events as they occur, not as a retrospective ending summary.
    Use `no_change` to close an unchecked, non-speaking action with no new
    result; do not invent a finding just because its time expired.

## Evidence, time and authority

Apply these boundaries in every phase, including skill-guided outcomes:

- A command is an attempt, not evidence that its verbs happened. A start sets
  the clock and check. Elapsed time measures the undertaking, not the completion
  of each clause. A roll answers that attempt within physical and evidential
  limits; a high level creates neither missing facts nor another person's acts.
- Only ids under `ending` receive an ending decision. `stillRunning` means
  no ending is due, not that the actor is motionless. During a settlement an
  ongoing action may have a supported intermediate effect: describe only that
  effect, with any required state changes, leaving the rest pending. Without
  an established intermediate effect, describe at most work in progress. Never
  execute the entire plan from its elapsed fraction or reapply an earlier effect.
- Words are delivered only for `endingWithUtterance` in this tick. A pending
  command's speech must not appear indirectly in an outcome, non-speech content,
  state description or listener reaction. A past delivered line remains past;
  a new action by that speaker neither repeats it nor makes it pending again.
- Every claim about another actor needs its own source and time. Observing,
  listening, waiting or reading a person does not execute that person's command.
  Record each actual event under its own cause and route it to its perceivers
  when it happens. Do not retell the interval at an observer's ending or fill
  gaps with imagined replies, silence, gestures, motives or beliefs.
  Missing records do not establish that no response occurred.
- Deliberate responses belong to their actors. Direct physical consequences
  of another action (a wound, forced movement, a restraint) can affect a target
  without a target command, but need a concrete cause and appropriate mechanics.
  Being named as a target is neither consent nor proof of sensory access.
- Keep evidence distinct from interpretation. Report established clues and
  supported measurements; a tentative inference stays tentative. Never invent
  the evidence that would make a reading work, impose a belief, or promote an
  erroneous analysis into world truth. A private finding does not tell bystanders.
- The supplied snapshot is the starting state; code-applied changes and this
  session's supported accepted deltas determine the resulting state. Old prose,
  history and intentions do not override those fields. Keep outcome, state and
  occurrence accounts consistent. Acceptance checks structure and implemented
  constraints; it is not proof of every prose claim. A downstream phase cannot
  revise an accepted array, but must not expand an unsupported clause into new
  speech, behavior or state just to make that clause true.
- Skill examples illustrate possible results, not mandatory bonuses or costs.
  Time and real resource use can be spent on any attempt. Additional injury,
  damage or loss needs a fumble or an independently supplied cause, and a fumble
  still respects available objects, actual exposure and proportional severity.
  Never duplicate a cost or movement already applied by code. No skill changes
  elapsed time, permits a new route, restores SAN or grants unavailable tools.
