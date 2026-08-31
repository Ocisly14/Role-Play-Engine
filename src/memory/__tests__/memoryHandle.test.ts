import { describe, expect, it } from "vitest";
import { memoryHandle, mintMemoryHandle } from "../memoryHandle.js";

const a = "aaaaaaaa-0000-0000-0000-000000000001";
const b = "aaaaaaaa-0000-0000-0000-000000000002";

describe("mintMemoryHandle", () => {
  it("gives the short form when nothing is in the way", () => {
    expect(mintMemoryHandle(a, new Set())).toBe("Maaaaaaaa");
  });

  it("lengthens only the newcomer, never what is already out there", () => {
    // The earlier design lengthened BOTH sides of a collision, so writing a
    // new memory renamed an old one and a handle the character had already
    // read stopped resolving.
    const first = mintMemoryHandle(a, new Set());
    const second = mintMemoryHandle(b, new Set([first]));

    expect(second).not.toBe(first);
    expect(mintMemoryHandle(a, new Set())).toBe(first);
    expect(second.startsWith("Maaaaaaaa")).toBe(true);
  });

  it("keeps lengthening until it is clear", () => {
    const crowd = new Set([
      memoryHandle(b, 8),
      memoryHandle(b, 10),
      memoryHandle(b, 12),
    ]);
    expect(crowd.has(mintMemoryHandle(b, crowd))).toBe(false);
  });

  it("is stable for the same id", () => {
    expect(memoryHandle(a)).toBe(memoryHandle(a));
  });

  it("handles an id that is not a uuid", () => {
    const handle = memoryHandle("seeded-fixture-1");
    expect(handle).toMatch(/^M[0-9a-f]{8}$/);
    expect(handle).toBe(memoryHandle("seeded-fixture-1"));
  });
});
