import {
  applyNpcReactionDecision,
  decideNpcReaction,
} from "../impactReaction.js";
import type { ImpactReactionDecision } from "../impactReaction.js";

describe("decideNpcReaction", () => {
  it("calls runImpactGateForNpc and returns decision", async () => {
    const gateResult = {
      shouldUpdateIntent: true,
      updatedIntent: "Run away!",
      shouldInterruptCurrentNode: true,
      shouldReviseSchedule: false,
      witnessEntry: "A gunshot rang out",
    };
    const npcPlanningAgent = {
      runImpactGateForNpc: vi.fn().mockResolvedValue(gateResult),
      getShortTermIntent: vi.fn().mockResolvedValue(null),
      getLongTermIntent: vi.fn().mockResolvedValue("Investigate the manor"),
      getPendingNodes: vi.fn().mockResolvedValue([]),
      getDailyPlan: vi.fn().mockResolvedValue({ schedule: [], nodes: [] }),
    };

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const result = await decideNpcReaction({
      npcId: "npc_a",
      npcName: "Alice",
      currentLocation: "lobby",
      triggeringEvents: "A gunshot was heard",
      tickTime: "10:00",
      language: "en",
      moduleBackground: "",
      npcPlanningAgent: npcPlanningAgent as any,
      sessionId: "s1",
      gameDay: 1,
    });

    expect(npcPlanningAgent.runImpactGateForNpc).toHaveBeenCalled();
    expect(result.shouldInterruptCurrentNode).toBe(true);
    expect(result.shouldUpdateIntent).toBe(true);
    expect(result.updatedIntent).toBe("Run away!");
    expect(result.witnessEntry).toBe("A gunshot rang out");
  });
});

describe("applyNpcReactionDecision", () => {
  it("updates intent when shouldUpdateIntent is true", async () => {
    const npcPlanningAgent = {
      setShortTermIntent: vi.fn().mockResolvedValue(undefined),
      reviseSchedule: vi.fn().mockResolvedValue(undefined),
    };
    const decision: ImpactReactionDecision = {
      shouldUpdateIntent: true,
      updatedIntent: "Flee!",
      shouldInterruptCurrentNode: false,
      shouldReviseSchedule: false,
      witnessEntry: "Heard something",
    };

    await applyNpcReactionDecision({
      decision,
      npcId: "npc_a",
      sessionId: "s1",
      triggerDescription: "A loud bang",
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      npcPlanningAgent: npcPlanningAgent as any,
      language: "en",
    });

    expect(npcPlanningAgent.setShortTermIntent).toHaveBeenCalledWith(
      "s1",
      "npc_a",
      "Flee!"
    );
    expect(npcPlanningAgent.reviseSchedule).not.toHaveBeenCalled();
  });

  it("calls reviseSchedule when shouldReviseSchedule is true", async () => {
    const npcPlanningAgent = {
      setShortTermIntent: vi.fn().mockResolvedValue(undefined),
      reviseSchedule: vi.fn().mockResolvedValue(undefined),
    };
    const decision: ImpactReactionDecision = {
      shouldUpdateIntent: false,
      shouldInterruptCurrentNode: false,
      shouldReviseSchedule: true,
      witnessEntry: "Fire spreading",
    };

    await applyNpcReactionDecision({
      decision,
      npcId: "npc_a",
      sessionId: "s1",
      triggerDescription: "Fire detected",
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      npcPlanningAgent: npcPlanningAgent as any,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      dgsm: {} as any,
      language: "en",
    });

    expect(npcPlanningAgent.reviseSchedule).toHaveBeenCalled();
  });

  it("does nothing when no flags set", async () => {
    const npcPlanningAgent = {
      setShortTermIntent: vi.fn(),
      reviseSchedule: vi.fn(),
    };
    const decision: ImpactReactionDecision = {
      shouldUpdateIntent: false,
      shouldInterruptCurrentNode: false,
      shouldReviseSchedule: false,
      witnessEntry: "Nothing happened",
    };

    await applyNpcReactionDecision({
      decision,
      npcId: "npc_a",
      sessionId: "s1",
      triggerDescription: "",
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      npcPlanningAgent: npcPlanningAgent as any,
      language: "en",
    });

    expect(npcPlanningAgent.setShortTermIntent).not.toHaveBeenCalled();
    expect(npcPlanningAgent.reviseSchedule).not.toHaveBeenCalled();
  });
});
