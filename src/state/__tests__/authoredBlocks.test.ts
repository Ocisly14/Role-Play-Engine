// A passage authored as blocked at the start (a locked door) seeds the
// session's block map — the one record movement reads. Without it a lock that
// lives only in prose stops nobody: neither the start judgement nor code reads
// the description before a walk.

import fs from "node:fs";
import path from "node:path";
import { authoredBlocksOf, seedAuthoredBlocks } from "@/state/moduleLoader.js";
import {
  ModuleSchemaError,
  buildSceneV2,
  parsePlaceFileV2,
} from "@/state/moduleSchemaV2.js";
import { describe, expect, it } from "vitest";

function scene(id: string, connections: Array<Record<string, unknown>>) {
  return {
    schemaVersion: 3,
    id,
    name: id,
    parentLocationId: "LOC_x",
    setting: connections.map((c) => `[${c.targetId}]`).join(" "),
    references: { items: [], connections, conditions: [] },
  };
}

const lookup = {
  scenes: new Map<string, unknown>([
    ["SCN_cliff", {}],
    ["SCN_tower", {}],
  ]),
  roads: new Map<string, unknown>(),
};

describe("authored blocked passages", () => {
  it("reads the reason, and keeps it off the runtime connection", () => {
    const file = parsePlaceFileV2(
      "SCN_cliff",
      scene("SCN_cliff", [
        { id: "c.cliff.tower", targetId: "SCN_tower", blocked: " 铁门锁着 " },
      ])
    );
    expect(authoredBlocksOf(file)).toEqual([
      {
        entryId: "SCN_cliff",
        connectionId: "c.cliff.tower",
        targetId: "SCN_tower",
        reason: "铁门锁着",
      },
    ]);
    expect(buildSceneV2(file).connections[0]).not.toHaveProperty("blocked");
  });

  it("refuses an empty reason", () => {
    expect(() =>
      parsePlaceFileV2(
        "SCN_cliff",
        scene("SCN_cliff", [
          { id: "c.cliff.tower", targetId: "SCN_tower", blocked: "  " },
        ])
      )
    ).toThrow(ModuleSchemaError);
  });

  it("one passage, one flag: either side blocks both directions", () => {
    const seeded = seedAuthoredBlocks(
      [
        {
          entryId: "SCN_cliff",
          connectionId: "c.cliff.tower",
          targetId: "SCN_tower",
          reason: "铁门锁着",
        },
        {
          entryId: "SCN_tower",
          connectionId: "c.tower.cliff",
          targetId: "SCN_cliff",
          reason: "铁门锁着",
        },
      ],
      lookup
    );
    expect([...seeded]).toEqual([
      ["scene:SCN_cliff::scene:SCN_tower", "铁门锁着"],
    ]);
  });

  it("refuses two sides that disagree on why", () => {
    expect(() =>
      seedAuthoredBlocks(
        [
          {
            entryId: "SCN_cliff",
            connectionId: "c.cliff.tower",
            targetId: "SCN_tower",
            reason: "锁着",
          },
          {
            entryId: "SCN_tower",
            connectionId: "c.tower.cliff",
            targetId: "SCN_cliff",
            reason: "焊死了",
          },
        ],
        lookup
      )
    ).toThrow(/one passage, one reason/);
  });

  it("grayhaven: the lighthouse door is locked from the start", () => {
    const dir = path.resolve(
      __dirname,
      "../../../testmods/grayhaven/Grayhaven_Scenarios"
    );
    const blocks = ["SCN_lighthouse_cliff", "SCN_lighthouse_interior"].flatMap(
      (id) =>
        authoredBlocksOf(
          parsePlaceFileV2(
            id,
            JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"))
          )
        )
    );
    const seeded = seedAuthoredBlocks(blocks, {
      scenes: new Map<string, unknown>([
        ["SCN_lighthouse_cliff", {}],
        ["SCN_lighthouse_interior", {}],
      ]),
      roads: new Map(),
    });
    expect(
      seeded.get("scene:SCN_lighthouse_cliff::scene:SCN_lighthouse_interior")
    ).toMatch(/锁/);
  });
});
