# LLMRoleSimAgent Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Phase F's placeholder system prompt + minimal context injection with a persona-simulation framework — system prompt assembled from per-tool skill files, user prompt with 12-field profile + perception narrative + today's memories.

**Architecture:** Three layers separated by file. (1) `systemPrompt.ts` — static, framing + 5 tool skill files (`toolSkills/*Skill.ts`) + decision principles + output format. (2) `userPromptBuilder.ts` — dynamic per-tick, structured sections (profile / perception / memory / etc). (3) Helpers: `profileFormatter.ts`, `memoryFormatter.ts`, `perceptionRenderer.ts`. Wire into existing `llmAgent.ts` + `npcActionController.ts.buildContext`.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest (globals enabled, no need to import describe/it/expect), Biome (2-space indent, double quotes, semicolons). Internal imports use `.js` extensions.

**Source spec:** `docs/superpowers/specs/2026-05-05-roleSim-agent-prompt-design.md`

**User preferences applied:**
- No per-task commit (single commit at the end of Task 9)
- No per-task test execution (all verification batched in Task 9)
- Skip TDD for trivial code: `systemPrompt.ts` (pure concatenation), `memoryFormatter.ts` (thin map+join), and the 5 tool skill files (pure string content). Test files exist for the 3 logic-bearing modules: `profileFormatter`, `perceptionRenderer`, `userPromptBuilder`.

---

## Task 1: Create the 5 tool skill files

**Files:**
- Create: `src/roleSim/toolSkills/actSkill.ts`
- Create: `src/roleSim/toolSkills/continueSkill.ts`
- Create: `src/roleSim/toolSkills/writeMemorySkill.ts`
- Create: `src/roleSim/toolSkills/recallMemorySkill.ts`
- Create: `src/roleSim/toolSkills/getMapSnapshotSkill.ts`

Each file exports a single `string` constant containing the markdown content. No logic, no imports. The strings are concatenated by `systemPrompt.ts` (Task 2).

- [ ] **Step 1: Create `src/roleSim/toolSkills/actSkill.ts`**

```ts
// src/roleSim/toolSkills/actSkill.ts

export const actSkill = `---
name: act
description: Take a physical action in the world. Terminates this decision (consumes a tick).
---

# act

Take an action in the world: move, speak, examine, attack, hide, work, etc.
This consumes a tick — calling \`act\` ends the current decision.

## When to use
- You want to start something new and meaningful
- Something just happened and you want to react with a new action
- Your current action is no longer right (calling \`act\` while you have an in-flight action will CANCEL it and start the new one)
- Idle and you've decided what to do next

## When NOT to use
- Your current action is fine — use \`continue\`
- You just want to "think more" — use \`recallMemory\` or \`writeMemory\` instead (they don't consume a tick)
- The action is purely internal (forming a belief, planning) — use \`writeMemory\`

## Usage
{ "tool": "act", "input": { "actionText": "<one sentence describing what you do>", "targetCharacterIds": ["<npcId>", ...] } }

- \`actionText\`: describe your action in one natural sentence ("walk to the library", "ask Smith about the letter", "search the desk")
- \`targetCharacterIds\`: optional. NPC IDs you're directly interacting with.

The engine resolves the action — you don't need to specify duration, skill checks, or outcomes.

## Examples

You see Smith in the room and decide to confront him:
{ "tool": "act", "input": { "actionText": "confront Smith about where he was last night", "targetCharacterIds": ["smith"] } }

You're alone and want to leave:
{ "tool": "act", "input": { "actionText": "head to the harbor" } }

You're in the middle of reading and a fire breaks out — interrupt and flee:
{ "tool": "act", "input": { "actionText": "drop the book and run for the exit" } }
`;
```

- [ ] **Step 2: Create `src/roleSim/toolSkills/continueSkill.ts`**

```ts
// src/roleSim/toolSkills/continueSkill.ts

export const continueSkill = `---
name: continue
description: Keep doing your current action / let time pass. Terminates this decision.
---

# continue

Don't start anything new. If you have an in-flight action, let it keep running. If you're idle, let the tick pass.

## When to use
- Your current action is still right — nothing has changed enough to warrant switching
- You're idle and have nothing meaningful to do this tick (resting, waiting, observing passively)
- Things just happened around you, but they don't actually demand a reaction from someone like you

## When NOT to use
- You want to start a new action — use \`act\`
- You want to reflect / record something — use \`writeMemory\` (then loop back to \`continue\` or \`act\` to terminate)

## Usage
{ "tool": "continue", "reason": "<optional one-line justification>" }

- \`reason\`: optional. One sentence explaining why you're continuing. Useful for debugging your own decisions.

## Examples

You're already walking to the library and the trigger event was distant:
{ "tool": "continue", "reason": "still heading to the library; the noise was outside" }

Idle, nothing to do:
{ "tool": "continue" }
`;
```

- [ ] **Step 3: Create `src/roleSim/toolSkills/writeMemorySkill.ts`**

```ts
// src/roleSim/toolSkills/writeMemorySkill.ts

export const writeMemorySkill = `---
name: writeMemory
description: Record a thought, plan, belief, secret, or new knowledge. Doesn't consume a tick.
---

# writeMemory

Record something to your memory. Doesn't consume a tick — you can chain other tool calls before terminating.

Use this for **internal mental events** that you wouldn't otherwise leave a trace of. Physical events you do (actions) and witness (other people's actions affecting you) are auto-logged by the engine — don't duplicate.

## When to use
- You formed a new plan: "I'll go to the library after dinner" → \`type=plan\`
- You came to believe something: "Smith is lying" → \`type=belief\`
- You learned something hidden: "I just realized X is the killer" → \`type=secret\`
- You learned a fact: "The library closes at 6 PM" → \`type=information\`
- Your long-term goal genuinely shifted (rare) → \`type=long_term_intent\`
- You learned about a place / route → \`type=map\` (use \`mapAdd\` not \`content\`)

## When NOT to use
- To narrate what just happened — events / witness are auto-recorded by the engine
- To rephrase something you already wrote this decision
- "I think I should do X next" — that's just an action choice, use \`act\` directly
- Routine observations ("the room is dim") — these are perception, not memory

## Usage
{ "tool": "writeMemory", "type": "<type>", "content": "<text>" }

For \`type=map\`:
{ "tool": "writeMemory", "type": "map", "mapAdd": { "sceneNames": ["library"], "junctionNames": [], "roadNames": [], "revealHiddenConnection": "" } }

## Cap
Max 3 \`writeMemory\` calls per decision.

## Examples

Forming a belief from observation:
{ "tool": "writeMemory", "type": "belief", "content": "Smith was at the library when I asked, but his coat was wet. He must have been outside earlier." }

Recording a plan:
{ "tool": "writeMemory", "type": "plan", "content": "Tomorrow morning, head to the harbor before anyone notices I'm gone." }

Recording a discovered location:
{ "tool": "writeMemory", "type": "map", "mapAdd": { "sceneNames": ["abandoned warehouse"] } }
`;
```

- [ ] **Step 4: Create `src/roleSim/toolSkills/recallMemorySkill.ts`**

```ts
// src/roleSim/toolSkills/recallMemorySkill.ts

export const recallMemorySkill = `---
name: recallMemory
description: Query your past memories (across days). Doesn't consume a tick.
---

# recallMemory

Search your memories for something specific. Today's events / witness are already in your prompt — use this for **older or topic-specific** memories.

## When to use
- You want to remember an event from a previous day
- You want to recall what someone said, what you believed, what secret you wrote
- You're filtering by type ("what did I plan recently?", "what beliefs do I hold about Smith?")
- The current situation reminds you of something — semantic search

## When NOT to use
- The information is already in \`## Today's memories\` — reading is free, no tool needed
- For trivial / spammy queries — costs a tool call
- More than 10 times per decision — capped

## Usage
{ "tool": "recallMemory", "query": "<keyword phrase>", "types": ["<type>", ...], "gameDay": <number>, "limit": <1-20> }

All fields optional:
- \`query\`: semantic search string (omit for chronological dump)
- \`types\`: filter by memory type (event, witness, belief, secret, plan, information, summary, long_term_intent, map)
- \`gameDay\`: only memories from a specific day
- \`limit\`: 1-20 (default 5; clamped)

## Cap
Max 10 \`recallMemory\` calls per decision.

## Examples

Recalling a past conversation:
{ "tool": "recallMemory", "query": "Smith said about the harbor" }

Listing your beliefs about a person:
{ "tool": "recallMemory", "query": "Smith", "types": ["belief"] }

Recent plans:
{ "tool": "recallMemory", "types": ["plan"], "limit": 5 }
`;
```

- [ ] **Step 5: Create `src/roleSim/toolSkills/getMapSnapshotSkill.ts`**

```ts
// src/roleSim/toolSkills/getMapSnapshotSkill.ts

export const getMapSnapshotSkill = `---
name: getMapSnapshot
description: View your known map of places (scenes, junctions, roads). Doesn't consume a tick.
---

# getMapSnapshot

Inspect your current map — what places you know exist, hidden connections you've discovered, etc.

## When to use
- You're planning a trip and need to confirm a route
- You want to know what scenes you know about
- You're trying to recall whether you've discovered a hidden connection

## When NOT to use
- You just need the name of your current scene — that's already in \`## Right now\`
- Routine — capped at 1 per decision

## Usage
{ "tool": "getMapSnapshot" }

No arguments. Returns a list of known scenes, junctions, roads, and revealed hidden connections.

## Cap
Max 1 \`getMapSnapshot\` call per decision.

## Example

You want to check if you've ever been told about a back alley:
{ "tool": "getMapSnapshot" }
`;
```

---

## Task 2: Create `systemPrompt.ts`

**Files:**
- Create: `src/roleSim/systemPrompt.ts`

Pure concatenation, no logic. (No test — trivial per `feedback_skip_trivial_tests.md`. The end-of-plan smoke run via `pnpm chat:dev` catches the only failure mode: missing tool import.)

- [ ] **Step 1: Create `src/roleSim/systemPrompt.ts`**

```ts
// src/roleSim/systemPrompt.ts
//
// Identity-agnostic system prompt for LLMRoleSimAgent. Built once at module
// import; cache-friendly (does not change per tick). Per-NPC facts live in
// the user prompt (built each tick by userPromptBuilder.ts).

import { actSkill } from "./toolSkills/actSkill.js";
import { continueSkill } from "./toolSkills/continueSkill.js";
import { getMapSnapshotSkill } from "./toolSkills/getMapSnapshotSkill.js";
import { recallMemorySkill } from "./toolSkills/recallMemorySkill.js";
import { writeMemorySkill } from "./toolSkills/writeMemorySkill.js";

const FRAMING = `You are this person, alive in your world. Each turn you receive your senses
(profile, what you perceive, today's memories, things that just happened) and
decide what to do next. You are not an AI helping someone — you ARE this person.

Act in character. Decisions should be what this person would do, not what's
"optimal". Inertia is normal — most turns should be \`continue\` if your current
action is fine.`;

const TOOLS_SECTION =
  "## Tools\n\n" +
  [
    actSkill,
    continueSkill,
    writeMemorySkill,
    recallMemorySkill,
    getMapSnapshotSkill,
  ].join("\n\n---\n\n");

const PRINCIPLES = `## Decision Principles

- In character > optimal. Decisions should be what someone with your background,
  personality, and current state would actually make.
- Inertia is normal. If your current action is fine, \`continue\`. Don't switch
  every tick.
- Memory writes are reflection, not narration. Only \`writeMemory\` when you
  genuinely formed a new thought / plan / belief / secret. The engine logs
  events automatically.
- Tool caps exist (recallMemory ≤ 10, writeMemory ≤ 3, getMapSnapshot ≤ 1
  per decision). Use them sparingly.
- End every decision with exactly one terminal call: \`act\` or \`continue\`.`;

const OUTPUT_FORMAT = `## Output

Respond with ONE JSON object per turn. Examples:

{ "tool": "recallMemory", "query": "smith last night" }

{ "tool": "writeMemory", "type": "belief", "content": "Smith is hiding something — he was outside earlier despite saying he was reading." }

{ "tool": "act", "input": { "actionText": "head to the harbor" } }`;

export const SYSTEM_PROMPT = [
  FRAMING,
  TOOLS_SECTION,
  PRINCIPLES,
  OUTPUT_FORMAT,
].join("\n\n");
```

---

## Task 3: Create `profileFormatter.ts` + test

**Files:**
- Create: `src/roleSim/profileFormatter.ts`
- Test: `src/roleSim/__tests__/profileFormatter.test.ts`

Formats the 12-field profile block. Has conditional logic (omit empty fields, format inventory with quantities, look up relationship target names). Test required.

- [ ] **Step 1: Write the failing test `src/roleSim/__tests__/profileFormatter.test.ts`**

```ts
// src/roleSim/__tests__/profileFormatter.test.ts

import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { DynamicNPCProfile, InventoryItem } from "../../state/types.js";
import { formatProfile } from "../profileFormatter.js";

void NpcMemoryManager; // imported for type-only narrowing parity if needed

function makeNpc(overrides: Partial<DynamicNPCProfile> = {}): DynamicNPCProfile {
  return {
    id: "npc1",
    name: "Alice",
    attributes: {
      STR: 50,
      CON: 50,
      DEX: 50,
      APP: 50,
      POW: 50,
      SIZ: 50,
      INT: 50,
      EDU: 50,
    },
    status: {
      hp: 12,
      maxHp: 12,
      san: 50,
      maxSan: 50,
      fatigue: 0,
      maxFatigue: 100,
      luck: 50,
      conditions: [],
    },
    inventory: [],
    skills: {},
    longTermIntent: "",
    relationships: [],
    ...overrides,
  };
}

function makeDgsm(opts?: {
  npcInventories?: Record<string, InventoryItem[]>;
  npcRelationshipGraph?: Record<
    string,
    Record<string, { score: number; note: string }>
  >;
  npcCharacters?: Array<{ id: string; name: string }>;
}): DynamicGameStateManager {
  return {
    getState: () => ({
      npcInventories: opts?.npcInventories ?? {},
      npcRelationshipGraph: opts?.npcRelationshipGraph ?? {},
      npcCharacters: opts?.npcCharacters ?? [],
    }),
  } as unknown as DynamicGameStateManager;
}

describe("formatProfile", () => {
  test("renders all populated 12 fields", () => {
    const npc = makeNpc({
      age: 34,
      gender: "female",
      occupation: "librarian",
      appearance: "tall, brown hair",
      personality: "introverted, observant",
      background: "small-town academic",
      backstory: "grew up next to the library",
      residence: "Library Cottage",
    });
    const dgsm = makeDgsm({
      npcInventories: {
        npc1: [
          { name: "key", quantity: 1 },
          { name: "notebook", quantity: 2 },
        ],
      },
      npcRelationshipGraph: {
        npc1: {
          smith: { score: 80, note: "close friend" },
        },
      },
      npcCharacters: [{ id: "smith", name: "Smith" }],
    });

    const out = formatProfile(npc, dgsm);

    expect(out).toContain("Name: Alice");
    expect(out).toContain("Age: 34");
    expect(out).toContain("Gender: female");
    expect(out).toContain("Occupation: librarian");
    expect(out).toContain("Appearance: tall, brown hair");
    expect(out).toContain("Personality: introverted, observant");
    expect(out).toContain("Background: small-town academic");
    expect(out).toContain("Backstory: grew up next to the library");
    expect(out).toContain("Residence: Library Cottage");
    expect(out).toContain("Status: HP 12/12, SAN 50/50, Fatigue 0/100");
    expect(out).toContain("Inventory: key, notebook (x2)");
    expect(out).toContain("- Smith: close friend (score: 80)");
  });

  test("omits absent optional fields", () => {
    const npc = makeNpc(); // only required fields
    const dgsm = makeDgsm();
    const out = formatProfile(npc, dgsm);

    expect(out).toContain("Name: Alice");
    expect(out).not.toContain("Age:");
    expect(out).not.toContain("Gender:");
    expect(out).not.toContain("Occupation:");
    expect(out).not.toContain("Appearance:");
    expect(out).not.toContain("Personality:");
    expect(out).not.toContain("Background:");
    expect(out).not.toContain("Backstory:");
    expect(out).not.toContain("Residence:");
    // Status renders even at defaults (it's runtime state, not optional)
    expect(out).toContain("Status:");
    // Inventory line omitted when empty
    expect(out).not.toContain("Inventory:");
    // Relationships omitted when empty
    expect(out).not.toContain("Relationships:");
  });

  test("includes status conditions in status line", () => {
    const npc = makeNpc({
      status: {
        hp: 5,
        maxHp: 12,
        san: 30,
        maxSan: 50,
        fatigue: 80,
        maxFatigue: 100,
        luck: 50,
        conditions: [
          {
            id: "wound1",
            description: "bleeding from arm",
          },
          {
            id: "tired1",
            description: "winded",
          },
        ],
      },
    });
    const dgsm = makeDgsm();
    const out = formatProfile(npc, dgsm);
    expect(out).toContain(
      "Status: HP 5/12, SAN 30/50, Fatigue 80/100, Conditions: bleeding from arm, winded"
    );
  });

  test("renders relationship with unknown target id when name lookup fails", () => {
    const npc = makeNpc();
    const dgsm = makeDgsm({
      npcRelationshipGraph: {
        npc1: {
          ghost42: { score: -50, note: "rival" },
        },
      },
      npcCharacters: [], // no name match
    });
    const out = formatProfile(npc, dgsm);
    expect(out).toContain("- ghost42: rival (score: -50)");
  });
});
```

- [ ] **Step 2: Create `src/roleSim/profileFormatter.ts`**

```ts
// src/roleSim/profileFormatter.ts
//
// Formats the 12-field profile block for the user prompt's "## Who you are"
// section. Inventory and relationships come from runtime DGSM (not the
// profile's static fields), so this helper takes both.

import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { DynamicNPCProfile, InventoryItem } from "../state/types.js";

export function formatProfile(
  npc: DynamicNPCProfile,
  dgsm: DynamicGameStateManager
): string {
  const lines: string[] = [];
  lines.push(`Name: ${npc.name}`);

  const ageGenderParts: string[] = [];
  if (npc.age != null) ageGenderParts.push(`Age: ${npc.age}`);
  if (npc.gender) ageGenderParts.push(`Gender: ${npc.gender}`);
  if (ageGenderParts.length > 0) lines.push(ageGenderParts.join("  "));

  if (npc.occupation) lines.push(`Occupation: ${npc.occupation}`);
  if (npc.appearance) lines.push(`Appearance: ${npc.appearance}`);
  if (npc.personality) lines.push(`Personality: ${npc.personality}`);
  if (npc.background) lines.push(`Background: ${npc.background}`);
  if (npc.backstory) lines.push(`Backstory: ${npc.backstory}`);
  if (npc.residence) lines.push(`Residence: ${npc.residence}`);

  lines.push(formatStatusLine(npc));

  const inventoryLine = formatInventoryLine(dgsm, npc.id);
  if (inventoryLine) lines.push(inventoryLine);

  const relationshipsBlock = formatRelationshipsBlock(dgsm, npc.id);
  if (relationshipsBlock) lines.push(relationshipsBlock);

  return lines.join("\n");
}

function formatStatusLine(npc: DynamicNPCProfile): string {
  const s = npc.status;
  const parts = [
    `HP ${s.hp}/${s.maxHp}`,
    `SAN ${s.san}/${s.maxSan}`,
    `Fatigue ${s.fatigue}/${s.maxFatigue}`,
  ];
  let line = `Status: ${parts.join(", ")}`;
  if (s.conditions && s.conditions.length > 0) {
    const condDescs = s.conditions.map((c) => c.description).join(", ");
    line += `, Conditions: ${condDescs}`;
  }
  return line;
}

function formatInventoryLine(
  dgsm: DynamicGameStateManager,
  npcId: string
): string | null {
  const items = dgsm.getState().npcInventories?.[npcId] as
    | InventoryItem[]
    | undefined;
  if (!items || items.length === 0) return null;
  const parts = items.map((item) => {
    if (item.quantity && item.quantity > 1) {
      return `${item.name} (x${item.quantity})`;
    }
    return item.name;
  });
  return `Inventory: ${parts.join(", ")}`;
}

function formatRelationshipsBlock(
  dgsm: DynamicGameStateManager,
  npcId: string
): string | null {
  const graph = dgsm.getState().npcRelationshipGraph?.[npcId];
  if (!graph) return null;
  const entries = Object.entries(graph);
  if (entries.length === 0) return null;

  const allNpcs = dgsm.getState().npcCharacters;
  const lines = entries.map(([targetId, rel]) => {
    const target = allNpcs.find((n) => n.id === targetId);
    const name = target?.name ?? targetId;
    return `  - ${name}: ${rel.note} (score: ${rel.score})`;
  });
  return ["Relationships:", ...lines].join("\n");
}
```

---

## Task 4: Create `memoryFormatter.ts`

**Files:**
- Create: `src/roleSim/memoryFormatter.ts`

Thin formatter — chronological sort + map to `[HH:MM] (type) content`. No test (trivial per `feedback_skip_trivial_tests.md`).

- [ ] **Step 1: Create `src/roleSim/memoryFormatter.ts`**

```ts
// src/roleSim/memoryFormatter.ts
//
// Renders today's memories (event + witness) into the user prompt's
// "## Today's memories" section. Pure formatter — sorting + line mapping.

import type { NpcMemory } from "@prisma/client";

export function formatTodayMemories(rows: NpcMemory[]): string {
  return [...rows]
    .sort((a, b) => (a.gameTime < b.gameTime ? -1 : 1))
    .map((m) => `- [${m.gameTime}] (${m.type}) ${m.content}`)
    .join("\n");
}
```

---

## Task 5: Create `perceptionRenderer.ts` + test

**Files:**
- Create: `src/roleSim/perceptionRenderer.ts`
- Test: `src/roleSim/__tests__/perceptionRenderer.test.ts`

Has logic: scene scan, present-NPC discovery, status thresholds. Test required.

- [ ] **Step 1: Write the failing test `src/roleSim/__tests__/perceptionRenderer.test.ts`**

```ts
// src/roleSim/__tests__/perceptionRenderer.test.ts

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { CharacterPosition } from "../../state/topologyTypes.js";
import type { DynamicNPCProfile } from "../../state/types.js";
import { buildPerceptionNarrative } from "../perceptionRenderer.js";

function makeNpc(
  id: string,
  name: string,
  status?: Partial<DynamicNPCProfile["status"]>
): DynamicNPCProfile {
  return {
    id,
    name,
    attributes: {
      STR: 50,
      CON: 50,
      DEX: 50,
      APP: 50,
      POW: 50,
      SIZ: 50,
      INT: 50,
      EDU: 50,
    },
    status: {
      hp: 12,
      maxHp: 12,
      san: 50,
      maxSan: 50,
      fatigue: 0,
      maxFatigue: 100,
      luck: 50,
      conditions: [],
      ...status,
    },
    inventory: [],
    skills: {},
    longTermIntent: "",
    relationships: [],
  };
}

function makeDgsm(opts: {
  scene?: { id: string; name: string; description: string; conditions?: Array<{ description: string }> };
  characterPositions?: Record<string, CharacterPosition>;
  npcs: DynamicNPCProfile[];
  selfPosition: CharacterPosition;
}): DynamicGameStateManager {
  return {
    getCharacterPosition: (id: string) => {
      if (id === opts.npcs[0].id) return opts.selfPosition;
      return opts.characterPositions?.[id];
    },
    getState: () => ({
      npcCharacters: opts.npcs,
      characterPositions: {
        ...(opts.characterPositions ?? {}),
        [opts.npcs[0].id]: opts.selfPosition,
      },
    }),
    getScene: (sceneId: string) =>
      opts.scene && opts.scene.id === sceneId
        ? {
            id: opts.scene.id,
            name: opts.scene.name,
            description: opts.scene.description,
            conditions: opts.scene.conditions ?? [],
          }
        : null,
    isNpcAlive: () => true,
  } as unknown as DynamicGameStateManager;
}

describe("buildPerceptionNarrative", () => {
  test("renders scene name + description, present NPCs, no status feel when healthy", () => {
    const self = makeNpc("npc1", "Alice");
    const smith = makeNpc("smith", "Smith");
    const dgsm = makeDgsm({
      npcs: [self, smith],
      scene: {
        id: "library",
        name: "Library",
        description: "A dim hall with floor-to-ceiling shelves.",
      },
      selfPosition: { type: "scene", sceneId: "library" },
      characterPositions: {
        smith: { type: "scene", sceneId: "library" },
      },
    });

    const out = buildPerceptionNarrative("npc1", dgsm);

    expect(out).toContain(
      "You are in Library. A dim hall with floor-to-ceiling shelves."
    );
    expect(out).toContain("Smith is here");
    expect(out).not.toContain("badly hurt");
    expect(out).not.toContain("mind is fraying");
    expect(out).not.toContain("exhausted");
  });

  test("excludes self and NPCs in other scenes", () => {
    const self = makeNpc("npc1", "Alice");
    const smith = makeNpc("smith", "Smith");
    const jones = makeNpc("jones", "Jones");
    const dgsm = makeDgsm({
      npcs: [self, smith, jones],
      scene: {
        id: "library",
        name: "Library",
        description: "Quiet.",
      },
      selfPosition: { type: "scene", sceneId: "library" },
      characterPositions: {
        smith: { type: "scene", sceneId: "library" },
        jones: { type: "scene", sceneId: "harbor" },
      },
    });

    const out = buildPerceptionNarrative("npc1", dgsm);
    expect(out).toContain("Smith is here");
    expect(out).not.toContain("Jones");
    expect(out).not.toContain("Alice is here"); // self excluded
  });

  test("renders scene conditions joined by '; '", () => {
    const self = makeNpc("npc1", "Alice");
    const dgsm = makeDgsm({
      npcs: [self],
      scene: {
        id: "library",
        name: "Library",
        description: "A hall.",
        conditions: [
          { description: "smoke fills the air" },
          { description: "fire crackles in the corner" },
        ],
      },
      selfPosition: { type: "scene", sceneId: "library" },
    });

    const out = buildPerceptionNarrative("npc1", dgsm);
    expect(out).toContain(
      "smoke fills the air; fire crackles in the corner"
    );
  });

  test("includes 'badly hurt' when HP < 25% maxHp", () => {
    const self = makeNpc("npc1", "Alice", { hp: 2, maxHp: 12 });
    const dgsm = makeDgsm({
      npcs: [self],
      scene: { id: "library", name: "Library", description: "." },
      selfPosition: { type: "scene", sceneId: "library" },
    });
    const out = buildPerceptionNarrative("npc1", dgsm);
    expect(out).toContain("badly hurt");
  });

  test("includes 'mind is fraying' when SAN < 20% maxSan", () => {
    const self = makeNpc("npc1", "Alice", { san: 5, maxSan: 50 });
    const dgsm = makeDgsm({
      npcs: [self],
      scene: { id: "library", name: "Library", description: "." },
      selfPosition: { type: "scene", sceneId: "library" },
    });
    const out = buildPerceptionNarrative("npc1", dgsm);
    expect(out).toContain("mind is fraying");
  });

  test("includes 'exhausted' when Fatigue > 75% maxFatigue", () => {
    const self = makeNpc("npc1", "Alice", { fatigue: 80, maxFatigue: 100 });
    const dgsm = makeDgsm({
      npcs: [self],
      scene: { id: "library", name: "Library", description: "." },
      selfPosition: { type: "scene", sceneId: "library" },
    });
    const out = buildPerceptionNarrative("npc1", dgsm);
    expect(out).toContain("exhausted");
  });

  test("returns minimal narrative when scene not found", () => {
    const self = makeNpc("npc1", "Alice");
    const dgsm = makeDgsm({
      npcs: [self],
      selfPosition: { type: "scene", sceneId: "unknown" },
    });
    const out = buildPerceptionNarrative("npc1", dgsm);
    // Should not crash; returns some safe fallback string.
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Create `src/roleSim/perceptionRenderer.ts`**

```ts
// src/roleSim/perceptionRenderer.ts
//
// Controller-side perception narrative stub. Produces the "## What you
// perceive" content for the user prompt. This is a deterministic placeholder
// until a real renderer ships (future Phase H — template vs LLM choice TBD).
// Output is fixed English; the LLM's response language is governed by the
// "Write content in <lang>" instruction in the user prompt's `## Decide`
// section.

import type { DynamicGameStateManager } from "../state/DynamicGameState.js";

const HP_HURT_THRESHOLD = 0.25;
const SAN_FRAYING_THRESHOLD = 0.2;
const FATIGUE_EXHAUSTED_THRESHOLD = 0.75;

export function buildPerceptionNarrative(
  npcId: string,
  dgsm: DynamicGameStateManager
): string {
  const lines: string[] = [];

  const position = dgsm.getCharacterPosition(npcId);
  const sceneId =
    position && position.type === "scene" ? position.sceneId : null;
  const scene = sceneId ? dgsm.getScene(sceneId) : null;

  if (scene) {
    lines.push(`You are in ${scene.name}. ${scene.description}`);
  } else {
    lines.push("You are somewhere indistinct.");
  }

  // Present NPCs (same scene, excluding self, alive only)
  if (sceneId) {
    const presentNames = collectPresentNpcNames(dgsm, npcId, sceneId);
    if (presentNames.length > 0) {
      lines.push(presentNames.map((n) => `${n} is here`).join("; ") + ".");
    }
  }

  // Scene conditions
  if (scene && scene.conditions && scene.conditions.length > 0) {
    lines.push(scene.conditions.map((c) => c.description).join("; "));
  }

  // Status feel (HP / SAN / Fatigue thresholds)
  const statusFeel = renderStatusFeel(dgsm, npcId);
  if (statusFeel) lines.push(statusFeel);

  return lines.join(" ");
}

function collectPresentNpcNames(
  dgsm: DynamicGameStateManager,
  selfId: string,
  sceneId: string
): string[] {
  const state = dgsm.getState();
  const names: string[] = [];
  for (const npc of state.npcCharacters) {
    if (npc.id === selfId) continue;
    if (!dgsm.isNpcAlive(npc.id)) continue;
    const pos = state.characterPositions?.[npc.id];
    if (pos && pos.type === "scene" && pos.sceneId === sceneId) {
      names.push(npc.name);
    }
  }
  return names;
}

function renderStatusFeel(
  dgsm: DynamicGameStateManager,
  npcId: string
): string | null {
  const npc = dgsm
    .getState()
    .npcCharacters.find((n) => n.id === npcId);
  if (!npc) return null;
  const s = npc.status;
  const feels: string[] = [];
  if (s.maxHp > 0 && s.hp / s.maxHp < HP_HURT_THRESHOLD) {
    feels.push("You're badly hurt.");
  }
  if (s.maxSan > 0 && s.san / s.maxSan < SAN_FRAYING_THRESHOLD) {
    feels.push("Your mind is fraying.");
  }
  if (s.maxFatigue > 0 && s.fatigue / s.maxFatigue > FATIGUE_EXHAUSTED_THRESHOLD) {
    feels.push("You're exhausted.");
  }
  return feels.length > 0 ? feels.join(" ") : null;
}
```

---

## Task 6: Create `userPromptBuilder.ts` + test

**Files:**
- Create: `src/roleSim/userPromptBuilder.ts`
- Test: `src/roleSim/__tests__/userPromptBuilder.test.ts`

Has logic: conditional sections, language switch, profile / memory delegation. Test required.

- [ ] **Step 1: Write the failing test `src/roleSim/__tests__/userPromptBuilder.test.ts`**

```ts
// src/roleSim/__tests__/userPromptBuilder.test.ts

import type { NpcMemory } from "@prisma/client";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { RoleSimContext } from "../agent.js";
import { buildUserPrompt } from "../userPromptBuilder.js";

function makeCtx(overrides: Partial<RoleSimContext> = {}): RoleSimContext {
  return {
    npcId: "npc1",
    currentTime: { day: 3, tickTime: "08:15" },
    npcProfile: {
      id: "npc1",
      name: "Alice",
      attributes: {
        STR: 50,
        CON: 50,
        DEX: 50,
        APP: 50,
        POW: 50,
        SIZ: 50,
        INT: 50,
        EDU: 50,
      },
      status: {
        hp: 12,
        maxHp: 12,
        san: 50,
        maxSan: 50,
        fatigue: 0,
        maxFatigue: 100,
        luck: 50,
        conditions: [],
      },
      inventory: [],
      skills: {},
      longTermIntent: "",
      relationships: [],
    },
    currentScene: "library",
    recentMemory: [],
    longTermIntent: "",
    perception: { narrative: "You are in Library." },
    ...overrides,
  };
}

function makeDgsm(): DynamicGameStateManager {
  return {
    getState: () => ({
      npcInventories: {},
      npcRelationshipGraph: {},
      npcCharacters: [],
    }),
  } as unknown as DynamicGameStateManager;
}

describe("buildUserPrompt", () => {
  test("includes always-on sections", () => {
    const out = buildUserPrompt(makeCtx(), [], { language: "en", dgsm: makeDgsm() });
    expect(out).toContain("# You are Alice");
    expect(out).toContain("## Who you are");
    expect(out).toContain("## Right now");
    expect(out).toContain("Day 3, 08:15");
    expect(out).toContain("Scene: library");
    expect(out).toContain("## What you perceive");
    expect(out).toContain("You are in Library.");
    expect(out).toContain("## Decide");
  });

  test("omits 'Currently doing' when no currentAction", () => {
    const out = buildUserPrompt(makeCtx(), [], { language: "en", dgsm: makeDgsm() });
    expect(out).not.toContain("## Currently doing");
  });

  test("includes 'Currently doing' when currentAction set", () => {
    const ctx = makeCtx({
      currentAction: { actionText: "reading the journal" },
    });
    const out = buildUserPrompt(ctx, [], { language: "en", dgsm: makeDgsm() });
    expect(out).toContain("## Currently doing");
    expect(out).toContain('"reading the journal"');
  });

  test("omits 'Things that just happened' when no reviseTriggers", () => {
    const out = buildUserPrompt(makeCtx(), [], { language: "en", dgsm: makeDgsm() });
    expect(out).not.toContain("## Things that just happened");
  });

  test("includes 'Things that just happened' when reviseTriggers populated", () => {
    const ctx = makeCtx({
      reviseTriggers: [
        { description: "Smith entered the room" },
        { description: "you hear footsteps upstairs" },
      ],
    });
    const out = buildUserPrompt(ctx, [], { language: "en", dgsm: makeDgsm() });
    expect(out).toContain("## Things that just happened around you");
    expect(out).toContain("- Smith entered the room");
    expect(out).toContain("- you hear footsteps upstairs");
  });

  test("omits 'Today's memories' when empty", () => {
    const out = buildUserPrompt(makeCtx(), [], { language: "en", dgsm: makeDgsm() });
    expect(out).not.toContain("## Today's memories");
  });

  test("includes 'Today's memories' when populated", () => {
    const ctx = makeCtx({
      recentMemory: [
        {
          type: "event",
          content: "saw a stranger by the well",
          gameDay: 3,
          gameTime: "07:42",
        },
      ],
    });
    const out = buildUserPrompt(ctx, [], { language: "en", dgsm: makeDgsm() });
    expect(out).toContain("## Today's memories");
    expect(out).toContain(
      "- [07:42] (event) saw a stranger by the well"
    );
  });

  test("omits 'Tool calls so far' when transcript empty", () => {
    const out = buildUserPrompt(makeCtx(), [], { language: "en", dgsm: makeDgsm() });
    expect(out).not.toContain("## Tool calls so far this decision");
  });

  test("includes transcript when populated", () => {
    const transcript = [
      `→ Called: {"tool":"recallMemory","query":"smith"}`,
      `← Result: No memories matched.`,
    ];
    const out = buildUserPrompt(makeCtx(), transcript, {
      language: "en",
      dgsm: makeDgsm(),
    });
    expect(out).toContain("## Tool calls so far this decision");
    expect(out).toContain(`→ Called: {"tool":"recallMemory","query":"smith"}`);
    expect(out).toContain("← Result: No memories matched.");
  });

  test("language switch: en", () => {
    const out = buildUserPrompt(makeCtx(), [], { language: "en", dgsm: makeDgsm() });
    expect(out).toContain("Write content in English");
  });

  test("language switch: zh", () => {
    const out = buildUserPrompt(makeCtx(), [], { language: "zh", dgsm: makeDgsm() });
    expect(out).toContain("Write content in Chinese");
  });

  test("language switch: zh-CN matches Chinese", () => {
    const out = buildUserPrompt(makeCtx(), [], {
      language: "zh-CN",
      dgsm: makeDgsm(),
    });
    expect(out).toContain("Write content in Chinese");
  });

  test("includes longTermIntent section when set", () => {
    const ctx = makeCtx({ longTermIntent: "Find the truth." });
    const out = buildUserPrompt(ctx, [], { language: "en", dgsm: makeDgsm() });
    expect(out).toContain("## Your long-term goal");
    expect(out).toContain("Find the truth.");
  });

  test("omits longTermIntent section when empty", () => {
    const out = buildUserPrompt(makeCtx(), [], { language: "en", dgsm: makeDgsm() });
    expect(out).not.toContain("## Your long-term goal");
  });
});
```

- [ ] **Step 2: Create `src/roleSim/userPromptBuilder.ts`**

```ts
// src/roleSim/userPromptBuilder.ts
//
// Builds the per-tick user prompt for LLMRoleSimAgent. Conditional sections
// are omitted when their data is absent (no empty headers). Profile, memory,
// and perception are delegated to focused formatter helpers. Language line
// at the end mirrors the old planner's `contentLanguageName` convention.

import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { RoleSimContext } from "./agent.js";
import { formatTodayMemories } from "./memoryFormatter.js";
import { formatProfile } from "./profileFormatter.js";

export interface BuildUserPromptOptions {
  language: string;
  dgsm: DynamicGameStateManager;
}

export function buildUserPrompt(
  ctx: RoleSimContext,
  transcript: string[],
  opts: BuildUserPromptOptions
): string {
  const sections: string[] = [];

  sections.push(`# You are ${ctx.npcProfile.name}`);

  sections.push(`## Who you are\n${formatProfile(ctx.npcProfile, opts.dgsm)}`);

  sections.push(
    `## Right now\nDay ${ctx.currentTime.day}, ${ctx.currentTime.tickTime}\nScene: ${ctx.currentScene}`
  );

  if (ctx.perception?.narrative) {
    sections.push(`## What you perceive\n${ctx.perception.narrative}`);
  }

  if (ctx.longTermIntent && ctx.longTermIntent.trim()) {
    sections.push(`## Your long-term goal\n${ctx.longTermIntent}`);
  }

  if (ctx.currentAction) {
    sections.push(`## Currently doing\n"${ctx.currentAction.actionText}"`);
  }

  if (ctx.reviseTriggers && ctx.reviseTriggers.length > 0) {
    const lines = ctx.reviseTriggers.map((t) => `- ${t.description}`);
    sections.push(
      `## Things that just happened around you\n${lines.join("\n")}`
    );
  }

  if (ctx.recentMemory.length > 0) {
    sections.push(
      `## Today's memories\n${formatTodayMemories(
        ctx.recentMemory.map((m) => ({
          type: m.type,
          content: m.content,
          gameDay: m.gameDay,
          gameTime: m.gameTime,
          // Padding the rest of the NpcMemory shape with placeholders since
          // the formatter only reads {type, content, gameTime}.
          id: "",
          sessionId: "",
          moduleId: "",
          npcId: "",
          metadata: null,
          tags: [],
          location: null,
          importance: 0,
          baseImportance: 0,
          accessCount: 0,
          lastAccessedAt: new Date(0),
          embedding: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }))
      )}`
    );
  }

  if (transcript.length > 0) {
    sections.push(
      `## Tool calls so far this decision\n${transcript.join("\n")}`
    );
  }

  const langName = opts.language?.startsWith("zh") ? "Chinese" : "English";
  sections.push(
    `## Decide\nOutput a single JSON object using a tool from the system prompt.\nWrite content in ${langName}.`
  );

  return sections.join("\n\n");
}
```

---

## Task 7: Wire `llmAgent.ts` to new modules

**Files:**
- Modify: `src/roleSim/llmAgent.ts`

Replace the inline `PHASE_F_PLACEHOLDER_SYSTEM_PROMPT` constant with the import. Replace the inline `buildUserPrompt` method with a call to the new `userPromptBuilder.ts`. Pass `dgsm` and `language` from `this.deps`.

- [ ] **Step 1: Replace the placeholder system prompt + inline buildUserPrompt**

Replace the full file `src/roleSim/llmAgent.ts` with:

```ts
// src/roleSim/llmAgent.ts
//
// Phase F LLM-driven RoleSimAgent. One decide() opens a fresh agent loop:
// each iteration sends the full ctx + transcript-so-far as one user prompt,
// the LLM emits a single JSON tool call, instant tools loop back, terminal
// tools (act/continue) end the loop and return the decision to the
// controller. No native Anthropic tool_use API — same generateText +
// parseJsonResponse path as the rest of the project.

import { parseJsonResponse } from "../engine/shared/jsonParse.js";
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import { ModelClass, generateText } from "../models/index.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { RoleSimAgent, RoleSimContext, RoleSimDecision } from "./agent.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import {
  type DispatcherDeps,
  TERMINAL_TOOLS,
  TOOL_CAPS,
  VALID_TOOLS,
  dispatchInstantTool,
} from "./toolDispatcher.js";
import { buildUserPrompt } from "./userPromptBuilder.js";

const MAX_TOTAL_ITERATIONS = 14;

export interface LLMRoleSimAgentDeps {
  memory: NpcMemoryManager;
  dgsm: DynamicGameStateManager;
  sessionId: string;
  moduleId: string;
  language: string;
}

export class LLMRoleSimAgent implements RoleSimAgent {
  constructor(private deps: LLMRoleSimAgentDeps) {}

  async decideNext(ctx: RoleSimContext): Promise<RoleSimDecision> {
    const caps = { ...TOOL_CAPS };
    const dispatcherDeps = this.buildDispatcherDeps(ctx);
    const transcript: string[] = [];

    for (let i = 0; i < MAX_TOTAL_ITERATIONS; i++) {
      const userPrompt = buildUserPrompt(ctx, transcript, {
        language: this.deps.language,
        dgsm: this.deps.dgsm,
      });

      const responseText = await generateText({
        customSystemPrompt: SYSTEM_PROMPT,
        context: userPrompt,
        modelClass: ModelClass.MEDIUM,
        operation: "role-sim-agent",
      });

      let parsed: { tool: string; [k: string]: unknown };
      try {
        parsed = parseJsonResponse<{ tool: string; [k: string]: unknown }>(
          responseText
        );
      } catch {
        console.warn(
          `[LLMRoleSimAgent] ${ctx.npcId} returned non-JSON — falling back to continue`
        );
        return { tool: "continue", reason: "implicit (no JSON tool call)" };
      }

      if (!parsed.tool || !VALID_TOOLS.has(parsed.tool)) {
        transcript.push(
          this.formatToolError(parsed.tool, "Unknown tool name.")
        );
        continue;
      }

      if (TERMINAL_TOOLS.has(parsed.tool)) {
        return this.buildTerminalDecision(parsed);
      }

      const dispatched = await dispatchInstantTool(
        parsed.tool,
        parsed,
        caps,
        dispatcherDeps
      );
      transcript.push(this.formatToolCall(parsed));
      transcript.push(this.formatToolResult(dispatched.result));
    }

    console.warn(
      `[LLMRoleSimAgent] ${ctx.npcId} hit MAX_TOTAL_ITERATIONS without terminating — forcing continue`
    );
    return { tool: "continue", reason: "iteration cap (forced)" };
  }

  private buildTerminalDecision(parsed: {
    tool: string;
    [k: string]: unknown;
  }): RoleSimDecision {
    if (parsed.tool === "act") {
      const inputBlob = (parsed.input ?? parsed) as Record<string, unknown>;
      const actionText = String(inputBlob.actionText ?? "");
      const targetCharacterIds = Array.isArray(inputBlob.targetCharacterIds)
        ? (inputBlob.targetCharacterIds as string[])
        : undefined;
      return { tool: "act", input: { actionText, targetCharacterIds } };
    }
    return {
      tool: "continue",
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  }

  private formatToolCall(parsed: {
    tool: string;
    [k: string]: unknown;
  }): string {
    return `→ Called: ${JSON.stringify(parsed)}`;
  }
  private formatToolResult(result: string): string {
    return `← Result: ${result}`;
  }
  private formatToolError(toolName: unknown, msg: string): string {
    return `← Error for "${String(toolName)}": ${msg}`;
  }

  private buildDispatcherDeps(ctx: RoleSimContext): DispatcherDeps {
    return {
      memory: this.deps.memory,
      dgsm: this.deps.dgsm,
      npcId: ctx.npcId,
      sessionId: this.deps.sessionId,
      moduleId: this.deps.moduleId,
      gameDay: ctx.currentTime.day,
      gameTime: ctx.currentTime.tickTime,
    };
  }
}
```

Diff summary vs current:
- Removed: `PHASE_F_PLACEHOLDER_SYSTEM_PROMPT` constant (~30 lines)
- Removed: `buildUserPrompt` private method (~38 lines)
- Added: `import { SYSTEM_PROMPT } from "./systemPrompt.js"`
- Added: `import { buildUserPrompt } from "./userPromptBuilder.js"`
- Changed: `decideNext` calls module-scope `buildUserPrompt(ctx, transcript, { language, dgsm })` and uses `SYSTEM_PROMPT`

---

## Task 8: Update `npcActionController.ts.buildContext`

**Files:**
- Modify: `src/roleSim/npcActionController.ts`

Two changes inside `buildContext`:
1. Call `buildPerceptionNarrative` and assign to `ctx.perception`.
2. Replace `loadRecentMemory` (currently calls `getAllForDay`) with a type-filtered + capped fetch via `getForDayByTypes(npcId, sessionId, day, ["event", "witness"], 20)`.

- [ ] **Step 1: Add imports + perception + replace memory loader**

Locate the existing `buildContext` method and `loadRecentMemory` method in `src/roleSim/npcActionController.ts`. Apply this diff:

```diff
 import { findAffectedCharacters } from "../engine/shared/impactPropagation.js";
 import type { TickEngine } from "../engine/core/tickEngine.js";
 import type {
   CharacterAction,
   FeatureEvent,
   TickReport,
 } from "../engine/core/types.js";
 import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
 import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
 import type { RoleSimAgent, RoleSimContext } from "./agent.js";
+import { buildPerceptionNarrative } from "./perceptionRenderer.js";
```

Then in `buildContext`, replace these blocks:

Before (current):
```ts
    const longTermIntent = await this.loadLongTermIntent(npcId);
    const recentMemory = await this.loadRecentMemory(npcId, day);

    const queue = this.engine.getActorQueue(npcId);
    const active = queue.find((s) => s.status === "active");
    const currentAction = active
      ? { actionText: active.actionText }
      : undefined;

    return {
      npcId,
      currentTime: { day, tickTime },
      npcProfile: profile,
      currentScene,
      recentMemory,
      longTermIntent,
      reviseTriggers: opts?.reviseTriggers,
      currentAction,
      // perception left undefined per Decision 11 (renderer deferred).
    };
```

After:
```ts
    const longTermIntent = await this.loadLongTermIntent(npcId);
    const recentMemory = await this.loadTodayMemories(npcId, day);

    const queue = this.engine.getActorQueue(npcId);
    const active = queue.find((s) => s.status === "active");
    const currentAction = active
      ? { actionText: active.actionText }
      : undefined;

    const perception = {
      narrative: buildPerceptionNarrative(npcId, this.dgsm),
    };

    return {
      npcId,
      currentTime: { day, tickTime },
      npcProfile: profile,
      currentScene,
      recentMemory,
      longTermIntent,
      reviseTriggers: opts?.reviseTriggers,
      currentAction,
      perception,
    };
```

Also replace the `loadRecentMemory` private method:

Before (current):
```ts
  private async loadRecentMemory(
    npcId: string,
    gameDay: number
  ): Promise<RoleSimContext["recentMemory"]> {
    const rows = await this.memory.getAllForDay(npcId, this.sessionId, gameDay);
    return rows.map((r) => ({
      type: r.type,
      content: r.content,
      gameDay: r.gameDay,
      gameTime: r.gameTime,
    }));
  }
```

After:
```ts
  private async loadTodayMemories(
    npcId: string,
    gameDay: number
  ): Promise<RoleSimContext["recentMemory"]> {
    const rows = await this.memory.getForDayByTypes(
      npcId,
      this.sessionId,
      gameDay,
      ["event", "witness"],
      20
    );
    return rows.map((r) => ({
      type: r.type,
      content: r.content,
      gameDay: r.gameDay,
      gameTime: r.gameTime,
    }));
  }
```

Diff summary:
- Added import for `buildPerceptionNarrative`
- Added perception construction and `perception` field in returned ctx
- Renamed `loadRecentMemory` → `loadTodayMemories`
- Renamed callsite in `buildContext` accordingly
- Memory fetch switched from `getAllForDay` to `getForDayByTypes(["event","witness"], 20)`

---

## Task 9: End-of-plan verification + commit

**Files:** none new; runs the full verification stack.

This is the **only** task that runs commands or commits. Per `feedback_batch_test_at_end.md` + `feedback_commit_all_at_once.md` + `feedback_no_auto_commit.md`, no per-task commits or per-task test runs.

- [ ] **Step 1: Run the full test suite**

```bash
pnpm vitest run --reporter=basic 2>&1 | tail -20
```

Expected: all green. New tests:
- `src/roleSim/__tests__/profileFormatter.test.ts` (4 tests)
- `src/roleSim/__tests__/perceptionRenderer.test.ts` (7 tests)
- `src/roleSim/__tests__/userPromptBuilder.test.ts` (12 tests)

If any new test fails, fix at site (re-read the test + impl, find the mismatch).

- [ ] **Step 2: Type check**

```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | grep -v "__tests__" | head -30
```

Expected: 0 NEW errors from this plan's surface (`src/roleSim/`). Pre-existing Phase D errors (worldStateBlock `getFeatureState`, fireFeature, eventBus overload, moduleLoader TransportEdge, MemoryStore `rag/embedding`) may persist — they're unrelated to this plan.

If a new error surfaces in `src/roleSim/`, fix at site (most likely candidates: missing `.js` extension on internal import, type mismatch on `RoleSimContext` field).

- [ ] **Step 3: Biome check**

```bash
pnpm check 2>&1 | tail -10
```

Biome auto-formats and reports remaining issues. If it claims to fix files outside `src/roleSim/`, that's residual from prior commits — review with `git status --short` and decide whether to include in this commit (Phase F's bundled biome-fix precedent applies; user's call).

If biome reports errors in this plan's new files, fix at site.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Pause here and ask the user whether to run `pnpm chat:dev` to capture an actual prompt from the logs. If yes, run it, create a fresh session, advance one tick, and grep the logs for one of the new prompt strings (e.g., `## Who you are` or `Decision Principles`) to confirm the wiring fired end-to-end.

If anything unexpected, fix at site.

- [ ] **Step 5: Stop here. Show diff and ask user to commit**

Per `feedback_no_auto_commit.md`, **do not commit autonomously**. Instead:

```bash
git -C /Users/sunyining/project_SentiEdge/CoC-AI-agent status --short
git -C /Users/sunyining/project_SentiEdge/CoC-AI-agent diff --stat HEAD
```

Show the user the file list + LOC delta. Ask: *"Implementation done. All tests pass / type errors are pre-existing. Files changed: [list]. Want me to commit, or do you want to review first?"*

Wait for explicit user instruction before running `git add` / `git commit`.

If user approves a commit, suggested message:

```
feat(roleSim): persona-simulation prompt + per-tool skill files

Replaces Phase F's placeholder system prompt + minimal context injection
with a persona-simulation framework per spec
docs/superpowers/specs/2026-05-05-roleSim-agent-prompt-design.md.

System prompt:
- Framing: "You ARE this person, alive in your world" (statement, not role-play)
- 5 per-tool skill files (toolSkills/*Skill.ts) — each with frontmatter,
  when-to-use / when-not-to-use, usage, examples; concatenated into the
  system prompt at module load (cache-friendly, static across ticks)
- Decision principles: in-character > optimal, inertia is normal, memory
  writes are reflection not narration, terminal-only via act/continue
- Output format with 3 examples

User prompt (per tick):
- 12-field profile block (name, age, gender, occupation, appearance,
  personality, background, backstory, residence, status, inventory,
  relationships) — inventory + relationships sourced from runtime DGSM
- Perception narrative (controller-side template stub: scene + present
  NPCs + scene conditions + status thresholds; real renderer is a
  separate future phase)
- Long-term goal (when set)
- Currently-doing (when in-flight action)
- Things-that-just-happened (when reviseTriggers populated)
- Today's memories (event/witness only, capped 20, chronological — past
  memories accessible via recallMemory tool)
- Transcript-so-far (when prior tool calls in this decision)
- Decide section with `Write content in <Chinese|English>` based on language

Helpers:
- profileFormatter.ts (12-field renderer with conditional fields)
- memoryFormatter.ts (chronological [HH:MM] (type) content)
- perceptionRenderer.ts (deterministic stub: HP < 25% → "badly hurt", etc)
- userPromptBuilder.ts (section assembly, conditional rendering, language)

Wiring:
- llmAgent.ts: import SYSTEM_PROMPT + buildUserPrompt; pass dgsm + language
- npcActionController.ts.buildContext: call buildPerceptionNarrative,
  switch loadRecentMemory → loadTodayMemories (event/witness only, limit 20)

Tests added (logic-bearing modules only): profileFormatter,
perceptionRenderer, userPromptBuilder. Tool skill files + systemPrompt +
memoryFormatter are pure content / thin formatters and skip TDD per
project preference.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Use HEREDOC syntax to pass the message:

```bash
git -C /Users/sunyining/project_SentiEdge/CoC-AI-agent commit -m "$(cat <<'EOF'
<paste message above>
EOF
)"
```

---

## Self-review notes

**Spec coverage check:**
- ✓ Framing (sec "Section 1") → Task 2 (FRAMING constant)
- ✓ 5 tool skills → Task 1 (5 files) + Task 2 (concatenation in TOOLS_SECTION)
- ✓ Decision Principles → Task 2 (PRINCIPLES constant)
- ✓ Output format → Task 2 (OUTPUT_FORMAT constant)
- ✓ User prompt sections → Task 6 (`buildUserPrompt`)
- ✓ Profile 12 fields → Task 3 (`formatProfile`)
- ✓ Perception stub → Task 5 (`buildPerceptionNarrative`)
- ✓ Memory injection (event/witness, limit 20) → Task 8 (`loadTodayMemories`)
- ✓ Transcript format unchanged → Tasks 6/7 (passed through)
- ✓ Language handling → Task 6 (`langName` switch)
- ✓ `LLMRoleSimAgent` rewire → Task 7
- ✓ Controller `buildContext` changes → Task 8

**Type consistency:**
- `formatProfile(npc, dgsm)` signature matches Task 3 + Task 6 caller
- `formatTodayMemories(rows: NpcMemory[])` shape — Task 6 caller passes a padded shape because `RoleSimContext.recentMemory` only has 4 fields whereas `NpcMemory` has more; padding is intentional and explicit
- `buildPerceptionNarrative(npcId, dgsm)` matches Task 5 + Task 8 caller
- `buildUserPrompt(ctx, transcript, opts)` matches Task 6 + Task 7 caller
- `BuildUserPromptOptions { language, dgsm }` matches Task 7 caller

**No placeholders:** every step has complete code or exact commands.

**No per-task commits / no per-task verification:** confirmed — only Task 9 runs commands.
