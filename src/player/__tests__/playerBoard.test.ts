import { describe, expect, it } from "vitest";
import { addLink, linksTouching, removeLink } from "../playerBoard.js";

describe("player board links", () => {
  it("keeps one link for the same pair and label in either order", () => {
    const links = addLink([], "ada", "ben", " neighbors ");
    expect(links).toEqual([
      { id: expect.any(String), a: "ada", b: "ben", label: "neighbors" },
    ]);
    expect(addLink(links, "ben", "ada", "neighbors")).toBe(links);
    expect(addLink(links, "ada", "ben", "colleagues")).toHaveLength(2);
  });

  it("finds links from either end and removes them by id", () => {
    const links = addLink(
      addLink([], "ada", "ben", "neighbors"),
      "cy",
      "dee",
      "friends"
    );
    expect(linksTouching(links, "ada")).toEqual([links[0]]);
    expect(linksTouching(links, "ben")).toEqual([links[0]]);
    expect(removeLink(links, links[0].id)).toEqual([links[1]]);
    expect(removeLink(links, "missing")).toBe(links);
  });

  it("requires two different people and a nonblank label", () => {
    expect(() => addLink([], "ada", "ada", "neighbors")).toThrow(
      "two different people"
    );
    expect(() => addLink([], "ada", "ben", " ")).toThrow("empty link label");
  });
});
