/**
 * Deep-merge `updates` into `target` in place.
 * - Plain objects are merged recursively (field by field).
 * - Arrays and primitives are overwritten.
 * - undefined values in updates are skipped.
 * Returns the mutated `target`.
 */
export function deepMergeItem<T extends Record<string, unknown>>(target: T, updates: Partial<T>): T {
  for (const key of Object.keys(updates) as Array<keyof T>) {
    const uVal = updates[key];
    if (uVal === undefined) continue;
    const tVal = target[key];
    if (
      uVal !== null &&
      typeof uVal === "object" &&
      !Array.isArray(uVal) &&
      tVal !== null &&
      typeof tVal === "object" &&
      !Array.isArray(tVal)
    ) {
      deepMergeItem(
        tVal as Record<string, unknown>,
        uVal as Record<string, unknown>,
      );
    } else {
      (target as Record<string, unknown>)[key as string] = uVal;
    }
  }
  return target;
}
