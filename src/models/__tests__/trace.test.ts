// A resumed run traces into the directory of the run it resumes. The index
// has to continue from what is there, or the first run's files are overwritten
// from 0001 upward — which is how half of one measured run went missing.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { highestTraceIndex } from "../trace.js";

describe("highestTraceIndex", () => {
  it("is 0 for an empty or missing directory", () => {
    expect(highestTraceIndex(mkdtempSync(path.join(tmpdir(), "trace-")))).toBe(
      0
    );
    expect(highestTraceIndex(path.join(tmpdir(), "does-not-exist-xyz"))).toBe(
      0
    );
  });

  it("continues from the highest numbered file present", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "trace-"));
    for (const name of [
      "0001-role-sim-agent.json",
      "0137-world-action-engine.json",
      "0042-phase-g-perception-render.json",
      "notes.txt",
    ]) {
      writeFileSync(path.join(dir, name), "{}");
    }
    expect(highestTraceIndex(dir)).toBe(137);
  });
});
