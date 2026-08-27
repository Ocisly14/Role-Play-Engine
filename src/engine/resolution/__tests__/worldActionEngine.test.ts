// Phase 7 session loop: code tools answered mid-session, terminal
// submit_resolution accepted alone, addressed errors repaired INCREMENTALLY
// via repair_resolution, and — when repair cannot converge or the model
// fails — a result that applies nothing at all.

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

const { renderContext, renderContextSegments, resolveTick } = await import(
  "../worldActionEngine.js"
);

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
    },
    rules: {
      resolutionGuide: "src/engine/rules/world-action-resolution.md",
      outputSchemaVersion: 1,
      worldInvariants: [],
    },
    state: {
      // The scene the actor stands in, and the one it connects to. The
      // movement destination has to be somewhere the Engine was shown.
      scenes: [
        {
          id: "SCN_1",
          name: "Reading room",
          description: "Shelves and a long table.",
          parentLocationId: "OUTDOOR",
          conditions: [],
          itemIds: [],
          connections: [{ targetId: "SCN_FAR", description: "a far door" }],
          environment: {
            temperature: 18,
            illumination: 60,
            oxygen: 100,
            noise: 10,
            airborneHazards: [],
          },
          presentCharacterIds: ["npc_1"],
        },
      ],
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
  starting: [
    {
      actionId: "action_c1",
      resolvedDurationTicks: 5,
      timingReason: "route takes five minutes",
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

    expect(result.ok).toBe(true);
    if (!result.ok) return;
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

    // The second request carried the tool result back to the model.
    const secondCall = generateToolCalls.mock.calls[1][0];
    const toolMsg = secondCall.messages.find(
      (m: { role: string }) => m.role === "tool"
    );
    expect(toolMsg.results[0].content).toContain("reachable");
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
    expect(result.ok).toBe(true);
    if (!result.ok) return;
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

  it("applies nothing when the model call throws", async () => {
    // An engine that cannot answer is a fault, not an event in the world:
    // the actions keep the state they had rather than being marked failed.
    generateToolCalls.mockRejectedValue(new Error("provider down"));

    const result = await resolveTick(makeContext(), makeDeps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toContain("model error");
  });

  it("repairs incrementally: only the flagged element is re-sent", async () => {
    // The action is queued, so ending it is the wrong moment entirely.
    const invalid = {
      ending: [
        {
          actionId: "action_c1",
          outcome: "success",
          reason: "done already",
          occurrence: {
            facts: [{ type: "action_result", content: "the door opens" }],
            participants: [{ characterId: "npc_1", role: "actor" }],
            perceiverCharacterIds: ["npc_1"],
          },
        },
      ],
    };
    generateToolCalls
      .mockResolvedValueOnce(
        turn([{ id: "t1", name: "submit_resolution", args: invalid }])
      )
      .mockResolvedValueOnce(
        turn([
          {
            id: "t2",
            name: "repair_resolution",
            // Only the transition, moved into the moment it belongs in.
            args: { starting: validSubmission.starting },
          },
        ])
      );

    const result = await resolveTick(makeContext(), makeDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolution.transitions[0]).toMatchObject({
      actionId: "action_c1",
      to: "active",
      resolvedDurationTicks: 5,
    });

    // The rejection addressed the element, and demanded a patch not a rewrite.
    const repairCall = generateToolCalls.mock.calls[1][0];
    const rejection = repairCall.messages.find(
      (m: { role: string }) => m.role === "tool"
    );
    expect(rejection.results[0].content).toContain("action:action_c1");
    expect(rejection.results[0].content).toContain("has not started yet");
    expect(rejection.results[0].content).toContain(
      "do not re-send correct parts or the whole resolution"
    );
    // The tool LIST is identical to the opening round's — tools render ahead
    // of the system prompt in the cached prefix, so swapping the array would
    // discard the system-prompt cache on every repair. Repair is forced by
    // toolChoice instead.
    const openingCall = generateToolCalls.mock.calls[0][0];
    expect(repairCall.tools).toEqual(openingCall.tools);
    expect(repairCall.tools.map((t: { name: string }) => t.name)).toContain(
      "repair_resolution"
    );
    expect(repairCall.toolChoice).toEqual({ name: "repair_resolution" });
  });

  it("applies nothing when repair cannot converge", async () => {
    const invalid = {
      ending: [
        {
          actionId: "action_c1",
          outcome: "success",
          reason: "done already",
          occurrence: {
            facts: [{ type: "action_result", content: "the door opens" }],
            participants: [{ characterId: "npc_1", role: "actor" }],
            perceiverCharacterIds: ["npc_1"],
          },
        },
      ],
    };
    generateToolCalls.mockResolvedValue(
      turn([{ id: "t1", name: "submit_resolution", args: invalid }])
    );
    // Every repair round re-sends the same broken transition.
    generateToolCalls.mockResolvedValueOnce(
      turn([{ id: "t0", name: "submit_resolution", args: invalid }])
    );
    for (let i = 0; i < 5; i++) {
      generateToolCalls.mockResolvedValueOnce(
        turn([
          {
            id: `r${i}`,
            name: "repair_resolution",
            args: { ending: invalid.ending },
          },
        ])
      );
    }

    const result = await resolveTick(makeContext(), makeDeps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toContain("repair round");
    // The errors still name what was wrong, addressed.
    expect(result.errors.some((e) => e.target.kind === "action")).toBe(true);
  });
});

describe("renderContext addressing", () => {
  // A prompt that shows both `commandId` and `action_<commandId>` gives the
  // model two ids for one action; it echoed the commandId, every entry failed
  // lookup as "unknown actionId", and all three repair rounds re-sent the same
  // mismatch. The prompt now carries only the id the schema addresses.
  it("prints the actionId and never the raw commandId", () => {
    const context = makeContext();
    context.actions.activeActions = [
      {
        id: "action_c0",
        status: "active",
        command: { ...cmd, commandId: "c0" },
        progressMinutes: 2,
        resolvedDurationTicks: 3,
      } as EngineResolutionContext["actions"]["activeActions"][number],
    ];

    const prompt = renderContext(context);

    expect(prompt).toContain('"actionId": "action_c1"');
    expect(prompt).toContain('"actionId": "action_c0"');
    expect(prompt).not.toContain("commandId");
    // The bare ids must not appear as standalone values either — that is the
    // string the model would copy.
    expect(prompt).not.toContain('"c1"');
    expect(prompt).not.toContain('"c0"');
  });
});

describe("renderContextSegments caching layout", () => {
  // `## Tick` is 114 characters and used to sit at offset 360 of a 116k
  // prompt, so the measured cross-tick common prefix was 0.3% — the whole
  // world description was re-sent at full price every minute. Stability, not
  // topic, decides the order now.
  it("keeps the world in the stable half and the minute in the volatile half", () => {
    const { stable, volatile } = renderContextSegments(makeContext());

    expect(stable).toContain("## Scenes");
    expect(stable).toContain("## Items");
    expect(stable).toContain("## World Invariants");

    for (const section of [
      "## Tick",
      "## Trigger",
      "## Characters",
      "## New Commands",
      "## Active Actions",
    ]) {
      expect(stable).not.toContain(section);
      expect(volatile).toContain(section);
    }
  });

  it("concatenates back to the single-string form", () => {
    const context = makeContext();
    const { stable, volatile } = renderContextSegments(context);
    expect(stable + volatile).toBe(renderContext(context));
    expect(stable + volatile).not.toContain("\n\n\n");
  });
});
