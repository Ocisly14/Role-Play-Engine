/**
 * Shared JSON repair and parse utilities for LLM resolver outputs.
 *
 * LLM responses may contain trailing commas, unescaped control characters,
 * or unclosed brackets. These helpers attempt best-effort repair before parsing.
 */

export function repairJson(text: string): string {
  text = text.replace(/,\s*([}\]])/g, "$1");
  text = text.replace(/"(?:[^"\\]|\\.)*"/g, (match) =>
    match.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
  );
  let inString = false;
  let escape = false;
  const stack: string[] = [];
  for (const ch of text) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  while (stack.length > 0) text += stack.pop();
  return text;
}

/**
 * Extract the first complete top-level JSON object from surrounding text.
 *
 * Models routinely wrap a valid tool call in prose ("Let me think... {json}")
 * or append a trailing remark. Scans for the first `{`, then tracks brace
 * depth while skipping over string literals and escapes, so braces inside
 * string values do not end the object early. Returns null when there is no
 * balanced object — a reply with no JSON at all must still fail loudly.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  // Unbalanced — hand back the tail from the first brace so repairJson can
  // close it (the truncated-output case).
  return text.slice(start);
}

export function parseJsonResponse<T>(raw: string): T {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  text = text.replace(/\\([^"\\\/bfnrtu])/g, "$1");
  try {
    return JSON.parse(text) as T;
  } catch {
    // Direct parse failed: the object may be embedded in prose, or truncated.
    const extracted = extractJsonObject(text);
    if (extracted === null) {
      // No object at all — rethrow the original, more informative error.
      return JSON.parse(text) as T;
    }
    try {
      return JSON.parse(extracted) as T;
    } catch {
      return JSON.parse(repairJson(extracted)) as T;
    }
  }
}
