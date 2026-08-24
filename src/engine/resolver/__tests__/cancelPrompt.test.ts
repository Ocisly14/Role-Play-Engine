import { describe, expect, it } from "vitest";
import {
  buildCancelResolverAction,
  stripActionMarkup,
} from "../cancelPrompt.js";

// The replacement action exactly as npcActionController hands it over —
// this is the real shape from the run where the bug was observed.
const REPLACEMENT =
  'the character turned to something else instead: [narrative]\n我耸耸肩，故作轻松地摆摆手，"没什么新消息"，一边观察布鲁诺·伽利略[1]的表情。\n\n[references]\n[1] id: Bruno Galilei; kind: character';

const cancel = {
  elapsedMinutes: 3,
  plannedDuration: 3,
  reason: REPLACEMENT,
  plannedNarrative: "他走近搭话，对方含糊回应。",
};

describe("stripActionMarkup", () => {
  it("removes the scaffolding and keeps the prose", () => {
    const out = stripActionMarkup(REPLACEMENT);
    expect(out).toContain("我耸耸肩");
    expect(out).not.toContain("[narrative]");
    expect(out).not.toContain("[references]");
    expect(out).not.toContain("[1]");
    expect(out).not.toContain("kind: character");
  });

  it("passes plain reasons through", () => {
    expect(stripActionMarkup("scene forced interruption")).toBe(
      "scene forced interruption"
    );
  });
});

describe("buildCancelResolverAction", () => {
  const out = buildCancelResolverAction("我朝布鲁诺点头走近他", cancel);

  it("leads with the interrupted action, not the replacement", () => {
    // The observed bug: the replacement's full text sat at the top and the
    // resolver narrated it. The interrupted action must come first.
    expect(out.indexOf("我朝布鲁诺点头走近他")).toBeLessThan(
      out.indexOf("我耸耸肩")
    );
  });

  it("keeps the reason but as prose without actionText scaffolding", () => {
    expect(out).toContain("我耸耸肩");
    expect(out).not.toContain("[narrative]");
    expect(out).not.toContain("[references]");
  });

  it("marks the replacement as not yet happened", () => {
    expect(out).toContain("NOT happened yet");
  });

  it("still instructs partial-progress narration with the elapsed time", () => {
    expect(out).toContain("3.0");
    expect(out).toMatch(/ONLY what actually happened/);
  });

  it("omits empty sections", () => {
    const minimal = buildCancelResolverAction("doing X", {
      elapsedMinutes: 1,
      plannedDuration: 5,
      reason: "",
      plannedNarrative: undefined,
    });
    expect(minimal).not.toContain("Why it stopped");
    expect(minimal).not.toContain("Had it completed");
  });
});
