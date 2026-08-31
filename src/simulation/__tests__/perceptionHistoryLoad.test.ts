// Reloading a session that has compacted.
//
// Compaction never deletes: the event log stays the whole record of what each
// character lived, because that is what the client reads back and what a
// person debugging a run needs. What compaction changes is only the view the
// prompts get — the newest summary, then the paragraphs it does not already
// speak for. This is where those two facts are kept from contradicting each
// other on reload.

import { describe, expect, it } from "vitest";
import {
  PERCEPTION_COMPACTED_EVENT,
  loadPerceptionHistory,
} from "../runtimePersistence.js";

type Row = {
  actorNpcId: string;
  type: string;
  gameDateTime: string;
  location: string;
  data: Record<string, unknown>;
};

/** Rows come back ordered by (actorNpcId, gameDateTime, timestamp) — the
 *  fixture is written in that order, as the query would return it. */
function prismaWith(rows: Row[]) {
  return {
    simulationEvent: { findMany: async () => rows },
  } as never;
}

const perceived = (npcId: string, minute: string, text: string): Row => ({
  actorNpcId: npcId,
  type: "npc_perceived",
  gameDateTime: `1923-04-02T09:${minute}:00`,
  location: "SCN_library",
  data: { narrative: text },
});

const summary = (npcId: string, minute: string, text: string): Row => ({
  actorNpcId: npcId,
  type: PERCEPTION_COMPACTED_EVENT,
  gameDateTime: `1923-04-02T09:${minute}:00`,
  location: "SCN_library",
  data: { narrative: text, coversThrough: `1923-04-02T09:${minute}:00` },
});

describe("loadPerceptionHistory", () => {
  it("returns every paragraph when nothing has been compacted", async () => {
    const history = await loadPerceptionHistory(
      prismaWith([
        perceived("npc_1", "01", "a"),
        perceived("npc_1", "02", "b"),
      ]),
      "sess"
    );
    expect(history.map((h) => h.narrative)).toEqual(["a", "b"]);
  });

  it("serves the summary plus only the paragraphs it does not cover", async () => {
    const history = await loadPerceptionHistory(
      prismaWith([
        perceived("npc_1", "01", "a"),
        perceived("npc_1", "02", "b"),
        summary("npc_1", "02", "what I would still tell you"),
        perceived("npc_1", "03", "c"),
        perceived("npc_1", "04", "d"),
      ]),
      "sess"
    );
    expect(history.map((h) => h.narrative)).toEqual([
      "what I would still tell you",
      "c",
      "d",
    ]);
  });

  it("uses the newest summary and drops what an older one covered", async () => {
    const history = await loadPerceptionHistory(
      prismaWith([
        perceived("npc_1", "01", "a"),
        summary("npc_1", "01", "first summary"),
        perceived("npc_1", "02", "b"),
        perceived("npc_1", "03", "c"),
        summary("npc_1", "03", "second summary"),
        perceived("npc_1", "04", "d"),
      ]),
      "sess"
    );
    expect(history.map((h) => h.narrative)).toEqual(["second summary", "d"]);
  });

  it("compacts one character without touching another", async () => {
    const history = await loadPerceptionHistory(
      prismaWith([
        perceived("npc_1", "01", "a1"),
        summary("npc_1", "01", "s1"),
        perceived("npc_1", "02", "b1"),
        perceived("npc_2", "01", "a2"),
        perceived("npc_2", "02", "b2"),
      ]),
      "sess"
    );
    expect(
      history.filter((h) => h.npcId === "npc_1").map((h) => h.narrative)
    ).toEqual(["s1", "b1"]);
    expect(
      history.filter((h) => h.npcId === "npc_2").map((h) => h.narrative)
    ).toEqual(["a2", "b2"]);
  });
});
