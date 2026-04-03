import { describe, expect, it, vi } from "vitest";
import { itemOp } from "../itemOp.js";

describe("itemOp", () => {
  it("has correct id and schema", () => {
    expect(itemOp.id).toBe("item");
    expect(itemOp.schema.requiredParams.map((p) => p.name)).toEqual([
      "actorId",
      "action",
      "itemId",
    ]);
  });

  it("execute returns failure when item not found (preCheck fails)", async () => {
    const dgsm = {
      getCharacterPosition: () => ({ type: "scene", sceneId: "room1" }),
      resolveLocationId: () => "room1",
      getScene: () => ({ id: "room1", name: "Room 1", items: [] }),
      findNpcItem: () => undefined,
      getNpcInventory: () => [],
    };
    const ctx = {
      getScenePenalties: () => new Map(),
      getCharacterPenalties: () => new Map(),
      applyPenalties: (_s: Record<string, number>) => _s,
      resolveSkillRoll: () => ({
        failed: false,
        successLevel: "regular_success",
      }),
      getNodeDifficulty: () => "regular" as const,
    };

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const result = await itemOp.execute(
      { actorId: "npc_a", action: "Pick up knife", itemId: "knife" },
      dgsm as any,
      ctx as any
    );

    expect(result.delta.objectDelta).toBeNull();
    expect(result.delta.failureReason).toBeTruthy();
    expect(result.narrative.outcome).toContain("knife");
  });

  it("execute returns basic delta when no runtime available", async () => {
    const dgsm = {
      getCharacterPosition: () => ({ type: "scene", sceneId: "room1" }),
      resolveLocationId: () => "room1",
      getScene: () => ({
        id: "room1",
        name: "Room 1",
        items: [{ id: "knife", name: "Knife" }],
      }),
      findNpcItem: () => undefined,
      getNpcInventory: () => [],
    };
    const ctx = {
      getScenePenalties: () => new Map(),
      getCharacterPenalties: () => new Map(),
      applyPenalties: (_s: Record<string, number>) => _s,
      resolveSkillRoll: () => ({
        failed: false,
        successLevel: "regular_success",
      }),
      getNodeDifficulty: () => "regular" as const,
      // no runtime property
    };

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const result = await itemOp.execute(
      { actorId: "npc_a", action: "Pick up the knife", itemId: "knife" },
      dgsm as any,
      ctx as any
    );

    expect(result.delta.actorId).toBe("npc_a");
    expect(result.delta.locationId).toBe("room1");
    expect(result.delta.objectDelta).toBeNull();
    expect(result.delta.failureReason).toBeUndefined();
    expect(result.narrative.outcome).toBe("Pick up the knife");
  });

  it("applyDelta delegates to applyObjectDelta when objectDelta present", () => {
    const removeItemFromNpc = vi.fn();
    const addItemToNpc = vi.fn();
    const getScene = vi.fn().mockReturnValue({
      id: "room1",
      items: [{ id: "knife", name: "Knife" }],
    });
    const getNpcInventory = vi.fn().mockReturnValue([]);
    const getState = vi.fn().mockReturnValue({ npcCharacters: [] });

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const dgsm = {
      getScene,
      getNpcInventory,
      getState,
      removeItemFromNpc,
      addItemToNpc,
    } as any;

    itemOp.applyDelta(dgsm, {
      actorId: "npc_a",
      locationId: "room1",
      objectDelta: {
        items: [{ itemId: "knife", location: "inventory" }],
        outcome: "Picked up the knife",
      },
    });

    // The item was in the scene and moved to inventory
    expect(addItemToNpc).toHaveBeenCalledWith(
      "npc_a",
      expect.objectContaining({ id: "knife" })
    );
  });

  it("applyDelta does nothing when objectDelta is null", () => {
    const getScene = vi.fn();

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const dgsm = { getScene } as any;

    itemOp.applyDelta(dgsm, {
      actorId: "npc_a",
      locationId: "room1",
      objectDelta: null,
    });

    expect(getScene).not.toHaveBeenCalled();
  });
});
