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
  type RawSanityCheck,
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
// Written in wire order, not alphabetical: the flat shape relies on it (see
// "an occurrence row cites its actions via actionIds and carries facts last").
const END = fields<RawActionEnd>()(
  "actionId",
  "replacedBy",
  "outcome",
  "reason"
);
const OCCURRENCE = fields<RawOccurrence>()(
  "actionIds",
  "locationId",
  "actorId",
  "targetIds",
  "affectedIds",
  "perceiverCharacterIds",
  "signals",
  "sanityChecks",
  "facts"
);
const SANITY_CHECK = fields<RawSanityCheck>()(
  "characterId",
  "failureLoss",
  "consequence"
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

  it("an occurrence row cites its actions via actionIds and carries facts last", () => {
    // The trace of an ending no longer hangs off the ending: it is a flat
    // row here, tied back by `actionIds`. The row is scalars and string
    // arrays with its one array of objects LAST, and the ending entry is four
    // scalars with the longest string last — generation is left-to-right, so
    // the order is the design, not a style: the model never has to close a
    // deep object and then come back for a sibling scalar (the brace slip
    // every unreadable DeepSeek submission made in two measured runs).
    expect(propsOf(submit.properties.occurrences.items)).toEqual(
      sorted(OCCURRENCE)
    );
    const occurrenceOrder = Object.keys(
      submit.properties.occurrences.items?.properties ?? {}
    );
    expect(occurrenceOrder).toEqual([...OCCURRENCE]);
    expect(occurrenceOrder.at(-1)).toBe("facts");
    expect(
      Object.keys(submit.properties.ending.items?.properties ?? {})
    ).toEqual(["actionId", "replacedBy", "outcome", "reason"]);
  });

  it("a declared sanity check matches RawSanityCheck", () => {
    // One placement only: the occurrence row. An ending has no occurrence of
    // its own any more, so there is no second copy to keep in step.
    const standalone = submit.properties.occurrences.items?.properties
      .sanityChecks as Schema & { items?: Schema };

    expect(propsOf(standalone.items)).toEqual(sorted(SANITY_CHECK));
    // There is no success loss: passing costs nothing, so there is no pair.
    expect(propsOf(standalone.items?.properties.consequence)).toEqual([
      "description",
      "durationMinutes",
    ]);
    expect(standalone.items?.required).toEqual(["characterId", "failureLoss"]);
    expect(standalone.items?.properties.consequence.required).toEqual([
      "description",
      "durationMinutes",
    ]);
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

  it("takes action entries in the submission's own shape, plus remove", () => {
    // Addressed by actionId, so they need no index — and re-declaring the
    // fields here is what let the two shapes diverge before. `remove` is the
    // one addition: withdrawing an entry is a gesture the submission has no
    // use for.
    expect(propsOf(repair.properties.starting.items)).toEqual(
      sorted([...START, "remove"])
    );
    expect(propsOf(repair.properties.ending.items)).toEqual(
      sorted([...END, "remove"])
    );
    expect(repair.properties.starting.items?.required).toEqual(["actionId"]);
    expect(repair.properties.ending.items?.required).toEqual(["actionId"]);
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
  it("keeps an ending flat: no nested occurrence, only actionId and reason required", () => {
    // The trace used to be a required `occurrence` object on the entry, so
    // the rule needed no validator; now it is the validator's job (every
    // ending must be cited by an occurrence's `actionIds`), and the entry
    // carries nothing the model has to close.
    expect(
      submit.properties.ending.items?.properties.occurrence
    ).toBeUndefined();
    expect(submit.properties.ending.items?.required).toEqual([
      "actionId",
      "reason",
    ]);
    expect(submit.properties.occurrences.items?.required).toEqual([
      "actionIds",
      "perceiverCharacterIds",
      "facts",
    ]);
  });

  it("leaves duration optional in shape — travel derives its clock from the route", () => {
    // Duration cannot be `required`: a movement action must NOT be clocked
    // by hand (code derives its time from the route and overrides any
    // number), while a non-travel action must be. The conditional lives in
    // the validator (a non-travel start without a duration is rejected)
    // plus the field description — same split as `outcome` below.
    expect(submit.properties.starting.items?.required).toEqual(["actionId"]);
    const duration = submit.properties.starting.items?.properties
      .resolvedDurationTicks as { description?: string } | undefined;
    expect(duration?.description).toContain("OMIT when `movement` is set");
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

  it("makes character conditions objective major impairments in the advertised contract", () => {
    const addCondition = CHARACTER_OPS.find((op) =>
      op.kinds.includes("addCondition")
    );
    expect(addCondition?.fields).toContain("description:string");
    expect(addCondition?.fields).toContain("objective");
    expect(addCondition?.fields).toContain("severely impairs");
    expect(addCondition?.fields).toContain("never a thought, feeling");
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
        graph: { places: [], edges: [] },
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

describe("the operation grammar is the same table as the prose", () => {
  // The `anyOf` the provider enforces and the `{kind:...}` list the model
  // reads are both generated from CHARACTER_OPS / SCENE_OPS / ITEM_OPS. This
  // pins the generation on the grammar side, as the test above does for the
  // prose side.
  type OpBranch = {
    properties: { kind: { const: string } };
    additionalProperties: boolean;
    required: string[];
  };
  const branchesOf = (tool: Schema, field: string): OpBranch[] =>
    (
      (tool.properties[field] as unknown as { items: Schema }).items.properties
        .operation as unknown as { anyOf: OpBranch[] }
    ).anyOf;

  it.each([
    ["characterChanges", CHARACTER_OPS],
    ["sceneChanges", SCENE_OPS],
    ["itemChanges", ITEM_OPS],
  ])("%s: one closed branch per kind, in submit and repair", (field, ops) => {
    for (const tool of [submit, repair]) {
      const branches = branchesOf(tool, field);
      expect(branches.map((b) => b.properties.kind.const).sort()).toEqual(
        [...opKinds(ops)].sort()
      );
      for (const b of branches) {
        expect(b.additionalProperties).toBe(false);
        expect(b.required).toContain("kind");
      }
    }
  });

  it("offers position as a scene placement only", () => {
    const position = branchesOf(submit, "characterChanges").find(
      (b) => b.properties.kind.const === "position"
    ) as unknown as {
      properties: { position: { properties: { type: { const: string } } } };
    };
    expect(position.properties.position.properties.type.const).toBe("scene");
  });
});

describe("both engine tools stay inside the strict subset", () => {
  // Anthropic compiles a strict tool's schema into a grammar and 400s the
  // whole request on any keyword outside its subset. Measured before strict
  // went on: `starting` returned as a JSON string, a submission shattered
  // into seven parallel calls — each a full-world repair round.
  const FORBIDDEN = [
    "minimum",
    "maximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "pattern",
    "maxItems",
    "oneOf",
    "patternProperties",
  ];
  const violations = (node: unknown, path: string, out: string[]): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => violations(v, `${path}[${i}]`, out));
      return;
    }
    const o = node as Record<string, unknown>;
    if (o.type === "object" && o.additionalProperties !== false) {
      out.push(`${path}: object without additionalProperties:false`);
    }
    for (const k of FORBIDDEN) if (k in o) out.push(`${path}: ${k}`);
    if ("minItems" in o && ![0, 1].includes(o.minItems as number)) {
      out.push(`${path}: minItems=${o.minItems}`);
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === "enum" || k === "required" || k === "const") continue;
      violations(v, `${path}.${k}`, out);
    }
  };

  it.each([
    ["submit_resolution", submitResolutionTool],
    ["repair_resolution", repairResolutionTool],
  ])("%s stays strict-compatible", (_name, tool) => {
    const out: string[] = [];
    violations(tool.inputSchema, "schema", out);
    expect(out).toEqual([]);
  });

  // The limit the docs do not mention and the API enforces: at most 24
  // optional parameters across every strict tool in one request, counted
  // through every nesting level. Measured live: 111 → 400. A tool may only
  // ask for strict when it fits; today neither does, and this says by how
  // much, so the flag can be flipped the day it does.
  const ANTHROPIC_OPTIONAL_LIMIT = 24;
  const optionals = (node: unknown, out: string[], path = ""): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => optionals(v, out, `${path}[${i}]`));
      return;
    }
    const o = node as Record<string, unknown>;
    if (o.type === "object" && o.properties) {
      const required = new Set((o.required as string[] | undefined) ?? []);
      for (const k of Object.keys(o.properties as Record<string, unknown>)) {
        if (!required.has(k)) out.push(`${path}.${k}`);
      }
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === "enum" || k === "required" || k === "const") continue;
      optionals(v, out, `${path}.${k}`);
    }
  };

  it("asks for strict only within Anthropic's optional-parameter budget", () => {
    let total = 0;
    for (const tool of [submitResolutionTool, repairResolutionTool]) {
      const out: string[] = [];
      optionals(tool.inputSchema, out);
      if (tool.strict) total += out.length;
    }
    expect(total).toBeLessThanOrEqual(ANTHROPIC_OPTIONAL_LIMIT);
  });

  it("documents why the engine tools are not strict today", () => {
    // The exact totals, so a schema change that moves them is noticed here
    // rather than in a 400 from the API. Flat shape (2026-09): the ending
    // entry lost its nested occurrence (and two duration fields), the
    // occurrence row traded `participants`/`entityRefs` objects for
    // `actorId`/`targetIds`/`affectedIds`/`refIds` — 38 for submit, 63 for
    // repair (every item field goes optional there, plus the address
    // fields). Both still well over the limit of 24.
    const submitOptionals: string[] = [];
    optionals(submitResolutionTool.inputSchema, submitOptionals);
    const repairOptionals: string[] = [];
    optionals(repairResolutionTool.inputSchema, repairOptionals);
    expect(submitOptionals.length).toBe(38);
    expect(repairOptionals.length).toBe(63);
    expect(submitOptionals.length).toBeGreaterThan(ANTHROPIC_OPTIONAL_LIMIT);
    expect(submitResolutionTool.strict).toBe(false);
    expect(repairResolutionTool.strict).toBe(false);
  });
});
