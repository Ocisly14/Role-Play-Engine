// Schema v2 place files: parse guards, v1 rejection, per-kind derivation
// (SCN/JUNC/ROAD), and module-wide reference integrity. The loader supports
// ONLY v2 — the whole migration strategy for v1 modules is the error message.

import {
  ModuleSchemaError,
  type PlaceFileV2,
  buildJunctionV2,
  buildRoadV2,
  buildSceneV2,
  parsePlaceFileV2,
  validateModuleReferences,
  validateScenarioOutlines,
  validateTransportEdges,
} from "@/state/moduleSchemaV2.js";
import type { JunctionNode, RoadNode } from "@/state/topologyTypes.js";
import type { DynamicScene } from "@/state/types.js";
import { describe, expect, it } from "vitest";

// ─── fixtures ──────────────────────────────────────────────────────

function rawScene(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    id: "SCN_library",
    name: "Town Library",
    description:
      "Dusty archives fill the reading room [item.library.archives]. " +
      "A stairway rises to the stacks [exit.library.stacks]. " +
      "The unlit back row is hard to examine [cond.library.dim].",
    parentLocationId: "LOC_downtown",
    references: {
      items: [
        {
          id: "item.library.archives",
          name: "Archive shelves",
          description: "Tall shelves of municipal records.",
        },
      ],
      connections: [
        {
          id: "exit.library.stacks",
          targetId: "SCN_library_stacks",
          name: "Stairway to stacks",
          description: "A narrow stairway behind the desk.",
        },
      ],
      conditions: [
        {
          id: "cond.library.dim",
          description: "The rear shelves are poorly lit.",
          mechanicalEffect: { skillPenalty: { Perception: -10 } },
        },
      ],
    },
    ...overrides,
  };
}

function rawJunction(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    id: "JUNC_main_north",
    name: "North Corner",
    description:
      "The library door faces the corner [exit.main_north.library]. " +
      "A cellar hatch hides under leaves.",
    parentLocationId: "OUTDOOR",
    references: {
      connections: [
        { id: "exit.main_north.library", targetId: "SCN_library" },
        {
          id: "exit.main_north.cellar",
          targetId: "SCN_cellar",
          hidden: true,
        },
      ],
    },
    ...overrides,
  };
}

function rawRoad(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    id: "ROAD_main_street",
    name: "Main Street",
    description:
      "The street runs from the north corner [exit.main_street.north] " +
      "to the south corner [exit.main_street.south], past the diner " +
      "[exit.main_street.diner].",
    parentLocationId: "OUTDOOR",
    travelTimeMinutes: 15,
    references: {
      connections: [
        {
          id: "exit.main_street.north",
          targetId: "JUNC_main_north",
          role: "endpointA",
        },
        {
          id: "exit.main_street.south",
          targetId: "JUNC_main_south",
          role: "endpointB",
        },
        {
          id: "exit.main_street.diner",
          targetId: "SCN_diner",
          role: "access",
          position: 0.4,
        },
      ],
    },
    ...overrides,
  };
}

function roadWithConnections(
  connections: unknown[],
  overrides: Record<string, unknown> = {}
) {
  return rawRoad({
    description: "A bare stretch of road.",
    references: { connections },
    ...overrides,
  });
}

// A minimal consistent module for cross-file validation. Each helper builds
// runtime nodes straight from the raw fixtures above.
function builtModule(
  mutate?: (module: {
    scenes: Map<string, DynamicScene>;
    junctions: Map<string, JunctionNode>;
    roads: Map<string, RoadNode>;
  }) => void
) {
  const scenes = new Map<string, DynamicScene>();
  const junctions = new Map<string, JunctionNode>();
  const roads = new Map<string, RoadNode>();

  const library = buildSceneV2(parsePlaceFileV2("SCN_library", rawScene()));
  const stacks = buildSceneV2(
    parsePlaceFileV2(
      "SCN_library_stacks",
      rawScene({
        id: "SCN_library_stacks",
        name: "Stacks",
        description:
          "Rows of shelves, and the stairway down [exit.stacks.down].",
        references: {
          connections: [{ id: "exit.stacks.down", targetId: "SCN_library" }],
        },
      })
    )
  );
  scenes.set(library.id, library);
  scenes.set(stacks.id, stacks);

  const junction = buildJunctionV2(
    parsePlaceFileV2("JUNC_main_north", rawJunction())
  );
  junctions.set(junction.id, junction);
  const cellar = buildSceneV2(
    parsePlaceFileV2(
      "SCN_cellar",
      rawScene({
        id: "SCN_cellar",
        name: "Cellar",
        description: "A dirt-floored cellar.",
        references: {},
      })
    )
  );
  scenes.set(cellar.id, cellar);

  const module = { scenes, junctions, roads };
  mutate?.(module);
  return module;
}

function expectSchemaError(fn: () => unknown): ModuleSchemaError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ModuleSchemaError);
    return error as ModuleSchemaError;
  }
  throw new Error("expected a ModuleSchemaError, but nothing was thrown");
}

// ─── parse ─────────────────────────────────────────────────────────

describe("parsePlaceFileV2", () => {
  it("parses a valid SCN file", () => {
    const parsed = parsePlaceFileV2("SCN_library", rawScene());
    expect(parsed.id).toBe("SCN_library");
    expect(parsed.references.items).toHaveLength(1);
    expect(parsed.references.connections).toHaveLength(1);
    expect(parsed.references.conditions[0].mechanicalEffect).toEqual({
      skillPenalty: { Perception: -10 },
    });
  });

  it("rejects v1 rows (schemaVersion missing) with a clear message and the entryId", () => {
    const { schemaVersion: _dropped, ...v1 } = rawScene();
    const error = expectSchemaError(() => parsePlaceFileV2("SCN_old", v1));
    expect(error.entryId).toBe("SCN_old");
    expect(error.message).toContain("SCN_old");
    expect(error.message).toContain("v1 不再支持");
    expect(error.message).toContain("DYNAMIC_WORLD_SCENE_SCHEMA.md");
  });

  it("rejects schemaVersion values other than 2", () => {
    const error = expectSchemaError(() =>
      parsePlaceFileV2("SCN_v3", rawScene({ schemaVersion: 3 }))
    );
    expect(error.problems[0]).toContain("v1 不再支持");
  });

  it("aggregates every problem in the file into one error", () => {
    const bad = rawScene({
      name: 42,
      parentLocationId: undefined,
      references: {
        items: [{ id: "item.x" }], // missing name
        connections: [{ id: "exit.x" }], // missing targetId
      },
    });
    const error = expectSchemaError(() => parsePlaceFileV2("SCN_bad", bad));
    expect(error.problems.length).toBeGreaterThanOrEqual(4);
    expect(error.problems.join("\n")).toContain("name");
    expect(error.problems.join("\n")).toContain("parentLocationId");
    expect(error.problems.join("\n")).toContain("targetId");
  });

  it("rejects the old array-shaped skillPenalty with a targeted message", () => {
    const bad = rawScene();
    (bad.references as Record<string, unknown>).conditions = [
      {
        id: "cond.library.dim",
        description: "dim",
        mechanicalEffect: {
          skillPenalty: [{ skill: "Perception", delta: -20 }],
        },
      },
    ];
    const error = expectSchemaError(() => parsePlaceFileV2("SCN_library", bad));
    expect(error.problems.join("\n")).toContain("no longer supported");
    expect(error.problems.join("\n")).toContain("Record");
  });
});

// ─── derivation ────────────────────────────────────────────────────

describe("buildSceneV2 / buildJunctionV2", () => {
  it("derives a DynamicScene carrying items, conditions and connections", () => {
    const scene = buildSceneV2(parsePlaceFileV2("SCN_library", rawScene()));
    expect(scene.connections).toEqual([
      {
        id: "exit.library.stacks",
        targetId: "SCN_library_stacks",
        name: "Stairway to stacks",
        description: "A narrow stairway behind the desk.",
      },
    ]);
    expect(scene.items[0].id).toBe("item.library.archives");
    expect(scene.conditions[0].id).toBe("cond.library.dim");
  });

  it("rejects role/position on SCN connections", () => {
    const bad = rawScene();
    (bad.references as { connections: Record<string, unknown>[] }).connections =
      [
        {
          id: "exit.library.stacks",
          targetId: "SCN_library_stacks",
          role: "access",
          position: 0.5,
        },
      ];
    const error = expectSchemaError(() =>
      buildSceneV2(parsePlaceFileV2("SCN_library", bad))
    );
    expect(error.problems[0]).toContain("role/position");
  });

  it("derives connectedSceneIds from junction connections, hidden included", () => {
    const junction = buildJunctionV2(
      parsePlaceFileV2("JUNC_main_north", rawJunction())
    );
    expect(junction.connections).toHaveLength(2);
    expect(junction.connectedSceneIds).toEqual(["SCN_library", "SCN_cellar"]);
  });

  it("rejects role/position on JUNC connections", () => {
    const bad = rawJunction();
    (bad.references as { connections: Record<string, unknown>[] }).connections =
      [
        {
          id: "exit.main_north.library",
          targetId: "SCN_library",
          role: "endpointA",
        },
      ];
    const error = expectSchemaError(() =>
      buildJunctionV2(parsePlaceFileV2("JUNC_main_north", bad))
    );
    expect(error.problems[0]).toContain("role/position");
  });
});

describe("buildRoadV2", () => {
  it("derives endpointA/endpointB/alongConnections and keeps connections", () => {
    const road = buildRoadV2(parsePlaceFileV2("ROAD_main_street", rawRoad()));
    expect(road.endpointA).toBe("JUNC_main_north");
    expect(road.endpointB).toBe("JUNC_main_south");
    expect(road.travelTimeMinutes).toBe(15);
    expect(road.alongConnections).toEqual([
      { sceneId: "SCN_diner", position: 0.4 },
    ]);
    expect(road.connections.map((c) => c.role)).toEqual([
      "endpointA",
      "endpointB",
      "access",
    ]);
  });

  it("rejects a road with no endpointA", () => {
    const error = expectSchemaError(() =>
      buildRoadV2(
        parsePlaceFileV2(
          "ROAD_main_street",
          roadWithConnections([
            {
              id: "exit.main_street.south",
              targetId: "JUNC_main_south",
              role: "endpointB",
            },
          ])
        )
      )
    );
    expect(error.problems.join("\n")).toContain("exactly one endpointA");
  });

  it("rejects a road with two endpointA connections", () => {
    const error = expectSchemaError(() =>
      buildRoadV2(
        parsePlaceFileV2(
          "ROAD_main_street",
          roadWithConnections([
            {
              id: "exit.main_street.north",
              targetId: "JUNC_main_north",
              role: "endpointA",
            },
            {
              id: "exit.main_street.north2",
              targetId: "JUNC_main_south",
              role: "endpointA",
            },
            {
              id: "exit.main_street.south",
              targetId: "JUNC_main_south",
              role: "endpointB",
            },
          ])
        )
      )
    );
    expect(error.problems.join("\n")).toContain("exactly one endpointA");
  });

  it("rejects an endpoint targeting a SCN_* node", () => {
    const error = expectSchemaError(() =>
      buildRoadV2(
        parsePlaceFileV2(
          "ROAD_main_street",
          roadWithConnections([
            {
              id: "exit.main_street.north",
              targetId: "SCN_diner",
              role: "endpointA",
            },
            {
              id: "exit.main_street.south",
              targetId: "JUNC_main_south",
              role: "endpointB",
            },
          ])
        )
      )
    );
    expect(error.problems.join("\n")).toContain("must target a JUNC_*");
  });

  it("rejects an access connection without a position", () => {
    const road = rawRoad();
    (
      road.references as { connections: Record<string, unknown>[] }
    ).connections[2] = {
      id: "exit.main_street.diner",
      targetId: "SCN_diner",
      role: "access",
    };
    const error = expectSchemaError(() =>
      buildRoadV2(parsePlaceFileV2("ROAD_main_street", road))
    );
    expect(error.problems.join("\n")).toContain("require a position");
  });

  it("rejects an access position outside [0, 1]", () => {
    const road = rawRoad();
    (
      road.references as { connections: Record<string, unknown>[] }
    ).connections[2] = {
      id: "exit.main_street.diner",
      targetId: "SCN_diner",
      role: "access",
      position: 1.4,
    };
    const error = expectSchemaError(() =>
      buildRoadV2(parsePlaceFileV2("ROAD_main_street", road))
    );
    expect(error.problems.join("\n")).toContain("[0, 1]");
  });

  it("rejects a connection without a role", () => {
    const error = expectSchemaError(() =>
      buildRoadV2(
        parsePlaceFileV2(
          "ROAD_main_street",
          roadWithConnections([
            { id: "exit.main_street.north", targetId: "JUNC_main_north" },
            {
              id: "exit.main_street.south",
              targetId: "JUNC_main_south",
              role: "endpointB",
            },
          ])
        )
      )
    );
    expect(error.problems.join("\n")).toContain("require a role");
  });

  it("rejects a missing or non-positive travelTimeMinutes", () => {
    const { travelTimeMinutes: _dropped, ...road } = rawRoad();
    const missing = expectSchemaError(() =>
      buildRoadV2(parsePlaceFileV2("ROAD_main_street", road))
    );
    expect(missing.problems.join("\n")).toContain("travelTimeMinutes");

    const zero = expectSchemaError(() =>
      buildRoadV2(
        parsePlaceFileV2("ROAD_main_street", rawRoad({ travelTimeMinutes: 0 }))
      )
    );
    expect(zero.problems.join("\n")).toContain("travelTimeMinutes");
  });
});

// ─── module-wide reference integrity ───────────────────────────────

describe("validateModuleReferences", () => {
  it("accepts a consistent module (hidden references uncited)", () => {
    expect(() => validateModuleReferences(builtModule())).not.toThrow();
  });

  it("rejects a reference id reused across files", () => {
    const module = builtModule((m) => {
      const cellar = m.scenes.get("SCN_cellar");
      if (!cellar) throw new Error("fixture broke");
      cellar.description =
        "A dirt-floored cellar. A lamp [item.library.archives].";
      cellar.items = [{ id: "item.library.archives", name: "Lamp" }];
    });
    const error = expectSchemaError(() => validateModuleReferences(module));
    expect(error.problems.join("\n")).toContain(
      'duplicate id "item.library.archives"'
    );
  });

  it("rejects a visible item that is never cited", () => {
    const module = builtModule((m) => {
      const cellar = m.scenes.get("SCN_cellar");
      if (!cellar) throw new Error("fixture broke");
      cellar.items = [{ id: "item.cellar.crate", name: "Crate" }];
    });
    const error = expectSchemaError(() => validateModuleReferences(module));
    expect(error.problems.join("\n")).toContain(
      '"item.cellar.crate" is never cited'
    );
  });

  it("rejects a visible connection that is never cited", () => {
    const module = builtModule((m) => {
      const cellar = m.scenes.get("SCN_cellar");
      if (!cellar) throw new Error("fixture broke");
      cellar.connections = [{ id: "exit.cellar.up", targetId: "SCN_library" }];
    });
    const error = expectSchemaError(() => validateModuleReferences(module));
    expect(error.problems.join("\n")).toContain(
      '"exit.cellar.up" is never cited'
    );
  });

  it("rejects a citation that resolves to nothing in the file", () => {
    const module = builtModule((m) => {
      const cellar = m.scenes.get("SCN_cellar");
      if (!cellar) throw new Error("fixture broke");
      cellar.description =
        "A dirt-floored cellar with a ghost [item.cellar.ghost].";
    });
    const error = expectSchemaError(() => validateModuleReferences(module));
    expect(error.problems.join("\n")).toContain(
      "cites [item.cellar.ghost], which is not declared"
    );
  });

  it("rejects a reference cited more than once", () => {
    const module = builtModule((m) => {
      const library = m.scenes.get("SCN_library");
      if (!library) throw new Error("fixture broke");
      library.description += " The shelves again [item.library.archives].";
    });
    const error = expectSchemaError(() => validateModuleReferences(module));
    expect(error.problems.join("\n")).toContain(
      '"item.library.archives" is cited 2 times'
    );
  });

  it("rejects a hidden reference that the prose cites (leak)", () => {
    const module = builtModule((m) => {
      const junction = m.junctions.get("JUNC_main_north");
      if (!junction) throw new Error("fixture broke");
      junction.description += " A hatch [exit.main_north.cellar].";
    });
    const error = expectSchemaError(() => validateModuleReferences(module));
    expect(error.problems.join("\n")).toContain(
      'hidden reference "exit.main_north.cellar" must not be cited'
    );
  });

  it("treats an uncited hidden item as legal", () => {
    const module = builtModule((m) => {
      const cellar = m.scenes.get("SCN_cellar");
      if (!cellar) throw new Error("fixture broke");
      cellar.items = [
        { id: "item.cellar.duplicate_bills", name: "Bills", hidden: true },
      ];
    });
    expect(() => validateModuleReferences(module)).not.toThrow();
  });

  it("requires conditions to be cited", () => {
    const module = builtModule((m) => {
      const cellar = m.scenes.get("SCN_cellar");
      if (!cellar) throw new Error("fixture broke");
      cellar.conditions = [
        { id: "cond.cellar.damp", description: "Damp air." },
      ];
    });
    const error = expectSchemaError(() => validateModuleReferences(module));
    expect(error.problems.join("\n")).toContain(
      '"cond.cellar.damp" is never cited'
    );
  });

  it("rejects a connection to a place that does not exist", () => {
    const module = builtModule((m) => {
      const stacks = m.scenes.get("SCN_library_stacks");
      if (!stacks) throw new Error("fixture broke");
      stacks.connections[0].targetId = "SCN_nowhere";
    });
    const error = expectSchemaError(() => validateModuleReferences(module));
    expect(error.problems.join("\n")).toContain(
      'targets unknown place "SCN_nowhere"'
    );
  });

  it("rejects a self-targeting connection", () => {
    const module = builtModule((m) => {
      const stacks = m.scenes.get("SCN_library_stacks");
      if (!stacks) throw new Error("fixture broke");
      stacks.connections[0].targetId = "SCN_library_stacks";
    });
    const error = expectSchemaError(() => validateModuleReferences(module));
    expect(error.problems.join("\n")).toContain("targets its own place");
  });

  it("does not require exits to be bidirectional", () => {
    const module = builtModule((m) => {
      // SCN_library → SCN_library_stacks exists; remove the reverse exit.
      const stacks = m.scenes.get("SCN_library_stacks");
      if (!stacks) throw new Error("fixture broke");
      stacks.description = "Rows of shelves.";
      stacks.connections = [];
    });
    expect(() => validateModuleReferences(module)).not.toThrow();
  });
});

// ─── outline / transport edge validators ───────────────────────────

describe("validateScenarioOutlines", () => {
  const module = builtModule();

  it("accepts valid outlines (array or wrapped)", () => {
    const outlines = [
      {
        id: "LOC_downtown",
        name: "Downtown",
        description: "The center of town.",
        subSceneCount: 2,
        entrySceneId: "SCN_library",
      },
    ];
    expect(
      validateScenarioOutlines("__scenarios_outline__", outlines, module)
    ).toHaveLength(1);
    expect(
      validateScenarioOutlines(
        "__scenarios_outline__",
        { scenarios: outlines },
        module
      )
    ).toHaveLength(1);
  });

  it("rejects missing required fields", () => {
    const error = expectSchemaError(() =>
      validateScenarioOutlines(
        "__scenarios_outline__",
        [{ id: "LOC_downtown" }],
        module
      )
    );
    expect(error.entryId).toBe("__scenarios_outline__");
    expect(error.problems.join("\n")).toContain("name");
    expect(error.problems.join("\n")).toContain("description");
    expect(error.problems.join("\n")).toContain("subSceneCount");
  });

  it("rejects an entrySceneId that is not a scene or junction", () => {
    const error = expectSchemaError(() =>
      validateScenarioOutlines(
        "__scenarios_outline__",
        [
          {
            id: "LOC_downtown",
            name: "Downtown",
            description: "x",
            subSceneCount: 1,
            entrySceneId: "SCN_missing",
          },
        ],
        module
      )
    );
    expect(error.problems.join("\n")).toContain("SCN_missing");
  });

  it("accepts a junction as entrySceneId", () => {
    expect(() =>
      validateScenarioOutlines(
        "__scenarios_outline__",
        [
          {
            id: "LOC_downtown",
            name: "Downtown",
            description: "x",
            subSceneCount: 1,
            entrySceneId: "JUNC_main_north",
          },
        ],
        module
      )
    ).not.toThrow();
  });
});

describe("validateTransportEdges", () => {
  const lookup = {
    outlineIds: new Set(["LOC_downtown", "LOC_harbor"]),
    placeIds: new Set(["SCN_harbor_road"]),
  };

  it("accepts valid edges", () => {
    const edges = validateTransportEdges(
      "__transport_edges__",
      [
        {
          fromLocationId: "LOC_downtown",
          toLocationId: "LOC_harbor",
          streetSceneId: "SCN_harbor_road",
          travelTimeMinutes: 5,
        },
      ],
      lookup
    );
    expect(edges).toHaveLength(1);
  });

  it("rejects edges whose ids do not exist", () => {
    const error = expectSchemaError(() =>
      validateTransportEdges(
        "__transport_edges__",
        [
          {
            fromLocationId: "LOC_nowhere",
            toLocationId: "LOC_harbor",
            streetSceneId: "SCN_missing_road",
            travelTimeMinutes: 5,
          },
        ],
        lookup
      )
    );
    expect(error.entryId).toBe("__transport_edges__");
    expect(error.problems.join("\n")).toContain("LOC_nowhere");
    expect(error.problems.join("\n")).toContain("SCN_missing_road");
  });
});

// Type-level sanity: the parsed file is the exact PlaceFileV2 shape.
const _typecheck: PlaceFileV2 = parsePlaceFileV2("SCN_library", rawScene());
void _typecheck;
