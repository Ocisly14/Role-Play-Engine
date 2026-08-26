import { describe, expect, it } from "vitest";
import { parseActionText } from "../interpreter/gameInterpreter.js";
import type { PerceivableDirectory } from "../../state/perceivableDirectory.js";

const directory: PerceivableDirectory = {
  characters: new Set(["Smith"]),
  items: new Set(["ITEM_1", "ITEM_2"]),
  scenes: new Set(["SCN_1"]),
};

describe("parseActionText — canonical format", () => {
  it("parses narrative + references with real newlines", () => {
    const text =
      "[narrative]\nI hold up the ledger [1] and ask Smith [2].\n\n" +
      "[references]\n[1] id: ITEM_1; kind: item\n[2] id: Smith; kind: character";
    const result = parseActionText(text, directory);
    expect(result.narrative).toContain("ledger [1]");
    expect(result.referencedEntities).toEqual([
      { id: "ITEM_1", kind: "item" },
      { id: "Smith", kind: "character" },
    ]);
  });

  it("treats fence-less text with no citations as plain narrative", () => {
    const result = parseActionText("I stretch and yawn.", directory);
    expect(result.narrative).toBe("I stretch and yawn.");
    expect(result.referencedEntities).toEqual([]);
  });
});

describe("parseActionText — model-output leniency", () => {
  it("decodes literal \\n escapes when the text has no real newlines", () => {
    const text =
      "[narrative]\\nI check the tickets [1] against the jewelry [2].\\n\\n" +
      "[references]\\n[1] id: ITEM_1; kind: item\\n[2] id: ITEM_2; kind: item";
    const result = parseActionText(text, directory);
    expect(result.referencedEntities).toEqual([
      { id: "ITEM_1", kind: "item" },
      { id: "ITEM_2", kind: "item" },
    ]);
  });

  it("keeps real newlines untouched even when literal \\n also appears", () => {
    const text =
      "[narrative]\nI mutter about the sign that reads \\n twice.\n\n" +
      "[references]";
    const result = parseActionText(text, directory);
    expect(result.narrative).toContain("\\n twice");
  });

  it("accepts [narrative] with inline content after the header", () => {
    const text =
      "[narrative]I sit down beside Smith [1].\n\n" +
      "[references]\n[1] id: Smith; kind: character";
    const result = parseActionText(text, directory);
    expect(result.narrative).toBe("I sit down beside Smith [1].");
    expect(result.referencedEntities).toEqual([
      { id: "Smith", kind: "character" },
    ]);
  });

  it("still rejects a citation with no matching reference line", () => {
    expect(() =>
      parseActionText("[narrative]\nI wave at Smith [1].", directory)
    ).toThrow(/missing from \[references\]/);
  });

  it("still rejects references whose id is out of perceivable scope", () => {
    const text =
      "[narrative]\nI grab the idol [1].\n\n" +
      "[references]\n[1] id: ITEM_UNSEEN; kind: item";
    expect(() => parseActionText(text, directory)).toThrow(
      /not in perceivable scope/
    );
  });
});
