import { describe, expect, it } from "vitest";
import type {
  ActionTransition,
  Occurrence,
  PerceptionClarity,
} from "@/engine/actions/types";
import { classifyManualWake, type ManualWakeInput } from "../wakeClassifier";

const PLAYER = "player";

function occ(
  sourceActionIds: string[],
  clarity: PerceptionClarity,
): Occurrence {
  return {
    id: "occ1",
    tickId: "t1",
    sourceActionIds,
    facts: [],
    participants: [],
    perceivers: [{ characterId: PLAYER, clarity }],
    signals: [],
  };
}

function transition(
  to: ActionTransition["to"],
  actionId = "own1",
): ActionTransition {
  return {
    actionId,
    actorId: PLAYER,
    from: "active",
    to,
    progressDeltaMinutes: 1,
  };
}

function input(over: Partial<ManualWakeInput> = {}): ManualWakeInput {
  return {
    playerId: PLAYER,
    occurrences: [],
    transitions: [],
    ownActionIds: new Set(["own1"]),
    hasLiveAction: true,
    hasPendingStep: false,
    ...over,
  };
}

describe("classifyManualWake", () => {
  it.each(["failed", "interrupted", "cancelled"] as const)(
    "own %s transition pauses as failed even with a queued step",
    (to) => {
      expect(
        classifyManualWake(
          input({
            transitions: [transition(to)],
            hasLiveAction: false,
            hasPendingStep: true,
          }),
        ),
      ).toEqual({ kind: "pause", reason: "failed" });
    },
  );

  it.each(["full", "limited"] as const)(
    "another's occurrence at %s clarity wakes the player",
    (clarity) => {
      expect(
        classifyManualWake(input({ occurrences: [occ(["other9"], clarity)] })),
      ).toEqual({ kind: "pause", reason: "woken" });
    },
  );

  it("trace-only occurrences from others do not wake a player with a live action", () => {
    expect(
      classifyManualWake(input({ occurrences: [occ(["other9"], "trace")] })),
    ).toEqual({ kind: "none" });
  });

  it("trace occurrence + own completed step + queued next step advances the queue", () => {
    expect(
      classifyManualWake(
        input({
          occurrences: [occ(["other9"], "trace")],
          transitions: [transition("completed")],
          hasLiveAction: false,
          hasPendingStep: true,
        }),
      ),
    ).toEqual({ kind: "advanceQueue" });
  });

  it("own-action result occurrence + completed + next step advances the queue", () => {
    expect(
      classifyManualWake(
        input({
          occurrences: [occ(["own1"], "full")],
          transitions: [transition("completed")],
          hasLiveAction: false,
          hasPendingStep: true,
        }),
      ),
    ).toEqual({ kind: "advanceQueue" });
  });

  it("feature event with no source actions pauses", () => {
    expect(
      classifyManualWake(input({ occurrences: [occ([], "full")] })),
    ).toEqual({ kind: "pause", reason: "woken" });
  });

  it("no live action and empty queue pauses as idle", () => {
    expect(
      classifyManualWake(
        input({ hasLiveAction: false, hasPendingStep: false }),
      ),
    ).toEqual({ kind: "pause", reason: "idle" });
  });

  it("live action and nothing happening does nothing", () => {
    expect(classifyManualWake(input())).toEqual({ kind: "none" });
  });
});
