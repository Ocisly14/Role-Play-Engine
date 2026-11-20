// A place's `coordinates` (meters: x east, y north, z elevation) — checked at
// load time like every other authored field. Roads have none of their own
// (their points lie between their endpoints), and a vehicle's interior has
// none (it is wherever the vehicle is).

import {
  ModuleSchemaError,
  buildRoadV2,
  buildSceneV2,
  parsePlaceFileV2,
  parseVehicleFileV2,
} from "@/state/moduleSchemaV2.js";
import { describe, expect, it } from "vitest";

const place = (extra: Record<string, unknown>) => ({
  schemaVersion: 3,
  id: "SCN_a",
  name: "a",
  setting: "a",
  references: { items: [], connections: [], conditions: [] },
  ...extra,
});

describe("place coordinates", () => {
  it("parses onto the scene; z defaults to 0", () => {
    const file = parsePlaceFileV2(
      "SCN_a",
      place({ coordinates: { x: 12, y: -40 } })
    );
    expect(buildSceneV2(file).coordinates).toEqual({ x: 12, y: -40, z: 0 });
  });

  it("refuses a non-number and an unknown field", () => {
    expect(() =>
      parsePlaceFileV2("SCN_a", place({ coordinates: { x: "12", y: 0 } }))
    ).toThrow(ModuleSchemaError);
    expect(() =>
      parsePlaceFileV2(
        "SCN_a",
        place({ coordinates: { x: 1, y: 2, floor: 1 } })
      )
    ).toThrow(/only x, y, z/);
  });

  it("a road has none of its own", () => {
    const file = parsePlaceFileV2("ROAD_r", {
      ...place({ coordinates: { x: 0, y: 0 } }),
      id: "ROAD_r",
      travelTimeMinutes: 5,
      references: {
        items: [],
        conditions: [],
        connections: [
          { id: "c.a", targetId: "SCN_a", role: "endpointA" },
          { id: "c.b", targetId: "SCN_b", role: "endpointB" },
        ],
      },
    });
    expect(() => buildRoadV2(file)).toThrow(/a road has none of its own/);
  });

  it("a vehicle's interior has none", () => {
    const cab = buildSceneV2(
      parsePlaceFileV2(
        "SCN_cab",
        place({
          id: "SCN_cab",
          parentLocationId: "VEH_t",
          coordinates: { x: 0, y: 0 },
        })
      )
    );
    expect(() =>
      parseVehicleFileV2(
        "VEH_t",
        {
          id: "VEH_t",
          name: "t",
          description: "t",
          interiorSceneId: "SCN_cab",
          initialLocation: "SCN_a",
        },
        {
          scenes: new Map([["SCN_cab", cab]]),
          placeIds: new Set(["SCN_a"]),
        }
      )
    ).toThrow(/wherever the vehicle is/);
  });
});
