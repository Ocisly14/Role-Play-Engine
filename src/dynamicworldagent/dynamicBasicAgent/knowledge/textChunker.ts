/**
 * Character-based token estimator for BGE models.
 * CJK characters ~1.5 chars/token, Latin ~4 chars/token.
 * Mixed content uses a blended ratio.
 */
function estimateTokens(text: string): number {
  let cjkCount = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
      (cp >= 0xf900 && cp <= 0xfaff)    // CJK Compatibility
    ) {
      cjkCount++;
    }
  }
  const latinCount = text.length - cjkCount;
  return Math.ceil(cjkCount / 1.5 + latinCount / 4);
}

const SENTENCE_BOUNDARY = /(?<=[。！？\n])|(?<=(?<![A-Z])[.!?]\s)/u;

/**
 * Split text into sentences on natural boundaries.
 */
function splitSentences(text: string): string[] {
  return text.split(SENTENCE_BOUNDARY).filter((s) => s.length > 0);
}

/**
 * Chunk text into segments of at most maxTokens, with overlapTokens of overlap.
 * Tries to split on sentence boundaries; falls back to hard character cut.
 */
export function chunkText(
  text: string,
  maxTokens: number,
  overlapTokens: number
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (estimateTokens(trimmed) <= maxTokens) {
    return [trimmed];
  }

  const sentences = splitSentences(trimmed);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentTokens = estimateTokens(sentence);

    // Single sentence exceeds maxTokens — hard-cut it
    if (sentTokens > maxTokens) {
      if (current.length > 0) {
        chunks.push(current.join(""));
        current = [];
        currentTokens = 0;
      }
      // Hard cut by characters
      let pos = 0;
      while (pos < sentence.length) {
        let end = pos;
        let tokens = 0;
        while (end < sentence.length && tokens < maxTokens) {
          tokens = estimateTokens(sentence.slice(pos, end + 1));
          end++;
        }
        chunks.push(sentence.slice(pos, end));
        pos = end - Math.floor(sentence.length * (overlapTokens / maxTokens));
        if (pos <= 0) pos = end;
      }
      continue;
    }

    if (currentTokens + sentTokens > maxTokens && current.length > 0) {
      chunks.push(current.join(""));

      // Build overlap from tail of current chunk
      const overlap: string[] = [];
      let overlapTokenCount = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const t = estimateTokens(current[i]);
        if (overlapTokenCount + t > overlapTokens) break;
        overlap.unshift(current[i]);
        overlapTokenCount += t;
      }
      current = overlap;
      currentTokens = overlapTokenCount;
    }

    current.push(sentence);
    currentTokens += sentTokens;
  }

  if (current.length > 0) {
    chunks.push(current.join(""));
  }

  return chunks;
}
