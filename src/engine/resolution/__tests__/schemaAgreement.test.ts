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
import { PERCEPTION_CLARITIES } from "../../actions/types.js";
import {
  CHARACTER_OPS,
  CODE_TOOL_SPECS,
  ITEM_OPS,
  type RawActionEnd,
  type RawActionStart,
  type RawCharacterChange,
  type RawOccurrence,
  type RawPerceiver,
  type RawSanityCheck,
  type RawTickResolution,
  SCENE_OPS,
  SUBMIT_TOOLS,
  opKinds,
  submitActionsTool,
  submitEffectsTool,
} from "../worldDeltaSchema.js";

type Schema = {
  properties: Record<string, Schema & { items?: Schema }>;
  required?: string[];
};

/** The two terminal tools partition one resolution, so the agreement tests
 *  below read them as the single object they describe between them. What the
 *  split changes is which provider compiles which half into a grammar — not
 *  the wire contract, which is asserted here exactly as before. */
const submit = {
  properties: {
    ...((submitActionsTool.inputSchema as unknown as Schema).properties ?? {}),
    ...((submitEffectsTool.inputSchema as unknown as Schema).properties ?? {}),
  },
  required: [
    ...((submitActionsTool.inputSchema as unknown as Schema).required ?? []),
    ...((submitEffectsTool.inputSchema as unknown as Schema).required ?? []),
  ],
} as Schema;

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
  "check",
  "opposedBy",
  "movement"
);
// Written in wire order, not alphabetical: the flat shape relies on it (see
// "an occurrence row cites its actions via actionIds and carries content last").
const END = fields<RawActionEnd>()("actionId", "outcome");
const OCCURRENCE = fields<RawOccurrence>()(
  "actionIds",
  "speech",
  "targetIds",
  "perceivers",
  "sanityChecks",
  "content"
);
const PERCEIVER = fields<RawPerceiver>()("characterId", "clarity");
const SANITY_CHECK = fields<RawSanityCheck>()(
  "characterId",
  "failureLoss",
  "consequence"
);
const DELTA = fields<RawCharacterChange>()(
  "sourceActionId",
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

// Adding a field to any of these interfaces stops the build here, by name.
const _covers: [
  Covers<RawActionStart, (typeof START)[number]>,
  Covers<RawActionEnd, (typeof END)[number]>,
  Covers<RawOccurrence, (typeof OCCURRENCE)[number]>,
  Covers<RawPerceiver, (typeof PERCEIVER)[number]>,
  Covers<RawCharacterChange, (typeof DELTA)[number]>,
  Covers<RawTickResolution, (typeof RESOLUTION)[number]>,
] = [true, true, true, true, true, true];
void _covers;

describe("the tool schema and the TS types describe the same thing", () => {
  it("the two tools together carry exactly the top-level lists the type has", () => {
    expect(propsOf(submit)).toEqual(sorted(RESOLUTION));
  });

  it("starting carries the fields of RawActionStart", () => {
    expect(propsOf(submit.properties.starting.items)).toEqual(sorted(START));
  });

  it("ending carries the fields of RawActionEnd", () => {
    expect(propsOf(submit.properties.ending.items)).toEqual(sorted(END));
  });

  it("an occurrence row cites its actions via actionIds and carries content last", () => {
    // The trace of an ending no longer hangs off the ending: it is a flat
    // row here, tied back by `actionIds`. Ids and flags first, the one long
    // string LAST, and the ending entry is two scalars with the paragraph
    // last — generation is left-to-right, so the order is the design, not a
    // style: the model never has to close a deep object and then come back
    // for a sibling scalar (the brace slip every unreadable DeepSeek
    // submission made in two measured runs).
    expect(propsOf(submit.properties.occurrences.items)).toEqual(
      sorted(OCCURRENCE)
    );
    const occurrenceOrder = Object.keys(
      submit.properties.occurrences.items?.properties ?? {}
    );
    expect(occurrenceOrder).toEqual([...OCCURRENCE]);
    expect(occurrenceOrder.at(-1)).toBe("content");
    expect(
      Object.keys(submit.properties.ending.items?.properties ?? {})
    ).toEqual(["actionId", "outcome"]);
  });

  it("a perceiver entry matches RawPerceiver, and its clarity is the shared enum", () => {
    // The list used to be bare ids; what came back is one narrow field, the
    // per-perceiver grade. The enum the model is shown and the one the
    // validator accepts are the same constant, not two hand-kept lists.
    const perceivers = submit.properties.occurrences.items?.properties
      .perceivers as Schema & { items?: Schema; minItems?: number };
    expect(propsOf(perceivers.items)).toEqual(sorted(PERCEIVER));
    expect(perceivers.items?.required).toEqual(["characterId", "clarity"]);
    expect(perceivers.minItems).toBe(1);
    const clarity = perceivers.items?.properties.clarity as
      | { type?: string; enum?: unknown }
      | undefined;
    expect(clarity?.type).toBe("string");
    expect(clarity?.enum).toEqual([...PERCEPTION_CLARITIES]);
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
      expect(props).not.toContain("causalBasis");
      expect(props).toContain("operation");
    }
    expect(propsOf(submit.properties.characterChanges.items)).toEqual(
      sorted(DELTA)
    );
  });
});

describe("what the schema marks required", () => {
  it("keeps an ending flat: no nested occurrence, actionId and outcome both required", () => {
    // The trace used to be a required `occurrence` object on the entry, so
    // the rule needed no validator; now it is the validator's job (every
    // ending must be cited by an occurrence's `actionIds`), and the entry
    // carries nothing the model has to close.
    expect(
      submit.properties.ending.items?.properties.occurrence
    ).toBeUndefined();
    expect(submit.properties.ending.items?.required).toEqual([
      "actionId",
      "outcome",
    ]);
    // `content` is conditionally required (speech false), so it stays out of
    // `required` and the condition lives in its description and the validator.
    expect(submit.properties.occurrences.items?.required).toEqual([
      "actionIds",
      "speech",
      "perceivers",
    ]);
    const content = submit.properties.occurrences.items?.properties.content as
      | { description?: string }
      | undefined;
    expect(content?.description).toContain("REQUIRED when speech is false");
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

  it("makes outcome a paragraph, not a verdict", () => {
    // The enum (success/partial/failure/blocked) is gone: nothing downstream
    // read it, and its conditional rules were 81 of 188 repair lines in one
    // measured run. What remains is the account the actor is told.
    const outcome = submit.properties.ending.items?.properties.outcome as
      | { type?: string; enum?: unknown; description?: string }
      | undefined;
    expect(outcome?.type).toBe("string");
    expect(outcome?.enum).toBeUndefined();
    expect(outcome?.description).not.toContain("endingNeedsOutcome");
  });

  it("says what a speech row is and what it waives", () => {
    const speech = submit.properties.occurrences.items?.properties.speech as
      | { type?: string; description?: string }
      | undefined;
    expect(speech?.type).toBe("boolean");
    expect(speech?.description).toContain("needs no `ending` entry");
    expect(speech?.description).toContain("TWO rows");
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
    const command = (
      commandId: string,
      declaredSkillId?: string,
      utterance?: string
    ) => ({
      commandId,
      actorId: "npc_1",
      issuedAt: "1923-04-02T09:15:00",
      issuedSceneId: "SCN_1",
      description: "I pretend to browse.",
      objectRefs: [],
      proposedDurationTicks: 2,
      ...(declaredSkillId ? { declaredSkillId } : {}),
      ...(utterance ? { utterance } : {}),
    });

    const worklist = resolutionWorklist({
      trigger: {
        triggers: [],
        actionIds: ["action_bare", "action_skilled", "action_spoken"],
      },
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
        newCommands: [
          command("bare"),
          command("skilled", "Social"),
          command("spoken", undefined, "喂。"),
        ],
        activeActions: [],
      },
      events: { objectiveWorldEvents: [], deterministicResults: [] },
    } as never);

    expect(worklist.starting).toEqual([
      "action_bare",
      "action_skilled",
      "action_spoken",
    ]);
    expect(worklist.startingWithoutSkill).toEqual([
      "action_bare",
      "action_spoken",
    ]);
    // The words are not said yet: the id is flagged, and not as ending.
    expect(worklist.startingWithUtterance).toEqual(["action_spoken"]);
    expect(worklist.endingWithUtterance).toEqual([]);
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
  ])("%s: one closed branch per kind", (field, ops) => {
    const branches = branchesOf(submit, field);
    expect(branches.map((b) => b.properties.kind.const).sort()).toEqual(
      [...opKinds(ops)].sort()
    );
    for (const b of branches) {
      expect(b.additionalProperties).toBe(false);
      expect(b.required).toContain("kind");
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

describe("the Engine submission schema and provider limits", () => {
  // Anthropic compiles a strict tool's schema into a grammar and 400s the
  // whole request on any keyword outside its subset. Measured before strict
  // went on: `starting` returned as a JSON string, a submission shattered
  // into seven parallel calls — each a full-world correction round.
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

  it("both submission tools stay strict-compatible", () => {
    const out: string[] = [];
    for (const tool of SUBMIT_TOOLS)
      violations(tool.inputSchema, tool.name, out);
    expect(out).toEqual([]);
  });

  // The limit the API enforces (now documented): at most 24 optional
  // parameters across every strict tool in one request, counted through
  // every nesting level. Measured live: 111 → 400. A tool may only ask for
  // strict when it fits, and this says by how much.
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

  const branchCount = (node: unknown): number => {
    if (!node || typeof node !== "object") return 0;
    if (Array.isArray(node)) {
      return node.reduce<number>((n, v) => n + branchCount(v), 0);
    }
    const o = node as Record<string, unknown>;
    let n = Array.isArray(o.anyOf) ? (o.anyOf as unknown[]).length : 0;
    for (const [k, v] of Object.entries(o)) {
      if (k === "enum" || k === "required" || k === "const") continue;
      n += branchCount(v);
    }
    return n;
  };

  it("asks for strict only within Anthropic's optional-parameter budget", () => {
    let total = 0;
    for (const tool of [...CODE_TOOL_SPECS, ...SUBMIT_TOOLS]) {
      const out: string[] = [];
      optionals(tool.inputSchema, out);
      if (tool.strict) total += out.length;
    }
    expect(total).toBeLessThanOrEqual(ANTHROPIC_OPTIONAL_LIMIT);
  });

  it("keeps the grammar on the half that compiles, and only that half", () => {
    // Probed live against claude-sonnet-5 on 2026-09-03 with
    // scripts/probe-strict-schema.ts (`--sweep`, `--sweep-occ`). Anthropic
    // publishes two ceilings — 20 strict tools, 24 optional parameters across
    // them — and enforces a third it does not put a number on: the size of the
    // compiled grammar. This is that number, measured:
    //
    //   STRICT SET                                    opt  anyOf  verdict
    //   starting+ending                                 6      0  accepted ← production
    //   starting+ending + occurrences                  10      0  accepted
    //   starting+ending + a 1..7-branch union           6    1-7  accepted
    //   starting+ending + occurrences + 1..5 branches  10    1-5  accepted
    //   starting+ending + occurrences + 6 branches     10      6  GRAMMAR TOO LARGE
    //   starting+ending + occurrences + characterChanges 10    7  GRAMMAR TOO LARGE
    //   …+ itemChanges                                 18     11  GRAMMAR TOO LARGE
    //   the three change lists, unions merged          19     16  GRAMMAR TOO LARGE
    //   the four effect lists                          17     19  GRAMMAR TOO LARGE
    //   all six lists                                  23     19  GRAMMAR TOO LARGE
    //
    // Three things follow, and they are the reason this table is written down
    // rather than re-derived:
    //
    //  1. What is bounded is TOTAL grammar mass, not branch count. A 7-branch
    //     union compiles beside `starting`/`ending`; the same union stops
    //     compiling once `occurrences` — which has no `anyOf` at all — joins
    //     them. `anyOf` is the most expensive item on the bill, not the bill.
    //  2. The budget is roughly "the action half, plus one small thing". With
    //     `occurrences` also strict there is room for exactly 5 more branches.
    //     `CHARACTER_OPS` collapses to 6 (its `hp`/`fatigue` row is the only
    //     one sharing a field list) — one over, which is as close as this gets.
    //  3. Simplifying the operation unions does NOT rescue them. Folding
    //     connection×3→1 and environment×2→1 takes 19 branches to 16 and costs
    //     6 optionals; at 16 branches with a legal optional count it is still
    //     refused. 19 is not marginally over the ceiling, it is about 4x over.
    //
    // So the current partition is not a first draft — it is the only useful
    // arrangement the API accepts, and the effect lists cannot be brought
    // under a grammar by rearranging or simplifying them. Numbers here are
    // pinned, not just the flags: an optional added to `starting`, or an
    // `anyOf` introduced anywhere in the strict half, is a change that can
    // stop the tool compiling, and it should be caught here rather than in a
    // 400 from the API. Re-measure with the probe when the model changes —
    // these were taken on the MEDIUM class the Engine actually runs on.
    const actionOptionals: string[] = [];
    optionals(submitActionsTool.inputSchema, actionOptionals);
    const effectOptionals: string[] = [];
    optionals(submitEffectsTool.inputSchema, effectOptionals);

    expect(submitActionsTool.strict).toBe(true);
    expect(actionOptionals.length).toBe(6);
    expect(branchCount(submitActionsTool.inputSchema)).toBe(0);

    expect(submitEffectsTool.strict).toBe(false);
    expect(effectOptionals.length).toBe(17);
    expect(branchCount(submitEffectsTool.inputSchema)).toBe(19);

    // Together they are still the same 23 optionals over the same six lists.
    expect(actionOptionals.length + effectOptionals.length).toBe(23);
    expect(
      [
        ...((submitActionsTool.inputSchema as { required?: string[] })
          .required ?? []),
        ...((submitEffectsTool.inputSchema as { required?: string[] })
          .required ?? []),
      ].sort()
    ).toEqual(
      [
        "starting",
        "ending",
        "characterChanges",
        "sceneChanges",
        "itemChanges",
        "occurrences",
      ].sort()
    );
  });

  it("gives each list to exactly one of the two tools", () => {
    const action = Object.keys(
      (submitActionsTool.inputSchema as { properties: object }).properties
    );
    const effect = Object.keys(
      (submitEffectsTool.inputSchema as { properties: object }).properties
    );
    expect(action.filter((f) => effect.includes(f))).toEqual([]);
    expect([...action, ...effect].sort()).toEqual(sorted(RESOLUTION));
  });
});
