// Phase 7 session loop: code tools answered mid-session, terminal
// submit_resolution accepted alone, one corrective retry on validation
// errors, and fail-all fallbacks on model failure / iteration cap.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { ActionCommand } from "../../actions/types.js";
import { CodeToolRegistry } from "../../tools/codeTool.js";
import type { EngineResolutionContext } from "../types.js";

const generateToolCalls = vi.fn();
vi.mock("../../../models/index.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../../models/types.js"
  );
  return { ...actual, generateToolCalls };
});

const { resolveTick } = await import("../worldActionEngine.js");

const cmd: ActionCommand = {
  commandId: "c1",
  actorId: "npc_1",
  issuedAt: "1923-04-02T09:15:00",
  issuedSceneId: "SCN_1",
  description: "I walk to the far room.",
  objectRefs: [],
  proposedDurationTicks: 3,
};

function makeContext(): EngineResolutionContext {
  return {
    trigger: {
      triggers: [{ actionIds: ["action_c1"], reason: "new_action" }],
      actionIds: ["action_c1"],
    },
    tick: {
      tickId: "tick_1",
      tickStartTime: "1923-04-02T09:15:00",
      durationMinutes: 1,
      worldVersion: "v1",
      randomSeed: "s",
    },
    rules: {
      resolutionGuide: "src/engine/rules/world-action-resolution.md",
      outputSchemaVersion: 1,
      worldInvariants: [],
    },
    state: {
      scenes: [],
      items: [],
      characters: [
        {
          id: "npc_1",
          name: "Marsh",
          alive: true,
          attributes: {},
          skills: {},
          hp: 10,
          maxHp: 10,
          san: 50,
          maxSan: 60,
          fatigue: 0,
          maxFatigue: 10,
          position: null,
          locationId: "",
          conditions: [],
          inventoryItemIds: [],
          relationships: [],
        },
      ],
    },
    actions: { newCommands: [cmd], activeActions: [] },
    events: { objectiveWorldEvents: [], deterministicResults: [] },
  };
}

function turn(calls: Array<{ id: string; name: string; args?: object }>) {
  const toolCalls = calls.map((c) => ({ ...c, args: c.args ?? {} }));
  return {
    toolCalls,
    assistantMessage: { role: "assistant" as const, toolCalls },
  };
}

const validSubmission = {
  actions: [
    {
      actionId: "action_c1",
      to: "active",
      progressDeltaMinutes: 0,
      resolvedDurationTicks: 5,
      timingReason: "route takes five minutes",
      nextWakeInTicks: 5,
      judgement: { kind: "direct", outcome: "continue", reason: "under way" },
      movement: { destinationId: "SCN_FAR" },
    },
  ],
};

function makeDeps() {
  const codeTools = new CodeToolRegistry();
  codeTools.register({
    name: "movementCost",
    description: "stub",
    execute: () => ({ reachable: true, totalMinutes: 5, totalTicks: 5 }),
  });
  return { dgsm: {} as DynamicGameStateManager, codeTools };
}

describe("resolveTick session loop", () => {
  // Braces matter: `() => generateToolCalls.mockReset()` implicitly returns
  // the mock, and vitest treats a function returned from a hook as a teardown
  // callback — it would CALL the mock after each test, re-throwing whatever
  // implementation the test installed.
  beforeEach(() => {
    generateToolCalls.mockReset();
  });

  it("answers code-tool calls, then accepts the lone submission", async () => {
    generateToolCalls
      .mockResolvedValueOnce(
        turn([
          {
            id: "t1",
            name: "movementCost",
            args: { characterId: "npc_1", destinationId: "SCN_FAR" },
          },
        ])
      )
      .mockResolvedValueOnce(
        turn([{ id: "t2", name: "submit_resolution", args: validSubmission }])
      );

    const result = await resolveTick(makeContext(), makeDeps());

    expect(result.resolution.transitions).toEqual([
      expect.objectContaining({
        actionId: "action_c1",
        to: "active",
        resolvedDurationTicks: 5,
        nextWakeAt: "1923-04-02T09:20:00",
      }),
    ]);
    expect(result.movementInits.action_c1).toEqual({
      destinationId: "SCN_FAR",
    });
    expect(result.codeToolInvocations).toHaveLength(1);
    expect(result.codeToolInvocations[0]).toMatchObject({
      toolName: "movementCost",
      output: { reachable: true, totalMinutes: 5, totalTicks: 5 },
    });
    expect(result.droppedViolations).toEqual([]);

    // The second request carried the tool result back to the model.
    const secondCall = generateToolCalls.mock.calls[1][0];
    const toolMsg = secondCall.messages.find(
      (m: { role: string }) => m.role === "tool"
    );
    expect(toolMsg.results[0].content).toContain("reachable");
  });

  it("gives one corrective retry with the violations spelled out", async () => {
    const invalid = {
      actions: [
        {
          actionId: "action_c1",
          to: "active",
          progressDeltaMinutes: 0,
          // missing duration/timing/judgement/nextWake
        },
      ],
    };
    generateToolCalls
      .mockResolvedValueOnce(
        turn([{ id: "t1", name: "submit_resolution", args: invalid }])
      )
      .mockResolvedValueOnce(
        turn([{ id: "t2", name: "submit_resolution", args: validSubmission }])
      );

    const result = await resolveTick(makeContext(), makeDeps());

    expect(result.resolution.transitions[0].to).toBe("active");
    const retryCall = generateToolCalls.mock.calls[1][0];
    const rejection = retryCall.messages.find(
      (m: { role: string }) => m.role === "tool"
    );
    expect(rejection.results[0].content).toContain("REJECTED");
    expect(rejection.results[0].content).toContain("resolvedDurationTicks");
  });

  it("rejects a mixed submit+tool turn without losing the session", async () => {
    generateToolCalls
      .mockResolvedValueOnce(
        turn([
          { id: "t1", name: "movementCost", args: {} },
          { id: "t2", name: "submit_resolution", args: validSubmission },
        ])
      )
      .mockResolvedValueOnce(
        turn([{ id: "t3", name: "submit_resolution", args: validSubmission }])
      );

    const result = await resolveTick(makeContext(), makeDeps());
    expect(result.resolution.transitions[0].to).toBe("active");

    const secondCall = generateToolCalls.mock.calls[1][0];
    const toolMsg = secondCall.messages.find(
      (m: { role: string }) => m.role === "tool"
    );
    const submitResult = toolMsg.results.find(
      (r: { toolCallId: string }) => r.toolCallId === "t2"
    );
    expect(submitResult.content).toContain("NOT accepted");
  });

  it("fails every triggering action when the model call throws", async () => {
    generateToolCalls.mockRejectedValue(new Error("provider down"));

    const result = await resolveTick(makeContext(), makeDeps());

    expect(result.resolution.transitions).toEqual([
      expect.objectContaining({ actionId: "action_c1", to: "failed" }),
    ]);
    expect(result.droppedViolations.join("\n")).toContain("model error");
  });

  it("still-invalid output after the retry drops the bad parts and fails the action", async () => {
    const invalid = {
      actions: [
        { actionId: "action_c1", to: "active", progressDeltaMinutes: 0 },
      ],
    };
    generateToolCalls
      .mockResolvedValueOnce(
        turn([{ id: "t1", name: "submit_resolution", args: invalid }])
      )
      .mockResolvedValueOnce(
        turn([{ id: "t2", name: "submit_resolution", args: invalid }])
      );

    const result = await resolveTick(makeContext(), makeDeps());
    expect(result.resolution.transitions[0]).toMatchObject({
      actionId: "action_c1",
      to: "failed",
    });
    expect(result.droppedViolations.length).toBeGreaterThan(0);
  });
});
