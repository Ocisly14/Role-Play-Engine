// The phase prompt layer: six narrow system prompts that each name exactly one
// submission tool, an instruction block that carries the accepted upstream
// draft as read-only JSON, and rejections that demand a COMPLETE replacement of
// one phase's array. Also the standing English-only guarantee: no string this
// file renders, and no markdown document any phase loads, may carry CJK or the
// names of the retired submission tools.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ActionCommand } from "../../actions/types.js";
import type { EngineResolutionContext, ResolutionError } from "../types.js";
import {
  renderContext,
  renderContextSegments,
  renderPhaseDuplicate,
  renderPhaseEmpty,
  renderPhaseInstruction,
  renderPhaseRejection,
  renderPhaseSystemPrompt,
  renderPhaseUnreadable,
  renderPhaseWrongTool,
} from "../worldResolutionStagePrompts.js";
import {
  type AcceptedResolutionDraft,
  PHASE_FIELDS,
  PHASE_TOOL_NAMES,
  RESOLUTION_PHASES,
  type ResolutionPhase,
} from "../worldResolutionStageSchemas.js";
import { MERGE_PHASES } from "../worldResolutionStageValidator.js";

/** The tool names that no longer exist anywhere. `submit_resolution` and
 *  `repair_resolution` are two refactors old; `submit_actions`/`submit_effects`
 *  are the pair this one replaces. An instruction that still names one of them
 *  points the model at a tool the request does not carry. */
const RETIRED_TOOLS = [
  "submit_actions",
  "submit_effects",
  "submit_resolution",
  "repair_resolution",
];

/** The whole CJK block. Every rendered instruction is English; the world's own
 *  prose travels inside the context JSON, which these fixtures keep English so
 *  a hit here can only come from a prompt string or a rule document. */
const CJK = /[一-鿿]/u;

const BUDGET = { maxProviderCalls: 12, maxPhaseAttempts: 3 };

// Copied from worldActionEngine.test.ts: one queued movement command, one
// actor, one involved place. Small enough that every id in a rendered prompt
// is accounted for.
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

/** Two phases accepted: one ending decided, one action started. Everything
 *  downstream is still absent, which is a different state from an accepted
 *  empty array. */
const draft: AcceptedResolutionDraft = {
  endings: [
    { actionId: "action_c0", mode: "outcome", outcome: "The drawer opens." },
  ],
  starting: [{ actionId: "action_c1", movement: { route: ["SCN_FAR"] } }],
};

const errors: ResolutionError[] = [
  {
    target: { kind: "action", actionId: "action_c0" },
    message: "no decision was submitted for this ending id",
  },
  {
    target: { kind: "resolution" },
    message: "an accepted ending is cited by no occurrence",
  },
];

describe("renderPhaseSystemPrompt — one phase, one tool", () => {
  for (const phase of RESOLUTION_PHASES) {
    it(`names only ${PHASE_TOOL_NAMES[phase]} for the ${phase} phase`, () => {
      const prompt = renderPhaseSystemPrompt(phase, BUDGET);
      const instruction = renderPhaseInstruction(
        phase,
        makeContext(),
        phase === "endings" ? {} : draft
      );
      const both = `${prompt}\n${instruction}`;

      expect(both).toContain(PHASE_TOOL_NAMES[phase]);
      for (const other of RESOLUTION_PHASES) {
        if (other === phase) continue;
        expect(both).not.toContain(PHASE_TOOL_NAMES[other]);
      }
      for (const retired of RETIRED_TOOLS) {
        expect(both).not.toContain(retired);
      }
    });
  }

  it("templates both budget numbers and leaves no placeholder behind", () => {
    for (const phase of RESOLUTION_PHASES) {
      const prompt = renderPhaseSystemPrompt(phase, BUDGET);
      expect(prompt).toContain("12 model calls");
      expect(prompt).toContain("3 submission attempts");
      // A prompt that still carries `{{...}}` is one the model reads as a
      // literal, and the number the guard actually uses is then invisible in
      // both places.
      expect(prompt).not.toContain("{{");
    }
  });

  it("gives the two adjudicating phases the skill catalog and no other phase", () => {
    for (const phase of RESOLUTION_PHASES) {
      const prompt = renderPhaseSystemPrompt(phase, BUDGET);
      const hasCatalog = prompt.includes("## Skill catalog");
      expect(hasCatalog).toBe(phase === "endings" || phase === "starts");
    }
  });

  it("gives each phase only its own domain modules", () => {
    // The endings phase judges results; it has no business being handed the
    // item-conservation rules it cannot act on, and the request is re-sent on
    // every turn, so an unread module is paid for every time.
    expect(renderPhaseSystemPrompt("endings", BUDGET)).toContain(
      "# Action Adjudication"
    );
    expect(renderPhaseSystemPrompt("endings", BUDGET)).not.toContain(
      "# Item Changes"
    );
    expect(renderPhaseSystemPrompt("itemChanges", BUDGET)).toContain(
      "# Item Changes"
    );
    expect(renderPhaseSystemPrompt("itemChanges", BUDGET)).not.toContain(
      "# Perception"
    );
    // `character-changes.md` delegates `position` to the movement document by
    // name, so the phase that writes `position` has to carry both or the
    // delegation dead-ends.
    expect(renderPhaseSystemPrompt("characterChanges", BUDGET)).toContain(
      "# Character Changes"
    );
    expect(renderPhaseSystemPrompt("characterChanges", BUDGET)).toContain(
      "# Movement and Position"
    );
    expect(renderPhaseSystemPrompt("characterChanges", BUDGET)).not.toContain(
      "# Scene Changes"
    );
    expect(renderPhaseSystemPrompt("occurrences", BUDGET)).toContain(
      "# Occurrences and Dialogue"
    );
    expect(renderPhaseSystemPrompt("occurrences", BUDGET)).toContain(
      "# Perception and Audience Resolution"
    );
    expect(renderPhaseSystemPrompt("occurrences", BUDGET)).toContain(
      "# Sanity Check Guidance"
    );
    // The root contract and the transport contract ride along with all six.
    for (const phase of RESOLUTION_PHASES) {
      const prompt = renderPhaseSystemPrompt(phase, BUDGET);
      expect(prompt).toContain("# World Action Resolution");
      expect(prompt).toContain("# Phase Protocol");
    }
  });

  it("tells the endings phase, and only it, that damage is rolled", () => {
    expect(renderPhaseSystemPrompt("endings", BUDGET)).toContain("damageRoll");
    for (const phase of RESOLUTION_PHASES) {
      if (phase === "endings") continue;
      expect(renderPhaseSystemPrompt(phase, BUDGET)).not.toContain(
        "damageRoll"
      );
    }
  });
});

describe("renderPhaseInstruction — the accepted draft is read-only", () => {
  it("embeds each accepted upstream array as JSON, in phase order", () => {
    const text = renderPhaseInstruction("occurrences", makeContext(), draft);

    expect(text).toContain("## Accepted so far (read-only)");
    expect(text).toContain("### `endings` — accepted in phase 1");
    expect(text).toContain("### `starting` — accepted in phase 2");
    expect(text.indexOf("### `endings`")).toBeLessThan(
      text.indexOf("### `starting`")
    );
    // The arrays themselves, verbatim, not a paraphrase.
    expect(text).toContain('"outcome": "The drawer opens."');
    expect(text).toContain('"mode": "outcome"');
    expect(text).toContain('"route"');
    // Read-only means read-only, and the reason it is not this phase's problem
    // is stated rather than left to be inferred.
    expect(text).toContain("do not try to revise them here");
  });

  it("omits every phase that has not been accepted yet", () => {
    const text = renderPhaseInstruction("itemChanges", makeContext(), draft);

    expect(text).toContain("### `endings` — accepted in phase 1");
    expect(text).toContain("### `starting` — accepted in phase 2");
    for (const phase of ["characterChanges", "itemChanges", "sceneChanges"]) {
      expect(text).not.toContain(`### \`${phase}\` — accepted`);
    }
  });

  // `acceptedSoFarSection` indexes the draft with `PHASE_FIELDS[p]`, which is
  // typed `string` and therefore needs a cast. The cast is only safe while
  // every field name really is a draft key — a phase renamed on one side and
  // not the other would silently render nothing instead of failing to compile.
  it("indexes the draft by a PHASE_FIELDS value that is a real draft key", () => {
    const full: Required<AcceptedResolutionDraft> = {
      endings: [],
      starting: [],
      characterChanges: [],
      itemChanges: [],
      sceneChanges: [],
      occurrences: [],
    };
    const keys = Object.keys(full);
    for (const phase of RESOLUTION_PHASES) {
      expect(keys).toContain(PHASE_FIELDS[phase]);
    }
    expect(new Set(Object.values(PHASE_FIELDS)).size).toBe(keys.length);

    // And the rendering actually reaches every one of them: an occurrences
    // phase given a full draft shows all five upstream arrays.
    const text = renderPhaseInstruction("occurrences", makeContext(), full);
    for (const phase of RESOLUTION_PHASES) {
      if (phase === "occurrences") continue;
      expect(text).toContain(`### \`${PHASE_FIELDS[phase]}\` — accepted`);
    }
  });

  it("says so plainly when nothing precedes the phase", () => {
    const text = renderPhaseInstruction("endings", makeContext(), {});
    expect(text).toContain("## Accepted so far (read-only)");
    expect(text).toContain("Nothing precedes this phase");
    expect(text).not.toContain("### `");
  });

  it("gives the two lifecycle phases their own worklist subset", () => {
    const endings = renderPhaseInstruction("endings", makeContext(), {});
    expect(endings).toContain('"ending"');
    expect(endings).toContain('"endingWithUtterance"');
    expect(endings).toContain('"replaced"');
    expect(endings).not.toContain('"startingWithoutSkill"');

    const starts = renderPhaseInstruction("starts", makeContext(), {
      endings: [],
    });
    expect(starts).toContain('"starting": [\n  "action_c1"\n ]');
    expect(starts).toContain('"startingWithUtterance"');
    expect(starts).toContain('"startingWithoutSkill"');
    expect(starts).not.toContain('"endingWithUtterance"');
  });

  it("gives the downstream phases the action ids of this tick", () => {
    const context = makeContext();
    // An in-flight action that is neither ending nor starting. A change or an
    // occurrence sourced to it is legal — the validator builds its action
    // lookup from every active action, not from the two lifecycle worklists —
    // so it has to be listed, and the wording must not call the ended-plus-
    // started set exhaustive.
    context.trigger.triggers = [
      { actionIds: ["action_c1"], reason: "new_action" },
      { actionIds: ["action_c9"], reason: "new_action" },
    ];
    context.trigger.actionIds = ["action_c1", "action_c9"];
    context.actions.activeActions = [
      {
        id: "action_c9",
        status: "active",
        command: { ...cmd, commandId: "c9" },
        progressMinutes: 2,
        resolvedDurationTicks: 30,
      } as EngineResolutionContext["actions"]["activeActions"][number],
    ];

    const text = renderPhaseInstruction("sceneChanges", context, draft);
    expect(text).toContain('"endedWithOutcome"');
    expect(text).toContain('"endedAsPureSpeech"');
    expect(text).toContain('"stillRunning": [\n  "action_c9"\n ]');
    expect(text).toContain("action_c0");
    expect(text).toContain("action_c1");
    expect(text).toContain("These are the ids of this tick");
    expect(text).not.toContain("there are no others");
    expect(text).toContain("needs no mention merely to say it continues");
  });

  it("renders the redo heading only when the global gate rewound here", () => {
    const context = makeContext();
    expect(renderPhaseInstruction("starts", context, draft)).not.toContain(
      "## Why this phase is being redone"
    );

    const redone = renderPhaseInstruction("starts", context, draft, {
      globalErrors: errors,
    });
    expect(redone).toContain("## Why this phase is being redone");
    expect(redone).toContain(
      "- action:action_c0 — no decision was submitted for this ending id"
    );
    expect(redone).toContain(
      "- resolution — an accepted ending is cited by no occurrence"
    );
    // The phases after this one are gone; not saying so leaves the model
    // correcting as if the later rows still stood.
    expect(redone).toContain("discarded and will be decided again");
  });

  it("puts the starts obligations, with the proposed duration and declared skill, before the demand", () => {
    const text = renderPhaseInstruction("starts", makeContext(), {});
    expect(text).toContain("## Required start entries (1)");
    expect(text).toContain('"proposedDurationTicks": 3');
    expect(text).toContain('"hasUtterance": false');
    expect(text).toContain('"declaredSkillId": null');
    expect(text).toContain("An empty array is invalid.");
    expect(text).toContain("Quoted words in description are not an utterance");
  });

  it("judges an utterance-bearing command by its attempt, not its sentence", () => {
    // Action before speech: a spoken command that declares a skill is told to
    // clock the attempt and check it, never "resolvedDurationTicks must be 1".
    const ctx = makeContext();
    ctx.actions.newCommands = [
      {
        ...cmd,
        utterance: "Hold still.",
        declaredSkillId: "Medicine & Psychology",
      },
    ];
    const text = renderPhaseInstruction("starts", ctx, {});
    expect(text).toContain('"hasUtterance": true');
    expect(text).toContain('"declaredSkillId": "Medicine & Psychology"');
    expect(text).toContain("Judge the attempt, not the sentence");
    expect(text).toContain("A skill was declared: expect a check");
    expect(text).not.toContain("must be 1");
    const system = renderPhaseSystemPrompt("starts", BUDGET);
    expect(system).toContain("### Action before speech");
    expect(system).not.toContain(
      "submit `resolvedDurationTicks: 1`; code owns"
    );
  });

  it("lists every (actionId, speech) pair the occurrences phase owes and withdraws the `[]` offer", () => {
    const draft: AcceptedResolutionDraft = {
      endings: [
        { actionId: "action_x", mode: "outcome", outcome: "done" },
        { actionId: "action_y", mode: "pure_speech" },
      ],
    };
    const text = renderPhaseInstruction("occurrences", makeContext(), draft);
    expect(text).toContain("## Required occurrence coverage (2 obligations)");
    expect(text).toContain('"actionId": "action_x",\n  "speech": false');
    expect(text).toContain('"actionId": "action_y",\n  "speech": true');
    expect(text).toContain("An empty array is invalid.");
    expect(text).not.toContain("Nothing perceptible happened is `[]`");
  });

  it("still allows an empty occurrences array when nothing is owed", () => {
    const text = renderPhaseInstruction("occurrences", makeContext(), {
      endings: [],
    });
    expect(text).toContain("(0 obligations)");
    expect(text).toContain("An empty array is allowed");
  });

  it("closes with a demand naming only this phase's tool and field", () => {
    for (const phase of RESOLUTION_PHASES) {
      const text = renderPhaseInstruction(phase, makeContext(), draft);
      const tail = text.slice(text.lastIndexOf("\n\n"));
      expect(tail).toContain(`Call \`${PHASE_TOOL_NAMES[phase]}\` now`);
      expect(tail).toContain(`\`${PHASE_FIELDS[phase]}\``);
    }
  });
});

describe("phase rejections", () => {
  it("demands the complete array again from the index-addressed phases", () => {
    for (const phase of RESOLUTION_PHASES.filter((p) => !MERGE_PHASES.has(p))) {
      const text = renderPhaseRejection(phase, errors);
      expect(text.startsWith("REJECTED.")).toBe(true);
      expect(text).toContain(PHASE_TOOL_NAMES[phase]);
      expect(text).toContain(`\`${PHASE_FIELDS[phase]}\``);
      expect(text).toContain("COMPLETE");
      expect(text).toContain("There is no patch");
      // Every error, addressed.
      expect(text).toContain("- action:action_c0 — ");
      expect(text).toContain("- resolution — ");
      // The accepted phases are not in play; without this the model reaches
      // for the upstream array it thinks is wrong and spends the attempt.
      expect(text).toContain("Nothing accepted in an earlier phase changes");
    }
  });

  it("corrects a starts rejection by difference: kept rows, owed ids, no `[]`", () => {
    const text = renderPhaseRejection("starts", errors, {
      context: makeContext(),
      draft: {},
      previousPayload: { starting: [] },
      retained: [],
      faulty: [],
    });
    expect(text.startsWith("REJECTED.")).toBe(true);
    expect(text).toContain("## Kept by code (0 rows)");
    expect(text).toContain("## Still owed — send ONLY these (1 entries)");
    expect(text).toContain('"actionId": "action_c1"');
    // The proposed duration is put in front of the model, so a missing
    // duration is answered with a number rather than a deleted action.
    expect(text).toContain('"proposedDurationTicks": 3');
    expect(text).toContain("holding the missing required rows");
    expect(text).not.toContain("COMPLETE");
    expect(text).not.toContain("Use `[]`");
    expect(text).toContain("Nothing accepted in an earlier phase changes");
  });

  it("shows the occurrences phase what it kept, what it refused and which pairs are still uncovered", () => {
    const kept = {
      actionIds: ["action_x"],
      speech: true,
      targetIds: ["npc_1"],
      perceivers: [{ characterId: "npc_1", clarity: "full" }],
    };
    const refused = { ...kept, speech: false, content: "placeholder" };
    const text = renderPhaseRejection("occurrences", errors, {
      context: makeContext(),
      draft: {
        endings: [{ actionId: "action_x", mode: "outcome", outcome: "done" }],
      },
      previousPayload: { occurrences: [kept, refused] },
      retained: [kept],
      faulty: [refused],
    });
    expect(text).toContain("## Kept by code (1 rows) — do NOT resend");
    expect(text).toContain("## Refused rows (1) — rewrite or drop");
    expect(text).toContain(
      "## Still owed — send ONLY these (1 coverage pairs, plus any refused row you rewrite)"
    );
    expect(text).toContain('"actionId": "action_x",\n  "speech": false');
    expect(text).not.toContain("COMPLETE");
    expect(text).not.toContain("`[]`");
  });

  it("still echoes the refused payload for an index-addressed phase", () => {
    const text = renderPhaseRejection("itemChanges", errors, {
      context: makeContext(),
      draft: {},
      previousPayload: { itemChanges: [{ itemId: "lamp_1" }] },
    });
    expect(text).toContain("## Previous candidate to repair (NOT accepted)");
    expect(text).toContain('"itemId": "lamp_1"');
    expect(text).toContain("COMPLETE");
  });

  it("answers an unreadable call about its JSON, not about its content", () => {
    const text = renderPhaseUnreadable("occurrences", 8123);
    expect(text).toContain("`submit_occurrences` arguments (8123 characters)");
    expect(text).toContain("did not arrive as readable JSON");
    expect(text).not.toContain("occurrence:");
  });

  it("tells an empty call which array was missing", () => {
    const text = renderPhaseEmpty("characterChanges");
    expect(text).toContain("`submit_character_changes`");
    expect(text).toContain("`characterChanges` is required");
    expect(text).toContain("`[]`");
  });

  it("refuses a doubled call rather than preferring a copy", () => {
    const text = renderPhaseDuplicate("starts");
    expect(text).toContain("`submit_starts` was called more than once");
    expect(text).toContain("exactly once");
  });

  it("names the phase's own tool when another one was called", () => {
    const endings = renderPhaseWrongTool("endings", "submit_occurrences");
    expect(endings).toContain("`submit_occurrences` was NOT accepted");
    expect(endings).toContain("`submit_endings`");
    // Only the endings phase carries a second legal tool.
    expect(endings).toContain("damageRoll");

    const scenes = renderPhaseWrongTool("sceneChanges", "pathfind");
    expect(scenes).toContain("`pathfind` was NOT accepted");
    expect(scenes).toContain(
      "`submit_scene_changes` is the only tool it takes"
    );
    expect(scenes).not.toContain("damageRoll");
  });
});

describe("English-only rendering", () => {
  it("renders no CJK from an English fixture, in any phase string", () => {
    const context = makeContext();
    for (const phase of RESOLUTION_PHASES) {
      const strings = [
        renderPhaseSystemPrompt(phase, BUDGET),
        renderPhaseInstruction(phase, context, draft),
        renderPhaseInstruction(phase, context, draft, {
          globalErrors: errors,
        }),
        renderPhaseRejection(phase, errors),
        renderPhaseUnreadable(phase, 10),
        renderPhaseEmpty(phase),
        renderPhaseDuplicate(phase),
        renderPhaseWrongTool(phase, "nope"),
      ];
      for (const text of strings) {
        expect(CJK.test(text)).toBe(false);
      }
    }
    expect(CJK.test(renderContext(context))).toBe(false);
  });

  it("keeps every rule document English and free of retired tool names", () => {
    const rulesDir = fileURLToPath(new URL("../../rules/", import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith(".md") ? [full] : [];
      });

    const files = walk(rulesDir);
    // A silent empty walk would make this test pass forever.
    expect(files.length).toBeGreaterThan(20);

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(
        CJK.test(text),
        `${file} carries CJK; every prompt-reachable document is English`
      ).toBe(false);
      for (const retired of RETIRED_TOOLS) {
        expect(text.includes(retired), `${file} still names ${retired}`).toBe(
          false
        );
      }
    }
  });
});

describe("renderContextSegments is phase-neutral", () => {
  it("carries no tool name and makes no closing demand", () => {
    const { stable, volatile } = renderContextSegments(makeContext());
    const whole = stable + volatile;

    // The old closing paragraph belonged to a session that submitted
    // everything at once. The per-phase demand replaced it.
    expect(whole).not.toContain("Resolve now");
    for (const retired of RETIRED_TOOLS) {
      expect(whole).not.toContain(retired);
    }
    for (const phase of RESOLUTION_PHASES) {
      expect(whole).not.toContain(PHASE_TOOL_NAMES[phase]);
    }
  });

  it("keeps the worklist vocabulary in the trigger note", () => {
    const { volatile } = renderContextSegments(makeContext());
    for (const word of [
      "starting",
      "ending",
      "replaced",
      "endingWithUtterance",
      "startingWithUtterance",
      "startingWithoutSkill",
      "stillRunning",
      "diceRoll",
    ]) {
      expect(volatile).toContain(word);
    }
  });

  it("still splits world from minute at the cache boundary", () => {
    const { stable, volatile } = renderContextSegments(makeContext());

    expect(stable.startsWith("# Tick Resolution Request")).toBe(true);
    expect(stable).toContain("## World Graph");
    expect(stable).toContain("## World Invariants");
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

    // The volatile half now ends on a data section rather than on a closing
    // demand: the phase instruction is appended after it instead. This fixture
    // declares no skill, so Objective Events is last; a context with a declared
    // skill ends on `## Declared Skill Guidance`, which is also data.
    const headings = volatile
      .split("\n")
      .filter((line) => line.startsWith("## "));
    expect(headings.at(-1)).toBe("## Objective Events (already effective)");
    expect(volatile.trimEnd().endsWith("}")).toBe(true);
  });
});

/** Compile-time: the exported signatures are the ones the runner (Task 4) is
 *  written against. A rename here would otherwise only surface there. */
const _signatures: {
  system: (
    phase: ResolutionPhase,
    budget: { maxProviderCalls: number; maxPhaseAttempts: number }
  ) => string;
  instruction: (
    phase: ResolutionPhase,
    context: EngineResolutionContext,
    draft: AcceptedResolutionDraft,
    opts?: { globalErrors?: ResolutionError[] }
  ) => string;
  rejection: (phase: ResolutionPhase, errors: ResolutionError[]) => string;
} = {
  system: renderPhaseSystemPrompt,
  instruction: renderPhaseInstruction,
  rejection: renderPhaseRejection,
};
void _signatures;

describe("recorded staged-run correction regressions", () => {
  it("lists both delivery obligations for an outcome with an utterance", () => {
    const context = makeContext();
    context.actions.newCommands = [];
    context.actions.activeActions = [
      {
        id: "action_c1",
        command: { ...cmd, utterance: "Hold still." },
        status: "active",
        submittedAt: cmd.issuedAt,
        progressMinutes: 1,
        resolvedDurationTicks: 1,
        nextWakeAt: context.tick.tickStartTime,
      },
    ];
    const accepted: AcceptedResolutionDraft = {
      endings: [
        {
          actionId: "action_c1",
          mode: "outcome",
          outcome: "The bandage holds.",
        },
      ],
    };
    const text = renderPhaseInstruction("occurrences", context, accepted);
    expect(text).toContain('"actionId": "action_c1",\n  "speech": false');
    expect(text).toContain('"actionId": "action_c1",\n  "speech": true');
    expect(text).toContain("An empty array is invalid");
    expect(text).toContain("BOTH flags");
    const repair = renderPhaseRejection("occurrences", [], {
      context,
      draft: accepted,
      previousPayload: { occurrences: [] },
    });
    expect(repair).toContain("Still owed — send ONLY these (2 coverage pairs)");
    expect(repair).not.toContain("exactly once");
    expect(repair).not.toContain("Use `[]`");
    expect(repair).toContain("missing required rows");
  });

  it("spells out duration for a command whose description quotes words but has no utterance", () => {
    const context = makeContext();
    context.actions.newCommands = [
      {
        ...cmd,
        description: 'I bandage her and say "hold still".',
        proposedDurationTicks: 2,
      },
    ];
    const text = renderPhaseInstruction("starts", context, {});
    expect(text).toContain('"hasUtterance": false');
    expect(text).toContain('"proposedDurationTicks": 2');
    expect(text).toContain("resolvedDurationTicks is REQUIRED");
    expect(text).toContain("never to avoid providing duration");
  });

  it("shows retained starts and asks only for missing required ids during repair", () => {
    const context = makeContext();
    context.actions.newCommands.push({ ...cmd, commandId: "c2" });
    context.trigger.actionIds.push("action_c2");
    const previousPayload = {
      starting: [
        { actionId: "action_c1" },
        { actionId: "action_c2", resolvedDurationTicks: 2 },
      ],
    };
    const text = renderPhaseRejection(
      "starts",
      [
        {
          target: { kind: "action", actionId: "action_c1" },
          message: "missing duration",
        },
      ],
      {
        context,
        draft: {},
        previousPayload,
        retained: [previousPayload.starting[1]],
        faulty: [previousPayload.starting[0]],
      }
    );
    expect(text).toContain("Kept by code (1 rows)");
    expect(text).toContain('"actionId": "action_c2"');
    expect(text).toContain("Still owed — send ONLY these (1 entries)");
    const owed = text.slice(text.indexOf("## Still owed"));
    expect(owed).toContain('"actionId": "action_c1"');
    expect(owed).not.toContain('"actionId": "action_c2"');
    expect(text).not.toContain("fix or drop");
  });
});
