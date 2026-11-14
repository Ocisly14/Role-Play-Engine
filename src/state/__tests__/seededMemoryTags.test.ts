import { describe, expect, it } from "vitest";
import { validateSeededMemoryTags } from "../moduleLoader.js";
import type { DynamicNPCProfile } from "../types.js";

const known = {
  placeIds: new Set(["SCN_diner", "ROAD_main_street"]),
  itemIds: new Set(["item.diner.ledger"]),
  npcIds: new Set(["npc_1"]),
};

function npc(memory: Array<{ type: string; content: string }>) {
  return { id: "npc_1", name: "A", memory } as unknown as DynamicNPCProfile;
}

describe("validateSeededMemoryTags", () => {
  it("accepts tags that name real things, and a map memory with a place tag", () => {
    expect(() =>
      validateSeededMemoryTags(
        [
          npc([
            {
              type: "map",
              content: "顺主街 [ROAD_main_street] 到蓝鸟 [SCN_diner]。",
            },
            { type: "secret", content: "账本 [item.diner.ledger] 在柜台下。" },
            { type: "general", content: "没有提到任何地方。" },
          ]),
        ],
        known
      )
    ).not.toThrow();
  });

  it("refuses a tag that names nothing", () => {
    expect(() =>
      validateSeededMemoryTags(
        [npc([{ type: "general", content: "去 [SCN_nowhere]。" }])],
        known
      )
    ).toThrow(/SCN_nowhere/);
  });

  it("refuses a map memory with no place tag", () => {
    expect(() =>
      validateSeededMemoryTags(
        [npc([{ type: "map", content: "顺主街往北走一刻钟就到蓝鸟。" }])],
        known
      )
    ).toThrow(/map memory must tag/);
  });
});
