// The act tool schema and RoleSimDecision describe the same wire format —
// and until this file, nothing made the MIDDLE of the pipe agree with its
// ends.
//
// `language` shipped in the tool schema (the mouth) and in the command
// boundary (the stomach), but `buildTerminalDecision` and the controller's
// forwarding spread were written before it existed and silently dropped it.
// The actor declared `skillId: "Languages", language: "Hindi"` — exactly what
// the docs teach — and was rejected with feedback telling her to do what she
// had already done. Twice. A field the model is TOLD about must survive to
// the layer it is JUDGED BY.

import { describe, expect, it } from "vitest";
import type { RoleSimDecision } from "../agent.js";
import { actTool } from "../tools/schemas.js";

type ActDecision = Extract<RoleSimDecision, { tool: "act" }>;

/** Pins the literal tuple type (same curried-identity trick as the engine's
 *  schemaAgreement test — without the literals the coverage check below
 *  collapses to `never` and passes forever). */
const fields =
  <T>() =>
  <K extends ReadonlyArray<keyof T & string>>(...keys: K): K =>
    keys;

/** `true` when the list covers every key of `T`; otherwise a type whose
 *  property NAMES the field added to the decision and missed here. */
type Covers<T, K extends string> = Exclude<keyof T & string, K> extends never
  ? true
  : {
      FIELD_MISSING_FROM_THIS_TEST_AND_MAYBE_THE_SCHEMA: Exclude<
        keyof T & string,
        K
      >;
    };

// `tool` is the discriminant, not a wire field the model fills in.
const ACT = fields<ActDecision>()(
  "tool",
  "description",
  "objectRefs",
  "proposedDurationTicks",
  "skillId",
  "language",
  "utterance"
);

const _covers: Covers<ActDecision, (typeof ACT)[number]> = true;
void _covers;

describe("the act tool schema and RoleSimDecision describe the same thing", () => {
  it("every schema property has a slot in the decision — nothing to drop", () => {
    const schema = actTool.inputSchema as {
      properties: Record<string, unknown>;
    };
    const wireFields = ACT.filter((k) => k !== "tool").sort();
    expect(Object.keys(schema.properties).sort()).toEqual(wireFields);
  });

  it("buildTerminalDecision carries every optional wire field through", async () => {
    // The dropped-field bug lived here: the copy was field-by-field, so a
    // field present in the schema and in the boundary simply vanished.
    const { LLMRoleSimAgent } = await import("../llmAgent.js");
    const agent = Object.create(LLMRoleSimAgent.prototype) as {
      buildTerminalDecision(parsed: Record<string, unknown>): RoleSimDecision;
    };
    const decision = agent.buildTerminalDecision({
      tool: "act",
      description: "我就着窗光读舅舅的信。",
      objectRefs: [{ id: "item.batra_master.sari_trunk", role: "target" }],
      proposedDurationTicks: 8,
      skillId: "Languages",
      language: "Hindi",
      utterance: "……",
    });
    expect(decision).toEqual({
      tool: "act",
      description: "我就着窗光读舅舅的信。",
      objectRefs: [{ id: "item.batra_master.sari_trunk", role: "target" }],
      proposedDurationTicks: 8,
      skillId: "Languages",
      language: "Hindi",
      utterance: "……",
    });
  });
});
