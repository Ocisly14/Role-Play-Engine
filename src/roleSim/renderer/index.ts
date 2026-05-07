// src/roleSim/renderer/index.ts
//
// Phase G renderer entry. Two modes:
//   render(...)      — LLM call (Haiku-tier per G6) with retry; falls back
//                      to deterministic god-eye prose on failure (G11).
//   renderFallback(...) — direct god-eye path, used by tests and as the
//                      fallback target.

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { buildGodEyeFallback } from "./godEyeFallback.js";
import { renderViaLLM } from "./llmRenderer.js";
import type { PerceivedBundle, RenderedPerception } from "./types.js";

export type {
  PerceivedBundle,
  OwnActionState,
  RenderedPerception,
} from "./types.js";
export { buildPerceivedBundle } from "./buildBundle.js";
export { buildGodEyeFallback } from "./godEyeFallback.js";

export interface RenderParams {
  npcId: string;
  bundle: PerceivedBundle;
  dgsm: DynamicGameStateManager;
  language?: string;
}

/** Render via LLM with built-in retry; on hard failure, degrade to god-eye. */
export async function render(
  params: RenderParams
): Promise<RenderedPerception> {
  try {
    const narrative = await renderViaLLM(params);
    if (narrative.trim().length === 0) {
      console.warn(
        `[renderer] LLM returned empty output for ${params.npcId}, falling back`
      );
      return {
        narrative: buildGodEyeFallback(
          params.npcId,
          params.bundle,
          params.dgsm
        ),
        llmSucceeded: false,
      };
    }
    return { narrative, llmSucceeded: true };
  } catch (err) {
    console.warn(
      `[renderer] LLM call failed for ${params.npcId}, falling back:`,
      err instanceof Error ? err.message : err
    );
    return {
      narrative: buildGodEyeFallback(params.npcId, params.bundle, params.dgsm),
      llmSucceeded: false,
    };
  }
}

/** Direct god-eye path. Synchronous, no LLM. */
export function renderFallback(params: RenderParams): RenderedPerception {
  return {
    narrative: buildGodEyeFallback(params.npcId, params.bundle, params.dgsm),
    llmSucceeded: false,
  };
}
