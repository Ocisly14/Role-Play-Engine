import { afterEach, describe, expect, it, vi } from "vitest";
import type { Occurrence } from "../../engine/actions/types.js";
import type { DecisionAnswer } from "../../models/decisions.js";
import type { PerceivedBundle } from "../renderer/types.js";
import {
  ACT_QUESTION,
  PendingDelivery,
  buildGateRequest,
  gateSaysSkip,
  hardWakeReason,
} from "../wakeGate.js";

function occ(overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    id: "occ_1",
    tickId: "1923-04-02T09:01:00",
    sourceActionIds: ["a1"],
    facts: [{ id: "f0", type: "action_result", content: "x", entityRefs: [] }],
    participants: [{ characterId: "npc_2", role: "actor" }],
    perceivers: [{ characterId: "npc_1", sight: "clear", hearing: "clear" }],
    signals: [],
    ...overrides,
  } as Occurrence;
}

const base = {
  npcId: "npc_1",
  ownActionEnded: false,
  occurrences: [] as Occurrence[],
  hasHistory: true,
};

describe("hardWakeReason", () => {
  it("wakes on an ended action or no history", () => {
    expect(hardWakeReason({ ...base, ownActionEnded: true })).not.toBeNull();
    expect(hardWakeReason({ ...base, hasHistory: false })).not.toBeNull();
  });

  it("wakes someone addressed or involved", () => {
    const addressed = occ({
      participants: [
        { characterId: "npc_2", role: "actor" },
        { characterId: "npc_1", role: "target" },
      ],
    });
    expect(
      hardWakeReason({ ...base, occurrences: [addressed] })
    ).not.toBeNull();
  });

  it("wakes a listener who hears a line spoken to the room clearly", () => {
    const toRoom = occ({
      facts: [
        { id: "f0", type: "utterance", content: "Hello", entityRefs: [] },
      ],
    });
    expect(hardWakeReason({ ...base, occurrences: [toRoom] })).not.toBeNull();
  });

  it("leaves a bystander to the gate", () => {
    expect(hardWakeReason({ ...base, occurrences: [occ()] })).toBeNull();
    const muffled = occ({
      facts: [
        { id: "f0", type: "utterance", content: "Hello", entityRefs: [] },
      ],
      perceivers: [{ characterId: "npc_1", sight: "none", hearing: "faint" }],
    });
    expect(hardWakeReason({ ...base, occurrences: [muffled] })).toBeNull();
  });
});

describe("reading the gate", () => {
  afterEach(() => vi.unstubAllEnvs());
  const answers = (p?: number) =>
    new Map<string, DecisionAnswer>(
      p === undefined
        ? []
        : [
            [
              ACT_QUESTION,
              { name: ACT_QUESTION, type: "predicate", probability: p },
            ],
          ]
    );

  it("skips only when confident they will not act", () => {
    expect(gateSaysSkip(answers(0.05))).toBe(true);
    expect(gateSaysSkip(answers(0.1))).toBe(true);
    expect(gateSaysSkip(answers(0.11))).toBe(false);
    expect(gateSaysSkip(answers())).toBe(false);
  });
});

describe("buildGateRequest", () => {
  it("drops this minute's paragraph and the decide section, keeps the rest", () => {
    const bundle = {
      scene: {
        id: "SCN_1",
        name: "Room",
        description: "",
        activeConditions: [],
        items: [],
        adjacentPlaces: [],
      },
      ownConditions: [],
      ownAction: { kind: "idle" },
      occurrences: [],
      charactersInScene: [],
    } as unknown as PerceivedBundle;
    const req = buildGateRequest({
      npcId: "npc_1",
      agentSegments: [
        { text: "# You are A\n## Who you are\nme", cache: true },
        {
          text: "## What you perceive now\nthe paragraph\n## Decide\ngo",
          cache: false,
        },
      ],
      bundle,
    });
    const text = (req.input.text ?? []).join("\n");
    expect(text).toContain("## Who you are");
    expect(text).not.toContain("the paragraph");
    expect(text).not.toContain("## Decide");
    expect(req.questions.map((q) => q.name)).toEqual([ACT_QUESTION]);
    expect(req.operation).toBe("decisions:wake-gate");
  });
});

describe("PendingDelivery", () => {
  it("holds without duplicates, reports full at the cap, hands everything over", () => {
    const pending = new PendingDelivery(2);
    pending.hold("npc_1", [occ({ id: "o1" })]);
    pending.hold("npc_1", [occ({ id: "o1" }), occ({ id: "o2" })]);
    expect(pending.peek("npc_1").map((o) => o.id)).toEqual(["o1", "o2"]);
    expect(pending.isFull("npc_1")).toBe(true);
    expect(pending.take("npc_1").map((o) => o.id)).toEqual(["o1", "o2"]);
    expect(pending.peek("npc_1")).toEqual([]);
  });

  it("round-trips through serialize / rehydrate", () => {
    const a = new PendingDelivery(5);
    a.hold("npc_1", [occ({ id: "o1" })]);
    const b = new PendingDelivery(5);
    b.rehydrate(JSON.parse(JSON.stringify(a.serialize())));
    expect(b.peek("npc_1").map((o) => o.id)).toEqual(["o1"]);
  });
});
