import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../eventBus.js";
import type { CharacterAction, TickReport } from "../types.js";

describe("EventBus", () => {
  it("emits streaming events to all subscribers", () => {
    const bus = new EventBus();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    bus.on("actionCompleted", cb1);
    bus.on("actionCompleted", cb2);
    const action = { characterId: "npc1" } as CharacterAction;
    bus.emitActionCompleted(action);
    expect(cb1).toHaveBeenCalledWith(action);
    expect(cb2).toHaveBeenCalledWith(action);
  });

  it("awaits async tickCompleted handlers", async () => {
    const bus = new EventBus();
    let resolved = false;
    bus.on("tickCompleted", async () => {
      await new Promise((r) => setTimeout(r, 5));
      resolved = true;
    });
    await bus.emitTickCompleted({} as TickReport);
    expect(resolved).toBe(true);
  });

  it("unsubscribe removes the listener", () => {
    const bus = new EventBus();
    const cb = vi.fn();
    const off = bus.on("featureEvent", cb);
    off();
    bus.emitFeatureEvent({ type: "x", impact: 0, description: "x" });
    expect(cb).not.toHaveBeenCalled();
  });
});
