// M3 validator surface: the lookup is built from the FULL state (Tier-1 graph
// + full-world itemHolders), so node scenes and roads are first-class places —
// their items are movable, their conditions removable — and connection ids
// are checked against the registry-backed edge list. New operations:
// setDescription, connectionHidden, removeCondition-by-id, item.create with a
// stable id, item.set hidden.

import { describe, expect, it } from "vitest";
import type { ActionCommand } from "../../actions/types.js";
import {
  type EngineResolutionContext,
  type ResolutionError,
  formatErrorTarget,
} from "../types.js";
import type { RawTickResolution } from "../worldDeltaSchema.js";
import { validateRawResolution } from "../worldDeltaValidator.js";

const ACTION_ID = "action_c1";

const command: ActionCommand = {
  commandId: "c1",
  actorId: "npc_1",
  issuedAt: "1985-07-08T09:00:00",
  issuedSceneId: "SCN_1",
  description: "I search the crossing.",
  objectRefs: [],
  proposedDurationTicks: 2,
};

function makeContext(): EngineResolutionContext {
  return {
    trigger: {
      triggers: [{ actionIds: [ACTION_ID], reason: "new_action" }],
      actionIds: [ACTION_ID],
    },
    tick: {
      tickId: "tick_1",
      tickStartTime: "1985-07-08T09:00:00",
      durationMinutes: 1,
    },
    rules: {
      resolutionGuide: "src/engine/rules/world-action-resolution.md",
      outputSchemaVersion: 1,
      worldInvariants: [],
    },
    state: {
      // Prompt tiers are material for the model; the validator reads only the
      // full-world lookups below (placeKinds/connectionIds/itemHolders).
      graph: {
        places: [
          {
            id: "J_A",
            kind: "scene",
            name: "Crossing",
          },
          {
            id: "R_MAIN",
            kind: "road",
            name: "Star Avenue",
          },
        ],
        edges: [
          { connectionId: "connection.home.junc", from: "LOC_TOWN", to: "J_A" },
          { connectionId: "connection.junc.home", from: "J_A", to: "LOC_TOWN" },
          {
            connectionId: "connection.rmain.a",
            from: "R_MAIN",
            to: "J_A",
            travelTimeMinutes: 10,
          },
        ],
      },
      blockedEdges: [],
      placeKinds: { SCN_1: "scene", J_A: "scene", R_MAIN: "road" },
      connectionIds: [
        "connection.home.junc",
        "connection.junc.home",
        "connection.rmain.a",
      ],
      places: [],
      items: [],
      itemHolders: {
        item_chair: "scene:SCN_1",
        item_lamppost: "scene:J_A",
        item_glove: "scene:R_MAIN",
        item_coin: "npc_1",
      },
      characters: [
        {
          id: "npc_1",
          name: "Ann",
          alive: true,
          attributes: {},
          skills: {},
          hp: 10,
          maxHp: 10,
          san: 50,
          maxSan: 60,
          fatigue: 0,
          maxFatigue: 10,
          position: { type: "scene", sceneId: "J_A" },
          locationId: "J_A",
          conditions: [],
          inventoryItemIds: ["item_coin"],
        },
      ],
    },
    actions: { newCommands: [command], activeActions: [] },
    events: { objectiveWorldEvents: [], deterministicResults: [] },
  };
}

const start = { actionId: ACTION_ID, resolvedDurationTicks: 1 };

const text = (errors: ResolutionError[]): string =>
  errors.map((e) => `${formatErrorTarget(e.target)} ${e.message}`).join("\n");

function validate(partial: Partial<RawTickResolution>): string {
  return text(
    validateRawResolution({ starting: [start], ...partial }, makeContext())
  );
}

const sourced = { sourceActionId: ACTION_ID };

describe("node scenes and roads are first-class item holders", () => {
  it("accepts moving an item off a node scene and off a road", () => {
    expect(
      validate({
        itemChanges: [
          {
            ...sourced,
            itemId: "item_lamppost",
            operation: { kind: "move", from: "scene:J_A", to: "npc_1" },
          },
          {
            ...sourced,
            itemId: "item_glove",
            operation: {
              kind: "move",
              from: "scene:R_MAIN",
              to: "scene:SCN_1",
            },
          },
        ],
      })
    ).toBe("");
  });

  it("accepts creating an item on a road", () => {
    expect(
      validate({
        itemChanges: [
          {
            ...sourced,
            operation: {
              kind: "create",
              name: "a milestone",
              location: "scene:R_MAIN",
            },
          },
        ],
      })
    ).toBe("");
  });
});

describe("scene operations reach node scenes and roads", () => {
  it("accepts addCondition on a node scene and removeCondition {id} on a road", () => {
    expect(
      validate({
        sceneChanges: [
          {
            ...sourced,
            sceneId: "J_A",
            operation: {
              kind: "addCondition",
              condition: { description: "sleet" },
            },
          },
          {
            ...sourced,
            sceneId: "R_MAIN",
            operation: {
              kind: "removeCondition",
              predicate: { id: "cond.road.fog" },
            },
          },
        ],
      })
    ).toBe("");
  });

  it("still rejects a place nobody has", () => {
    expect(
      validate({
        sceneChanges: [
          {
            ...sourced,
            sceneId: "J_NOWHERE",
            operation: {
              kind: "addCondition",
              condition: { description: "x" },
            },
          },
        ],
      })
    ).toContain('sceneId "J_NOWHERE" does not exist');
  });
});

describe("removeCondition predicate shapes", () => {
  const remove = (predicate: object) =>
    validate({
      sceneChanges: [
        {
          ...sourced,
          sceneId: "SCN_1",
          operation: { kind: "removeCondition", predicate } as never,
        },
      ],
    });

  it("rejects an empty predicate", () => {
    expect(remove({})).toContain(
      "requires predicate.id and/or predicate.featureId"
    );
  });

  it("accepts {id}, {featureId} and both", () => {
    expect(remove({ id: "cond.home.dust" })).toBe("");
    expect(remove({ featureId: "fire" })).toBe("");
    expect(remove({ id: "cond.home.dust", featureId: "fire" })).toBe("");
  });
});

describe("connectionBlock / connectionHidden take registry ids", () => {
  it("rejects a connection id that names nothing real", () => {
    const errors = validate({
      sceneChanges: [
        {
          ...sourced,
          sceneId: "J_A",
          operation: {
            kind: "connectionBlock",
            connectionId: "connection.nowhere.door",
            blocked: true,
            reason: "rubble",
          },
        },
      ],
    });
    expect(errors).toContain("names nothing real");
    expect(errors).toContain("exit id");
  });

  it("accepts a registry id for both operations", () => {
    expect(
      validate({
        sceneChanges: [
          {
            ...sourced,
            sceneId: "J_A",
            operation: {
              kind: "connectionBlock",
              connectionId: "connection.junc.home",
              blocked: true,
              reason: "rubble",
            },
          },
          {
            ...sourced,
            sceneId: "SCN_1",
            operation: {
              kind: "connectionHidden",
              connectionId: "connection.home.junc",
              hidden: false,
            },
          },
        ],
      })
    ).toBe("");
  });

  it("rejects connectionHidden without its boolean or with a fake id", () => {
    expect(
      validate({
        sceneChanges: [
          {
            ...sourced,
            sceneId: "SCN_1",
            operation: {
              kind: "connectionHidden",
              connectionId: "connection.home.junc",
            },
          },
        ],
      })
    ).toContain("requires hidden boolean");
    expect(
      validate({
        sceneChanges: [
          {
            ...sourced,
            sceneId: "SCN_1",
            operation: {
              kind: "connectionHidden",
              connectionId: "connection.ghost",
              hidden: true,
            },
          },
        ],
      })
    ).toContain("names nothing real");
  });
});

describe("item.create with an explicit id", () => {
  const create = (id: string) =>
    validate({
      itemChanges: [
        {
          ...sourced,
          operation: {
            kind: "create",
            name: "账本",
            location: "scene:SCN_1",
            id,
          },
        },
      ],
    });

  it("rejects an id an existing item already wears", () => {
    expect(create("item_lamppost")).toContain("already taken");
  });

  it("rejects brackets, whitespace and over-long ids", () => {
    expect(create("item[ledger]")).toContain(
      "must not contain brackets or whitespace"
    );
    expect(create("item ledger")).toContain(
      "must not contain brackets or whitespace"
    );
    expect(create(`item_${"x".repeat(70)}`)).toContain("at most 64 characters");
  });

  it("rejects the same id created twice in one submission", () => {
    expect(
      validate({
        itemChanges: [
          {
            ...sourced,
            operation: {
              kind: "create",
              name: "Ledger",
              location: "scene:SCN_1",
              id: "item.home.ledger",
            },
          },
          {
            ...sourced,
            operation: {
              kind: "create",
              name: "Ledger copy",
              location: "scene:J_A",
              id: "item.home.ledger",
            },
          },
        ],
      })
    ).toContain("created more than once this tick");
  });

  it("lets an occurrence cite the id the same tick creates", () => {
    expect(
      validate({
        itemChanges: [
          {
            ...sourced,
            operation: {
              kind: "create",
              name: "Repair Ledger",
              location: "scene:SCN_1",
              id: "item.home.ledger",
            },
          },
        ],
        occurrences: [
          {
            actionIds: [ACTION_ID],
            speech: false,
            perceivers: [{ characterId: "npc_1", clarity: "full" }],
            content: "a ledger tumbles from the shelf",
          },
        ],
      })
    ).toBe("");
  });
});

describe("item.set hidden and scene setDescription", () => {
  it("accepts a set that carries only the hidden flag (the reveal)", () => {
    expect(
      validate({
        itemChanges: [
          {
            ...sourced,
            itemId: "item_glove",
            operation: { kind: "set", hidden: false },
          },
        ],
      })
    ).toBe("");
  });

  it("still rejects a set that changes nothing", () => {
    expect(
      validate({
        itemChanges: [
          { ...sourced, itemId: "item_glove", operation: { kind: "set" } },
        ],
      })
    ).toContain("at least one of description, appendDescription, hidden");
  });

  it("accepts setDescription with prose and rejects an empty one", () => {
    expect(
      validate({
        sceneChanges: [
          {
            ...sourced,
            sceneId: "R_MAIN",
            operation: {
              kind: "setDescription",
              description: "The avenue lies bare where the stall once stood.",
            },
          },
        ],
      })
    ).toBe("");
    expect(
      validate({
        sceneChanges: [
          {
            ...sourced,
            sceneId: "R_MAIN",
            operation: { kind: "setDescription", description: "  " },
          },
        ],
      })
    ).toContain("non-empty description");
  });
});
