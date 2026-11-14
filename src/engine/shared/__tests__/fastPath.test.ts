import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fastPathMode, recordShadow } from "../fastPath.js";

describe("fastPathMode", () => {
  it("defaults to off", () => {
    expect(fastPathMode("ENGINE_ARRIVAL_SKIP", {})).toBe("off");
  });

  it("reads on and shadow", () => {
    expect(
      fastPathMode("ENGINE_ARRIVAL_SKIP", { ENGINE_ARRIVAL_SKIP: "on" })
    ).toBe("on");
    expect(
      fastPathMode("DECISIONS_PHASE_SKIP", { DECISIONS_PHASE_SKIP: "shadow" })
    ).toBe("shadow");
  });

  it("treats an unknown value as off", () => {
    expect(
      fastPathMode("ENGINE_ARRIVAL_SKIP", { ENGINE_ARRIVAL_SKIP: "yes" })
    ).toBe("off");
  });
});

describe("recordShadow", () => {
  it("appends one JSON line per record when DECISIONS_SHADOW_LOG is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "fastpath-"));
    const file = join(dir, "shadow.jsonl");
    const env = { DECISIONS_SHADOW_LOG: file };
    recordShadow("ENGINE_ARRIVAL_SKIP", { actionId: "a1", agree: true }, env);
    recordShadow("DECISIONS_PHASE_SKIP", { phase: "itemChanges" }, env);

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({
      fastPath: "ENGINE_ARRIVAL_SKIP",
      actionId: "a1",
      agree: true,
    });
    expect(typeof first.at).toBe("string");
    expect(JSON.parse(lines[1])).toMatchObject({
      fastPath: "DECISIONS_PHASE_SKIP",
      phase: "itemChanges",
    });
  });

  it("writes nothing when DECISIONS_SHADOW_LOG is unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "fastpath-"));
    recordShadow("ENGINE_ARRIVAL_SKIP", { actionId: "a1" }, {});
    expect(readdirSync(dir)).toEqual([]);
  });
});
