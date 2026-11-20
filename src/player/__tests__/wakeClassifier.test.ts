import { describe, expect, it } from "vitest";
import type {
  ActionTransition,
  HearingGrade,
  Occurrence,
  SightGrade,
} from "@/engine/actions/types.js";
import { classifyManualWake, type ManualWakeInput } from "../wakeClassifier.js";

const PLAYER = "player";

function occ(
  sourceActionIds: string[],
  [sight, hearing]: [SightGrade, HearingGrade],
): Occurrence {
  return {
    id: "occ1",
    tickId: "t1",
    sourceActionIds,
    facts: [],
    participants: [],
    perceivers: [{ characterId: PLAYER, sight, hearing }],
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
    ...over,
  };
}

describe("classifyManualWake", () => {
  it.each(["failed", "interrupted", "cancelled"] as const)(
    "own %s transition pauses as failed",
    (to) => {
      expect(
        classifyManualWake(
          input({
            transitions: [transition(to)],
            hasLiveAction: false,
          }),
        ),
      ).toEqual({ kind: "pause", reason: "failed" });
    },
  );

  it.each([
    ["clear", "clear"],
    ["partial", "none"],
    ["none", "muffled"],
  ] as Array<[SightGrade, HearingGrade]>)(
    "another's occurrence seen %s / heard %s wakes the player",
    (sight, hearing) => {
      expect(
        classifyManualWake(
          input({ occurrences: [occ(["other9"], [sight, hearing])] }),
        ),
      ).toEqual({ kind: "pause", reason: "woken" });
    },
  );

  it("sourceless occurrences from others do not wake a player with a live action", () => {
    expect(
      classifyManualWake(
        input({ occurrences: [occ(["other9"], ["glimpse", "faint"])] }),
      ),
    ).toEqual({ kind: "none" });
  });

  it("trace occurrence + own completed step + idle pauses as idle", () => {
    expect(
      classifyManualWake(
        input({
          occurrences: [occ(["other9"], ["none", "faint"])],
          transitions: [transition("completed")],
          hasLiveAction: false,
        }),
      ),
    ).toEqual({ kind: "pause", reason: "idle" });
  });

  it("own completed step, nothing from others, idle pauses as idle", () => {
    expect(
      classifyManualWake(
        input({
          occurrences: [occ(["own1"], ["clear", "clear"])],
          transitions: [transition("completed")],
          hasLiveAction: false,
        }),
      ),
    ).toEqual({ kind: "pause", reason: "idle" });
  });

  it("feature event with no source actions pauses", () => {
    expect(
      classifyManualWake(input({ occurrences: [occ([], ["clear", "clear"])] })),
    ).toEqual({ kind: "pause", reason: "woken" });
  });

  it("no live action pauses as idle", () => {
    expect(classifyManualWake(input({ hasLiveAction: false }))).toEqual({
      kind: "pause",
      reason: "idle",
    });
  });

  it("live action and nothing happening does nothing", () => {
    expect(classifyManualWake(input())).toEqual({ kind: "none" });
  });
});
