// src/engine/core/__tests__/outdoorFixture.ts
//
// A small outdoor world for the tick-engine tests: two node scenes joined by
// a road, one indoor scene hanging off the hollow. Nothing outdoors has a
// parent, so the whole outdoors is the implicit OUTDOOR region. Not a test
// file itself — vitest collects only `*.test.ts` — so other test files may
// import it without re-running anything.

import { vi } from "vitest";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../../../state/DynamicGameState.js";
import { type RoadNode, buildTopology } from "../../../state/topologyTypes.js";
import type { DynamicScene } from "../../../state/types.js";
import { SubsystemRegistry } from "../../subsystem/registry.js";
import type { AnchorSubsystem } from "../../subsystem/types.js";
import { CodeToolRegistry } from "../../tools/codeTool.js";
import { createTickEngine } from "../tickEngine.js";

export function makeOutdoorDgsm(): DynamicGameStateManager {
  const state = initialDynamicGameState("1923-04-02T09:00:00");
  const ridge: DynamicScene = {
    id: "SCN_ridge",
    name: "山脊",
    description: "一道裸露的山脊，风从北面直灌过来。",
    items: [],
    conditions: [],
    connections: [{ id: "connection.ridge.pass", targetId: "ROAD_pass" }],
  };
  const hollow: DynamicScene = {
    id: "SCN_hollow",
    name: "谷底",
    description: "两排石屋夹着的小巷，背风。",
    items: [],
    conditions: [],
    connections: [
      { id: "connection.hollow.pass", targetId: "ROAD_pass" },
      { id: "connection.hollow.inn", targetId: "SCN_inn" },
    ],
  };
  const inn: DynamicScene = {
    id: "SCN_inn",
    name: "客栈",
    description: "低矮的堂屋。",
    parentLocationId: "B_INN",
    indoor: true,
    items: [],
    conditions: [],
    connections: [{ id: "connection.inn.hollow", targetId: "SCN_hollow" }],
  };
  const pass: RoadNode = {
    id: "ROAD_pass",
    name: "山道",
    description: "翻过山脊的土路。",
    parentLocationId: "OUTDOOR",
    connections: [
      { id: "connection.pass.a", targetId: "SCN_ridge", role: "endpointA" },
      { id: "connection.pass.b", targetId: "SCN_hollow", role: "endpointB" },
    ],
    endpointA: "SCN_ridge",
    endpointB: "SCN_hollow",
    travelTimeMinutes: 20,
    alongConnections: [],
    items: [],
    conditions: [],
  };
  for (const s of [ridge, hollow, inn]) state.scenes.set(s.id, s);
  state.roads.set(pass.id, pass);
  state.topology = buildTopology(state.scenes, state.roads);
  return new DynamicGameStateManager(state);
}

/** A tick engine over the fixture with the given subsystems and a World
 *  Action Engine stub that is never reached (no commands are submitted). */
export function makeEngine(
  dgsm: DynamicGameStateManager,
  subsystems: AnchorSubsystem[],
  extra: Partial<Parameters<typeof createTickEngine>[0]> = {}
) {
  const reg = new SubsystemRegistry();
  for (const s of subsystems) reg.register(s);
  return createTickEngine({
    dgsm,
    scriptedEvents: [],
    subsystemRegistry: reg,
    tickDurationMinutes: 1,
    codeTools: new CodeToolRegistry(),
    resolveTickFn: vi.fn(),
    ...extra,
  });
}
