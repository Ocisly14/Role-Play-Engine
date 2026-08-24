// src/engine/resolver/cancelPrompt.ts
//
// Builds the resolver's `action` input for a cancelled step.
//
// Shared by SimulationRunner and the e2e harness — this used to be duplicated
// in both, and the duplicate carried a real bug: the cancel reason embedded
// the REPLACEMENT action's full actionText (complete with [narrative] /
// [references] scaffolding) at the top of the prompt, and the resolver
// sometimes narrated THAT — writing a memory for an action that had not
// happened yet, which then duplicated when the replacement actually ran.
//
// The fix keeps the reason (an interruption's cause belongs in the memory:
// "he spoke first" reads truer than "my action stopped") but strips it down
// to plain prose and explicitly marks the replacement as not-yet-happened.

import type { ResolveCancelContext } from "../core/tickOrchestrator.js";

/**
 * Reduce an actionText (or a free-form cancel reason that may embed one) to
 * plain prose: drop the [references] block, the [narrative] header, and the
 * [N] citation markers. Non-actionText strings pass through unchanged apart
 * from whitespace collapsing.
 */
export function stripActionMarkup(text: string): string {
  let out = text;
  // Drop everything from the [references] header onward.
  const refIdx = out.indexOf("[references]");
  if (refIdx !== -1) out = out.slice(0, refIdx);
  out = out.replace(/\[narrative\]/g, " ");
  // Citation markers like [1], [2] — but not e.g. [CANCELLED ...].
  out = out.replace(/\[(\d+)\]/g, "");
  return out.replace(/\s+/g, " ").trim();
}

/**
 * The resolver input for a cancelled step. Ordering is deliberate:
 * the interrupted action comes FIRST (it is what must be narrated), the
 * reason follows as stripped prose with an explicit not-yet-happened guard,
 * and the instruction closes. The old shape led with the replacement
 * action's full text, which the model then narrated instead.
 */
export function buildCancelResolverAction(
  originalActionText: string,
  cancel: ResolveCancelContext
): string {
  const elapsed = cancel.elapsedMinutes.toFixed(1);
  const planned = cancel.plannedDuration.toFixed(1);
  const reason = stripActionMarkup(cancel.reason);

  return [
    `The character was doing: "${originalActionText}"`,
    `It was INTERRUPTED after ${elapsed} of the planned ${planned} minutes.`,
    reason
      ? `Why it stopped: ${reason}\n(Whatever the character turned to next has NOT happened yet — do not narrate it.)`
      : "",
    cancel.plannedNarrative
      ? `Had it completed, the outcome would have been: ${cancel.plannedNarrative}`
      : "",
    `Narrate ONLY what actually happened during those ${elapsed} minutes of the interrupted action — partial progress, and any state changes that already took effect. Keep the memory.event SHORT.`,
  ]
    .filter(Boolean)
    .join("\n");
}
