/**
 * Shared game-time parsing and comparison for DynamicWorld.
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
      gameDay: Number.parseInt(match[1], 10),
      timeOfDay: match[2],
    };
  }
  return null;
}

/**
 * Convert "Day N, HH:MM" to absolute minutes from Day 1 00:00.
 * Returns null when input cannot be parsed.
 */
export function toAbsoluteMinutes(gameTime?: string): number | null {
  const parsed = parseGameTime(gameTime);
  if (!parsed) return null;
  const [h, m] = parsed.timeOfDay.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return (parsed.gameDay - 1) * 1440 + h * 60 + m;
}

/**
 * Returns "to - from" in minutes.
 * Positive means `to` is later than `from`; negative means overdue.
 */
export function diffGameTimeMinutes(
  fromGameTime?: string,
  toGameTime?: string
): number | null {
  const fromAbs = toAbsoluteMinutes(fromGameTime);
  const toAbs = toAbsoluteMinutes(toGameTime);
  if (fromAbs === null || toAbs === null) return null;
  return toAbs - fromAbs;
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
