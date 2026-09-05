// scripts/lib/errorWatch.ts
//
// Per-run diagnostics for the simulation scripts: every console warning and
// error is normalised to a signature and counted, and the run is told when to
// stop. Three figures are kept apart, because one measured run confused them:
// a single World Action Engine dump named four unanswered actions on four
// lines, the four lines collapsed to one signature, and "the same failure 4x"
// stopped the run after the FIRST tick that failed. So:
//
//   count      — log rows carrying this signature (how loud the failure was)
//   tickCount  — completed ticks in which it appeared (how often it recurred)
//   per tick   — which phase failed, how many submission attempts the tick
//                spent on corrections, and which actions the errors named
//
// The stop rule reads only the per-tick figures: the same signature across
// `maxRepeat` ticks, or two ticks in a row that applied nothing.

export function errorSignature(line: string): string {
  return (
    line
      // A tick id carries its number and its clock — `tick_9_2038-12-06T19:09:00`
      // — with no word boundary before either, so it needs its own rule or the
      // same failure in two ticks would never count as the same failure.
      .replace(/\btick_\d+_\d{4}-\d{2}-\d{2}T[\d:]+/g, "<tick>")
      .replace(/\b\d{4}-\d{2}-\d{2}T[\d:]+\b/g, "<time>")
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>")
      .replace(/\baction_[a-z0-9_-]+\b/gi, "<action>")
      .replace(/\b\d+\b/g, "<n>")
      .replace(/"[^"]*"/g, '"…"')
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160)
  );
}

export interface PhaseAttempts {
  phase: string;
  /** Submission attempts the phase took, accepted or not. */
  attempts: number;
  accepted: boolean;
}

export interface TickDiagnostics {
  tick: number;
  globalRewinds: number;
  rewindSubmissions: number;
  /** The tick applied nothing: a resolution failure or a runner error. */
  failed: boolean;
  /** The phase that gave up, when the failure was the engine's. */
  failedPhase?: string;
  /** Every phase that needed more than one attempt, or never got accepted. */
  phaseAttempts: PhaseAttempts[];
  /** Attempts beyond the first, summed over the tick's phases. */
  correctionAttempts: number;
  /** Distinct action ids named by this tick's warnings and errors. */
  affectedActionIds: string[];
}

export interface RunDiagnostics {
  globalRewinds: number;
  rewindSubmissions: number;
  ticks: number;
  failedTicks: number[];
  correctionAttempts: number;
  affectedActions: number;
}

const ACCEPTED =
  /\[WorldActionEngine\].* phase (\w+) accepted after (\d+) attempt\(s\)/;
const PHASE_GAVE_UP =
  /\[WorldActionEngine\].*: phase (\w+) still invalid after (\d+) attempts?, nothing applied/;
const PHASE_FAILED_OTHERWISE =
  /\[WorldActionEngine\].*: (?:call budget of \d+ exhausted|model error) in phase (\w+)(?: after (\d+) submission attempt\(s\))?, nothing applied/;
const ACTION_ID = /\baction_[a-z0-9_-]+\b/gi;

function freshTick(tick = 0): TickDiagnostics {
  return {
    tick,
    globalRewinds: 0,
    rewindSubmissions: 0,
    failed: false,
    phaseAttempts: [],
    correctionAttempts: 0,
    affectedActionIds: [],
  };
}

export class ErrorWatch {
  private readonly counts = new Map<
    string,
    { count: number; tickCount: number; sample: string }
  >();
  private readonly pending = new Set<string>();
  private readonly affected = new Set<string>();
  private restore: Array<() => void> = [];
  private active = false;
  private failedInARow = 0;
  private current: TickDiagnostics = freshTick();
  private readonly history: TickDiagnostics[] = [];

  constructor(private readonly maxRepeat: number) {}

  beginTick(tick = this.history.length + 1): void {
    this.active = true;
    this.pending.clear();
    this.affected.clear();
    this.current = freshTick(tick);
  }

  record(level: "log" | "warn" | "error", line: string): void {
    if (!this.active || !line.trim()) return;
    if (
      line.includes("[WorldActionEngine]") &&
      line.includes("rewinding to phase")
    ) {
      this.current.globalRewinds += 1;
    }
    if (level === "log") {
      const accepted = line.match(ACCEPTED);
      if (accepted) this.notePhase(accepted[1], Number(accepted[2]), true);
      return;
    }
    const gaveUp = line.match(PHASE_GAVE_UP);
    if (gaveUp) {
      this.current.failed = true;
      this.current.failedPhase = gaveUp[1];
      this.notePhase(gaveUp[1], Number(gaveUp[2]), false);
    } else {
      const otherwise = line.match(PHASE_FAILED_OTHERWISE);
      if (otherwise) {
        this.current.failed = true;
        this.current.failedPhase = otherwise[1];
        this.notePhase(otherwise[1], Number(otherwise[2] ?? 0), false);
      } else if (
        line.includes("[SimulationRunner] Error during tick") ||
        (line.includes("[WorldActionEngine]") &&
          line.includes("nothing applied"))
      ) {
        this.current.failed = true;
      }
    }
    for (const id of line.match(ACTION_ID) ?? []) this.affected.add(id);
    const key = errorSignature(line);
    const entry = this.counts.get(key);
    if (entry) entry.count += 1;
    else {
      this.counts.set(key, {
        count: 1,
        tickCount: 0,
        sample: line.trim().slice(0, 300),
      });
    }
    this.pending.add(key);
  }

  private notePhase(phase: string, attempts: number, accepted: boolean): void {
    if (this.current.globalRewinds > 0)
      this.current.rewindSubmissions += attempts;
    if (attempts <= 1 && accepted) return;
    this.current.phaseAttempts.push({ phase, attempts, accepted });
    this.current.correctionAttempts += Math.max(0, attempts - 1);
  }

  endTick(): { diagnostics: TickDiagnostics; stopReason: string | null } {
    if (!this.active) throw new Error("ErrorWatch.endTick requires beginTick");
    this.active = false;
    for (const key of this.pending) {
      const entry = this.counts.get(key);
      if (entry) entry.tickCount += 1;
    }
    this.pending.clear();
    this.current.affectedActionIds = [...this.affected].sort();
    this.history.push(this.current);
    this.failedInARow = this.current.failed ? this.failedInARow + 1 : 0;
    let stopReason: string | null = null;
    if (this.failedInARow >= 2) {
      stopReason = "two ticks in a row failed to resolve";
    } else {
      for (const entry of this.counts.values()) {
        if (entry.tickCount >= this.maxRepeat) {
          stopReason = `the same warning/error in ${entry.tickCount} ticks (${entry.count} log rows): ${entry.sample}`;
          break;
        }
      }
    }
    return { diagnostics: this.current, stopReason };
  }

  /** The run so far, in the three figures the stop rule and the report use. */
  summary(): RunDiagnostics {
    const affected = new Set<string>();
    const failedTicks: number[] = [];
    let correctionAttempts = 0;
    this.history.forEach((t) => {
      if (t.failed) failedTicks.push(t.tick);
      correctionAttempts += t.correctionAttempts;
      for (const id of t.affectedActionIds) affected.add(id);
    });
    return {
      ticks: this.history.length,
      globalRewinds: this.history.reduce((n, t) => n + t.globalRewinds, 0),
      rewindSubmissions: this.history.reduce(
        (n, t) => n + t.rewindSubmissions,
        0
      ),
      failedTicks,
      correctionAttempts,
      affectedActions: affected.size,
    };
  }

  top(limit = 8) {
    return [...this.counts.entries()]
      .map(([signature, value]) => ({ signature, ...value }))
      .sort((a, b) => b.tickCount - a.tickCount || b.count - a.count)
      .slice(0, limit);
  }

  install(): void {
    if (this.restore.length) return;
    for (const level of ["log", "warn", "error"] as const) {
      const original = console[level];
      console[level] = (...args: unknown[]) => {
        this.record(
          level,
          args
            .map((a) =>
              a instanceof Error ? a.message : typeof a === "string" ? a : ""
            )
            .join(" ")
        );
        original.apply(console, args);
      };
      this.restore.push(() => {
        console[level] = original;
      });
    }
  }

  uninstall(): void {
    for (const undo of this.restore.reverse()) undo();
    this.restore = [];
  }
}
