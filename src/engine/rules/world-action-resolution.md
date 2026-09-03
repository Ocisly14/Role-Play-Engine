# World Action Resolution

This is the root contract for the World Action Engine. Every `act` command is
resolved under these invariants. Domain-specific judgement lives in the
companion documents below; they are parts of one contract, not optional
recipes.

## Rule modules

Load these documents in this order after this root contract:

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

`session-protocol.md` is the transport contract for tool use and submission;
it is not a world-rule module.

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
   attempt, omit the check; never substitute another skill or raise the bar to
   punish the choice.

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
   changed. A descriptive moment belongs in an occurrence, not in state merely
   to make the result feel richer.

9. **The request is the evidence.** Report what the supplied world and this
   tick's actions support. Absence is a valid finding. Introducing an object or
   a lasting mark requires the corresponding create or state-change operation;
   atmosphere is not evidence.

10. **Fact and perception stay separate.** The Engine states objective events
    and identifies who could perceive each one. It never writes a character's
    subjective interpretation, memory, opinion or emotional conclusion.
