// Sanity settlement: the model declares, code rolls.
//
// Every test pins the dice through one injected `rng`, which is the whole
// reason the resolver takes a uniform source rather than a `fixedRolls` array
// — one resolution can carry several declarations, each with a variable
// number of loss dice, and they all come off the same tape.

import { describe, expect, it } from "vitest";
import type {
  CharacterChange,
  SourcedWorldDelta,
} from "../../actions/types.js";
import { derivePenalty, resolveSanityDeclarations } from "../sanityResolver.js";
import type { RawOccurrence } from "../worldDeltaSchema.js";

const TICK = {
  tickId: "tick_7",
  tickStartTime: "1985-07-08T09:15:00",
  durationMinutes: 1,
};

const lookup = (san = 60, maxSan = 80) => ({
  sanById: new Map([["npc_1", { san, maxSan }]]),
});

/** A d100 of `roll` comes from `(roll - 1) / 100`. */
const d100 = (roll: number) => (roll - 1) / 100;
/** A die of `sides` showing `face` comes from `(face - 1) / sides`. */
const die = (face: number, sides: number) => (face - 1) / sides;

/** Reads the pinned values in order, then throws rather than drifting into
 *  Math.random and making a failure look like a flake. */
function tape(...values: number[]): () => number {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error("rng tape exhausted");
    return values[i++];
  };
}

function occurrence(
  sanityChecks: RawOccurrence["sanityChecks"],
  sourceActionIds = ["action_1"]
): Pick<RawOccurrence, "sourceActionIds" | "sanityChecks"> {
  return { sourceActionIds, ...(sanityChecks ? { sanityChecks } : {}) };
}

const decl = (
  over: Partial<NonNullable<RawOccurrence["sanityChecks"]>[0]> = {}
): NonNullable<RawOccurrence["sanityChecks"]>[0] => ({
  characterId: "npc_1",
  failureLoss: "1d6",
  consequence: {
    description:
      "speech is incoherent and the person cannot remain oriented to place, so they cannot communicate a coherent plan or act safely without guidance",
    durationMinutes: 30,
  },
  ...over,
});

describe("resolveSanityDeclarations", () => {
  it("emits nothing at all when the check passes", () => {
    const out = resolveSanityDeclarations(
      [occurrence([decl()])],
      lookup(60),
      TICK,
      { rng: tape(d100(35)) }
    );

    // The load-bearing behaviour change: passing is free. No SAN, no
    // condition, nothing for the applier to do.
    expect(out.deltas).toEqual([]);
    expect(out.outcomes).toEqual([
      expect.objectContaining({ passed: true, roll: 35, loss: 0 }),
    ]);
  });

  it("emits the SAN loss and the condition, in that order, when it fails", () => {
    const out = resolveSanityDeclarations(
      [occurrence([decl()])],
      lookup(60),
      TICK,
      { rng: tape(d100(61), die(5, 6)) }
    );

    expect(out.deltas).toHaveLength(2);
    const [san, cond] = out.deltas as SourcedWorldDelta<CharacterChange>[];

    expect(san.source).toEqual({ kind: "action", actionId: "action_1" });
    expect(san.causalBasis).toBe(
      "sanity check failed: rolled 61 against SAN 60 — 1d6 → 5"
    );
    expect(san.delta.operation).toEqual({
      kind: "san",
      delta: -5,
      reason: "sanity check failed: rolled 61 against SAN 60 — 1d6 → 5",
    });

    expect(cond.delta.operation).toMatchObject({
      kind: "addCondition",
      condition: {
        id: "sanity_tick_7_0",
        featureId: "sanity",
        description:
          "speech is incoherent and the person cannot remain oriented to place, so they cannot communicate a coherent plan or act safely without guidance",
        mechanicalEffect: { globalSkillPenalty: -25 },
        expiresAt: "1985-07-08T09:45:00",
      },
    });
  });

  it("fails a roll of 100 however steady the character is", () => {
    // The 0..99 cap is deliberate: nobody is immune.
    const out = resolveSanityDeclarations(
      [occurrence([decl({ failureLoss: "1" })])],
      lookup(100, 100),
      TICK,
      { rng: tape(d100(100)) }
    );
    expect(out.outcomes[0]).toMatchObject({ passed: false, roll: 100 });
  });

  it("mints one id per condition across the whole resolution", () => {
    const out = resolveSanityDeclarations(
      [occurrence([decl()], ["action_1"]), occurrence([decl()], ["action_2"])],
      lookup(60),
      TICK,
      { rng: tape(d100(61), die(5, 6), d100(90), die(6, 6)) }
    );

    const ids = out.outcomes.map((o) => o.conditionId);
    expect(ids).toEqual(["sanity_tick_7_0", "sanity_tick_7_1"]);
    expect(out.outcomes[1].sourceActionId).toBe("action_2");
  });

  it("skips a character with no sanity capacity", () => {
    const out = resolveSanityDeclarations(
      [occurrence([decl({ characterId: "npc_entity" })])],
      lookup(60),
      TICK,
      { rng: tape() }
    );
    expect(out.deltas).toEqual([]);
    expect(out.outcomes).toEqual([]);
  });

  it("does not turn a sub-threshold SAN loss into a condition", () => {
    const out = resolveSanityDeclarations(
      [occurrence([decl()])],
      lookup(60),
      TICK,
      { rng: tape(d100(61), die(4, 6)) }
    );

    expect(out.deltas).toHaveLength(1);
    expect(out.deltas[0].delta.operation).toMatchObject({ kind: "san" });
    expect(out.outcomes[0]).toMatchObject({ loss: 4, passed: false });
    expect(out.outcomes[0].conditionId).toBeUndefined();
  });

  it("does not invent a condition when no objective consequence was declared", () => {
    const out = resolveSanityDeclarations(
      [occurrence([decl({ consequence: undefined })])],
      lookup(60),
      TICK,
      { rng: tape(d100(61), die(6, 6)) }
    );

    expect(out.deltas).toHaveLength(1);
    expect(out.deltas[0].delta.operation).toMatchObject({ kind: "san" });
    expect(out.outcomes[0].conditionId).toBeUndefined();
  });

  it("drops only the condition when the duration would crash the clock", () => {
    // `addMinutes` throws on a non-integer. Validation refuses one first, but
    // a throw here would take the whole tick down, so the SAN loss survives.
    const out = resolveSanityDeclarations(
      [
        occurrence([
          decl({
            consequence: {
              description:
                "the person cannot remain oriented to the room or stand steadily, so they cannot navigate or act safely without physical guidance",
              durationMinutes: 2.5,
            },
          }),
        ]),
      ],
      lookup(60),
      TICK,
      { rng: tape(d100(61), die(5, 6)) }
    );

    expect(out.deltas).toHaveLength(1);
    expect(out.deltas[0].delta.operation).toMatchObject({ kind: "san" });
    expect(out.outcomes[0].conditionId).toBeUndefined();
  });

  it("ignores a declaration with no action to attribute it to", () => {
    const out = resolveSanityDeclarations(
      [occurrence([decl()], [])],
      lookup(60),
      TICK,
      { rng: tape() }
    );
    expect(out.deltas).toEqual([]);
  });
});

describe("derivePenalty", () => {
  it("tracks the SAN actually lost, calibrated against the stamina penalties", () => {
    // stamina: tired -10, exhausted -20. One point is half a tired, two is a
    // tired, four is an exhausted, and 1d10's ceiling lands just past it.
    expect(derivePenalty(1)).toBe(-5);
    expect(derivePenalty(2)).toBe(-10);
    expect(derivePenalty(4)).toBe(-20);
    expect(derivePenalty(10)).toBe(-25);
  });

  it("never returns nothing for a loss that happened", () => {
    expect(derivePenalty(0)).toBe(-5);
  });
});
