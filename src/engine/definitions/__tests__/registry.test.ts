import { describe, expect, it } from "vitest";
import type { ActionDefinition } from "../../types.js";
import { ActionDefinitionRegistry } from "../registry.js";

const stub = (
  id: string,
  engine: "code" | "llm" = "llm"
): ActionDefinition => ({
  id,
  engine,
  title: id,
  description: "",
  content: "",
  guidanceBody: "",
});

describe("ActionDefinitionRegistry", () => {
  it("registers and retrieves a definition by id", () => {
    const r = new ActionDefinitionRegistry();
    const def = stub("examine");
    r.register(def);
    expect(r.get("examine")).toBe(def);
  });

  it("returns undefined for unknown id", () => {
    expect(new ActionDefinitionRegistry().get("missing")).toBeUndefined();
  });

  it("warns on overwrite, keeps the most recent", () => {
    const r = new ActionDefinitionRegistry();
    const a = stub("dup");
    const b = stub("dup");
    r.register(a);
    r.register(b);
    expect(r.get("dup")).toBe(b);
  });

  it("getAll returns every registered definition", () => {
    const r = new ActionDefinitionRegistry();
    r.register(stub("a"));
    r.register(stub("b"));
    expect(
      r
        .getAll()
        .map((d) => d.id)
        .sort()
    ).toEqual(["a", "b"]);
  });
});
