import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rulesDir = new URL("../", import.meta.url);
const injectedRuleFiles = [
  "world-action-resolution.md",
  "weather-judgement.md",
  "sanity-check.md",
  "session-protocol.md",
  "world/action-adjudication.md",
  "world/movement-and-position.md",
  "world/character-changes.md",
  "world/item-changes.md",
  "world/scene-changes.md",
  "world/perception.md",
  "world/occurrences-and-dialogue.md",
  ...readdirSync(new URL("../skills/", import.meta.url))
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => `skills/${name}`),
];

describe("Engine prompt rule language", () => {
  it.each(injectedRuleFiles)("keeps %s in English", (relativePath) => {
    const text = readFileSync(new URL(relativePath, rulesDir), "utf8");
    expect(
      text,
      `${relativePath} contains Han-script instruction text`
    ).not.toMatch(/\p{Script=Han}/u);
  });
});
