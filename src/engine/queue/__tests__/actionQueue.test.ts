import { ActionQueue } from "../actionQueue.js";
import type { QueueEntry } from "../actionQueue.js";

describe("ActionQueue", () => {
  const makeEntry = (overrides: Partial<QueueEntry> = {}): QueueEntry => ({
    nodeId: "n1",
    characterId: "npc_1",
    action: "Search the room",
    startTime: "09:00",
    endTime: "09:05",
    impact: 0,
    status: "pending",
    ...overrides,
  });

  it("adds and retrieves entries", () => {
    const queue = new ActionQueue();
    queue.add(makeEntry());
    expect(queue.getAll()).toHaveLength(1);
  });

  it("activates entries when startTime reached", () => {
    const queue = new ActionQueue();
    queue.add(makeEntry({ startTime: "09:00" }));
    queue.activatePending("09:00");
    expect(queue.getAll()[0].status).toBe("in_progress");
  });

  it("does not activate entries before startTime", () => {
    const queue = new ActionQueue();
    queue.add(makeEntry({ startTime: "09:05" }));
    queue.activatePending("09:00");
    expect(queue.getAll()[0].status).toBe("pending");
  });

  it("getDueEntries returns in_progress entries at endTime", () => {
    const queue = new ActionQueue();
    queue.add(makeEntry({ status: "in_progress", endTime: "09:05" }));
    const due = queue.getDueEntries("09:05");
    expect(due).toHaveLength(1);
  });

  it("getDueEntries excludes entries with steps already set", () => {
    const queue = new ActionQueue();
    queue.add(
      makeEntry({
        status: "in_progress",
        endTime: "09:05",
        steps: [{ definitionId: "search" }],
        currentStepIndex: 0,
      })
    );
    const due = queue.getDueEntries("09:05");
    expect(due).toHaveLength(0);
  });

  it("getActiveMovements returns entries with activeMovement", () => {
    const queue = new ActionQueue();
    queue.add(
      makeEntry({
        status: "in_progress",
        activeMovement: {
          tickState: {
            remainingMinutes: 3,
            destination: "harbor",
            targetPosition: { type: "junction", junctionId: "harbor" },
          },
        },
      })
    );
    const moving = queue.getActiveMovements();
    expect(moving).toHaveLength(1);
  });

  it("sorts by startTime then DEX", () => {
    const queue = new ActionQueue();
    queue.add(
      makeEntry({
        nodeId: "n1",
        characterId: "slow",
        startTime: "09:00",
        status: "in_progress",
      })
    );
    queue.add(
      makeEntry({
        nodeId: "n2",
        characterId: "fast",
        startTime: "09:00",
        status: "in_progress",
      })
    );
    const sorted = queue.getSorted(
      new Map([
        ["slow", 30],
        ["fast", 70],
      ])
    );
    expect(sorted[0].characterId).toBe("fast");
  });

  it("advanceStep increments currentStepIndex", () => {
    const queue = new ActionQueue();
    queue.add(
      makeEntry({
        steps: [
          { definitionId: "movement", args: { destination: "harbor" } },
          { definitionId: "social", args: { targetId: "captain" } },
        ],
        currentStepIndex: 0,
      })
    );
    queue.advanceStep("n1");
    expect(queue.get("n1")?.currentStepIndex).toBe(1);
  });

  it("advanceStep marks completed when all steps done", () => {
    const queue = new ActionQueue();
    queue.add(
      makeEntry({
        steps: [{ definitionId: "search" }],
        currentStepIndex: 0,
      })
    );
    queue.advanceStep("n1");
    expect(queue.get("n1")?.status).toBe("completed");
  });

  it("interrupt changes status and clears movement", () => {
    const queue = new ActionQueue();
    queue.add(
      makeEntry({
        status: "in_progress",
        activeMovement: {
          tickState: {
            remainingMinutes: 2,
            destination: "harbor",
            targetPosition: { type: "junction", junctionId: "harbor" },
          },
        },
      })
    );
    queue.interrupt("n1");
    const entry = queue.get("n1");
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("interrupted");
    expect(entry?.activeMovement).toBeUndefined();
  });
});
