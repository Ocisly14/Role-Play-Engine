/**
 * Global API rate limiter: max 50 slots per 60-second sliding window.
 * Shared by the HTTP layer (generation requests) and the NPC builder
 * (internal batch API calls) so both draw from the same budget.
 */

const RATE_LIMIT_MAX = 50;
const RATE_LIMIT_WINDOW_MS = 60_000;

const timestamps: number[] = [];

function evict(): void {
  const windowStart = Date.now() - RATE_LIMIT_WINDOW_MS;
  while (timestamps.length > 0 && timestamps[0]! < windowStart) {
    timestamps.shift();
  }
}

/** How many slots are still free in the current window (read-only). */
export function getAvailableSlots(): number {
  evict();
  return Math.max(0, RATE_LIMIT_MAX - timestamps.length);
}

/**
 * Claim one slot, waiting until one is available if the window is full.
 * Call this once per generation request or per NPC batch API call.
 */
export async function acquireSlot(): Promise<void> {
  while (true) {
    evict();
    if (timestamps.length < RATE_LIMIT_MAX) {
      timestamps.push(Date.now());
      return;
    }
    // Wait until the oldest slot expires
    const waitMs = timestamps[0]! + RATE_LIMIT_WINDOW_MS - Date.now() + 10;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
