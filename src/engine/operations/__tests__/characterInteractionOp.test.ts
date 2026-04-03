import { characterInteractionOp } from "../characterInteractionOp.js";

describe("characterInteractionOp", () => {
  describe("schema", () => {
    it("has correct id", () => {
      expect(characterInteractionOp.id).toBe("character_interaction");
    });

    it("has required params: actorId, action, targetCharacterIds", () => {
      expect(
        characterInteractionOp.schema.requiredParams.map((p) => p.name)
      ).toEqual(["actorId", "action", "targetCharacterIds"]);
    });

    it("has optional params: skill", () => {
      expect(
        characterInteractionOp.schema.optionalParams?.map((p) => p.name)
      ).toEqual(["skill"]);
    });
  });

  describe("execute", () => {
    it("fails with no_targets when targetCharacterIds is empty", async () => {
      const dgsm = {
        getState: () => ({ npcCharacters: [{ id: "npc_a", skills: {} }] }),
        getCharacterPosition: () => ({ type: "scene", sceneId: "s1" }),
        resolveLocationId: () => "s1",
      };
      const ctx = {
        getScenePenalties: () => new Map(),
        getCharacterPenalties: () => new Map(),
        applyPenalties: (_s: Record<string, number>) => _s,
        resolveSkillRoll: vi.fn(),
      };

      // biome-ignore lint/suspicious/noExplicitAny: test stub
      const result = await characterInteractionOp.execute(
        { actorId: "npc_a", action: "Talk", targetCharacterIds: [] },
        dgsm as any,
        ctx as any
      );

      expect(result.delta.status).toBe("failed");
      expect(result.delta.failureReason).toBe("no_targets");
    });

    it("fails with no_targets when targetCharacterIds is undefined", async () => {
      const dgsm = {
        getState: () => ({ npcCharacters: [{ id: "npc_a", skills: {} }] }),
        getCharacterPosition: () => ({ type: "scene", sceneId: "s1" }),
        resolveLocationId: () => "s1",
      };
      const ctx = {
        getScenePenalties: () => new Map(),
        getCharacterPenalties: () => new Map(),
        applyPenalties: (_s: Record<string, number>) => _s,
        resolveSkillRoll: vi.fn(),
      };

      // biome-ignore lint/suspicious/noExplicitAny: test stub
      const result = await characterInteractionOp.execute(
        { actorId: "npc_a", action: "Talk" },
        dgsm as any,
        ctx as any
      );

      expect(result.delta.status).toBe("failed");
      expect(result.delta.failureReason).toBe("no_targets");
    });

    it("fails with target_absent when target is not co-located", async () => {
      const dgsm = {
        getState: () => ({ npcCharacters: [{ id: "npc_a", skills: {} }] }),
        getCharacterPosition: (id: string) => {
          if (id === "npc_a") return { type: "scene", sceneId: "s1" };
          return { type: "scene", sceneId: "s2" };
        },
        resolveLocationId: (pos: { sceneId: string }) => pos.sceneId,
        isCharacterHidden: () => false,
      };
      const ctx = {
        getScenePenalties: () => new Map(),
        getCharacterPenalties: () => new Map(),
        applyPenalties: (_s: Record<string, number>) => _s,
        resolveSkillRoll: vi.fn(),
      };

      // biome-ignore lint/suspicious/noExplicitAny: test stub
      const result = await characterInteractionOp.execute(
        {
          actorId: "npc_a",
          action: "Talk to B",
          targetCharacterIds: ["npc_b"],
        },
        dgsm as any,
        ctx as any
      );

      expect(result.delta.status).toBe("failed");
      expect(result.delta.failureReason).toBe("target_absent");
    });

    it("fails with target_absent when target is hidden", async () => {
      const dgsm = {
        getState: () => ({ npcCharacters: [{ id: "npc_a", skills: {} }] }),
        getCharacterPosition: () => ({ type: "scene", sceneId: "s1" }),
        resolveLocationId: () => "s1",
        isCharacterHidden: () => true,
      };
      const ctx = {
        getScenePenalties: () => new Map(),
        getCharacterPenalties: () => new Map(),
        applyPenalties: (_s: Record<string, number>) => _s,
        resolveSkillRoll: vi.fn(),
      };

      // biome-ignore lint/suspicious/noExplicitAny: test stub
      const result = await characterInteractionOp.execute(
        {
          actorId: "npc_a",
          action: "Talk to B",
          targetCharacterIds: ["npc_b"],
        },
        dgsm as any,
        ctx as any
      );

      expect(result.delta.status).toBe("failed");
      expect(result.delta.failureReason).toBe("target_absent");
    });

    it("fails with skill_roll_failed when skill roll fails", async () => {
      const dgsm = {
        getState: () => ({
          npcCharacters: [{ id: "npc_a", skills: { Persuade: 40 } }],
        }),
        getCharacterPosition: () => ({ type: "scene", sceneId: "s1" }),
        resolveLocationId: () => "s1",
        isCharacterHidden: () => false,
      };
      const ctx = {
        getScenePenalties: () => new Map(),
        getCharacterPenalties: () => new Map(),
        applyPenalties: (_s: Record<string, number>) => _s,
        resolveSkillRoll: () => ({
          failed: true,
          reason: "Fumble",
          successLevel: "fumble",
        }),
      };

      // biome-ignore lint/suspicious/noExplicitAny: test stub
      const result = await characterInteractionOp.execute(
        {
          actorId: "npc_a",
          action: "Persuade the guard",
          targetCharacterIds: ["npc_guard"],
          skill: "Persuade",
        },
        dgsm as any,
        ctx as any
      );

      expect(result.delta.status).toBe("failed");
      expect(result.delta.failureReason).toBe("skill_roll_failed");
    });

    it("returns completed delta without runtime (no LLM resolution)", async () => {
      const dgsm = {
        getState: () => ({
          npcCharacters: [{ id: "npc_a", skills: {} }],
        }),
        getCharacterPosition: () => ({ type: "scene", sceneId: "s1" }),
        resolveLocationId: () => "s1",
        isCharacterHidden: () => false,
      };
      const ctx = {
        getScenePenalties: () => new Map(),
        getCharacterPenalties: () => new Map(),
        applyPenalties: (_s: Record<string, number>) => _s,
        resolveSkillRoll: vi.fn(),
      };

      // biome-ignore lint/suspicious/noExplicitAny: test stub
      const result = await characterInteractionOp.execute(
        {
          actorId: "npc_a",
          action: "Chat with B",
          targetCharacterIds: ["npc_b"],
        },
        dgsm as any,
        ctx as any
      );

      expect(result.delta.status).toBe("completed");
      expect(result.delta.actorId).toBe("npc_a");
      expect(result.narrative.outcome).toBe("Chat with B");
    });
  });

  describe("applyDelta", () => {
    it("applies actor changes via applyCharacterDelta", async () => {
      const updateHp = vi.fn();
      const updateSan = vi.fn();
      const dgsm = {
        updateNpcHp: updateHp,
        updateNpcSan: updateSan,
        getNpcStats: () => ({ hp: 10, san: 50 }),
        updateNpcStats: vi.fn(),
        getState: () => ({
          npcCharacters: [
            { id: "npc_a", status: { conditions: [] } },
            { id: "npc_b", status: { conditions: [] } },
          ],
        }),
        getCharacterPosition: () => null,
        removeItemFromNpc: () => null,
        addItemToNpc: vi.fn(),
      };

      // biome-ignore lint/suspicious/noExplicitAny: test stub
      characterInteractionOp.applyDelta(dgsm as any, {
        status: "completed",
        actorId: "npc_a",
        locationId: "s1",
        actorChanges: { hpDelta: -2, sanDelta: -1 },
        targetChanges: {},
      });

      expect(updateHp).toHaveBeenCalledWith("npc_a", -2);
      expect(updateSan).toHaveBeenCalledWith("npc_a", -1);
    });

    it("applies target changes via applyCharacterDelta", async () => {
      const updateHp = vi.fn();
      const dgsm = {
        updateNpcHp: updateHp,
        updateNpcSan: vi.fn(),
        getNpcStats: () => ({ hp: 10, san: 50 }),
        updateNpcStats: vi.fn(),
        getState: () => ({
          npcCharacters: [
            { id: "npc_a", status: { conditions: [] } },
            { id: "npc_b", status: { conditions: ["bleeding"] } },
          ],
        }),
        getCharacterPosition: () => null,
        removeItemFromNpc: () => null,
        addItemToNpc: vi.fn(),
      };

      // biome-ignore lint/suspicious/noExplicitAny: test stub
      characterInteractionOp.applyDelta(dgsm as any, {
        status: "completed",
        actorId: "npc_a",
        locationId: "s1",
        actorChanges: null,
        targetChanges: {
          npc_b: { hpDelta: -3 },
        },
      });

      expect(updateHp).toHaveBeenCalledWith("npc_b", -3);
    });

    it("does nothing when status is failed", () => {
      const updateHp = vi.fn();
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      const dgsm = { updateNpcHp: updateHp } as any;

      characterInteractionOp.applyDelta(dgsm, {
        status: "failed",
        actorId: "npc_a",
        locationId: "s1",
        actorChanges: { hpDelta: -2 },
        targetChanges: {},
        failureReason: "no_targets",
      });

      expect(updateHp).not.toHaveBeenCalled();
    });

    it("does nothing when actorChanges is null", () => {
      const updateHp = vi.fn();
      const dgsm = {
        updateNpcHp: updateHp,
        updateNpcSan: vi.fn(),
        getState: () => ({
          npcCharacters: [{ id: "npc_a", status: { conditions: [] } }],
        }),
        getCharacterPosition: () => null,
        removeItemFromNpc: () => null,
        addItemToNpc: vi.fn(),
      };

      // biome-ignore lint/suspicious/noExplicitAny: test stub
      characterInteractionOp.applyDelta(dgsm as any, {
        status: "completed",
        actorId: "npc_a",
        locationId: "s1",
        actorChanges: null,
        targetChanges: {},
      });

      expect(updateHp).not.toHaveBeenCalled();
    });
  });
});
