import type { SimulationEvent, SimulationEventType } from "./types.js";

/** Event types that bypass the buffer and are delivered immediately. */
const IMMEDIATE_EVENT_TYPES: ReadonlySet<SimulationEventType> = new Set([
  "simulation_state_changed",
  "npc_death",
]);

/**
 * Decouples simulation speed from display speed.
 *
 * Events produced by the (fast) simulation loop are enqueued per tick and
 * released at the configured display rhythm. The default is zero pre-buffer.
 */
export class PlaybackScheduler {
  // --- Config ---
  private displayIntervalMs: number;
  private readonly minBufferTicks: number;
  /** Wall-clock time (ms) before which no events are released. */
  private readonly displayStartTime: number | undefined;

  // --- State ---
  private readonly eventBuffer: Map<number, SimulationEvent[]> = new Map();
  private nextDisplayTick = 1;
  private highestBufferedTick = 0;
  private lastReleasedGameDateTime: string | null = null;
  private displayTimerId: ReturnType<typeof setInterval> | null = null;
  private isPlaybackStarted = false;
  private broadcastCallback: ((events: SimulationEvent[]) => void) | null =
    null;
  /** Timer for waiting until displayStartTime is reached. */
  private wallclockTimerId: ReturnType<typeof setTimeout> | null = null;

  /** When true, enqueued events are delivered immediately (step mode). */
  private immediateMode = false;

  constructor(opts?: {
    displayIntervalMs?: number;
    minBufferTicks?: number;
    displayStartTime?: number;
  }) {
    this.displayIntervalMs = opts?.displayIntervalMs ?? 60_000;
    this.minBufferTicks = opts?.minBufferTicks ?? 0;
    this.displayStartTime = opts?.displayStartTime;
  }

  // ── Public API ────────────────────────────────────────────────

  setBroadcastCallback(cb: (events: SimulationEvent[]) => void): void {
    this.broadcastCallback = cb;
  }

  getBroadcastCallback(): ((events: SimulationEvent[]) => void) | null {
    return this.broadcastCallback;
  }

  /**
   * Enqueue a tick's events.
   * Immediate-type events are broadcast right away regardless of buffer state.
   * Normal events wait for playback rhythm.
   */
  enqueue(events: SimulationEvent[], tick: number): void {
    if (events.length === 0) return;

    // Separate immediate vs normal
    const immediate: SimulationEvent[] = [];
    const normal: SimulationEvent[] = [];
    for (const e of events) {
      if (IMMEDIATE_EVENT_TYPES.has(e.type)) {
        immediate.push(e);
      } else {
        normal.push(e);
      }
    }

    // Deliver immediate events right away
    if (immediate.length > 0) {
      this.broadcastCallback?.(immediate);
    }

    // In immediate mode (step), deliver everything at once
    if (this.immediateMode) {
      if (normal.length > 0) {
        this.broadcastCallback?.(normal);
      }
      return;
    }

    // Buffer normal events
    if (normal.length > 0) {
      const existing = this.eventBuffer.get(tick);
      if (existing) {
        existing.push(...normal);
      } else {
        this.eventBuffer.set(tick, [...normal]);
      }
      if (tick > this.highestBufferedTick) {
        this.highestBufferedTick = tick;
      }
    }

    // Auto-start playback when buffer is large enough
    if (
      !this.isPlaybackStarted &&
      this.bufferedCount() >= this.minBufferTicks
    ) {
      this.startPlayback();
    }

    // Resume from buffering pause (only if wallclock gate has passed)
    const wallclockReady =
      !this.displayStartTime || Date.now() >= this.displayStartTime;
    if (
      this.isPlaybackStarted &&
      !this.displayTimerId &&
      !this.wallclockTimerId &&
      wallclockReady &&
      this.bufferedCount() >= this.minBufferTicks
    ) {
      this.broadcastCallback?.([this.makeMetaEvent("playback_resumed")]);
      this.startDisplayTimer();
    }
  }

  startPlayback(): void {
    if (this.isPlaybackStarted) return;
    this.isPlaybackStarted = true;

    // If displayStartTime is set and hasn't arrived yet, defer the display timer
    if (this.displayStartTime && Date.now() < this.displayStartTime) {
      const waitMs = this.displayStartTime - Date.now();
      this.wallclockTimerId = setTimeout(() => {
        this.wallclockTimerId = null;
        if (this.isPlaybackStarted && this.bufferedCount() > 0) {
          this.startDisplayTimer();
        }
      }, waitMs);
      return;
    }

    this.startDisplayTimer();
  }

  pausePlayback(): void {
    this.stopDisplayTimer();
  }

  resumePlayback(): void {
    if (!this.isPlaybackStarted) return;
    // If wallclock gate hasn't passed, re-schedule the deferred start
    if (this.displayStartTime && Date.now() < this.displayStartTime) {
      if (!this.wallclockTimerId) {
        const waitMs = this.displayStartTime - Date.now();
        this.wallclockTimerId = setTimeout(() => {
          this.wallclockTimerId = null;
          if (this.isPlaybackStarted && this.bufferedCount() > 0) {
            this.startDisplayTimer();
          }
        }, waitMs);
      }
      return;
    }
    if (this.bufferedCount() >= this.minBufferTicks) {
      this.startDisplayTimer();
    }
  }

  /** Enable immediate mode — events bypass buffer entirely (for step mode). */
  setImmediateMode(enabled: boolean): void {
    this.immediateMode = enabled;
  }

  updateDisplayInterval(ms: number): void {
    this.displayIntervalMs = ms;
    // Restart timer with new interval if currently playing
    if (this.displayTimerId) {
      this.stopDisplayTimer();
      this.startDisplayTimer();
    }
  }

  getBufferStatus(): {
    buffered: number;
    displayTick: number;
    simulationTick: number;
    isPlaying: boolean;
    displayStartTime?: number;
    timeUntilStart?: number;
    displayGameDateTime?: string;
  } {
    const now = Date.now();
    const timeUntilStart =
      this.displayStartTime && now < this.displayStartTime
        ? this.displayStartTime - now
        : 0;
    return {
      buffered: this.bufferedCount(),
      displayTick: this.nextDisplayTick - 1,
      simulationTick: this.highestBufferedTick,
      isPlaying: this.displayTimerId !== null,
      displayStartTime: this.displayStartTime,
      timeUntilStart,
      displayGameDateTime: this.lastReleasedGameDateTime ?? undefined,
    };
  }

  /** Reset state (e.g. on stop). */
  destroy(): void {
    this.stopDisplayTimer();
    if (this.wallclockTimerId) {
      clearTimeout(this.wallclockTimerId);
      this.wallclockTimerId = null;
    }
    this.eventBuffer.clear();
    this.isPlaybackStarted = false;
    this.highestBufferedTick = 0;
    this.nextDisplayTick = 1;
    this.lastReleasedGameDateTime = null;
  }

  // ── Private ───────────────────────────────────────────────────

  private bufferedCount(): number {
    return this.highestBufferedTick - this.nextDisplayTick + 1;
  }

  private startDisplayTimer(): void {
    if (this.displayTimerId) return;
    this.displayTimerId = setInterval(
      () => this.releaseNextTick(),
      this.displayIntervalMs
    );
    // Release the first tick immediately so there's no initial delay
    this.releaseNextTick();
  }

  private stopDisplayTimer(): void {
    if (this.displayTimerId) {
      clearInterval(this.displayTimerId);
      this.displayTimerId = null;
    }
  }

  private releaseNextTick(): void {
    const events = this.eventBuffer.get(this.nextDisplayTick);
    if (events) {
      const lastEvent = events[events.length - 1];
      this.lastReleasedGameDateTime =
        lastEvent?.gameDateTime ?? this.lastReleasedGameDateTime;
      this.broadcastCallback?.(events);
      this.eventBuffer.delete(this.nextDisplayTick);
      this.nextDisplayTick++;
    } else if (this.nextDisplayTick > this.highestBufferedTick) {
      // Buffer exhausted — pause and notify
      this.stopDisplayTimer();
      this.broadcastCallback?.([this.makeMetaEvent("playback_buffering")]);
    } else {
      // Tick exists in sequence but had no normal events — skip
      this.nextDisplayTick++;
    }
  }

  /** Create a lightweight meta event (playback_buffering / playback_resumed). */
  private makeMetaEvent(
    type: "playback_buffering" | "playback_resumed"
  ): SimulationEvent {
    return {
      id: `meta_${type}_${Date.now()}`,
      sessionId: "",
      tick: this.nextDisplayTick - 1,
      gameDateTime: "1900-01-01T00:00:00",
      type,
      actorNpcId: "system",
      location: "global",
      data: {
        ...(this.displayStartTime
          ? { displayStartTime: this.displayStartTime }
          : {}),
      },
      timestamp: new Date(),
    };
  }
}
