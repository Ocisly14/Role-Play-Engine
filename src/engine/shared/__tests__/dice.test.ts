import { describe, expect, it } from "vitest";
import {
  getSuccessLevel,
  getSuccessLevelWithDifficulty,
  isFumble,
} from "../dice.js";

describe("dice fumble thresholds", () => {
  it("treats 98-100 as fumbles regardless of skill value", () => {
    expect(isFumble(97, 5)).toBe(false);
    expect(isFumble(98, 5)).toBe(true);
    expect(isFumble(99, 80)).toBe(true);
    expect(isFumble(100, 99)).toBe(true);
  });

  it("returns fail instead of fumble below 98", () => {
    expect(getSuccessLevel(97, 10)).toBe("fail");
    expect(getSuccessLevelWithDifficulty(97, 80, "regular")).toBe("fail");
  });

  it("still marks 98+ as fumble in regular and difficulty checks", () => {
    expect(getSuccessLevel(98, 80)).toBe("fumble");
    expect(getSuccessLevelWithDifficulty(99, 80, "hard")).toBe("fumble");
  });
});
