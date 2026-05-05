import { vi } from "vitest";
import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  type DispatcherDeps,
  TOOL_CAPS,
  dispatchInstantTool,
} from "../toolDispatcher.js";

interface Calls {
  add: Array<Record<string, unknown>>;
  query: Array<Record<string, unknown>>;
  getMapSnapshot: number;
}

function makeDeps(opts?: {
  scenes?: Map<string, { id: string; name: string }>;
  junctions?: Map<string, { id: string; name: string }>;
  roads?: Map<string, { id: string; name: string }>;
  queryResult?: Array<{
    type: string;
    content: string;
    gameDay: number;
    gameTime: string;
  }>;
  mapSnapshot?: unknown;
}): { deps: DispatcherDeps; calls: Calls } {
  const calls: Calls = { add: [], query: [], getMapSnapshot: 0 };
  const scenes = opts?.scenes ?? new Map();
  const junctions = opts?.junctions ?? new Map();
  const roads = opts?.roads ?? new Map();

  const memory = {
    add: async (params: Record<string, unknown>) => {
      calls.add.push(params);
      return params;
    },
    query: async (params: Record<string, unknown>) => {
      calls.query.push(params);
      return opts?.queryResult ?? [];
    },
    getMapSnapshot: async () => {
      calls.getMapSnapshot += 1;
      return opts?.mapSnapshot ?? null;
    },
  } as unknown as NpcMemoryManager;

  const dgsm = {
    getState: () => ({ scenes, junctions, roads }),
  } as unknown as DynamicGameStateManager;

  return {
    deps: {
      memory,
      dgsm,
      npcId: "npc1",
      sessionId: "sess1",
      moduleId: "mod1",
      gameDay: 1,
      gameTime: "08:00",
    },
    calls,
  };
}

describe("toolDispatcher.dispatchInstantTool", () => {
  test("writeMemory: type=plan calls memory.add with content", async () => {
    const { deps, calls } = makeDeps();
    const caps = { ...TOOL_CAPS };
    const result = await dispatchInstantTool(
      "writeMemory",
      { type: "plan", content: "Tomorrow I'll search the library." },
      caps,
      deps
    );
    expect(calls.add.length).toBe(1);
    expect(calls.add[0]).toMatchObject({
      type: "plan",
      content: "Tomorrow I'll search the library.",
      sessionId: "sess1",
      moduleId: "mod1",
      npcId: "npc1",
    });
    expect(result.result).toContain("Wrote plan memory");
  });

  test("writeMemory: type=belief works", async () => {
    const { deps, calls } = makeDeps();
    const caps = { ...TOOL_CAPS };
    await dispatchInstantTool(
      "writeMemory",
      { type: "belief", content: "Smith is hiding something." },
      caps,
      deps
    );
    expect(calls.add[0]).toMatchObject({ type: "belief" });
  });

  test("writeMemory: type=long_term_intent works", async () => {
    const { deps, calls } = makeDeps();
    const caps = { ...TOOL_CAPS };
    await dispatchInstantTool(
      "writeMemory",
      { type: "long_term_intent", content: "Find the truth at any cost." },
      caps,
      deps
    );
    expect(calls.add[0]).toMatchObject({ type: "long_term_intent" });
  });

  test("writeMemory: mapAdd resolves scene name", async () => {
    const scenes = new Map([["SCN_LIB", { id: "SCN_LIB", name: "Library" }]]);
    const { deps, calls } = makeDeps({ scenes });
    const caps = { ...TOOL_CAPS };
    await dispatchInstantTool(
      "writeMemory",
      { type: "map", mapAdd: { sceneNames: ["library"] } },
      caps,
      deps
    );
    expect(calls.add.length).toBe(1);
    expect(String(calls.add[0].content)).toContain("Library (SCN_LIB)");
  });

  test("writeMemory: mapAdd unknown name still writes a textual note", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, calls } = makeDeps();
    const caps = { ...TOOL_CAPS };
    await dispatchInstantTool(
      "writeMemory",
      { type: "map", mapAdd: { sceneNames: ["nonexistent"] } },
      caps,
      deps
    );
    expect(calls.add.length).toBe(1);
    expect(String(calls.add[0].content)).toContain("nonexistent");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("recallMemory: passes query and limit, formats results", async () => {
    const { deps, calls } = makeDeps({
      queryResult: [
        { type: "event", content: "smith left", gameDay: 1, gameTime: "07:00" },
      ],
    });
    const caps = { ...TOOL_CAPS };
    const result = await dispatchInstantTool(
      "recallMemory",
      { query: "smith", limit: 5 },
      caps,
      deps
    );
    expect(calls.query.length).toBe(1);
    expect(calls.query[0]).toMatchObject({
      query: "smith",
      limit: 5,
    });
    expect(result.result).toContain("smith left");
  });

  test("recallMemory: no query returns formatted output (or empty notice)", async () => {
    const { deps } = makeDeps();
    const caps = { ...TOOL_CAPS };
    const result = await dispatchInstantTool("recallMemory", {}, caps, deps);
    expect(result.result).toContain("No memories matched.");
  });

  test("getMapSnapshot: returns formatted snapshot", async () => {
    const { deps, calls } = makeDeps({
      mapSnapshot: {
        scenes: { S1: { id: "S1", name: "Hall" } },
        junctions: { J1: { id: "J1", name: "Cross" } },
        roads: {},
        revealedHiddenConnections: [],
      },
    });
    const caps = { ...TOOL_CAPS };
    const result = await dispatchInstantTool("getMapSnapshot", {}, caps, deps);
    expect(calls.getMapSnapshot).toBe(1);
    expect(result.result).toContain("Hall (S1)");
    expect(result.result).toContain("Cross (J1)");
  });

  test("recallMemory cap: 11th call returns cap-exceeded error", async () => {
    const { deps } = makeDeps();
    const caps = { ...TOOL_CAPS };
    for (let i = 0; i < TOOL_CAPS.recallMemory; i++) {
      await dispatchInstantTool("recallMemory", {}, caps, deps);
    }
    const overflow = await dispatchInstantTool("recallMemory", {}, caps, deps);
    expect(overflow.result).toContain("maximum allowed times");
  });

  test("unknown tool name returns error", async () => {
    const { deps } = makeDeps();
    const caps = { ...TOOL_CAPS };
    const result = await dispatchInstantTool("madeUpTool", {}, caps, deps);
    expect(result.result).toContain("Unknown instant tool");
  });
});
