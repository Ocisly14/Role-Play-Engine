import { describe, expect, it } from "vitest";
import { EmergentEventEmitter } from "../emergentEventEmitter.js";
import type { EmergentScanner, ScannerContext } from "../emergentScanner.js";
import type { FeatureEvent } from "../types.js";

class FakeScanner implements EmergentScanner {
  constructor(
    readonly id: string,
    private events: FeatureEvent[]
  ) {}
  scan(): FeatureEvent[] {
    return this.events;
  }
}

const fakeCtx = {} as ScannerContext;

describe("EmergentEventEmitter", () => {
  it("concatenates events from all registered scanners in registration order", () => {
    const emitter = new EmergentEventEmitter([
      new FakeScanner("a", [{ type: "a.evt" }]),
      new FakeScanner("b", [{ type: "b.evt1" }, { type: "b.evt2" }]),
    ]);
    const { featureEvents } = emitter.scan(fakeCtx);
    expect(featureEvents.map((e) => e.type)).toEqual([
      "a.evt",
      "b.evt1",
      "b.evt2",
    ]);
  });

  it("register() adds scanners after construction", () => {
    const emitter = new EmergentEventEmitter();
    emitter.register(new FakeScanner("late", [{ type: "late.evt" }]));
    const { featureEvents } = emitter.scan(fakeCtx);
    expect(featureEvents).toHaveLength(1);
    expect(emitter.listScannerIds()).toEqual(["late"]);
  });
});
