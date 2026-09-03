// src/engine/resolution/sanityResolver.ts
//
// Settles the sanity checks an Engine resolution DECLARED on its occurrences.
//
// This used to be a code tool the model called mid-session. It was stateless
// and non-idempotent: every repeat returned a fresh d100 and `ok: true`, so
// nothing in the payload ever said "this exposure is settled". Over 30
// full-injection ticks, five spent the entire session budget re-rolling the
// same (actionId, characterId) and never submitted — the whole tick dropped.
// Declaring instead of calling makes that loop structurally impossible: the
// model submits once, and code rolls once.
//
// The declaration carries the fiction (what the character will be like, and
// for how long); the dice carry the weight. A PASSED check costs nothing at
// all — no SAN, no condition — so there is one loss formula, not a pair.

import { addMinutes } from "../../state/gameClock.js";
import type { CharacterChange, SourcedWorldDelta } from "../actions/types.js";
import { clampValue, rollSanityLoss } from "../tools/diceTools.js";
import type { EngineResolutionContext } from "./types.js";
import type { RawOccurrence } from "./worldDeltaSchema.js";

/** How much a point of lost SAN handicaps everything the character then tries.
 *  Calibrated against the only existing precedent — stamina's -10 "tired" and
 *  -20 "exhausted" (`subsystem/stamina.ts`): a 1-point loss is half a tired,
 *  2 is a tired, 4 is an exhausted, and the 1d10 ceiling lands just past it. */
const SANITY_PENALTY_PER_SAN_POINT = 5;
const SANITY_PENALTY_MIN = 5;
const SANITY_PENALTY_MAX = 25;
/** CoC's one-roll temporary-insanity boundary also gives `condition` the
 *  semantic weight promised by its name: lesser losses are real SAN damage,
 *  but not an objective major incapacity carried in world state. */
export const MIN_SAN_LOSS_FOR_CONDITION = 5;

/**
 * The mechanical weight follows from the dice the model already declared, so
 * the model authors only fiction. It is the same bargain `renderOps()` and
 * `opKinds()` strike by sharing one table: what the model is told and what
 * actually happens come from one source. Letting it write the number instead
 * would allow "a faint unease" to arrive carrying a -40.
 */
export function derivePenalty(loss: number): number {
  return -clampValue(
    SANITY_PENALTY_PER_SAN_POINT * loss,
    SANITY_PENALTY_MIN,
    SANITY_PENALTY_MAX
  );
}

export interface SanityRollOptions {
  /** Uniform [0,1). Injectable so a whole resolution's dice — the d100 and
   *  every loss die — can be pinned from ONE source in tests and replays. A
   *  `fixedRolls` array cannot: a single resolution may carry several
   *  declarations, each with a variable number of loss dice. */
  rng?: () => number;
}

/** What one declaration actually did, for the trace. */
export interface SanityOutcome {
  characterId: string;
  sourceActionId: string;
  san: number;
  roll: number;
  passed: boolean;
  lossFormula: string;
  lossRolls: number[];
  loss: number;
  conditionId?: string;
  expiresAt?: string;
  skillPenalty?: number;
}

interface SanityLookup {
  sanById: Map<string, { san: number; maxSan: number }>;
}

/**
 * Roll every declared check and return the deltas it produced. The deltas are
 * ordinary `SourcedWorldDelta<CharacterChange>` — the applier path needs no
 * knowledge that sanity exists.
 *
 * Called from `finalizeResolution`, which runs exactly once per session and
 * only when validation found no errors. That is what guarantees one roll per
 * declaration: validation runs every round, finalization does not.
 */
export function resolveSanityDeclarations(
  occurrences: ReadonlyArray<Pick<RawOccurrence, "actionIds" | "sanityChecks">>,
  lookup: SanityLookup,
  tick: EngineResolutionContext["tick"],
  opts: SanityRollOptions = {}
): {
  deltas: SourcedWorldDelta<CharacterChange>[];
  outcomes: SanityOutcome[];
} {
  const rng = opts.rng ?? Math.random;
  const deltas: SourcedWorldDelta<CharacterChange>[] = [];
  const outcomes: SanityOutcome[] = [];
  let minted = 0;

  for (const occ of occurrences) {
    const sourceActionId = occ.actionIds?.[0];
    if (!sourceActionId) continue; // validation rule 1; keeps types honest
    for (const decl of occ.sanityChecks ?? []) {
      const capacity = lookup.sanById.get(decl.characterId);
      if (!capacity) continue; // validated; a being with maxSan 0 is not shocked

      // The TICK-START SAN. Correct even when the Engine also wrote its own
      // `san` delta this tick: the applier aggregates a tick's contributions
      // and applies them as one simultaneous change.
      const san = capacity.san;
      const roll = Math.floor(rng() * 100) + 1;
      // The 0..99 cap is deliberate — a roll of 100 always fails, however
      // steady the character is.
      const passed = roll <= clampValue(san, 0, 99);

      if (passed) {
        // Nothing. No SAN, no condition, no delta. This is the whole point of
        // the redesign: a check that passes is a shock the character absorbed.
        outcomes.push({
          characterId: decl.characterId,
          sourceActionId,
          san,
          roll,
          passed: true,
          lossFormula: decl.failureLoss,
          lossRolls: [],
          loss: 0,
        });
        continue;
      }

      const rolled = rollSanityLoss(decl.failureLoss, rng);
      const loss = rolled.total;
      const causalBasis = `sanity check failed: rolled ${roll} against SAN ${san} — ${decl.failureLoss} → ${loss}`;
      const outcome: SanityOutcome = {
        characterId: decl.characterId,
        sourceActionId,
        san,
        roll,
        passed: false,
        lossFormula: decl.failureLoss,
        lossRolls: rolled.rolls,
        loss,
      };

      // A zero delta is noise. Only reachable through an exotic formula like
      // "1d4-3" — flat zeros are refused at validation.
      if (loss > 0) {
        deltas.push({
          source: { kind: "action", actionId: sourceActionId },
          causalBasis,
          delta: {
            domain: "character",
            characterId: decl.characterId,
            operation: {
              kind: "san",
              delta: -loss,
              reason: causalBasis,
            },
          } as CharacterChange,
        });
      }

      // Belt-and-braces against `addMinutes`, which throws on a non-integer.
      // Validation already refuses one, but a throw here would take down the
      // whole tick, so a bad duration costs the condition and nothing else.
      const consequence = decl.consequence;
      let expiresAt: string | undefined;
      if (loss >= MIN_SAN_LOSS_FOR_CONDITION && consequence) {
        try {
          expiresAt = addMinutes(
            tick.tickStartTime,
            consequence.durationMinutes
          );
        } catch {
          expiresAt = undefined;
        }
      }

      if (expiresAt !== undefined) {
        const conditionId = `sanity_${tick.tickId}_${minted++}`;
        const skillPenalty = derivePenalty(loss);
        outcome.conditionId = conditionId;
        outcome.expiresAt = expiresAt;
        outcome.skillPenalty = skillPenalty;
        deltas.push({
          source: { kind: "action", actionId: sourceActionId },
          causalBasis,
          delta: {
            domain: "character",
            characterId: decl.characterId,
            operation: {
              kind: "addCondition",
              condition: {
                id: conditionId,
                // Observational only — character conditions are removed by id,
                // never by featureId (that path exists on the scene side).
                featureId: "sanity",
                description: consequence?.description ?? "",
                data: {
                  severityFormula: decl.failureLoss,
                  roll,
                  san,
                  loss,
                },
                mechanicalEffect: { globalSkillPenalty: skillPenalty },
                expiresAt,
              },
            },
          } as CharacterChange,
        });
      }

      outcomes.push(outcome);
    }
  }

  return { deltas, outcomes };
}
