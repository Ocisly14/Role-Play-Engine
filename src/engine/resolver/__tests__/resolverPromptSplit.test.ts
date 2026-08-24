import { describe, expect, it } from "vitest";
import type { ActionDefinition } from "../../types.js";
import { type ResolverContext, buildResolverPrompt } from "../stateResolver.js";

// `resolveState` passes `cacheSystemPrompt: true` for the `stable` half. That
// is only correct while `stable` is free of per-request content — one leaked
// action string or dice roll makes every call a unique prefix, so the cache is
// written every time and read never.
const definition = {
  id: "perception",
  description: "Spot hidden things",
  content: "Look carefully at the surroundings.",
  guidanceBody: "Resolve what the character notices.",
} as unknown as ActionDefinition;

function makeCtx(overrides: Partial<ResolverContext> = {}): ResolverContext {
  return {
    action: "I search the rolltop desk for a hidden drawer",
    definition,
    outcomeSection: "",
    stateContext: {
      actorSection: "Actor: Marsh (HP 11/12)",
      worldStateSection: "Scene: study, lamp lit",
    },
    language: "en",
    ...overrides,
  } as unknown as ResolverContext;
}

describe("buildResolverPrompt — cache split", () => {
  it("keeps per-request content out of the cacheable half", () => {
    const { stable, request } = buildResolverPrompt(makeCtx());

    expect(stable).not.toContain("rolltop desk");
    expect(stable).not.toContain("Actor: Marsh");
    expect(stable).not.toContain("Scene: study");

    expect(request).toContain("rolltop desk");
    expect(request).toContain("Actor: Marsh");
  });

  it("keeps the definition guidance in the cacheable half", () => {
    const { stable } = buildResolverPrompt(makeCtx());
    expect(stable).toContain("Resolve what the character notices.");
    expect(stable).toContain("# Definition Guidance");
  });

  it("produces the same cacheable half for different actions", () => {
    // The property the breakpoint depends on: two different actions resolved
    // against the same definition share one cache entry.
    const a = buildResolverPrompt(makeCtx({ action: "I search the desk" }));
    const b = buildResolverPrompt(
      makeCtx({ action: "I peer under the floorboards" })
    );

    expect(a.stable).toBe(b.stable);
    expect(a.request).not.toBe(b.request);
  });

  it("varies the cacheable half when the definition changes", () => {
    const other = buildResolverPrompt(
      makeCtx({
        definition: {
          ...definition,
          id: "listen",
          guidanceBody: "Resolve what the character hears.",
        } as ActionDefinition,
      })
    );
    expect(other.stable).not.toBe(buildResolverPrompt(makeCtx()).stable);
  });

  it("sends a non-empty user turn", () => {
    // Anthropic rejects an empty user message; the resolver used to pass "".
    expect(
      buildResolverPrompt(makeCtx()).request.trim().length
    ).toBeGreaterThan(0);
  });
});
