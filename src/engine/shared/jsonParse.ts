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

export function parseJsonResponse<T>(raw: string): T {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  text = text.replace(/\\([^"\\\/bfnrtu])/g, "$1");
  try {
    return JSON.parse(text) as T;
  } catch {
    const repaired = repairJson(text);
    return JSON.parse(repaired) as T;
  }
}
