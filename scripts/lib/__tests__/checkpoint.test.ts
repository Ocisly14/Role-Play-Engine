import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendCheckpointLine,
  finalizeCheckpoint,
  loadCheckpoint,
  openCheckpoint,
} from "../checkpoint.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "cp-test-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("checkpoint", () => {
  it("returns null when file does not exist", () => {
    const loaded = loadCheckpoint(path.join(tmpDir, "missing.jsonl"));
    expect(loaded).toBeNull();
  });

  it("writes header on openCheckpoint", () => {
    const filePath = path.join(tmpDir, "a.jsonl");
    openCheckpoint(filePath, {
      sessionId: "S1",
      moduleName: "Cassandra_zh",
      language: "zh",
      provider: "openai",
      totalCases: 3,
      caseIds: ["a", "b", "c"],
    });
    const contents = readFileSync(filePath, "utf-8");
    const [headerLine] = contents.trim().split("\n");
    const header = JSON.parse(headerLine);
    expect(header.type).toBe("header");
    expect(header.sessionId).toBe("S1");
    expect(header.totalCases).toBe(3);
    expect(header.caseIds).toEqual(["a", "b", "c"]);
    expect(header.startedAt).toBeDefined();
  });

  it("appends case lines and loads them back", () => {
    const filePath = path.join(tmpDir, "b.jsonl");
    openCheckpoint(filePath, {
      sessionId: "S2",
      moduleName: "M",
      language: "zh",
      provider: "openai",
      totalCases: 2,
      caseIds: ["x", "y"],
    });
    appendCheckpointLine(filePath, { type: "case", id: "x", label: "X" });

    const loaded = loadCheckpoint(filePath);
    expect(loaded).not.toBeNull();
    expect(loaded?.header.sessionId).toBe("S2");
    expect(loaded?.completedCaseIds.has("x")).toBe(true);
    expect(loaded?.completedCaseIds.has("y")).toBe(false);
    expect(loaded?.isComplete).toBe(false);
    expect(loaded?.results).toHaveLength(1);
  });

  it("marks isComplete=true when summary line present", () => {
    const filePath = path.join(tmpDir, "c.jsonl");
    openCheckpoint(filePath, {
      sessionId: "S3",
      moduleName: "M",
      language: "zh",
      provider: "openai",
      totalCases: 1,
      caseIds: ["x"],
    });
    appendCheckpointLine(filePath, { type: "case", id: "x" });
    finalizeCheckpoint(filePath, { totalCases: 1, applyPass: 1 });

    const loaded = loadCheckpoint(filePath);
    expect(loaded?.isComplete).toBe(true);
    expect(loaded?.summary).toBeDefined();
    expect((loaded?.summary as Record<string, unknown>)?.totalCases).toBe(1);
  });

  it("ignores a corrupted final line when loading", () => {
    const filePath = path.join(tmpDir, "d.jsonl");
    openCheckpoint(filePath, {
      sessionId: "S4",
      moduleName: "M",
      language: "zh",
      provider: "openai",
      totalCases: 2,
      caseIds: ["x", "y"],
    });
    appendCheckpointLine(filePath, { type: "case", id: "x" });
    // Simulate a crash mid-write by appending invalid JSON
    appendFileSync(filePath, '{"type":"case","id":"y",');

    const loaded = loadCheckpoint(filePath);
    expect(loaded).not.toBeNull();
    expect(loaded?.completedCaseIds.has("x")).toBe(true);
    expect(loaded?.completedCaseIds.has("y")).toBe(false);
    expect(loaded?.isComplete).toBe(false);
  });

  it("openCheckpoint overwrites when fresh=true", () => {
    const filePath = path.join(tmpDir, "e.jsonl");
    openCheckpoint(filePath, {
      sessionId: "OLD",
      moduleName: "M",
      language: "zh",
      provider: "openai",
      totalCases: 1,
      caseIds: ["x"],
    });
    openCheckpoint(filePath, {
      sessionId: "NEW",
      moduleName: "M",
      language: "zh",
      provider: "openai",
      totalCases: 1,
      caseIds: ["x"],
    });
    const loaded = loadCheckpoint(filePath);
    expect(loaded?.header.sessionId).toBe("NEW");
  });

  it("creates parent directory if missing", () => {
    const filePath = path.join(tmpDir, "nested", "deeper", "f.jsonl");
    openCheckpoint(filePath, {
      sessionId: "S",
      moduleName: "M",
      language: "zh",
      provider: "openai",
      totalCases: 0,
      caseIds: [],
    });
    expect(existsSync(filePath)).toBe(true);
  });
});
