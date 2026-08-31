// src/roleSim/promptBudget.ts
//
// How much of the character's prompt each part is spending.
//
// Measurement only — nothing here evicts anything yet. The quotas come after
// the numbers, not before.
//
// ── On estimating tokens without a tokenizer ───────────────────────────────
//
// There is no Claude tokenizer in-process, and character count alone is not a
// usable proxy here: this world runs in Chinese, and CJK costs roughly one
// token per character while English prose costs about a third of that. A
// single chars/N ratio is therefore wrong by 3x depending on which block you
// point it at.
//
// So: count the two character classes separately. Calibrated against 13 real
// calls whose provider-reported `input_tokens` we have:
//
//   perception-render   +6.7%
//   role-sim-agent      -1.4%   <- the prompt this file exists to budget
//   world-action-engine -21.6%
//
// The engine is always underestimated because it is pretty-printed JSON:
// indentation and punctuation tokenize far denser than prose. That is fine
// here — this estimator is for the roleSim prompt, where it lands within
// ~2%. Anywhere the true total matters, scale the estimate against the
// provider's reported usage rather than trusting it outright.

const CJK = /[　-鿿＀-￯]/;

/** Tokens per CJK character. */
const CJK_RATE = 1.1;
/** Characters per token for everything else. */
const ASCII_CHARS_PER_TOKEN = 3.0;

export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (CJK.test(ch)) cjk += 1;
  const rest = text.length - cjk;
  return Math.round(cjk * CJK_RATE + rest / ASCII_CHARS_PER_TOKEN);
}

export interface BudgetEntry {
  label: string;
  chars: number;
  tokens: number;
  /** Share of the measured whole, 0-100. */
  share: number;
}

/**
 * Turn labelled chunks into a share table.
 *
 * `actualTotal`, when the provider reported one, rescales every entry so the
 * column sums to what was really billed — the split stays the estimator's,
 * the magnitude becomes the provider's.
 */
export function budgetBreakdown(
  parts: ReadonlyArray<{ label: string; text: string }>,
  actualTotal?: number
): { entries: BudgetEntry[]; total: number } {
  const raw = parts.map((p) => ({
    label: p.label,
    chars: p.text.length,
    tokens: estimateTokens(p.text),
  }));
  const estimated = raw.reduce((n, p) => n + p.tokens, 0);
  const scale =
    actualTotal !== undefined && estimated > 0 ? actualTotal / estimated : 1;
  const total = actualTotal ?? estimated;

  return {
    total,
    entries: raw
      .map((p) => ({
        ...p,
        tokens: Math.round(p.tokens * scale),
        share: total > 0 ? (p.tokens * scale * 100) / total : 0,
      }))
      .sort((a, b) => b.tokens - a.tokens),
  };
}
