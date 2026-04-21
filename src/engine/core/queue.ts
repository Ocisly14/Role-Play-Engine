import type { ActionStep } from "./types.js";

export class Queue {
  private steps = new Map<string, ActionStep>();
  private dexByActor = new Map<string, number>();

  insert(step: ActionStep, actorDex: number): void {
    this.dexByActor.set(step.characterId, actorDex);
    this.steps.set(step.id, { ...step, status: step.status ?? "queued" });
  }

  get(stepId: string): ActionStep | undefined {
    return this.steps.get(stepId);
  }

  markActive(stepId: string): void {
    const s = this.steps.get(stepId);
    if (!s) return;
    s.status = "active";
  }

  markCompleted(stepId: string): void {
    const s = this.steps.get(stepId);
    if (!s) return;
    s.status = "completed";
  }

  markInterrupted(stepId: string): void {
    const s = this.steps.get(stepId);
    if (!s) return;
    s.status = "interrupted";
  }

  markCancelled(stepId: string): void {
    const s = this.steps.get(stepId);
    if (!s) return;
    s.status = "cancelled";
  }

  remove(stepId: string): void {
    this.steps.delete(stepId);
  }

  hasActiveFor(characterId: string): boolean {
    for (const s of this.steps.values()) {
      if (s.characterId === characterId && s.status === "active") return true;
    }
    return false;
  }

  /** Next queued step for actor, picking lowest stepIndex in any group they own. */
  nextIdleForActor(characterId: string): ActionStep | undefined {
    if (this.hasActiveFor(characterId)) return undefined;
    const queued = [...this.steps.values()]
      .filter((s) => s.characterId === characterId && s.status === "queued")
      .sort((a, b) => {
        if (a.submittedAt.day !== b.submittedAt.day) {
          return a.submittedAt.day - b.submittedAt.day;
        }
        if (a.submittedAt.tickTime !== b.submittedAt.tickTime) {
          return a.submittedAt.tickTime.localeCompare(b.submittedAt.tickTime);
        }
        return a.stepIndex - b.stepIndex;
      });
    return queued[0];
  }

  /** All steps ordered by DEX desc then submittedAt asc — stable view used by commit phase. */
  snapshotAll(): ActionStep[] {
    return [...this.steps.values()].sort((a, b) => {
      const dexA = this.dexByActor.get(a.characterId) ?? 0;
      const dexB = this.dexByActor.get(b.characterId) ?? 0;
      if (dexA !== dexB) return dexB - dexA;
      if (a.submittedAt.day !== b.submittedAt.day) {
        return a.submittedAt.day - b.submittedAt.day;
      }
      return a.submittedAt.tickTime.localeCompare(b.submittedAt.tickTime);
    });
  }

  activeByActor(characterId: string): ActionStep | undefined {
    for (const s of this.steps.values()) {
      if (s.characterId === characterId && s.status === "active") return s;
    }
    return undefined;
  }

  entriesByGroup(stepGroupId: string): ActionStep[] {
    return [...this.steps.values()].filter(
      (s) => s.stepGroupId === stepGroupId,
    );
  }

  isLastStepInChain(stepGroupId: string, stepIndex: number): boolean {
    return !this.entriesByGroup(stepGroupId).some(
      (s) => s.stepIndex > stepIndex && s.status !== "cancelled",
    );
  }

  cancelByHandle(handleId: string): number {
    const hits = [...this.steps.values()].filter((s) => s.handle.id === handleId);
    for (const h of hits) {
      this.steps.delete(h.id);
    }
    return hits.length;
  }

  /** For persistence / resume. */
  serialize(): ActionStep[] {
    return [...this.steps.values()];
  }

  /** Snapshot the per-actor DEX table so persistence can round-trip it. */
  getDexSnapshot(): Map<string, number> {
    return new Map(this.dexByActor);
  }

  rehydrate(steps: ActionStep[], dexByActor: Map<string, number>): void {
    this.steps.clear();
    this.dexByActor = new Map(dexByActor);
    for (const s of steps) this.steps.set(s.id, s);
  }
}
