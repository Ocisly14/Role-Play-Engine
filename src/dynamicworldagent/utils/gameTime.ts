/**
 * Shared game-time parsing and comparison for DynamicWorld.
 * Used to decide if an NPC's latest actionLog is "after" the scenario snapshot time
 * (e.g. NPC has left or arrived since the snapshot).
 */

/**
 * Parse game time from string format "Day X, HH:MM" or "initial"
 */
export function parseGameTime(
  gameTime?: string
): { gameDay: number; timeOfDay: string } | null {
  if (!gameTime) return null;
  if (gameTime.toLowerCase() === "initial" || !gameTime.includes("Day")) {
    return null;
  }
  const match = gameTime.match(/Day\s*(\d+),\s*(\d{2}:\d{2})/i);
  if (match) {
    return {
      gameDay: parseInt(match[1], 10),
      timeOfDay: match[2],
    };
  }
  return null;
}

/**
 * Returns true if time1 is strictly after time2
 */
export function isTimeAfter(time1: string, time2: string): boolean {
  const t1 = parseGameTime(time1);
  const t2 = parseGameTime(time2);
  if (!t1 || !t2) return false;
  if (t1.gameDay > t2.gameDay) return true;
  if (t1.gameDay < t2.gameDay) return false;
  const [h1, m1] = t1.timeOfDay.split(":").map(Number);
  const [h2, m2] = t2.timeOfDay.split(":").map(Number);
  return h1 > h2 || (h1 === h2 && m1 > m2);
}

/**
 * Get the latest actionLog entry that has both time and location (iterate backwards).
 */
export function getLatestActionLogEntryWithLocation(
  actionLog?: Array<{ time?: string; location?: string }>
): { time: string; location: string } | null {
  if (!actionLog || actionLog.length === 0) return null;
  for (let i = actionLog.length - 1; i >= 0; i--) {
    const e = actionLog[i];
    if (e?.time && e?.location) return { time: e.time, location: e.location };
  }
  return null;
}
