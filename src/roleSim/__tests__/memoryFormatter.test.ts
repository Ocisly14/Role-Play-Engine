// The memory block is ~90% of the character's user prompt and sits inside its
// cached prefix, so its byte order has to be a function of the memories alone
// — never of the order the store happened to return them in. The tag at the
// head of each line is what the character cites to correct or retract it.

import { describe, expect, it } from "vitest";
import { buildMemoryTags, formatMemories } from "../memoryFormatter.js";

const rows = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    type: "context",
    content: "The bakery is on Mill Street.",
    gameDateTime: "2003-12-01T00:00:00",
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    type: "context",
    content: "A footbridge crosses the creek.",
    gameDateTime: "2003-12-01T00:00:00",
  },
  {
    id: "33333333-3333-3333-3333-333333333333",
    type: "secret",
    content: "I owe Kovind money.",
    gameDateTime: "2003-12-01T00:00:00",
  },
  {
    id: "44444444-4444-4444-4444-444444444444",
    type: "general",
    content: "Simon came by at noon.",
    gameDateTime: "2003-12-01T12:00:00",
  },
];

const lineFor = (text: string, set = rows) =>
  formatMemories(set)
    .split("\n")
    .find((l) => l.includes(text))!;

describe("formatMemories", () => {
  it("renders chronologically", () => {
    const lines = formatMemories(rows).split("\n");
    expect(lines[lines.length - 1]).toContain("Simon came by at noon");
    expect(lines).toHaveLength(4);
  });

  it("is byte-identical however the store ordered the rows", () => {
    // Every `context` memory is stamped at session start, so sorting on time
    // alone leaves them tied — and a stable sort keeps ties in input order.
    // The store's own ordering used to be a non-unique key, which made that
    // input order a coin flip between ticks.
    const forward = formatMemories(rows);
    const reversed = formatMemories([...rows].reverse());
    const shuffled = formatMemories([rows[2], rows[0], rows[3], rows[1]]);

    expect(reversed).toBe(forward);
    expect(shuffled).toBe(forward);
  });

  it("keeps the location suffix out of the way of the ordering", () => {
    const withPlace = formatMemories([{ ...rows[0], location: "Mill Street" }]);
    expect(withPlace).toContain("(context) at Mill Street The bakery");
  });
});

describe("memory tags", () => {
  it("derives from the row id, so insertion and retraction never repoint one", () => {
    // A positional scheme would renumber everything after a retracted memory,
    // silently aiming a tag the character read last minute at a different one.
    const before = lineFor("Simon came by").slice(0, 13);
    const after = lineFor(
      "Simon came by",
      rows.filter((r) => r.type !== "context")
    ).slice(0, 13);

    expect(before).toBe(after);
    expect(before).toMatch(/^- \[M[0-9a-f]{8}\]$/);
  });

  it("falls back to the untruncated id when two tags would collide", () => {
    const a = "aaaaaaaa-0000-0000-0000-000000000001";
    const b = "aaaaaaaa-0000-0000-0000-000000000002";
    const tags = buildMemoryTags([{ id: a }, { id: b }]);

    expect(tags.get(a)).not.toBe(tags.get(b));
    expect(tags.get(a)).toBe("Maaaaaaaa000000000000000000000001");
  });
});
