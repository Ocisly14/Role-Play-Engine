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

const { renderContext, renderContextSegments, renderWorldGraph, resolveTick } =
  await import("../worldActionEngine.js");

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
      // The skeleton carries only the macro location; the scenes the actor
      // stands in / moves to are real via placeKinds (the validator's
      // full-world lookup), and the involved one is snapshotted below.
      graph: {
        places: [{ id: "J_A", kind: "scene" as const, name: "Crossing" }],
        edges: [],
      },
      blockedEdges: [],
      placeKinds: { SCN_1: "scene", SCN_FAR: "scene" },
      connectionIds: ["connection.scn1.far"],
      places: [
        {
          id: "SCN_1",
          kind: "scene",
          name: "Reading room",
          description: "Shelves and a long table.",
          parentLocationId: "OUTDOOR",
          conditions: [],
          itemIds: [],
          connections: [
            {
              connectionId: "connection.scn1.far",
              targetId: "SCN_FAR",
              description: "a far door",
            },
          ],
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
      itemHolders: {},
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
      movement: { route: ["SCN_FAR"] },
    },
  ],
};

function makeDeps() {
  const codeTools = new CodeToolRegistry();
  // The session offers only dice tools. (pathfinding,
  // movementCost and inventoryValidation were removed — a tool call costs a
  // full-context round trip, and those three answered from data the request
  // already carries.)
  codeTools.register({
    name: "damageRoll",
    description: "stub",
    execute: () => ({ ok: true, total: 5, dice: [4, 1] }),
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
            name: "damageRoll",
            args: { formula: "1d6+1" },
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
      route: ["SCN_FAR"],
    });
    expect(result.codeToolInvocations).toHaveLength(1);
    expect(result.codeToolInvocations[0]).toMatchObject({
      toolName: "damageRoll",
      output: { ok: true, total: 5 },
    });

    // The second request carried the tool result back to the model.
    const secondCall = generateToolCalls.mock.calls[1][0];
    const toolMsg = secondCall.messages.find(
      (m: { role: string }) => m.role === "tool"
    );
    expect(toolMsg.results[0].content).toContain("total");
  });

  it("attributes code-tool invocations to their causing action", async () => {
    generateToolCalls
      .mockResolvedValueOnce(
        turn([
          {
            id: "dmg",
            name: "damageRoll",
            args: { actionId: "action_c1", formula: "1d4" },
          },
        ])
      )
      .mockResolvedValueOnce(
        turn([
          { id: "submit", name: "submit_resolution", args: validSubmission },
        ])
      );

    const result = await resolveTick(makeContext(), makeDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.codeToolInvocations).toContainEqual(
      expect.objectContaining({
        toolName: "damageRoll",
        actionId: "action_c1",
      })
    );
  });

  it("rejects a mixed submit+tool turn without losing the session", async () => {
    generateToolCalls
      .mockResolvedValueOnce(
        turn([
          { id: "t1", name: "damageRoll", args: { formula: "1d6" } },
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

    expect(stable).toContain("## World Graph");
    expect(stable).toContain("## World Invariants");
    // The skeleton renders as a compact adjacency list, not JSON.
    expect(stable).toContain("- J_A (Crossing)");
    expect(stable).not.toContain('"places"');

    // Detailed places, items and blocked state depend on this tick, so they
    // live in the volatile half — blocking an edge must not invalidate the
    // cached stable prefix.
    for (const section of [
      "## Tick",
      "## Trigger",
      "## Blocked Connections",
      "## Detailed Places",
      "## Items",
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

describe("renderWorldGraph", () => {
  it("renders each node as description + connection references", () => {
    const text = renderWorldGraph({
      places: [
        {
          id: "J_A",
          kind: "scene",
          name: "Crossing",
          description: "A windswept\ncrossing.",
        },
        {
          id: "R_MAIN",
          kind: "road",
          name: "Star Avenue",
        },
      ],
      edges: [
        {
          connectionId: "connection.home.secret",
          from: "J_A",
          to: "R_MAIN",
          hidden: true,
        },
        {
          connectionId: "connection.road.a",
          from: "R_MAIN",
          to: "J_A",
          travelTimeMinutes: 15,
        },
      ],
    });
    expect(text.split("\n")).toEqual([
      "Outdoor node scenes:",
      // Authored prose rides along, newlines flattened.
      "- J_A (Crossing): A windswept crossing.",
      "  connections: [connection.home.secret] -> R_MAIN (hidden)",
      "Roads:",
      // No description and no prose — the node line stands alone.
      "- R_MAIN (Star Avenue)",
      "  connections: [connection.road.a] -> J_A 15min",
    ]);
  });
});

describe("the turn budget", () => {
  beforeEach(() => {
    generateToolCalls.mockReset();
  });

  it("stops offering parallel calls once one tool is demanded", async () => {
    // Repair is the one moment `toolChoice` still names a single tool. On that
    // turn a parallel call can add nothing but a second copy of it — and the
    // intake takes a patch ONLY when it arrives alone. Measured live: both
    // copies refused, another full-world round trip spent sending the same
    // thing again by itself.
    generateToolCalls
      .mockResolvedValueOnce(
        turn([{ id: "t0", name: "damageRoll", args: { formula: "1d6" } }])
      )
      .mockResolvedValueOnce(
        // Ending an action that is still queued — rejected, so repair opens.
        turn([
          {
            id: "t1",
            name: "submit_resolution",
            args: {
              ending: [
                {
                  actionId: "action_c1",
                  outcome: "success",
                  reason: "done already",
                  occurrence: {
                    facts: [
                      { type: "action_result", content: "the door opens" },
                    ],
                    participants: [{ characterId: "npc_1", role: "actor" }],
                    perceiverCharacterIds: ["npc_1"],
                  },
                },
              ],
            },
          },
        ])
      )
      .mockResolvedValueOnce(
        turn([
          {
            id: "t2",
            name: "repair_resolution",
            args: { starting: validSubmission.starting },
          },
        ])
      );

    const result = await resolveTick(makeContext(), makeDeps());
    expect(result.ok).toBe(true);

    const calls = generateToolCalls.mock.calls.map((c) => c[0]);
    // While it still had a choice of tool, batching stayed available.
    for (const call of calls.slice(0, 2)) {
      expect(call.toolChoice).toBe("any");
      expect(call.allowParallelCalls).toBe(true);
    }
    // On the demanded patch it does not.
    expect(calls[2].toolChoice).toEqual({ name: "repair_resolution" });
    expect(calls[2].allowParallelCalls).toBe(false);
  });

  it("tells the model the budget it is spending, with the real numbers", async () => {
    generateToolCalls.mockResolvedValueOnce(
      turn([{ id: "sub", name: "submit_resolution", args: validSubmission }])
    );
    await resolveTick(makeContext(), makeDeps());

    const prompt = generateToolCalls.mock.calls[0][0]
      .customSystemPrompt as string;
    // The budget is a code constant and a prompt sentence at once; the
    // document names it with a placeholder so the two cannot drift.
    expect(prompt).not.toContain("{{");
    expect(prompt).toMatch(/\b5 turns in all\b/);
    // And why there is nothing to spend those turns on but the resolution.
    expect(prompt).toContain("there is nothing to look up");
    expect(prompt).toContain("A turn is expensive");
    expect(prompt).toContain("# Sanity Check Guidance");
    expect(prompt).toContain("strict objective threshold");
    expect(prompt).toContain("Inner activity is never a condition");
    // Sanity is DECLARED on an occurrence, not called as a tool. The negative
    // assertion is the load-bearing half: it is what stops the tool — and its
    // loop — creeping back into the prompt.
    expect(prompt).toContain("sanityChecks");
    expect(prompt).not.toMatch(/Call `sanityCheck`|the `sanityCheck` tool/);
  });
});
