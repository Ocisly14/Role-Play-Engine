// The tool schema and the TypeScript types describe the same wire format, and
// nothing but this file makes them agree.
//
// They disagreed once already, and it cost six of sixteen rejections in a
// measured run: `result.outcome` was optional in the schema (`required:
// ["reason"]`, description written entirely as a prohibition) while the
// validator required it whenever the action carried no check. The model read
// the schema, omitted the field, and was punished by the code. Drift between
// the thing the model is TOLD and the thing it is JUDGED BY is invisible from
// either side alone — so it gets a test.

import { describe, expect, it } from "vitest";
import {
  CHARACTER_OPS,
  ITEM_OPS,
  type RawActionEnd,
  type RawActionStart,
  type RawCharacterChange,
  type RawOccurrence,
  type RawResolutionRepair,
  type RawTickResolution,
  SCENE_OPS,
  opKinds,
  repairResolutionTool,
  submitResolutionTool,
} from "../worldDeltaSchema.js";

type Schema = {
  properties: Record<string, Schema & { items?: Schema }>;
  required?: string[];
};

const submit = submitResolutionTool.inputSchema as unknown as Schema;
const repair = repairResolutionTool.inputSchema as unknown as Schema;

const propsOf = (s: Schema | undefined): string[] =>
  Object.keys(s?.properties ?? {}).sort();

/**
 * Pins the literal tuple type. Written as a curried identity because TypeScript
 * cannot infer `T` explicitly and `K` positionally in one call, and without the
 * literals `Exclude<keyof T, K>` collapses to `never` and the check below
 * silently passes forever.
 */
const fields =
  <T>() =>
  <K extends ReadonlyArray<keyof T & string>>(...keys: K): K =>
    keys;

/**
 * `true` when the list covers every key of `T`; otherwise an object type whose
 * single property NAMES the field that was added to the interface and never
 * reached the schema. That is the half a runtime comparison cannot do — both
 * sides of it would be the stale list.
 */
type Covers<T, K extends string> = Exclude<keyof T & string, K> extends never
  ? true
  : {
      FIELD_MISSING_FROM_THIS_TEST_AND_MAYBE_THE_SCHEMA: Exclude<
        keyof T & string,
        K
      >;
    };

const sorted = (keys: ReadonlyArray<string>): string[] => [...keys].sort();

const START = fields<RawActionStart>()(
  "actionId",
  "resolvedDurationTicks",
  "timingReason",
  "check",
  "opposedBy",
  "movement"
);
const END = fields<RawActionEnd>()(
  "actionId",
  "outcome",
  "reason",
  "occurrence",
  "resolvedDurationTicks",
  "timingReason"
);
const OCCURRENCE = fields<RawOccurrence>()(
  "sourceActionIds",
  "locationId",
  "facts",
  "participants",
  "perceiverCharacterIds",
  "signals"
);
const DELTA = fields<RawCharacterChange>()(
  "sourceActionId",
  "causalBasis",
  "characterId",
  "operation"
);
const RESOLUTION = fields<RawTickResolution>()(
  "starting",
  "ending",
  "characterChanges",
  "sceneChanges",
  "itemChanges",
  "occurrences"
);
const REPAIR = fields<RawResolutionRepair>()(
  "starting",
  "ending",
  "characterChanges",
  "sceneChanges",
  "itemChanges",
  "occurrences"
);

// Adding a field to any of these interfaces stops the build here, by name.
const _covers: [
  Covers<RawActionStart, (typeof START)[number]>,
  Covers<RawActionEnd, (typeof END)[number]>,
  Covers<RawOccurrence, (typeof OCCURRENCE)[number]>,
  Covers<RawCharacterChange, (typeof DELTA)[number]>,
  Covers<RawTickResolution, (typeof RESOLUTION)[number]>,
  Covers<RawResolutionRepair, (typeof REPAIR)[number]>,
] = [true, true, true, true, true, true];
void _covers;

describe("the tool schema and the TS types describe the same thing", () => {
  it("submit_resolution has exactly the top-level lists the type has", () => {
    expect(propsOf(submit)).toEqual(sorted(RESOLUTION));
  });

  it("starting carries the fields of RawActionStart", () => {
    expect(propsOf(submit.properties.starting.items)).toEqual(sorted(START));
  });

  it("ending carries the fields of RawActionEnd", () => {
    expect(propsOf(submit.properties.ending.items)).toEqual(sorted(END));
  });

  it("an ending's occurrence is an occurrence minus its source", () => {
    // The source IS the action it hangs off, so restating it would be a second
    // place for the same fact to be wrong.
    expect(
      propsOf(submit.properties.ending.items?.properties.occurrence)
    ).toEqual(sorted(OCCURRENCE.filter((k) => k !== "sourceActionIds")));
    expect(propsOf(submit.properties.occurrences.items)).toEqual(
      sorted(OCCURRENCE)
    );
  });

  it("every delta array shares one shape", () => {
    for (const field of ["characterChanges", "sceneChanges", "itemChanges"]) {
      const props = propsOf(submit.properties[field].items);
      expect(props).toContain("sourceActionId");
      expect(props).toContain("causalBasis");
      expect(props).toContain("operation");
    }
    expect(propsOf(submit.properties.characterChanges.items)).toEqual(
      sorted(DELTA)
    );
  });
});

describe("repair_resolution cannot drift from what it repairs", () => {
  it("repairs exactly the lists a submission has", () => {
    expect(propsOf(repair)).toEqual(sorted(REPAIR));
    expect(propsOf(repair)).toEqual(propsOf(submit));
  });

  it("takes action entries in the submission's own shape", () => {
    // Addressed by actionId, so they need no index — and re-declaring the
    // fields here is what let the two shapes diverge before.
    expect(propsOf(repair.properties.starting.items)).toEqual(sorted(START));
    expect(propsOf(repair.properties.ending.items)).toEqual(sorted(END));
  });

  it("adds the address fields, and only those, to the indexed lists", () => {
    for (const field of [
      "characterChanges",
      "sceneChanges",
      "itemChanges",
      "occurrences",
    ]) {
      const added = propsOf(repair.properties[field].items).filter(
        (k) => !propsOf(submit.properties[field].items).includes(k)
      );
      expect(added).toEqual(["index", "remove"]);
    }
  });
});

describe("what the schema marks required", () => {
  it("makes an ending carry its trace, so the rule needs no validator", () => {
    expect(submit.properties.ending.items?.required).toContain("occurrence");
    expect(submit.properties.ending.items?.required).toContain("reason");
  });

  it("makes a start carry its duration, so the rule needs no validator", () => {
    expect(submit.properties.starting.items?.required).toEqual([
      "actionId",
      "resolvedDurationTicks",
      "timingReason",
    ]);
  });

  it("leaves outcome optional in shape but says when it is required", () => {
    // It cannot be `required` — it is refused for checked actions. So the
    // conditional lives in the description, and the trigger worklist names the
    // exact ids. Both halves have to be present or we are back to the bug.
    const outcome = submit.properties.ending.items?.properties.outcome as
      | { description?: string }
      | undefined;
    expect(submit.properties.ending.items?.required).not.toContain("outcome");
    expect(outcome?.description).toContain("REQUIRED");
    expect(outcome?.description).toContain("endingNeedsOutcome");
  });
});

describe("operation kinds have one source", () => {
  // The kinds the model is told about and the kinds the validator accepts used
  // to be two hand-maintained lists. Now the description is generated from the
  // same rows `opKinds` reads, so this checks the generation rather than the
  // agreement — the agreement is structural.
  const described = (field: string): string =>
    (submit.properties[field] as unknown as { description: string })
      .description;

  it.each([
    ["characterChanges", CHARACTER_OPS],
    ["sceneChanges", SCENE_OPS],
    ["itemChanges", ITEM_OPS],
  ])("%s advertises exactly the kinds it accepts", (field, ops) => {
    const advertised = [
      ...described(field).matchAll(/\{kind:([^,}]+)/g),
    ].flatMap((m) => [...m[1].matchAll(/"(\w+)"/g)].map((k) => k[1]));

    expect(advertised.sort()).toEqual([...opKinds(ops)].sort());
  });

  it("spells out the fields of every kind, so none is left to guess", () => {
    // A kind advertised with no field list is how `addCondition` shipped
    // without `{id, description}` and got rejected on sight.
    for (const ops of [CHARACTER_OPS, SCENE_OPS, ITEM_OPS]) {
      for (const op of ops) {
        if (op.kinds.includes("destroy")) continue; // genuinely field-free
        expect(op.fields).not.toBe("");
      }
    }
  });
});

describe("the trigger worklist answers what the Engine would otherwise infer", () => {
  it("names the starts that cannot carry a check", async () => {
    // The rule is "no declared skill, no check". Working that out means
    // finding `declaredSkillId` in the New Commands section — a cross-section
    // lookup, and the last one left. Every remaining rejection in a measured
    // run was it going wrong, always on a described deception where a bar
    // feels obviously right and is not allowed.
    const { resolutionWorklist } = await import("../worldDeltaValidator.js");
    const command = (commandId: string, declaredSkillId?: string) => ({
      commandId,
      actorId: "npc_1",
      issuedAt: "1923-04-02T09:15:00",
      issuedSceneId: "SCN_1",
      description: "I pretend to browse.",
      objectRefs: [],
      proposedDurationTicks: 2,
      ...(declaredSkillId ? { declaredSkillId } : {}),
    });

    const worklist = resolutionWorklist({
      trigger: { triggers: [], actionIds: ["action_bare", "action_skilled"] },
      tick: {
        tickId: "t",
        tickStartTime: "1923-04-02T09:15:00",
        durationMinutes: 1,
      },
      rules: {
        resolutionGuide: "",
        outputSchemaVersion: 1,
        worldInvariants: [],
      },
      state: {
        graph: { macroLocations: [], places: [], edges: [] },
        places: [],
        items: [],
        itemHolders: {},
        characters: [],
      },
      actions: {
        newCommands: [command("bare"), command("skilled", "Social")],
        activeActions: [],
      },
      events: { objectiveWorldEvents: [], deterministicResults: [] },
    } as never);

    expect(worklist.starting).toEqual(["action_bare", "action_skilled"]);
    expect(worklist.startingWithoutSkill).toEqual(["action_bare"]);
  });
});
