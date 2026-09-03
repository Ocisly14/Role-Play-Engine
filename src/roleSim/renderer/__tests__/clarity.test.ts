// One occurrence row, three viewers. The Engine writes the facts once, at
// full objective detail, and grades each perceiver; the renderer's INPUT must
// already withhold what the grade withholds — at `trace` the actor's handle
// must not reach the model on the involved line, nor under "Other entities"
// with a place line — because a name printed anywhere in the prompt is a
// name the paragraph will use. The facts themselves (utterance included)
// stay in the input for every grade; the system prompt decides whether they
// are quoted.

import { describe, expect, it, vi } from "vitest";
import type { Occurrence } from "../../../engine/actions/types.js";

const generateText = vi.fn();
vi.mock("../../../models/index.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../../models/types.js"
  );
  return { ...actual, generateText };
});

const { renderViaLLM } = await import("../llmRenderer.js");

const profiles: Record<string, unknown> = {
  npc_1: { id: "npc_1", name: "Susan", status: { conditions: [] } },
  npc_2: {
    id: "npc_2",
    name: "Denny",
    appearance: "thin, oversized jacket",
    status: { conditions: [] },
  },
};
const positions: Record<string, unknown> = {
  npc_1: { type: "scene", sceneId: "SCN_common" },
  npc_2: { type: "scene", sceneId: "SCN_denny" },
};
const scenes: Record<string, unknown> = {
  SCN_common: { id: "SCN_common", name: "Common room", description: "" },
  SCN_denny: {
    id: "SCN_denny",
    name: "Denny's room",
    description: "A small room; a towel is wedged under the door.",
  },
};

// npc_2 is in npc_1's relationship graph (so citable) but has no `knownAs`
// (so cited as a stranger alias).
const dgsm = {
  getNpcProfile: (id: string) => profiles[id] ?? null,
  getState: () => ({
    npcRelationshipGraph: {
      npc_1: { npc_2: { score: 90, note: "", knownAs: undefined } },
    },
    npcCharacters: [],
  }),
  getRelationship: () => undefined,
  getCharactersInScene: () => [],
  getNpcInventory: () => [],
  getScene: (id: string) => scenes[id] ?? null,
  getTopology: () => ({
    junctions: new Map(),
    roads: new Map(),
    sceneToParent: new Map(),
  }),
  getCharacterPosition: (id: string) => positions[id] ?? null,
  isNpcAlive: () => true,
  getCharactersAtLocation: () => [],
  getSceneItems: () => [],
  getItem: () => null,
  resolveLocationId: () => "SCN_common",
  getSceneConditions: () => [],
} as never;

function occurrenceAt(clarity: "full" | "limited" | "trace"): Occurrence {
  return {
    id: "occ_1",
    tickId: "t1",
    sourceActionIds: [],
    locationId: "SCN_denny",
    facts: [
      {
        id: "occ_1#f0",
        type: "utterance",
        content: "Give me the key.",
        entityRefs: [],
      },
      {
        id: "occ_1#f1",
        type: "speech",
        content: "Denny speaks low, close to the door.",
        entityRefs: [{ kind: "character", id: "npc_2" }],
      },
    ],
    participants: [{ characterId: "npc_2", role: "actor" }],
    perceivers: [
      { characterId: "npc_1", clarity },
      { characterId: "npc_2", clarity: "full" },
    ],
    signals: [{ factIds: ["occ_1#f0", "occ_1#f1"], channel: "sound" }],
  };
}

function bundleWith(occ: Occurrence) {
  return {
    scene: {
      id: "SCN_common",
      name: "Common room",
      description: "A wide room.",
      activeConditions: [],
      items: [],
      adjacentPlaces: [{ id: "SCN_denny", name: "Denny's room" }],
    },
    ownConditions: [],
    ownAction: { kind: "idle" },
    occurrences: [occ],
    charactersInScene: [],
  } as never;
}

async function renderFor(clarity: "full" | "limited" | "trace") {
  generateText.mockReset();
  generateText.mockResolvedValueOnce("Something reaches me from the hall.");
  await renderViaLLM({
    npcId: "npc_1",
    bundle: bundleWith(occurrenceAt(clarity)),
    dgsm,
    language: "en",
    recentPerceptions: [],
  });
  const call = generateText.mock.calls[0][0] as {
    context: string;
    customSystemPrompt: string;
  };
  return call;
}

function occurrenceLine(context: string): string {
  const line = context.split("\n").find((l) => l.startsWith("- Occurrence "));
  if (!line) throw new Error("no occurrence line in context");
  return line;
}

/** The alias the renderer printed for npc_2, read off the `full` render. */
async function actorHandle(): Promise<string> {
  const { context } = await renderFor("full");
  const match = occurrenceLine(context).match(/involved: (stranger_\w+)/);
  if (!match) throw new Error("full render did not name the actor");
  return match[1];
}

describe("per-perceiver clarity in the renderer input", () => {
  it("full: prints the grade and names the actor on the involved line", async () => {
    const { context } = await renderFor("full");
    const line = occurrenceLine(context);
    expect(line).toContain("your clarity: full");
    expect(line).toMatch(/involved: stranger_\w+ \(actor\)/);
    // The remote actor is placed for the renderer, as before.
    expect(context).toContain("# Other entities involved in events");
    expect(context.split("# Other entities involved in events")[1]).toContain(
      "Where they are: NOT here"
    );
  });

  it("trace: prints the grade, withholds the actor everywhere, keeps the facts", async () => {
    const handle = await actorHandle();
    const { context } = await renderFor("trace");
    const line = occurrenceLine(context);
    expect(line).toContain("your clarity: trace");
    expect(line).not.toContain(handle);
    expect(line).not.toContain("involved:");
    // No "Other entities" entry for the actor — a person printed there
    // arrives with a name, an appearance and a place, which is a source.
    const other = context.split("# Other entities involved in events")[1];
    if (other !== undefined) {
      expect(other).not.toContain(handle);
      expect(other).not.toContain("Person (");
      // The place the trace came from is still legitimate direction.
      expect(other).toContain("Denny's room");
    }
    // The utterance stays in the input at every grade; the prompt rule, not
    // a fact subset, is what keeps it out of quotation marks.
    expect(context).toContain("fact (utterance): Give me the key.");
    expect(context).toContain("fact (speech): Denny speaks low");
  });

  it("limited: prints the grade and still names the actor", async () => {
    const handle = await actorHandle();
    const { context } = await renderFor("limited");
    const line = occurrenceLine(context);
    expect(line).toContain("your clarity: limited");
    expect(line).toContain(`involved: ${handle} (actor)`);
    expect(context).toContain("fact (utterance): Give me the key.");
  });

  it("the system prompt carries the three grade rules and drops the old one", async () => {
    const { customSystemPrompt } = await renderFor("full");
    expect(customSystemPrompt).toContain(
      "your clarity: full | limited | trace"
    );
    expect(customSystemPrompt).toMatch(/`full`: render the event/);
    expect(customSystemPrompt).toMatch(/`limited`: render the KIND of event/);
    expect(customSystemPrompt).toMatch(
      /`trace`: render only that something happened/
    );
    expect(customSystemPrompt).toContain(
      "# Example — one moment, three grades"
    );
    expect(customSystemPrompt).not.toContain(
      "Who heard what is already decided"
    );
  });
});
