// The six phase tools exist for one reason: the unified submission does not
// compile into a grammar, so the model is left to prose for the four lists that
// carry the operation unions. Cutting the same six arrays into six requests is
// only worth anything if each piece really is smaller AND the accepted element
// shapes did not quietly change on the way. Both halves are asserted here — the
// second one by object identity, because a copied schema that merely matches
// today is exactly the drift this suite exists to prevent.

import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../../../models/providers/types.js";
import {
  CHARACTER_CHANGES_LIST,
  CHARACTER_OPS,
  ITEM_CHANGES_LIST,
  ITEM_OPS,
  OCCURRENCES_LIST,
  SCENE_CHANGES_LIST,
  SCENE_OPS,
  STARTING_LIST,
  opKinds,
} from "../worldDeltaSchema.js";
import {
  PHASE_FIELDS,
  PHASE_TOOLS,
  PHASE_TOOLS_NON_STRICT,
  PHASE_TOOL_NAMES,
  PHASE_TOOL_NAME_SET,
  RESOLUTION_PHASES,
  type ResolutionPhase,
  phaseOfTool,
  phaseTool,
  schemaFingerprint,
} from "../worldResolutionStageSchemas.js";

type Node = Record<string, unknown>;

const schemaOf = (phase: ResolutionPhase): Node =>
  PHASE_TOOLS[phase].inputSchema as Node;

const propertyOf = (phase: ResolutionPhase): Node =>
  (schemaOf(phase).properties as Node)[PHASE_FIELDS[phase]] as Node;

/** The five domain lists as `worldDeltaSchema.ts` exports them, keyed by the
 *  field each phase submits. */
const domainLists: Node = {
  starting: STARTING_LIST,
  characterChanges: CHARACTER_CHANGES_LIST,
  itemChanges: ITEM_CHANGES_LIST,
  sceneChanges: SCENE_CHANGES_LIST,
  occurrences: OCCURRENCES_LIST,
};

/** Walks every schema node, skipping the keywords whose VALUES are data rather
 *  than sub-schemas (`enum` members, `required` names, a `const` literal). */
const walk = (
  node: unknown,
  path: string,
  visit: (o: Node, p: string) => void
): void => {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`, visit));
    return;
  }
  const o = node as Node;
  visit(o, path);
  for (const [k, v] of Object.entries(o)) {
    if (k === "enum" || k === "required" || k === "const") continue;
    walk(v, `${path}.${k}`, visit);
  }
};

const optionalsOf = (node: unknown): string[] => {
  const out: string[] = [];
  walk(node, "", (o, path) => {
    if (o.type !== "object" || !o.properties) return;
    const required = new Set((o.required as string[] | undefined) ?? []);
    for (const key of Object.keys(o.properties as Node)) {
      if (!required.has(key)) out.push(`${path}.${key}`);
    }
  });
  return out;
};

const branchCountOf = (node: unknown): number => {
  let n = 0;
  walk(node, "", (o) => {
    if (Array.isArray(o.anyOf)) n += (o.anyOf as unknown[]).length;
  });
  return n;
};

describe("the six phase tools", () => {
  it("names one tool per phase, in execution order", () => {
    expect([...RESOLUTION_PHASES]).toEqual([
      "endings",
      "starts",
      "characterChanges",
      "itemChanges",
      "sceneChanges",
      "occurrences",
    ]);
    expect(RESOLUTION_PHASES.map((p) => PHASE_TOOL_NAMES[p])).toEqual([
      "submit_endings",
      "submit_starts",
      "submit_character_changes",
      "submit_item_changes",
      "submit_scene_changes",
      "submit_occurrences",
    ]);
    expect([...PHASE_TOOL_NAME_SET].sort()).toEqual(
      RESOLUTION_PHASES.map((p) => PHASE_TOOL_NAMES[p]).sort()
    );
    for (const phase of RESOLUTION_PHASES) {
      expect(phaseOfTool(PHASE_TOOL_NAMES[phase])).toBe(phase);
    }
    // A tool name that belongs to no phase is a different event from a phase
    // calling the wrong phase's tool, and the runner answers them differently.
    expect(phaseOfTool("damageRoll")).toBeUndefined();
    expect(phaseOfTool("submit_actions")).toBeUndefined();
  });

  it("maps each phase to the one field it submits", () => {
    expect(PHASE_FIELDS).toEqual({
      endings: "endings",
      starts: "starting",
      characterChanges: "characterChanges",
      itemChanges: "itemChanges",
      sceneChanges: "sceneChanges",
      occurrences: "occurrences",
    });
  });

  it.each([...RESOLUTION_PHASES])(
    "%s takes exactly one required top-level array",
    (phase) => {
      const schema = schemaOf(phase);
      const field = PHASE_FIELDS[phase];
      expect(schema.type).toBe("object");
      expect(Object.keys(schema.properties as Node)).toEqual([field]);
      expect(schema.required).toEqual([field]);
      expect(schema.additionalProperties).toBe(false);
      expect(propertyOf(phase).type).toBe("array");
    }
  );

  it.each([...RESOLUTION_PHASES])(
    "%s closes every object it declares",
    (phase) => {
      const open: string[] = [];
      walk(schemaOf(phase), PHASE_TOOL_NAMES[phase], (o, path) => {
        if (o.type === "object" && o.additionalProperties !== false) {
          open.push(path);
        }
      });
      expect(open).toEqual([]);
    }
  );

  it("asks every phase for a grammar, and the fallback copy differs only in that", () => {
    for (const phase of RESOLUTION_PHASES) {
      const strict = PHASE_TOOLS[phase];
      const loose = PHASE_TOOLS_NON_STRICT[phase];
      expect(strict.strict).toBe(true);
      expect(loose.strict).toBe(false);
      expect(loose.name).toBe(strict.name);
      expect(loose.description).toBe(strict.description);
      expect(loose.inputSchema).toEqual(strict.inputSchema);
      expect(phaseTool(phase)).toBe(strict);
      expect(phaseTool(phase, { strict: true })).toBe(strict);
      expect(phaseTool(phase, { strict: false })).toBe(loose);
    }
  });

  it("tells every phase that its array is required and that history is read-only", () => {
    for (const phase of RESOLUTION_PHASES) {
      const description = PHASE_TOOLS[phase].description;
      expect(description).toContain("REQUIRED");
      expect(description).toContain("`[]`");
      expect(description).toContain("read-only");
      // The staged tools replace the unified submission; naming it would tell
      // the model to call something that is no longer offered.
      for (const dead of [
        "submit_actions",
        "submit_effects",
        "submit_resolution",
        "repair_resolution",
      ]) {
        expect(description).not.toContain(dead);
      }
    }
  });
});

describe("the endings phase is a decision, not a RawActionEnd", () => {
  type Branch = {
    type: string;
    properties: Record<string, { const?: string; description?: string }>;
    required: string[];
    additionalProperties: boolean;
  };
  const branches = (propertyOf("endings").items as Node).anyOf as Branch[];

  it("offers exactly two closed branches, discriminated by mode", () => {
    expect(branches).toHaveLength(2);
    expect(branches.map((b) => b.properties.mode.const)).toEqual([
      "outcome",
      "pure_speech",
    ]);
    for (const branch of branches) {
      expect(branch.type).toBe("object");
      expect(branch.additionalProperties).toBe(false);
      expect([...branch.required].sort()).toEqual(
        Object.keys(branch.properties).sort()
      );
    }
  });

  it("requires an outcome on the outcome branch and forbids one on the other", () => {
    expect([...branches[0].required].sort()).toEqual([
      "actionId",
      "mode",
      "outcome",
    ]);
    expect([...branches[1].required].sort()).toEqual(["actionId", "mode"]);
    expect(branches[1].properties.outcome).toBeUndefined();
  });

  it("states the rule the validator will enforce about each mode", () => {
    const description = (propertyOf("endings") as { description: string })
      .description;
    // "One decision per id" is what makes an absent row correctable: without
    // it, "you left one out" and "it was pure speech" look the same on the wire.
    expect(description).toContain("every id the trigger lists under `ending`");
    expect(description).toContain("`utterance`");
    const outcome = branches[0].properties.outcome;
    expect(outcome.description).toContain("third-person");
    expect(outcome.description).toContain("`diceRoll`");
  });
});

describe("the phase tools carry the very domain lists worldDeltaSchema defines", () => {
  // Identity, not equality: two objects that match today are how a schema and
  // its copy drift apart tomorrow.
  it.each([
    ["starts", "starting"],
    ["characterChanges", "characterChanges"],
    ["itemChanges", "itemChanges"],
    ["sceneChanges", "sceneChanges"],
    ["occurrences", "occurrences"],
  ] as Array<[ResolutionPhase, string]>)(
    "%s reuses the %s list by reference",
    (phase, field) => {
      expect(propertyOf(phase)).toBe(domainLists[field]);
      expect((propertyOf(phase) as { items: unknown }).items).toBe(
        (domainLists[field] as { items: unknown }).items
      );
    }
  );

  it("gives the endings phase its own array, and only that one", () => {
    // A decision is not a `RawActionEnd` row, so no exported list carries it.
    for (const list of Object.values(domainLists)) {
      expect(propertyOf("endings")).not.toBe(list);
    }
  });
});

describe("what the split bought", () => {
  // The measured ceiling behind this refactor: the four effect lists arrive at
  // 19 `anyOf` branches together and the compiler refuses them. Split by
  // domain, no phase carries more than eight.
  const UNIFIED_EFFECT_BRANCHES = 19;

  it.each([
    ["characterChanges", CHARACTER_OPS, 7],
    ["itemChanges", ITEM_OPS, 4],
    ["sceneChanges", SCENE_OPS, 8],
  ] as Array<[ResolutionPhase, typeof CHARACTER_OPS, number]>)(
    "%s carries one branch per operation kind",
    (phase, ops, expected) => {
      expect(branchCountOf(schemaOf(phase))).toBe(expected);
      expect(opKinds(ops).size).toBe(expected);
      expect(expected).toBeLessThan(UNIFIED_EFFECT_BRANCHES);
    }
  );

  it("uses two timing branches for starts and no union for occurrences", () => {
    expect(branchCountOf(schemaOf("starts"))).toBe(2);
    expect(branchCountOf(schemaOf("occurrences"))).toBe(0);
    // The endings decision is a union too, but a two-branch one — the cheapest
    // way to say "required unless" in a grammar that cannot say it.
    expect(branchCountOf(schemaOf("endings"))).toBe(2);
  });

  it("keeps every phase inside Anthropic's optional-parameter budget", () => {
    // 24 across all strict tools in ONE request; a phase request offers one
    // phase tool (plus damageRoll, which has one optional), so the per-tool
    // count is what matters now rather than the sum over six lists.
    const ANTHROPIC_OPTIONAL_LIMIT = 24;
    for (const phase of RESOLUTION_PHASES) {
      expect(optionalsOf(schemaOf(phase)).length).toBeLessThanOrEqual(
        ANTHROPIC_OPTIONAL_LIMIT
      );
    }
    expect(
      RESOLUTION_PHASES.map((p) => optionalsOf(schemaOf(p)).length)
    ).toEqual([0, 6, 0, 8, 5, 4]);
  });

  it("stays inside the strict keyword subset", () => {
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
    const out: string[] = [];
    for (const phase of RESOLUTION_PHASES) {
      walk(schemaOf(phase), PHASE_TOOL_NAMES[phase], (o, path) => {
        for (const k of FORBIDDEN) if (k in o) out.push(`${path}: ${k}`);
        if ("minItems" in o && ![0, 1].includes(o.minItems as number)) {
          out.push(`${path}: minItems=${o.minItems}`);
        }
      });
    }
    expect(out).toEqual([]);
  });
});

describe("schema fingerprints", () => {
  const tool = PHASE_TOOLS.occurrences;

  it("is the same value every time it is asked", () => {
    const a = schemaFingerprint("anthropic", "claude-sonnet-5", tool);
    const b = schemaFingerprint("anthropic", "claude-sonnet-5", tool);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any of the four inputs changes", () => {
    const base = schemaFingerprint("anthropic", "claude-sonnet-5", tool);
    expect(schemaFingerprint("deepseek", "claude-sonnet-5", tool)).not.toBe(
      base
    );
    expect(schemaFingerprint("anthropic", "claude-opus-5", tool)).not.toBe(
      base
    );
    expect(
      schemaFingerprint("anthropic", "claude-sonnet-5", {
        ...tool,
        name: "submit_something_else",
      })
    ).not.toBe(base);

    const edited: ToolSpec = {
      ...tool,
      inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)),
    };
    (edited.inputSchema as Node).additionalProperties = true;
    expect(schemaFingerprint("anthropic", "claude-sonnet-5", edited)).not.toBe(
      base
    );
  });

  it("ignores key order, so a reformatted schema is still the same schema", () => {
    const reordered: ToolSpec = {
      ...tool,
      inputSchema: {
        additionalProperties: false,
        required: (tool.inputSchema as Node).required,
        properties: (tool.inputSchema as Node).properties,
        type: "object",
      },
    };
    expect(schemaFingerprint("anthropic", "claude-sonnet-5", reordered)).toBe(
      schemaFingerprint("anthropic", "claude-sonnet-5", tool)
    );
  });

  it("does not depend on the strict flag — the downgrade is remembered by schema", () => {
    // The fallback asks for the same arguments; if the flag moved the
    // fingerprint, the downgrade would be filed under a key the next strict
    // attempt never looks up.
    expect(
      schemaFingerprint("anthropic", "claude-sonnet-5", PHASE_TOOLS.occurrences)
    ).toBe(
      schemaFingerprint(
        "anthropic",
        "claude-sonnet-5",
        PHASE_TOOLS_NON_STRICT.occurrences
      )
    );
  });

  it("separates the six phases", () => {
    const prints = RESOLUTION_PHASES.map((p) =>
      schemaFingerprint("anthropic", "claude-sonnet-5", PHASE_TOOLS[p])
    );
    expect(new Set(prints).size).toBe(RESOLUTION_PHASES.length);
  });
});
