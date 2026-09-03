import { describe, expect, it } from "vitest";
import type { EngineAction } from "../../engine/actions/types.js";
import type { TickReport } from "../../engine/core/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { aliasFor } from "../../state/perceivableDirectory.js";
import { collectLandedChecks, formatLandedCheck } from "../landedChecks.js";

function action(
  overrides: Partial<EngineAction> & {
    actorId?: string;
    targets?: Array<{ kind: "character" | "item"; id: string; role: string }>;
    skillId?: string;
    met?: boolean;
  }
): EngineAction {
  const {
    actorId = "npc_owen",
    targets = [],
    skillId,
    met,
    ...rest
  } = overrides;
  return {
    id: "action_1",
    status: "completed",
    submittedAt: "2038-12-06T14:30:00",
    progressMinutes: 2,
    command: {
      actorId,
      issuedAt: "2038-12-06T14:30:00",
      issuedSceneId: "SCN_lodge",
      description: "asks",
      objectRefs: targets as EngineAction["command"]["objectRefs"],
      proposedDurationTicks: 2,
      ...(skillId ? { declaredSkillId: skillId } : {}),
    },
    ...(skillId
      ? { check: { skillId, requiredLevel: "regular", basis: "b" } }
      : {}),
    ...(met !== undefined
      ? {
          checkOutcome: {
            actor: {
              rollId: "r",
              skillId: skillId ?? "",
              skillValue: 55,
              roll: met ? 25 : 90,
              successLevel: met ? "hard" : "failure",
            },
            requiredLevel: "regular",
            met,
            fumble: false,
          },
        }
      : {}),
    ...rest,
  } as EngineAction;
}

function report(to = "completed"): TickReport {
  return {
    gameDateTime: "2038-12-06T14:33:00",
    transitions: [
      {
        actionId: "action_1",
        actorId: "npc_owen",
        from: "active",
        to: to as never,
        progressDeltaMinutes: 1,
      },
    ],
    occurrences: [],
    commits: [],
    cancellations: [],
    featureEvents: [],
    stateChanges: [],
    damageReports: [],
  };
}

const joel = { kind: "character" as const, id: "npc_joel", role: "target" };

describe("collectLandedChecks", () => {
  it("carries a met Social check to each character it was aimed at", () => {
    const engine = {
      getAction: () =>
        action({
          skillId: "Social",
          met: true,
          targets: [
            joel,
            { kind: "character", id: "npc_tommy", role: "recipient" },
            { kind: "item", id: "item.cup", role: "tool" },
          ],
        }),
    };
    expect(collectLandedChecks(report(), engine)).toEqual([
      { targetId: "npc_joel", actorId: "npc_owen", skillId: "Social" },
      { targetId: "npc_tommy", actorId: "npc_owen", skillId: "Social" },
    ]);
  });

  it("carries a met Investigation check put to a person", () => {
    const engine = {
      getAction: () =>
        action({ skillId: "Investigation", met: true, targets: [joel] }),
    };
    expect(collectLandedChecks(report(), engine)).toHaveLength(1);
  });

  it("carries nothing for a missed check — the target held", () => {
    const engine = {
      getAction: () =>
        action({ skillId: "Social", met: false, targets: [joel] }),
    };
    expect(collectLandedChecks(report(), engine)).toEqual([]);
  });

  it("carries nothing for a fumble either", () => {
    const base = action({ skillId: "Social", met: false, targets: [joel] });
    const engine = {
      getAction: () => ({
        ...base,
        ...(base.checkOutcome
          ? { checkOutcome: { ...base.checkOutcome, fumble: true } }
          : {}),
      }),
    };
    expect(collectLandedChecks(report(), engine)).toEqual([]);
  });

  it("ignores skills that resolve in the Engine's facts", () => {
    const engine = {
      getAction: () =>
        action({
          skillId: "Medicine & Psychology",
          met: true,
          targets: [joel],
        }),
    };
    expect(collectLandedChecks(report(), engine)).toEqual([]);
  });

  it("ignores an action with no check, an interrupted one still counts", () => {
    expect(
      collectLandedChecks(report(), {
        getAction: () => action({ targets: [joel] }),
      })
    ).toEqual([]);
    expect(
      collectLandedChecks(report("interrupted"), {
        getAction: () =>
          action({ skillId: "Social", met: true, targets: [joel] }),
      })
    ).toHaveLength(1);
    expect(
      collectLandedChecks(report("active"), {
        getAction: () =>
          action({ skillId: "Social", met: true, targets: [joel] }),
      })
    ).toEqual([]);
  });

  it("never lists the actor as their own target", () => {
    const engine = {
      getAction: () =>
        action({
          skillId: "Social",
          met: true,
          targets: [{ kind: "character", id: "npc_owen", role: "target" }],
        }),
    };
    expect(collectLandedChecks(report(), engine)).toEqual([]);
  });
});

describe("formatLandedCheck", () => {
  const landed = {
    targetId: "npc_joel",
    actorId: "npc_owen",
    skillId: "Social",
  };

  it("names an unknown speaker by the target's alias tag, in the prompt language", () => {
    const dgsm = {
      getRelationship: () => undefined,
    } as unknown as DynamicGameStateManager;
    const tag = aliasFor("npc_joel", "npc_owen");
    expect(formatLandedCheck(landed, dgsm, "zh")).toBe(
      `那个人 [${tag}] 刚才的话让你无法回避，你不得不回答。`
    );
    expect(formatLandedCheck(landed, dgsm, "en")).toContain(
      `the person [${tag}]`
    );
    expect(formatLandedCheck(landed, dgsm, "en")).not.toContain("npc_owen");
  });

  it("names a known speaker by what the target calls them, with their real id", () => {
    const dgsm = {
      getRelationship: () => ({ knownAs: "Owen" }),
    } as unknown as DynamicGameStateManager;
    expect(formatLandedCheck(landed, dgsm, "zh")).toBe(
      "Owen [npc_owen] 刚才的话让你无法回避，你不得不回答。"
    );
  });
});
