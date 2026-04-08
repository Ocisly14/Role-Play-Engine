import type { MovementTickState } from "../types.js";
import type { InterpretedStep, ToolResult } from "../types.js";

export interface QueueEntry {
  nodeId: string;
  characterId: string;
  action: string;
  startTime: string;
  endTime: string;
  impact: number;
  status: "pending" | "in_progress" | "completed" | "failed" | "interrupted";

  steps?: InterpretedStep[];
  currentStepIndex?: number;
  skillCheckResult?: ToolResult;

  activeMovement?: {
    tickState: MovementTickState;
  };
}

/**
 * Compares two "HH:MM" time strings.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareTime(a: string, b: string): number {
  const [aH, aM] = a.split(":").map(Number);
  const [bH, bM] = b.split(":").map(Number);
  return aH * 60 + aM - (bH * 60 + bM);
}

export class ActionQueue {
  private entries = new Map<string, QueueEntry>();

  add(entry: QueueEntry): void {
    this.entries.set(entry.nodeId, entry);
  }

  get(nodeId: string): QueueEntry | undefined {
    return this.entries.get(nodeId);
  }

  getAll(): QueueEntry[] {
    return Array.from(this.entries.values());
  }

  remove(nodeId: string): void {
    this.entries.delete(nodeId);
  }

  /**
   * Transition pending → in_progress for entries whose startTime <= currentTime.
   */
  activatePending(currentTime: string): void {
    for (const entry of this.entries.values()) {
      if (
        entry.status === "pending" &&
        compareTime(entry.startTime, currentTime) <= 0
      ) {
        entry.status = "in_progress";
      }
    }
  }

  /**
   * Transition in_progress → interrupted and clear activeMovement.
   */
  interrupt(nodeId: string): void {
    const entry = this.entries.get(nodeId);
    if (!entry) return;
    if (entry.status === "in_progress") {
      entry.status = "interrupted";
    }
    entry.activeMovement = undefined;
  }

  /**
   * Returns in_progress entries that have no activeMovement, no steps, and
   * whose endTime <= currentTime.
   */
  getDueEntries(currentTime: string): QueueEntry[] {
    return Array.from(this.entries.values()).filter(
      (e) =>
        e.status === "in_progress" &&
        !e.activeMovement &&
        !e.steps &&
        compareTime(e.endTime, currentTime) <= 0
    );
  }

  /**
   * Returns in_progress entries that have steps but no activeMovement and
   * still have remaining steps to execute.
   */
  getInProgressWithSteps(): QueueEntry[] {
    return Array.from(this.entries.values()).filter(
      (e) =>
        e.status === "in_progress" &&
        e.steps !== undefined &&
        !e.activeMovement &&
        (e.currentStepIndex ?? 0) < (e.steps?.length ?? 0)
    );
  }

  /**
   * Returns in_progress entries that have an activeMovement.
   */
  getActiveMovements(): QueueEntry[] {
    return Array.from(this.entries.values()).filter(
      (e) => e.status === "in_progress" && e.activeMovement !== undefined
    );
  }

  /**
   * Increment currentStepIndex. If all steps are done, mark as completed.
   */
  advanceStep(nodeId: string): void {
    const entry = this.entries.get(nodeId);
    if (!entry || !entry.steps) return;
    const nextIndex = (entry.currentStepIndex ?? 0) + 1;
    if (nextIndex >= entry.steps.length) {
      entry.status = "completed";
    } else {
      entry.currentStepIndex = nextIndex;
    }
  }

  /**
   * Returns in_progress entries sorted by startTime ASC, then DEX DESC.
   * Characters not in dexMap default to 0 DEX.
   */
  getSorted(dexMap: Map<string, number>): QueueEntry[] {
    return Array.from(this.entries.values())
      .filter((e) => e.status === "in_progress")
      .sort((a, b) => {
        const timeDiff = compareTime(a.startTime, b.startTime);
        if (timeDiff !== 0) return timeDiff;
        const dexA = dexMap.get(a.characterId) ?? 0;
        const dexB = dexMap.get(b.characterId) ?? 0;
        return dexB - dexA; // DESC
      });
  }

  clear(): void {
    this.entries.clear();
  }
}
