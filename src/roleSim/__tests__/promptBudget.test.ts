import { describe, expect, it } from "vitest";
import { budgetBreakdown, estimateTokens } from "../promptBudget.js";

describe("estimateTokens", () => {
  it("charges CJK far more per character than prose", () => {
    // The whole point: one chars/N ratio would be wrong by ~3x across the
    // blocks of a prompt whose memories are Chinese and whose instructions
    // are English.
    const cjk = estimateTokens("守住花店活过这个冬天");
    const ascii = estimateTokens("Keep the shop open through the winter");

    expect(cjk / 10).toBeGreaterThan(1);
    expect(ascii / 37).toBeLessThan(0.4);
  });

  it("lands within 5% on a real role-sim prompt shape", () => {
    // 19,961 CJK + 18,425 other characters was billed at 28,483 tokens.
    const text = "字".repeat(19961) + "a".repeat(18425);
    const error = Math.abs(estimateTokens(text) - 28483) / 28483;
    expect(error).toBeLessThan(0.05);
  });
});

describe("budgetBreakdown", () => {
  it("reports shares that sum to 100", () => {
    const { entries } = budgetBreakdown([
      { label: "memories", text: "字".repeat(1000) },
      { label: "decide", text: "a".repeat(300) },
    ]);
    const sum = entries.reduce((n, e) => n + e.share, 0);
    expect(sum).toBeCloseTo(100, 5);
    expect(entries[0].label).toBe("memories");
  });

  it("rescales to the provider's total, keeping the estimator's split", () => {
    const parts = [
      { label: "a", text: "字".repeat(1000) },
      { label: "b", text: "字".repeat(3000) },
    ];
    const { entries, total } = budgetBreakdown(parts, 8000);

    expect(total).toBe(8000);
    expect(entries.reduce((n, e) => n + e.tokens, 0)).toBe(8000);
    expect(entries.find((e) => e.label === "b")!.share).toBeCloseTo(75, 5);
  });
});
