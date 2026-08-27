// writeMemory's revise/retract path is a trust boundary: `ref` is agent
// output, and it names a row in a shared table. The rules under test are the
// same two the `act` boundary applies to objectRefs — you may only point at
// what you were shown, and the store call is scoped so a wrong id changes
// nothing.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchInstantTool } from "../toolDispatcher.js";
import { memoryTag } from "../memoryFormatter.js";

const MINE = "11111111-1111-1111-1111-111111111111";
const CONTEXT = "22222222-2222-2222-2222-222222222222";

const add = vi.fn(async () => ({}));
const reviseOwn = vi.fn(async () => true);
const retractOwn = vi.fn(async () => true);

function deps() {
  return {
    memory: { add, reviseOwn, retractOwn } as never,
    dgsm: {} as never,
    npcId: "npc_1",
    sessionId: "sess_1",
    moduleId: "mod_1",
    gameDateTime: "1923-04-02T09:15:00",
    memories: [
      { id: MINE, type: "general", content: "Hollins was at the harbour." },
      { id: CONTEXT, type: "context", content: "The bakery is on Mill Street." },
    ],
  };
}

const caps = () => ({ writeMemory: 3 });

beforeEach(() => {
  add.mockClear();
  reviseOwn.mockClear();
  retractOwn.mockClear();
});

describe("writeMemory op=replace", () => {
  it("revises the memory the tag names, scoped to this character", async () => {
    const { result } = await dispatchInstantTool(
      "writeMemory",
      { op: "replace", ref: memoryTag(MINE), content: "Hollins lied." },
      caps(),
      deps()
    );

    expect(reviseOwn).toHaveBeenCalledWith({
      memoryId: MINE,
      sessionId: "sess_1",
      npcId: "npc_1",
      content: "Hollins lied.",
      metadata: { revisedAt: "1923-04-02T09:15:00" },
    });
    expect(result).toContain("Corrected");
  });

  it("refuses a tag that was not in this decision's prompt", async () => {
    const { result } = await dispatchInstantTool(
      "writeMemory",
      { op: "replace", ref: "Mdeadbeef", content: "..." },
      caps(),
      deps()
    );

    expect(reviseOwn).not.toHaveBeenCalled();
    expect(result).toContain("not a memory of yours");
  });

  it("refuses to rewrite a system-authored memory", async () => {
    const { result } = await dispatchInstantTool(
      "writeMemory",
      { op: "replace", ref: memoryTag(CONTEXT), content: "..." },
      caps(),
      deps()
    );

    expect(reviseOwn).not.toHaveBeenCalled();
    expect(result).toContain("not yours to change");
  });

  it("requires the whole corrected memory, not a diff", async () => {
    const { result } = await dispatchInstantTool(
      "writeMemory",
      { op: "replace", ref: memoryTag(MINE) },
      caps(),
      deps()
    );

    expect(reviseOwn).not.toHaveBeenCalled();
    expect(result).toContain("not just what changed");
  });
});

describe("writeMemory op=delete", () => {
  it("retracts the memory the tag names", async () => {
    const { result } = await dispatchInstantTool(
      "writeMemory",
      { op: "delete", ref: memoryTag(MINE) },
      caps(),
      deps()
    );

    expect(retractOwn).toHaveBeenCalledWith({
      memoryId: MINE,
      sessionId: "sess_1",
      npcId: "npc_1",
    });
    expect(result).toContain("Forgotten");
  });

  it("reports a row that vanished between prompt and call", async () => {
    retractOwn.mockResolvedValueOnce(false);
    const { result } = await dispatchInstantTool(
      "writeMemory",
      { op: "delete", ref: memoryTag(MINE) },
      caps(),
      deps()
    );

    expect(result).toContain("no longer in your memory");
  });

  it("needs a ref", async () => {
    const { result } = await dispatchInstantTool(
      "writeMemory",
      { op: "delete" },
      caps(),
      deps()
    );

    expect(retractOwn).not.toHaveBeenCalled();
    expect(result).toContain("requires 'ref'");
  });
});

describe("writeMemory op=add", () => {
  it("stays the default, so an omitted op still writes", async () => {
    await dispatchInstantTool(
      "writeMemory",
      { type: "general", content: "The drawer finally gave." },
      caps(),
      deps()
    );

    expect(add).toHaveBeenCalledTimes(1);
    expect(reviseOwn).not.toHaveBeenCalled();
    expect(retractOwn).not.toHaveBeenCalled();
  });

  it("shares one budget with replace and delete", async () => {
    const budget = { writeMemory: 1 };
    const d = deps();
    await dispatchInstantTool(
      "writeMemory",
      { op: "delete", ref: memoryTag(MINE) },
      budget,
      d
    );
    const { result } = await dispatchInstantTool(
      "writeMemory",
      { type: "general", content: "..." },
      budget,
      d
    );

    expect(result).toContain("maximum allowed times");
    expect(add).not.toHaveBeenCalled();
  });
});
