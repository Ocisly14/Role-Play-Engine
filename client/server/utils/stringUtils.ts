/**
 * Normalize name for fuzzy matching
 * Removes special characters and converts to lowercase
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ")
    .trim();
}

/**
 * Calculate Levenshtein distance (edit distance) between two strings
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return dp[m][n];
}

/**
 * Check if two names are similar (>= 80% similarity)
 * Uses normalized comparison and Levenshtein distance
 */
export function isNameSimilar(name1: string, name2: string): boolean {
  const na = normalizeName(name1);
  const nb = normalizeName(name2);

  if (!na || !nb) return false;
  if (na === nb) return true;

  // Check if first word matches
  const tokensA = na.split(/\s+/);
  const tokensB = nb.split(/\s+/);
  if (tokensA[0] && tokensA[0] === tokensB[0]) return true;

  // Calculate Levenshtein distance and convert to similarity
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return false;

  const similarity = 1 - dist / maxLen;
  return similarity >= 0.8; // 80% similarity threshold
}
