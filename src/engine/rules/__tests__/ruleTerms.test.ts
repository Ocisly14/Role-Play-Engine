// The engine's shared definitions are written once (`ruleTerms.ts`). The rule
// documents are prose and cannot import them, so this pins the prose to the
// same words: the LLM settlement and the Decisions fast paths must judge
// against one definition, not two that drifted apart.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHECK_NEED_RULE,
  ENDING_MODE_MEANING,
  ITEM_CONTAINER_MEANING,
  ITEM_PLACEMENT_MEANING,
  STATED_ROUTE_RULE,
  SURROUNDINGS_MEANING,
  TALK_DURATION_RULE,
} from "../ruleTerms.js";

const doc = (name: string): string =>
  readFileSync(path.resolve(__dirname, "../world", name), "utf8").replace(
    /\s+/g,
    " "
  );

describe("rule documents use the defined words", () => {
  const adjudication = doc("action-adjudication.md");

  it("action-adjudication.md defines every ending mode as ruleTerms does", () => {
    for (const [mode, meaning] of Object.entries(ENDING_MODE_MEANING)) {
      expect(adjudication).toContain(`\`mode: "${mode}"\` — ${meaning}.`);
    }
  });

  it("action-adjudication.md states the talk duration rule", () => {
    expect(adjudication).toContain(TALK_DURATION_RULE);
  });

  it("occurrences-and-dialogue.md states the talk duration rule", () => {
    expect(doc("occurrences-and-dialogue.md")).toContain(TALK_DURATION_RULE);
  });

  it("both rule documents state when a check is needed", () => {
    expect(adjudication).toContain(CHECK_NEED_RULE);
    const root = readFileSync(
      path.resolve(__dirname, "../world-action-resolution.md"),
      "utf8"
    ).replace(/\s+/g, " ");
    expect(root).toContain(CHECK_NEED_RULE);
  });

  it("perception.md defines Surroundings as ruleTerms does", () => {
    expect(doc("perception.md")).toContain(SURROUNDINGS_MEANING);
  });

  it("movement-and-position.md states the route rule", () => {
    expect(doc("movement-and-position.md")).toContain(STATED_ROUTE_RULE);
  });

  it("item-changes.md defines placement and container as ruleTerms does", () => {
    const items = doc("item-changes.md");
    expect(items).toContain(ITEM_PLACEMENT_MEANING);
    expect(items).toContain(ITEM_CONTAINER_MEANING);
  });
});
