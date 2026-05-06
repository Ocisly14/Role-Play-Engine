import { describe, expect, it, vi } from "vitest";
import type { InterpretedStep } from "../../types.js";
import { ActionIntake } from "../actionIntake.js";
import { Queue } from "../queue.js";

const fakeInterpret = vi.fn<[unknown], Promise<{ steps: InterpretedStep[] }>>();

describe("ActionIntake", () => {
  it("expands interpreter output into ActionSteps sharing stepGroupId", async () => {
    const queue = new Queue();
    fakeInterpret.mockResolvedValueOnce({
      steps: [
        {
          definitionId: "walk",
          impact: 0,
          engine: "llm",
          actionText: "walk to bar",
        } as InterpretedStep,
        {
          definitionId: "order",
          impact: 0,
          engine: "llm",
          actionText: "order whisky",
        } as InterpretedStep,
      ],
    });
    const intake = new ActionIntake({
      queue,
      interpretAction: fakeInterpret,
      getActorDex: () => 60,
      getNow: () => "1923-10-17T08:00:00",
    });
    const handle = await intake.submit({
      characterId: "npc1",
      actionText: "go to bar and order whisky",
      sceneId: "s1",
    });
    const steps = queue.snapshotAll();
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.stepGroupId === handle.id)).toBe(true);
    expect(steps.map((s) => s.stepIndex).sort()).toEqual([0, 1]);
  });
});
