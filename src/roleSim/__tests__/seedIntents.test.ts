import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { DynamicNPCProfile } from "../../state/types.js";
import { seedNpcLongTermIntents } from "../seedIntents.js";

function makeMemory(): {
  manager: NpcMemoryManager;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const manager = {
    add: async (params: Record<string, unknown>) => {
      calls.push(params);
      return params;
    },
  } as unknown as NpcMemoryManager;
  return { manager, calls };
}

function npc(id: string, longTermIntent: string): DynamicNPCProfile {
  return {
    id,
    name: id,
    attributes: {} as DynamicNPCProfile["attributes"],
    status: {} as DynamicNPCProfile["status"],
    inventory: [],
    skills: {},
    longTermIntent,
    relationships: [],
  };
}

describe("seedNpcLongTermIntents", () => {
  test("writes one memory per NPC with non-empty intent", async () => {
    const { manager, calls } = makeMemory();
    await seedNpcLongTermIntents({
      npcs: [npc("a", "Find the truth"), npc("b", "Protect my family")],
      sessionId: "s1",
      moduleId: "m1",
      memoryManager: manager,
      gameDateTime: "1923-10-17T08:00:00",
    });
    expect(calls.length).toBe(2);
    expect(calls[0]).toMatchObject({
      npcId: "a",
      type: "long_term_intent",
      content: "Find the truth",
      sessionId: "s1",
      moduleId: "m1",
    });
    expect(calls[1]).toMatchObject({
      npcId: "b",
      type: "long_term_intent",
      content: "Protect my family",
    });
  });

  test("skips NPCs with empty longTermIntent", async () => {
    const { manager, calls } = makeMemory();
    await seedNpcLongTermIntents({
      npcs: [npc("a", ""), npc("b", "real intent"), npc("c", "")],
      sessionId: "s1",
      moduleId: "m1",
      memoryManager: manager,
      gameDateTime: "1923-10-17T08:00:00",
    });
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ npcId: "b" });
  });
});
