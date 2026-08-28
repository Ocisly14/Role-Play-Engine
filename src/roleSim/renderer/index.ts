// src/roleSim/renderer/index.ts
//
// Phase G renderer entry. Single mode: LLM call with built-in retry
// (maxRetries=2 in llmRenderer). On hard failure (LLM rejects, empty output,
// retry exhausted) returns null — caller (NpcActionController) handles by
// skipping that NPC's decide() this tick. No god-eye fallback (D6).

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { renderViaLLM } from "./llmRenderer.js";
import type { PerceivedBundle, RenderedPerception } from "./types.js";

export type {
  PerceivedBundle,
  OwnActionState,
  RenderedPerception,
} from "./types.js";
export { buildPerceivedBundle } from "./buildBundle.js";

export interface RenderParams {
  npcId: string;
  bundle: PerceivedBundle;
  dgsm: DynamicGameStateManager;
  language?: string;
  /** Everything already rendered for this character, oldest first, excluding
   *  this tick. Lets the renderer say what CHANGED instead of reintroducing
   *  the room every minute. */
  recentPerceptions?: ReadonlyArray<{
    gameDateTime: string;
    location: string;
    narrative: string;
  }>;
}

/**
 * Render via LLM. Returns null on hard failure (caller skips decide() that tick).
 * Empty narrative also counts as failure.
 */
export async function render(
  params: RenderParams
): Promise<RenderedPerception | null> {
  try {
    const narrative = await renderViaLLM(params);
    if (narrative.trim().length === 0) {
      console.warn(
        `[renderer] LLM returned empty output for ${params.npcId}; skipping decide() this tick`
      );
      return null;
    }
    return { narrative };
  } catch (err) {
    console.warn(
      `[renderer] LLM call failed for ${params.npcId}; skipping decide() this tick:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
