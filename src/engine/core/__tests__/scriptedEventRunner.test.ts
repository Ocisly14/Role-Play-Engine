// Recurring scripted events + the stage-set-economy verbs and guards:
// item.create(skipIfExists) / item.move / connection.setHidden, the
// timeOfDay window, the sceneOccupied witness guard, and the recurring
// cooldown that makes "once per night" expressible.

import type { ScriptedEvent } from "@/engine/scriptedEvents/types.js";
import type { DynamicGameStateManager } from "@/state/DynamicGameState.js";
import { describe, expect, it } from "vitest";
import { ScriptedEventRunner } from "../scriptedEventRunner.js";

function makeDgsm() {
  const states = new Map<string, unknown>();
  const scenes = new Map<
    string,
    { items: Array<{ id: string }>; conditions?: Array<{ featureId?: string }> }
  >([
    ["SCN_grocery_backroom", { items: [] }],
    ["SCN_creek_ford", { items: [], conditions: [] }],
  ]);
  const positions = new Map<string, { type: "scene"; sceneId: string }>();
  const weather = new Map<string, { weatherType: string; intensity: number }>();
  return {
    getScriptedEventState: (id: string) => states.get(id),
    setScriptedEventState: (id: string, s: unknown) => states.set(id, s),
    getState: () => ({
      npcCharacters: [...positions.keys()].map((id) => ({ id })),
    }),
    getScene: (id: string) => scenes.get(id) ?? null,
    getAllSceneIds: () => [...scenes.keys()],
    isNpcAlive: () => true,
    getCharacterPosition: (id: string) => positions.get(id) ?? null,
    getScopedFeatureState: (featureId: string, scope: string, key: string) =>
      featureId === "weather" && scope === "region"
        ? weather.get(key)
        : undefined,
    __scenes: scenes,
    __positions: positions,
    __weather: weather,
  } as unknown as DynamicGameStateManager & {
    __scenes: Map<
      string,
      {
        items: Array<{ id: string }>;
        conditions?: Array<{ featureId?: string }>;
      }
    >;
    __positions: Map<string, { type: "scene"; sceneId: string }>;
    __weather: Map<string, { weatherType: string; intensity: number }>;
  };
}

const restock: ScriptedEvent = {
  id: "evt_restock",
  label: "杂货店每日补货",
  recurring: true,
  recurringCooldownTicks: 1440,
  fireWhen: {
    op: "and",
    children: [
      { op: "timeOfDay", cmp: "gte", value: "02:00" },
      { op: "timeOfDay", cmp: "lte", value: "05:00" },
      {
        op: "not",
        child: { op: "sceneOccupied", sceneId: "SCN_grocery_backroom" },
      },
    ],
  },
  onComplete: [
    {
      kind: "item.create",
      location: "SCN_grocery_backroom",
      name: "本周的补货箱",
      id: "item.grocery_backroom.weekly_stock",
      skipIfExists: true,
    },
    {
      kind: "item.move",
      itemId: "item.freight_shed.crates",
      from: "scene:SCN_freight_shed",
      to: "scene:SCN_grocery_backroom",
    },
  ],
};

function run(
  runner: ScriptedEventRunner,
  dgsm: DynamicGameStateManager,
  tick: number,
  gameDateTime: string
) {
  return runner.run({
    dgsm,
    currentTick: tick,
    gameDateTime,
    committedActionsThisTick: [],
  });
}

describe("recurring scripted events", () => {
  it("refills at the first unobserved minute of the window, once per day", () => {
    const dgsm = makeDgsm();
    const runner = new ScriptedEventRunner([restock]);

    // 01:59 — before the window.
    expect(run(runner, dgsm, 119, "1985-07-08T01:59:00")).toEqual([]);

    // 02:00 but Marisol is standing in the backroom — the stage-set economy
    // refuses to operate while observed.
    dgsm.__positions.set("npc_marisol", {
      type: "scene",
      sceneId: "SCN_grocery_backroom",
    });
    expect(run(runner, dgsm, 120, "1985-07-08T02:00:00")).toEqual([]);

    // 02:01, she leaves — the refill happens that minute.
    dgsm.__positions.delete("npc_marisol");
    const changes = run(runner, dgsm, 121, "1985-07-08T02:01:00");
    expect(changes).toEqual([
      {
        kind: "item.create",
        name: "本周的补货箱",
        location: "SCN_grocery_backroom",
        id: "item.grocery_backroom.weekly_stock",
      },
      {
        kind: "item.move",
        itemId: "item.freight_shed.crates",
        from: "scene:SCN_freight_shed",
        to: "scene:SCN_grocery_backroom",
      },
    ]);
    const state = dgsm.getScriptedEventState("evt_restock");
    expect(state?.status).toBe("active");
    expect(state?.lastCompletedTick).toBe(121);

    // 02:02 — still inside the window, but the cooldown holds.
    expect(run(runner, dgsm, 122, "1985-07-08T02:02:00")).toEqual([]);

    // Next night: the crate is still on the shelf, so skipIfExists blocks
    // the create — only the freight move is emitted.
    dgsm.__scenes.get("SCN_grocery_backroom")?.items.push({
      id: "item.grocery_backroom.weekly_stock",
    });
    const next = run(runner, dgsm, 121 + 1440, "1985-07-09T02:01:00");
    expect(next).toEqual([
      {
        kind: "item.move",
        itemId: "item.freight_shed.crates",
        from: "scene:SCN_freight_shed",
        to: "scene:SCN_grocery_backroom",
      },
    ]);

    // The night after, the shelf is empty again — full refill.
    const backroom = dgsm.__scenes.get("SCN_grocery_backroom");
    if (backroom) backroom.items.length = 0;
    expect(run(runner, dgsm, 121 + 2880, "1985-07-10T02:01:00")).toHaveLength(
      2
    );
  });

  it("floods on sustained storm, cancels on a squall, recedes cross-event", () => {
    const dgsm = makeDgsm();
    const rain = (intensity: number) =>
      dgsm.__weather.set("OUTDOOR", { weatherType: "storm", intensity });
    const clear = () =>
      dgsm.__weather.set("OUTDOOR", { weatherType: "clear", intensity: 1 });
    const rise: ScriptedEvent = {
      id: "evt_rise",
      label: "灰溪涨水",
      recurring: true,
      fireDelayTicks: 120,
      fireWhen: {
        op: "and",
        children: [
          {
            op: "regionWeather",
            regionId: "OUTDOOR",
            types: ["rain", "storm"],
            minIntensity: 3,
          },
          {
            op: "not",
            child: {
              op: "sceneHasConditionFromFeature",
              sceneId: "SCN_creek_ford",
              featureId: "creek_flood",
            },
          },
        ],
      },
      failWhen: {
        op: "not",
        child: {
          op: "regionWeather",
          regionId: "OUTDOOR",
          types: ["rain", "storm"],
          minIntensity: 2,
        },
      },
      onComplete: [
        {
          kind: "connection.setBlock",
          connectionId: "exit.creek_sawmill.creek_end",
          blocked: true,
          reason: "洪水没过踏石",
          featureId: "creek_flood",
        },
      ],
    };
    const recede: ScriptedEvent = {
      id: "evt_recede",
      label: "灰溪退水",
      recurring: true,
      fireDelayTicks: 360,
      fireWhen: {
        op: "and",
        children: [
          {
            op: "sceneHasConditionFromFeature",
            sceneId: "SCN_creek_ford",
            featureId: "creek_flood",
          },
          {
            op: "not",
            child: {
              op: "regionWeather",
              regionId: "OUTDOOR",
              types: ["rain", "storm"],
              minIntensity: 1,
            },
          },
        ],
      },
      onComplete: [
        {
          kind: "connection.setBlock",
          connectionId: "exit.creek_sawmill.creek_end",
          blocked: false,
          reason: "洪水没过踏石",
          featureId: "creek_flood",
        },
      ],
    };
    const runner = new ScriptedEventRunner([rise, recede]);

    // Clear weather: nothing arms.
    clear();
    expect(run(runner, dgsm, 10, "1985-07-08T00:10:00")).toEqual([]);

    // Storm 4 — the rise goes pending (delay 120), no changes yet.
    rain(4);
    expect(run(runner, dgsm, 11, "1985-07-08T00:11:00")).toEqual([]);
    expect(dgsm.getScriptedEventState("evt_rise")?.status).toBe("pending");

    // A squall: weather clears mid-delay — the pending rise cancels but the
    // recurring event RE-ARMS instead of failing terminally.
    clear();
    run(runner, dgsm, 40, "1985-07-08T00:40:00");
    expect(dgsm.getScriptedEventState("evt_rise")?.status).toBe("active");

    // Storm returns and holds through the delay — the flood lands, voting
    // under the shared featureId.
    rain(4);
    run(runner, dgsm, 50, "1985-07-08T00:50:00");
    const changes = run(runner, dgsm, 170, "1985-07-08T02:50:00");
    expect(changes).toEqual([
      {
        kind: "connection.setBlock",
        connectionId: "exit.creek_sawmill.creek_end",
        blocked: true,
        sourceFeatureId: "creek_flood",
        reason: "洪水没过踏石",
      },
    ]);
    // Simulate the applier: the ford now carries the flood condition.
    dgsm.__scenes.get("SCN_creek_ford")?.conditions?.push({
      featureId: "creek_flood",
    });

    // Rain stops — recede goes pending; the lift, when it completes, votes
    // under the SAME featureId, so a different event can withdraw the block.
    clear();
    run(runner, dgsm, 200, "1985-07-08T03:20:00");
    expect(dgsm.getScriptedEventState("evt_recede")?.status).toBe("pending");
    const lift = run(runner, dgsm, 560, "1985-07-08T09:20:00");
    expect(lift).toEqual([
      {
        kind: "connection.setBlock",
        connectionId: "exit.creek_sawmill.creek_end",
        blocked: false,
        sourceFeatureId: "creek_flood",
        reason: "洪水没过踏石",
      },
    ]);
  });

  it("a non-recurring event completes terminally", () => {
    const dgsm = makeDgsm();
    const open: ScriptedEvent = {
      id: "evt_open_inner_door",
      label: "内门开启",
      fireWhen: { op: "timeOfDay", cmp: "eq", value: "03:00" },
      onComplete: [
        {
          kind: "connection.setHidden",
          connectionId: "exit.station_dock.inner_door",
          hidden: false,
        },
      ],
    };
    const runner = new ScriptedEventRunner([open]);
    const changes = run(runner, dgsm, 180, "1985-07-08T03:00:00");
    expect(changes).toEqual([
      {
        kind: "connection.setHidden",
        connectionId: "exit.station_dock.inner_door",
        hidden: false,
      },
    ]);
    expect(dgsm.getScriptedEventState("evt_open_inner_door")?.status).toBe(
      "completed"
    );
    // Never again.
    expect(run(runner, dgsm, 180 + 1440, "1985-07-09T03:00:00")).toEqual([]);
  });
});
