import type {
  CharacterAction,
  FeatureEvent,
  TickReport,
  Unsubscribe,
} from "./types.js";

type AnyCB = (...a: any[]) => unknown | Promise<unknown>;

export class EventBus {
  private listeners: Record<string, Set<AnyCB>> = {};

  on(ev: "actionCompleted", cb: (a: CharacterAction) => void): Unsubscribe;
  on(ev: "actionCancelled", cb: (a: CharacterAction) => void): Unsubscribe;
  on(ev: "featureEvent", cb: (e: FeatureEvent) => void): Unsubscribe;
  on(
    ev: "tickCompleted",
    cb: (r: TickReport) => Promise<void> | void
  ): Unsubscribe;
  on(ev: string, cb: AnyCB): Unsubscribe {
    if (!this.listeners[ev]) this.listeners[ev] = new Set();
    this.listeners[ev].add(cb);
    return () => this.listeners[ev]?.delete(cb);
  }

  /** Snapshot-and-iterate so listeners can safely subscribe / unsubscribe
   *  inside their own callback. New subscriptions take effect on the NEXT
   *  emit; unsubscribes during the current emit still see the rest of the
   *  snapshot list invoked. (Same guarantee as Node's EventEmitter.) */
  private snapshotListeners(channel: string): AnyCB[] {
    return [...(this.listeners[channel] ?? [])];
  }

  emitActionCompleted(a: CharacterAction): void {
    for (const cb of this.snapshotListeners("actionCompleted")) cb(a);
  }
  emitActionCancelled(a: CharacterAction): void {
    for (const cb of this.snapshotListeners("actionCancelled")) cb(a);
  }
  emitFeatureEvent(e: FeatureEvent): void {
    for (const cb of this.snapshotListeners("featureEvent")) cb(e);
  }
  async emitTickCompleted(r: TickReport): Promise<void> {
    for (const cb of this.snapshotListeners("tickCompleted")) await cb(r);
  }
}
