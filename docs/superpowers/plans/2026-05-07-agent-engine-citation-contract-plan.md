# Agent ↔ Engine Citation Contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **User preferences applied to this plan** (overriding default writing-plans template):
> - **Single commit at the end**, NOT per-task (`feedback_commit_all_at_once.md`)
> - **Skip per-task smoke tests; batch verification at end** (`feedback_batch_test_at_end.md`)
> - **Skip TDD for trivial code** — pure types, prompt strings, thin delegation get no unit tests; algorithmic logic (citation parser, directory builder) gets tests (`feedback_skip_trivial_tests.md`)
> - **Don't auto-commit** — user reviews full diff before any commit (`feedback_no_auto_commit.md`)
> - **Phase D-style review cadence** — implementer + spec reviewer per task; skip code-quality reviewer for routine ports (`feedback_phase_d_review_cadence.md`)

**Goal:** Replace agent-emitted `targetCharacterIds` with citation-based entity resolution: agent writes `[Name]` brackets in actionText; GameInterpreter resolves names → IDs against a per-decision `PerceivableDirectory`; outputs `referencedEntities: { id, kind }[]` consumed by 7 engine internal subsystems.

**Architecture:** Agent uses `[<full-name>]` markup in actionText (D3); ActionIntake builds a `PerceivableDirectory` from DGSM (relationships ∪ in-scene characters + scene/inventory items + current/adjacent scenes) at each submit; GameInterpreter parses citations into typed `ReferencedEntity[]`; downstream filters by `r.kind === "character"` for legacy character-target paths. Phase G renderer simplified per first-principles: delete god-eye fallback (it violates the "subjective perception" mandate by leaking god-view objective text), `render()` returns `null` on LLM fail, controller skips that NPC's `decide()` for the tick.

**Tech Stack:** TypeScript (strict), vitest, biome. No new external dependencies.

**Spec:** `docs/superpowers/specs/2026-05-07-agent-engine-citation-contract-design.md` (D1–D8 design decisions, OQ1–OQ6 all resolved).

**Estimated scope:** 8 tasks, ~3-4 days. ~20 files modified, 1 new file (`src/state/perceivableDirectory.ts`), 1 deleted (`src/roleSim/renderer/godEyeFallback.ts`).

---

## File Structure

### New files
- `src/state/perceivableDirectory.ts` — `PerceivableDirectory` type + `buildPerceivableDirectory()` builder; houses `isKnownTo` + `descriptionIdentifier` (moved from `llmRenderer.ts`).
- `src/state/__tests__/perceivableDirectory.test.ts` — directory builder unit tests.

### Deleted files
- `src/roleSim/renderer/godEyeFallback.ts` — D6 / first-principles cleanup (violates "subjective perception" invariant).

### Modified — Type foundations
- `src/engine/core/types.ts` — add `EntityKind`, `ReferencedEntity`; `ActionInput` drops `targetCharacterIds`; `ActionStep`/`CharacterAction` rename `targetCharacterIds` → `referencedEntities`.
- `src/engine/types.ts` — `InterpretedStep` adds `referencedEntities?`.

### Modified — Interpreter / Intake
- `src/engine/interpreter/gameInterpreter.ts` — accept `directory`, parse `[Name]` regex, output `referencedEntities`.
- `src/engine/core/actionIntake.ts` — receive `dgsm`; call `buildPerceivableDirectory` before `interpretAction`.
- `src/engine/core/tickEngine.ts` — wire `dgsm` into ActionIntake deps; update `interpretAction` callback signature.

### Modified — Renderer simplification (D6)
- `src/roleSim/renderer/types.ts` — `RenderedPerception` drops `llmSucceeded`.
- `src/roleSim/renderer/index.ts` — `render()` → `Promise<RenderedPerception | null>`; remove fallback path; remove `renderFallback` and `buildGodEyeFallback` re-exports.
- `src/roleSim/renderer/llmRenderer.ts` — remove inlined `isKnownTo` / `descriptionIdentifier`; import from `src/state/perceivableDirectory.ts`.

### Modified — Agent layer
- `src/roleSim/agent.ts` — `RoleSimDecision.act` drops `targetCharacterIds`.
- `src/roleSim/llmAgent.ts` — `buildTerminalDecision` drops `targetCharacterIds` parse branch.
- `src/roleSim/toolSkills/actSkill.ts` — rewrite prompt: `[Name]` syntax + short-action principle.
- `src/roleSim/npcActionController.ts` — drop `targetCharacterIds` passthrough; add `null` render skip.

### Modified — 7 engine internal consumers
- `src/engine/shared/impactPropagation.ts`
- `src/engine/tools/skillCheckTool.ts`
- `src/engine/shared/skillRoll.ts`
- `src/engine/core/scriptedEventRunner.ts`
- `src/engine/resolver/stateContextBuilder.ts`
- `src/engine/core/tickOrchestrator.ts`
- `src/simulation/SimulationEventEmitter.ts`

### Modified — Tests
- `src/engine/interpreter/__tests__/gameInterpreter.test.ts` — add citation parsing cases.
- `src/roleSim/__tests__/renderer.test.ts` — drop godEye tests; add null behavior tests.
- `src/roleSim/__tests__/npcActionController.tickReport.test.ts` — replace `targetCharacterIds` with `referencedEntities`; add null skip test.
- Any integration fixtures using `targetCharacterIds` (search-and-replace).

---

## Task 1: Type foundation

Add new types and rename fields. This task intentionally breaks TypeScript compile in many places — downstream tasks fix the breakage. Single-commit policy means we can be in a broken state mid-implementation.

**Files:**
- Modify: `src/engine/core/types.ts:50-300`
- Modify: `src/engine/types.ts:77-87`

- [ ] **Step 1: Add `EntityKind` + `ReferencedEntity` types to `src/engine/core/types.ts`**

Add directly after the existing `Unsubscribe` type (around line 30):

```ts
/** Kind of entity referenced via [Name] citation in actionText.
 *  Drives downstream routing: stateContextBuilder, scriptedEventRunner.matchTarget,
 *  impactPropagation level-1 propagation all filter by kind === "character". */
export type EntityKind = "character" | "item" | "scene";

/** A resolved citation from `actionText`: directory lookup result.
 *  Produced by GameInterpreter; carried on InterpretedStep / ActionStep / CharacterAction. */
export interface ReferencedEntity {
  id: string;
  kind: EntityKind;
}
```

- [ ] **Step 2: Drop `targetCharacterIds` from `ActionInput`**

Find and update `ActionInput` (around line 50):

```ts
export interface ActionInput {
  characterId: string;
  actionText: string;
  sceneId: string;
  overlayFields?: Record<string, unknown>;
  // targetCharacterIds removed — agent no longer emits this; interpreter derives referencedEntities
}
```

- [ ] **Step 3: Rename `ActionStep.targetCharacterIds` → `referencedEntities`**

Find and update `ActionStep` (around line 71):

```ts
export interface ActionStep {
  id: string;
  handle: ActionHandle;
  stepGroupId: string;
  stepIndex: number;
  characterId: string;
  /** Citations from actionText resolved by interpreter — typed (id + kind).
   *  Replaces legacy `targetCharacterIds: string[]` (Phase H). */
  referencedEntities: ReferencedEntity[];
  actionText: string;
  definitionId: string;
  executionSceneId: string;
  overlayFields?: Record<string, unknown>;
  submittedAt: GameTime;
  activatedAt?: GameTime;
  plannedDuration?: number;
  plannedOutcome?: StateResolution;
  completionTime?: GameTime;
  status: ActionStatus;
}
```

- [ ] **Step 4: Rename `CharacterAction.targetCharacterIds` → `referencedEntities`**

Find and update `CharacterAction` (around line 274):

```ts
export interface CharacterAction {
  characterId: string;
  handleId: string;
  stepGroupId: string;
  stepIndex: number;
  definitionId: string;
  actionText: string;
  sceneId: string;
  /** Citations from actionText resolved by interpreter — typed (id + kind).
   *  Phase H rename of `targetCharacterIds: string[]`. */
  referencedEntities: ReferencedEntity[];
  activatedAt: GameTime;
  completedAt: GameTime;
  outcome?: StateResolution;
}
```

- [ ] **Step 5: Add `referencedEntities` to `InterpretedStep` in `src/engine/types.ts`**

Update `InterpretedStep` (around line 77):

```ts
export interface InterpretedStep {
  definitionId: string;
  impact: 0 | 1 | 2 | 3 | 4 | 5;
  engine: "code" | "llm";
  codeSubsystem?: string;
  overlayFields?: Record<string, unknown>;
  /** Resolved [Name] citations from actionText (Phase H). Empty array if no
   *  citations present. ActionIntake passes through to ActionStep. */
  referencedEntities?: import("./core/types.js").ReferencedEntity[];
}
```

---

## Task 2: PerceivableDirectory helper + tests (algorithmic — TDD)

Builds the directory consumed by interpreter for citation resolution. Houses the known/unknown identity-gate helpers shared with renderer.

**Files:**
- Create: `src/state/perceivableDirectory.ts`
- Create: `src/state/__tests__/perceivableDirectory.test.ts`

- [ ] **Step 1: Write failing tests — `src/state/__tests__/perceivableDirectory.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  buildPerceivableDirectory,
  descriptionIdentifier,
  isKnownTo,
} from "../perceivableDirectory.js";

// Hand-rolled DGSM stub keeps coverage on directory logic, not state plumbing.
// Each test constructs only the slice it needs.

function stubDgsm(opts: {
  npcs: Array<{
    id: string;
    name: string;
    appearance?: string;
    age?: number;
    gender?: string;
    occupation?: string;
    relationships?: Array<{ targetId: string; targetName: string }>;
    inventory?: Array<{ name: string }>;
    alive?: boolean;
    sceneId?: string;
  }>;
  scenes: Array<{
    id: string;
    name: string;
    items?: Array<{ id: string; name: string }>;
    connections?: Array<{ toSceneId: string }>;
  }>;
}) {
  return {
    getNpcProfile: (id: string) => opts.npcs.find((n) => n.id === id),
    isNpcAlive: (id: string) =>
      opts.npcs.find((n) => n.id === id)?.alive !== false,
    getScene: (id: string) => opts.scenes.find((s) => s.id === id),
    getCharacterPosition: (id: string) => {
      const npc = opts.npcs.find((n) => n.id === id);
      return npc?.sceneId ? { type: "scene" as const, sceneId: npc.sceneId } : null;
    },
    getState: () => ({ npcCharacters: opts.npcs }),
  } as never;
}

describe("buildPerceivableDirectory — characters", () => {
  it("includes KNOWN characters from actor.relationships using canonical names", () => {
    const dgsm = stubDgsm({
      npcs: [
        { id: "alice", name: "Alice", relationships: [{ targetId: "bob", targetName: "Bob" }], sceneId: "lib" },
        { id: "bob", name: "Bob", sceneId: "harbor" },
      ],
      scenes: [{ id: "lib", name: "Library" }, { id: "harbor", name: "Harbor" }],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.characters.get("Bob")).toBe("bob");
  });

  it("includes UNKNOWN in-scene characters via descriptionIdentifier", () => {
    const dgsm = stubDgsm({
      npcs: [
        { id: "alice", name: "Alice", relationships: [], sceneId: "lib" },
        { id: "stranger", name: "Cyrus", appearance: "gaunt man with sunken eyes", sceneId: "lib" },
      ],
      scenes: [{ id: "lib", name: "Library" }],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.characters.get("the gaunt man with sunken eyes")).toBe("stranger");
    // Canonical name should NOT be present (would leak identity)
    expect(dir.characters.has("Cyrus")).toBe(false);
  });

  it("KNOWN actors take canonical name even if also in scene", () => {
    const dgsm = stubDgsm({
      npcs: [
        { id: "alice", name: "Alice", relationships: [{ targetId: "bob", targetName: "Bob" }], sceneId: "lib" },
        { id: "bob", name: "Bob", appearance: "hulking sailor", sceneId: "lib" },
      ],
      scenes: [{ id: "lib", name: "Library" }],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.characters.get("Bob")).toBe("bob");
    expect(dir.characters.has("the hulking sailor")).toBe(false);
  });

  it("excludes characters neither in relationships nor in scene", () => {
    const dgsm = stubDgsm({
      npcs: [
        { id: "alice", name: "Alice", relationships: [], sceneId: "lib" },
        { id: "remote", name: "Remote", sceneId: "harbor" },
      ],
      scenes: [{ id: "lib", name: "Library" }, { id: "harbor", name: "Harbor" }],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.characters.has("Remote")).toBe(false);
  });

  it("excludes dead characters from in-scene unknowns", () => {
    const dgsm = stubDgsm({
      npcs: [
        { id: "alice", name: "Alice", relationships: [], sceneId: "lib" },
        { id: "ghost", name: "Ghost", appearance: "pale figure", sceneId: "lib", alive: false },
      ],
      scenes: [{ id: "lib", name: "Library" }],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.characters.size).toBe(0);
  });

  it("excludes the actor themselves from their own directory", () => {
    const dgsm = stubDgsm({
      npcs: [
        { id: "alice", name: "Alice", relationships: [], sceneId: "lib" },
      ],
      scenes: [{ id: "lib", name: "Library" }],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.characters.has("Alice")).toBe(false);
  });
});

describe("buildPerceivableDirectory — items", () => {
  it("includes scene items by name → id", () => {
    const dgsm = stubDgsm({
      npcs: [{ id: "alice", name: "Alice", relationships: [], sceneId: "lib" }],
      scenes: [
        { id: "lib", name: "Library", items: [{ id: "ledger42", name: "the bound ledger" }] },
      ],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.items.get("the bound ledger")).toBe("ledger42");
  });

  it("includes actor inventory items (using name as id)", () => {
    const dgsm = stubDgsm({
      npcs: [
        {
          id: "alice",
          name: "Alice",
          relationships: [],
          inventory: [{ name: "the worn key" }],
          sceneId: "lib",
        },
      ],
      scenes: [{ id: "lib", name: "Library" }],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.items.get("the worn key")).toBe("the worn key");
  });

  it("scene wins on item name collision (OQ4 conflict rule)", () => {
    const dgsm = stubDgsm({
      npcs: [
        {
          id: "alice",
          name: "Alice",
          relationships: [],
          inventory: [{ name: "letter" }],
          sceneId: "lib",
        },
      ],
      scenes: [
        { id: "lib", name: "Library", items: [{ id: "letter_scene", name: "letter" }] },
      ],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.items.get("letter")).toBe("letter_scene");
  });
});

describe("buildPerceivableDirectory — scenes", () => {
  it("includes current scene by name", () => {
    const dgsm = stubDgsm({
      npcs: [{ id: "alice", name: "Alice", relationships: [], sceneId: "lib" }],
      scenes: [{ id: "lib", name: "Library" }],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.scenes.get("Library")).toBe("lib");
  });

  it("includes adjacent scenes via connections", () => {
    const dgsm = stubDgsm({
      npcs: [{ id: "alice", name: "Alice", relationships: [], sceneId: "lib" }],
      scenes: [
        { id: "lib", name: "Library", connections: [{ toSceneId: "harbor" }] },
        { id: "harbor", name: "Harbor" },
      ],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.scenes.get("Library")).toBe("lib");
    expect(dir.scenes.get("Harbor")).toBe("harbor");
  });
});

describe("isKnownTo / descriptionIdentifier", () => {
  it("isKnownTo true when targetId in relationships", () => {
    const profile = {
      relationships: [{ targetId: "bob", targetName: "Bob" }],
    } as never;
    expect(isKnownTo(profile, "bob")).toBe(true);
    expect(isKnownTo(profile, "alice")).toBe(false);
  });

  it("descriptionIdentifier prefers appearance", () => {
    const profile = { appearance: "gaunt man" } as never;
    expect(descriptionIdentifier(profile)).toBe("the gaunt man");
  });

  it("descriptionIdentifier falls back to age + gender", () => {
    const profile = { age: 40, gender: "male" } as never;
    expect(descriptionIdentifier(profile)).toBe("the age 40, male");
  });

  it("descriptionIdentifier falls back to occupation", () => {
    const profile = { occupation: "fisherman" } as never;
    expect(descriptionIdentifier(profile)).toBe("the fisherman");
  });

  it("descriptionIdentifier returns generic when nothing", () => {
    const profile = {} as never;
    expect(descriptionIdentifier(profile)).toBe("an unfamiliar person");
  });
});
```

- [ ] **Step 2: Implement `src/state/perceivableDirectory.ts`**

```ts
// src/state/perceivableDirectory.ts
//
// Phase H: shared directory used by GameInterpreter (citation resolution) and
// llmRenderer (perception identity gate). One source of truth for "what
// entities can this actor reference by name in this tick".
//
// Spec: docs/superpowers/specs/2026-05-07-agent-engine-citation-contract-design.md
//   - D8 character scope (relationships ∪ in-scene with KNOWN/UNKNOWN gate)
//   - OQ4 item scope (scene items ∪ actor inventory; scene wins conflicts)

import type { DynamicGameStateManager } from "./DynamicGameState.js";
import type { DynamicNPCProfile } from "./types.js";

export interface PerceivableDirectory {
  /** Display name → character ID. KNOWN: canonical name; UNKNOWN: descriptionIdentifier. */
  characters: Map<string, string>;
  /** Display name → item identifier. Scene items use Item.id; inventory items use name. */
  items: Map<string, string>;
  /** Display name → scene ID. Current scene + scenes reachable via 1-hop connections. */
  scenes: Map<string, string>;
}

/** Did `viewpoint` know `otherCharId` before this tick? Drives KNOWN/UNKNOWN gate. */
export function isKnownTo(
  viewpoint: DynamicNPCProfile | undefined,
  otherCharId: string
): boolean {
  if (!viewpoint?.relationships) return false;
  return viewpoint.relationships.some((r) => r.targetId === otherCharId);
}

/** Description-based identifier for an UNKNOWN character. Stable for a given
 *  profile snapshot — renderer + interpreter must agree. */
export function descriptionIdentifier(profile: DynamicNPCProfile): string {
  const bits: string[] = [];
  if (profile.appearance) {
    bits.push(profile.appearance);
  } else if (profile.age || profile.gender) {
    if (profile.age) bits.push(`age ${profile.age}`);
    if (profile.gender) bits.push(profile.gender);
  } else if (profile.occupation) {
    bits.push(profile.occupation);
  }
  return bits.length > 0 ? `the ${bits.join(", ")}` : "an unfamiliar person";
}

export function buildPerceivableDirectory(
  actorId: string,
  dgsm: DynamicGameStateManager
): PerceivableDirectory {
  const actor = dgsm.getNpcProfile(actorId);
  const characters = new Map<string, string>();
  const items = new Map<string, string>();
  const scenes = new Map<string, string>();

  if (!actor) {
    return { characters, items, scenes };
  }

  // ── Characters: KNOWN via relationships ─────────────────────────
  const knownIds = new Set<string>();
  for (const rel of actor.relationships ?? []) {
    if (rel.targetId === actorId) continue;
    if (!dgsm.isNpcAlive(rel.targetId)) continue;
    const target = dgsm.getNpcProfile(rel.targetId);
    if (!target) continue;
    characters.set(target.name, target.id);
    knownIds.add(target.id);
  }

  // ── Characters: UNKNOWN in-scene ─────────────────────────────────
  const actorPos = dgsm.getCharacterPosition(actorId);
  const sceneId =
    actorPos && actorPos.type === "scene" ? actorPos.sceneId : null;
  if (sceneId) {
    const state = dgsm.getState();
    for (const npc of state.npcCharacters) {
      if (npc.id === actorId) continue;
      if (knownIds.has(npc.id)) continue;
      if (!dgsm.isNpcAlive(npc.id)) continue;
      const npcPos = dgsm.getCharacterPosition(npc.id);
      const npcSceneId =
        npcPos && npcPos.type === "scene" ? npcPos.sceneId : null;
      if (npcSceneId !== sceneId) continue;
      characters.set(descriptionIdentifier(npc), npc.id);
    }
  }

  // ── Items: scene first (wins conflicts), then inventory ──────────
  if (sceneId) {
    const scene = dgsm.getScene(sceneId);
    for (const item of scene?.items ?? []) {
      items.set(item.name, item.id);
    }
  }
  for (const item of actor.inventory ?? []) {
    if (!items.has(item.name)) {
      items.set(item.name, item.name);
    }
  }

  // ── Scenes: current + adjacent via connections ───────────────────
  if (sceneId) {
    const currentScene = dgsm.getScene(sceneId);
    if (currentScene) {
      scenes.set(currentScene.name, currentScene.id);
      for (const conn of currentScene.connections ?? []) {
        const adj = dgsm.getScene(conn.toSceneId);
        if (adj) scenes.set(adj.name, adj.id);
      }
    }
  }

  return { characters, items, scenes };
}
```

- [ ] **Step 3: Run tests until green**

```bash
pnpm test -- src/state/__tests__/perceivableDirectory.test.ts
```

All 14 cases in the test file should pass. If they don't, debug and fix the implementation (NOT the tests — tests encode the contract).

---

## Task 3: GameInterpreter citation parsing + tests (algorithmic — TDD)

GameInterpreter resolves bracketed `[Name]` references using the directory; outputs `referencedEntities`.

**Files:**
- Modify: `src/engine/interpreter/gameInterpreter.ts`
- Modify: `src/engine/interpreter/__tests__/gameInterpreter.test.ts`

- [ ] **Step 1: Write failing tests for citation parsing**

Add a new `describe` block to `src/engine/interpreter/__tests__/gameInterpreter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CitationResolutionError,
  parseCitations,
} from "../gameInterpreter.js";
import type { PerceivableDirectory } from "../../../state/perceivableDirectory.js";

function dir(opts: {
  characters?: Record<string, string>;
  items?: Record<string, string>;
  scenes?: Record<string, string>;
}): PerceivableDirectory {
  return {
    characters: new Map(Object.entries(opts.characters ?? {})),
    items: new Map(Object.entries(opts.items ?? {})),
    scenes: new Map(Object.entries(opts.scenes ?? {})),
  };
}

describe("parseCitations", () => {
  it("returns empty array when no [Name] markers present", () => {
    const result = parseCitations("just walking down the street", dir({}));
    expect(result).toEqual([]);
  });

  it("resolves a single [character] citation", () => {
    const d = dir({ characters: { Smith: "smith42" } });
    const result = parseCitations("greet [Smith]", d);
    expect(result).toEqual([{ id: "smith42", kind: "character" }]);
  });

  it("resolves [item] and [character] in the same actionText", () => {
    const d = dir({
      characters: { Smith: "smith42" },
      items: { "the bound ledger": "ledger7" },
    });
    const result = parseCitations("hand [the bound ledger] to [Smith]", d);
    expect(result).toEqual([
      { id: "ledger7", kind: "item" },
      { id: "smith42", kind: "character" },
    ]);
  });

  it("resolves [scene] citations", () => {
    const d = dir({ scenes: { Harbor: "harbor_scene" } });
    const result = parseCitations("head to [Harbor]", d);
    expect(result).toEqual([{ id: "harbor_scene", kind: "scene" }]);
  });

  it("dedupes repeated citations of the same name", () => {
    const d = dir({ characters: { Smith: "smith42" } });
    const result = parseCitations(
      "[Smith] turns; I face [Smith] again",
      d
    );
    expect(result).toEqual([{ id: "smith42", kind: "character" }]);
  });

  it("checks character → item → scene order on lookup", () => {
    const d = dir({
      characters: { Tower: "char_named_tower" },
      items: { Tower: "item_tower" },
      scenes: { Tower: "scene_tower" },
    });
    const result = parseCitations("approach [Tower]", d);
    expect(result).toEqual([{ id: "char_named_tower", kind: "character" }]);
  });

  it("throws CitationResolutionError on unresolved citation (OQ3)", () => {
    const d = dir({ characters: {} });
    expect(() => parseCitations("approach [Mxy]", d)).toThrow(
      CitationResolutionError
    );
  });

  it("CitationResolutionError carries the unresolved name and full actionText", () => {
    const d = dir({});
    try {
      parseCitations("greet [Mxy] near [Tower]", d);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CitationResolutionError);
      expect((err as CitationResolutionError).citation).toBe("Mxy");
      expect((err as CitationResolutionError).actionText).toBe(
        "greet [Mxy] near [Tower]"
      );
    }
  });

  it("tolerates actionText with no brackets at all (OQ2 fallback)", () => {
    const d = dir({ characters: { Smith: "smith42" } });
    // No brackets present → no citations parsed; returns []. Existing
    // natural-language identification path in interpretAction continues.
    const result = parseCitations("greet Smith", d);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement `parseCitations` + `CitationResolutionError` in `gameInterpreter.ts`**

Add at the top of `src/engine/interpreter/gameInterpreter.ts` (or wherever convenient), exported:

```ts
import type { PerceivableDirectory } from "../../state/perceivableDirectory.js";
import type { ReferencedEntity } from "../core/types.js";

export class CitationResolutionError extends Error {
  constructor(
    public readonly citation: string,
    public readonly actionText: string
  ) {
    super(
      `Citation [${citation}] not in PerceivableDirectory. actionText: "${actionText}"`
    );
    this.name = "CitationResolutionError";
  }
}

const CITATION_REGEX = /\[([^\]]+)\]/g;

export function parseCitations(
  actionText: string,
  directory: PerceivableDirectory
): ReferencedEntity[] {
  const result: ReferencedEntity[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  CITATION_REGEX.lastIndex = 0;
  while ((match = CITATION_REGEX.exec(actionText)) !== null) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);

    const charId = directory.characters.get(name);
    if (charId !== undefined) {
      result.push({ id: charId, kind: "character" });
      continue;
    }
    const itemId = directory.items.get(name);
    if (itemId !== undefined) {
      result.push({ id: itemId, kind: "item" });
      continue;
    }
    const sceneId = directory.scenes.get(name);
    if (sceneId !== undefined) {
      result.push({ id: sceneId, kind: "scene" });
      continue;
    }

    throw new CitationResolutionError(name, actionText);
  }
  return result;
}
```

- [ ] **Step 3: Update `interpretAction` signature to accept directory and emit `referencedEntities`**

Find `interpretAction` (around line 158). Update its signature and body:

```ts
export async function interpretAction(
  input: ActionInput,
  directory: PerceivableDirectory,
  /* ... existing extra params if any ... */
): Promise<{ steps: InterpretedStep[] }> {
  // ... existing LLM call to pick ActionDefinition stays unchanged ...

  const referencedEntities = parseCitations(input.actionText, directory);

  // When emitting each InterpretedStep, attach referencedEntities. If the
  // interpreter produces multiple steps (multi-step chain), all share the
  // same citations from the original actionText.
  return {
    steps: rawSteps.map((step) => ({ ...step, referencedEntities })),
  };
}
```

If `interpretAction` doesn't currently match this exact shape, adapt to fit — the contract is "every step gets `referencedEntities` attached, parsed from `input.actionText` via the supplied directory".

- [ ] **Step 4: Run interpreter tests**

```bash
pnpm test -- src/engine/interpreter/__tests__/gameInterpreter.test.ts
```

The new `parseCitations` tests pass; existing interpreter tests may need updating if they call `interpretAction(input)` without directory (will fail to compile until Task 4 wires call sites — that's OK at this stage since we're committing once at the end).

---

## Task 4: ActionIntake / TickEngine wiring (thin glue, no tests)

Plumb `dgsm` into ActionIntake so it can build the directory at submit time.

**Files:**
- Modify: `src/engine/core/actionIntake.ts`
- Modify: `src/engine/core/tickEngine.ts`

- [ ] **Step 1: Update `ActionIntake` to accept `dgsm` + build directory**

Modify `src/engine/core/actionIntake.ts`:

```ts
import { buildPerceivableDirectory } from "../../state/perceivableDirectory.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { Queue } from "./queue.js";
import type { ActionHandle, ActionInput, ActionStep } from "./types.js";
import type { InterpretedStep } from "../types.js";

interface ActionIntakeDeps {
  queue: Queue;
  dgsm: DynamicGameStateManager;   // ← NEW
  interpretAction: (
    input: ActionInput,
    directory: import("../../state/perceivableDirectory.js").PerceivableDirectory
  ) => Promise<{ steps: InterpretedStep[] }>;
  getActorDex: (characterId: string) => number;
  getNow: () => string;
}

export class ActionIntake {
  constructor(private deps: ActionIntakeDeps) {}

  async submit(input: ActionInput): Promise<ActionHandle> {
    const directory = buildPerceivableDirectory(input.characterId, this.deps.dgsm);
    const { steps } = await this.deps.interpretAction(input, directory);

    // ... existing handle creation + step expansion logic ...
    // Each ActionStep gets step.referencedEntities (default to [] if absent).
    // Replace any prior reference to input.targetCharacterIds with
    // step.referencedEntities ?? [] when constructing ActionStep:
    //
    //   const newStep: ActionStep = {
    //     ...
    //     referencedEntities: step.referencedEntities ?? [],
    //     ...
    //   };
  }
}
```

The implementer must reconcile this with the existing `submit()` body (specifically the lines that construct `ActionStep` from each `InterpretedStep`).

- [ ] **Step 2: Update `createTickEngine` factory to pass `dgsm` to ActionIntake**

In `src/engine/core/tickEngine.ts`, find the `intake = new ActionIntake({ ... })` block (around line 98) and add `dgsm: opts.dgsm`:

```ts
const intake = new ActionIntake({
  queue,
  dgsm: opts.dgsm,                       // ← NEW
  interpretAction: opts.interpretAction,
  getActorDex: opts.getActorDex,
  getNow: () => opts.dgsm.getGameDateTime(),
});
```

- [ ] **Step 3: Update `createTickEngine` opts type**

In `src/engine/core/tickEngine.ts`, find `CreateTickEngineOptions.interpretAction` (around line 69):

```ts
export interface CreateTickEngineOptions {
  // ... existing
  interpretAction: (
    input: ActionInput,
    directory: import("../../state/perceivableDirectory.js").PerceivableDirectory
  ) => Promise<{ steps: import("../types.js").InterpretedStep[] }>;
  // ... existing
}
```

- [ ] **Step 4: Update SimulationRunner's `interpretAction` callback site**

`src/simulation/SimulationRunner.ts` constructs `createTickEngine` with an `interpretAction` callback (around line 520). Update its signature to accept `directory` as the second param and forward to `interpretAction`:

```ts
const engine = createTickEngine({
  // ... existing opts
  interpretAction: (input, directory) =>
    interpretAction(input, directory, /* any other existing args */),
  // ... existing opts
});
```

If the existing call has additional args, preserve them.

---

## Task 5: Renderer simplification (D6 — delete god-eye)

Delete the fallback path; `render()` returns `null` on LLM fail; `llmSucceeded` field removed.

**Files:**
- Delete: `src/roleSim/renderer/godEyeFallback.ts`
- Modify: `src/roleSim/renderer/types.ts`
- Modify: `src/roleSim/renderer/index.ts`
- Modify: `src/roleSim/renderer/llmRenderer.ts`
- Modify: `src/roleSim/__tests__/renderer.test.ts`

- [ ] **Step 1: Delete `src/roleSim/renderer/godEyeFallback.ts`**

```bash
rm src/roleSim/renderer/godEyeFallback.ts
```

- [ ] **Step 2: Drop `llmSucceeded` from `RenderedPerception`**

Update `src/roleSim/renderer/types.ts`:

```ts
export interface RenderedPerception {
  /** Final narrative + reference text fed into the agent prompt. */
  narrative: string;
}
```

- [ ] **Step 3: Simplify `src/roleSim/renderer/index.ts`**

Replace the file contents:

```ts
// src/roleSim/renderer/index.ts
//
// Phase G renderer entry. Single mode: LLM call with built-in retry
// (maxRetries=2 in llmRenderer). On hard failure (LLM rejects, empty output,
// retry exhausted) returns null — caller (NpcActionController) handles by
// skipping that NPC's decide() this tick. No god-eye fallback (D6).

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { renderViaLLM } from "./llmRenderer.js";
import type { PerceivedBundle, RenderedPerception } from "./types.js";

export type { PerceivedBundle, OwnActionState, RenderedPerception } from "./types.js";
export { buildPerceivedBundle } from "./buildBundle.js";

export interface RenderParams {
  npcId: string;
  bundle: PerceivedBundle;
  dgsm: DynamicGameStateManager;
  language?: string;
}

/**
 * Render via LLM. Returns null on hard failure (caller skips decide() that tick).
 * Empty narrative also counts as failure.
 */
export async function render(
  params: RenderParams
): Promise<RenderedPerception | null> {
  try {
    const narrative = await renderViaLLM(params);
    if (narrative.trim().length === 0) {
      console.warn(
        `[renderer] LLM returned empty output for ${params.npcId}; skipping decide() this tick`
      );
      return null;
    }
    return { narrative };
  } catch (err) {
    console.warn(
      `[renderer] LLM call failed for ${params.npcId}; skipping decide() this tick:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
```

Note: `buildGodEyeFallback` and `renderFallback` exports are removed.

- [ ] **Step 4: Strip inlined `isKnownTo` + `descriptionIdentifier` from `llmRenderer.ts`**

In `src/roleSim/renderer/llmRenderer.ts`, find the two helper functions (around line 215–233) and delete them. Replace with import:

```ts
import {
  descriptionIdentifier,
  isKnownTo,
} from "../../state/perceivableDirectory.js";
```

Both `collectOtherEntities` (around line 167) and the inline `descriptionIdentifier` callsite continue to work — the function names don't change.

- [ ] **Step 5: Update `src/roleSim/__tests__/renderer.test.ts`**

Find the test file. Two changes:

(a) Delete tests that exercise the god-eye fallback path. Look for `describe("buildGodEyeFallback ...")`, `describe("render() retry+fallback")`, or any test that asserts `llmSucceeded === false` with non-null narrative — delete these blocks.

(b) Add a new test that verifies `render()` returns `null` on LLM fail:

```ts
import { describe, expect, it, vi } from "vitest";
// ... existing imports

vi.mock("../../models/index.js", () => ({
  ModelClass: { SMALL: "small" },
  generateText: vi.fn(),
}));

import { generateText } from "../../models/index.js";
import { render } from "../renderer/index.js";

describe("render() — D6 null fallback", () => {
  it("returns null when LLM throws after retries", async () => {
    (generateText as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("LLM hard fail")
    );
    const result = await render({
      npcId: "alice",
      bundle: /* your minimal bundle stub */,
      dgsm: /* minimal dgsm stub with getNpcProfile */,
    });
    expect(result).toBeNull();
  });

  it("returns null when LLM returns empty output", async () => {
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValue("");
    const result = await render({
      npcId: "alice",
      bundle: /* minimal bundle */,
      dgsm: /* minimal dgsm */,
    });
    expect(result).toBeNull();
  });

  it("returns RenderedPerception { narrative } on success — no llmSucceeded field", async () => {
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValue(
      "[narrative]\nI walk in.\n\n[references]\n"
    );
    const result = await render({
      npcId: "alice",
      bundle: /* minimal */,
      dgsm: /* minimal */,
    });
    expect(result).toEqual({
      narrative: "[narrative]\nI walk in.\n\n[references]\n",
    });
    // No llmSucceeded property:
    expect(result && "llmSucceeded" in result).toBe(false);
  });
});
```

The implementer fills in `bundle` and `dgsm` minimal stubs by copy-paste from existing successful tests in this file.

---

## Task 6: Agent layer (no new tests; existing tests need update)

Drop `targetCharacterIds` from agent output; rewrite actSkill prompt; add null-render skip in controller.

**Files:**
- Modify: `src/roleSim/agent.ts:13-38`
- Modify: `src/roleSim/llmAgent.ts:95-110`
- Modify: `src/roleSim/toolSkills/actSkill.ts`
- Modify: `src/roleSim/npcActionController.ts:163-170, ~225`

- [ ] **Step 1: Drop `targetCharacterIds` from `RoleSimDecision`**

In `src/roleSim/agent.ts`, find the `act` variant of `RoleSimDecision` (around line 13):

```ts
export type RoleSimDecision =
  | {
      tool: "act";
      actionText: string;
      // targetCharacterIds removed — agent emits citations [Name] in actionText;
      // GameInterpreter resolves them into ActionStep.referencedEntities (Phase H).
    }
  | { tool: "continue"; reason?: string }
  | {
      tool: "writeMemory";
      // ... unchanged
    }
  | {
      tool: "recallMemory";
      // ... unchanged
    }
  | { tool: "getMapSnapshot" };
```

- [ ] **Step 2: Drop `targetCharacterIds` parse branch in `llmAgent.ts`**

In `src/roleSim/llmAgent.ts`, find `buildTerminalDecision` (around line 95):

```ts
private buildTerminalDecision(parsed: {
  tool: string;
  [k: string]: unknown;
}): RoleSimDecision {
  if (parsed.tool === "act") {
    const actionText = String(parsed.actionText ?? "");
    return { tool: "act", actionText };
  }
  return {
    tool: "continue",
    reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
  };
}
```

- [ ] **Step 3: Rewrite `actSkill` prompt with citation syntax + short-action principle**

Replace the entire contents of `src/roleSim/toolSkills/actSkill.ts`:

```ts
// src/roleSim/toolSkills/actSkill.ts

export const actSkill = `---
name: act
description: Take a single short physical action in the world. Terminates this decision (consumes a tick).
---

# act

Take ONE short atomic action: move, speak, examine, attack, hide, work, etc.
This consumes a tick — calling \`act\` ends the current decision.

## Action duration: short atomic only

Each \`act\` is one short action that fits within the next tick (~1 game minute).

Multi-step intentions (e.g. "go to the harbor and find Smith") MUST be broken
into multiple decisions across multiple ticks:

  Tick 1: act "leave through the front door"
  Tick 2: act "head down Lane Street toward [Harbor]"
  Tick 3: act "enter [Harbor]"
  Tick 4: now I see Smith → act "approach [Smith]"

Do NOT submit \`act\` for actions that span multiple minutes (e.g. "search the
warehouse thoroughly", "spend the afternoon reading"). Decompose into shorter
observable actions.

## When to use
- You want to start something new and meaningful
- Something just happened and you want to react with a new action
- Your current action is no longer right (calling \`act\` while in-flight CANCELS it and starts new)
- Idle and you've decided what to do next

## When NOT to use
- Your current action is fine — use \`continue\`
- You just want to "think more" — use \`recallMemory\` or \`writeMemory\` (they don't consume a tick)
- The action is purely internal (forming a belief, planning) — use \`writeMemory\`

## Citation syntax for entity references

When your action involves a specific named entity (person, item, scene), you
MUST wrap its name in square brackets, copying the EXACT name as it appears in
the [references] block of your perception narrative:

  Person  → [Smith]                       (KNOWN: canonical name from references)
  Person  → [the gaunt man]               (UNKNOWN: description identifier from references)
  Item    → [the bound ledger]
  Scene   → [Library], [Harbor]

The engine parses brackets to resolve targets. Names must match the references
block exactly — no abbreviation, no fuzzy matching. Cite only entities that
appear in this tick's references block.

## Output
{ "tool": "act", "actionText": "<one sentence with bracketed citations where applicable>" }

## Examples

You see Smith and want to confront him about a letter:
{ "tool": "act", "actionText": "confront [Smith] about [the letter]" }

You're alone and want to leave (no specific entity referenced):
{ "tool": "act", "actionText": "head out the door" }

You see an unknown person in the room and want to greet them:
{ "tool": "act", "actionText": "greet [the gaunt man]" }

You're in the middle of reading and a fire breaks out — interrupt and flee:
{ "tool": "act", "actionText": "drop the book and run for the exit" }

You hand a letter to Smith:
{ "tool": "act", "actionText": "hand [the bound ledger] to [Smith]" }

You move toward an adjacent scene:
{ "tool": "act", "actionText": "walk into [Harbor]" }
`;
```

- [ ] **Step 4: Drop `targetCharacterIds` passthrough in NpcActionController; add null skip**

Find `src/roleSim/npcActionController.ts:163-170`:

```ts
case "act": {
  const queue = this.engine.getActorQueue(npcId);
  const live = queue.find(
    (s) => s.status === "active" || s.status === "queued"
  );
  if (live) this.engine.cancelAction(live.handle);

  await this.engine.submitAction({
    characterId: npcId,
    actionText: decision.actionText,
    sceneId: this.resolveCurrentSceneId(npcId),
  });
  return;
}
```

(Remove the `targetCharacterIds: decision.targetCharacterIds,` line.)

Then find `buildContext` where `render(...)` is called (around line 223):

```ts
const rendered = await render({
  npcId,
  bundle,
  dgsm: this.dgsm,
  language: this.language,
});

if (rendered === null) {
  // D6: LLM render failed → NPC perceives nothing this tick; skip decide().
  // In-flight action continues. Events for this NPC are dropped (acceptable
  // per Phase H spec: render fail rate << 0.1%).
  return undefined;
}

return {
  npcId,
  currentTime: gameDateTime,
  npcProfile: profile,
  currentScene,
  recentMemory,
  longTermIntent,
  currentAction,
  perception: { narrative: rendered.narrative },
};
```

`buildContext` already returns `RoleSimContext | undefined` and the caller `decide()` handles `undefined` by returning. No further changes needed in `decide()`.

- [ ] **Step 5: Update `npcActionController.tickReport.test.ts`**

In `src/roleSim/__tests__/npcActionController.tickReport.test.ts`:

(a) Replace any assertion that mentions `targetCharacterIds` on action input with `referencedEntities`. For example:

```ts
// BEFORE
expect(submittedActions[0].targetCharacterIds).toEqual(["smith"]);

// AFTER — actionText is now the only target source; verify it
expect(submittedActions[0].actionText).toContain("[Smith]");
// (engine derives referencedEntities downstream; controller-level test
// doesn't assert that — it's an interpreter integration concern)
```

(b) If the test was constructing `RoleSimDecision { tool: "act", actionText, targetCharacterIds: [...] }`, drop the field.

(c) Add a new test for D6 null skip:

```ts
it("skips decide() when render returns null (D6)", async () => {
  // generateText is already mocked at the file level; force null path:
  (generateText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
    new Error("LLM fail")
  );
  await controller.decide("npc1");
  // No submitAction or cancelAction should have been called for this NPC:
  expect(engineSubmitMock).not.toHaveBeenCalled();
  expect(engineCancelMock).not.toHaveBeenCalled();
});
```

The mock variable names depend on this test file's existing setup — adapt to fit.

---

## Task 7: 7 engine internal consumer migrations

Each consumer reads `referencedEntities` instead of `targetCharacterIds`; legacy character-only paths add `.filter(r => r.kind === "character")`.

**Files:**
- Modify: `src/engine/shared/impactPropagation.ts:11-95`
- Modify: `src/engine/tools/skillCheckTool.ts:48-55`
- Modify: `src/engine/shared/skillRoll.ts:11-115`
- Modify: `src/engine/core/scriptedEventRunner.ts:147-164`
- Modify: `src/engine/resolver/stateContextBuilder.ts:1-310`
- Modify: `src/engine/core/tickOrchestrator.ts:240-440`
- Modify: `src/simulation/SimulationEventEmitter.ts:90-110`

- [ ] **Step 1: `impactPropagation.ts` — accept `referencedEntities`, filter to character**

```ts
// src/engine/shared/impactPropagation.ts

import type { ReferencedEntity } from "../core/types.js";

interface ImpactPropagationAction {
  characterId: string;
  referencedEntities?: ReferencedEntity[];  // ← rename from targetCharacterIds
  location: string;
}

// ... inside findAffectedCharacters:

  // Level 1: targeted (character entities only)
  if (impactLevel >= 1 && action.referencedEntities?.length) {
    for (const ref of action.referencedEntities) {
      if (ref.kind === "character") {
        addChar(ref.id, 1);
      }
    }
  }
```

Update the JSDoc comment block (line 5-9) to mention `referencedEntities` instead.

- [ ] **Step 2: `skillCheckTool.ts` — pass through new field**

Find `src/engine/tools/skillCheckTool.ts:48-55`:

```ts
const syntheticNode: SkillRollNode = {
  characterId,
  skill: resolvedSkill,
  difficulty: skillCheckDef?.difficulty ?? "regular",
  referencedEntities: targetIds,            // ← rename
  type:
    skillCheckDef?.type === "opposed" ? "character_interaction" : "action",
};
```

The variable `targetIds` here is upstream; trace back to where it's built. If it's `string[]`, you need to convert to `ReferencedEntity[]` (kind: "character" for each ID), OR change the upstream source to provide `ReferencedEntity[]`. Most likely the immediate caller already has the new field — pass it directly.

- [ ] **Step 3: `skillRoll.ts` — read `referencedEntities`, filter chars**

Find `src/engine/shared/skillRoll.ts:11-15`:

```ts
interface SkillRollNode {
  // ... existing
  referencedEntities?: ReferencedEntity[];  // ← rename from targetCharacterIds
}
```

Find `:112` (combat opposed-roll path):

```ts
const targetIds = (node.referencedEntities ?? [])
  .filter((r) => r.kind === "character")
  .map((r) => r.id);
```

Add the import at top:
```ts
import type { ReferencedEntity } from "../core/types.js";
```

- [ ] **Step 4: `scriptedEventRunner.ts` — char-only `withTargetId` (OQ6 = A)**

Find `:147-164`:

```ts
private matchesAction(a: CharacterAction, m: ActionMatch): boolean {
  if (m.definitionId !== undefined && a.definitionId !== m.definitionId) {
    return false;
  }
  if (m.byNpcId !== undefined && a.characterId !== m.byNpcId) {
    return false;
  }
  if (m.atSceneId !== undefined && a.sceneId !== m.atSceneId) {
    return false;
  }
  if (m.withTargetId !== undefined) {
    // OQ6 = A: char-only semantics. Filter referencedEntities → characters first.
    const charRefIds = a.referencedEntities
      .filter((r) => r.kind === "character")
      .map((r) => r.id);
    if (!charRefIds.includes(m.withTargetId)) return false;
  }
  return true;
}
```

- [ ] **Step 5: `stateContextBuilder.ts` — `targets` domain inject reads chars from refs**

Find the `targets` inject block (around line 295):

```ts
if (spec.inject.includes("targets")) {
  const targetIds = (node.referencedEntities ?? [])
    .filter((r) => r.kind === "character")
    .map((r) => r.id);
  if (targetIds.length > 0) {
    result.targetSections = targetIds
      .map((tid) =>
        buildTargetSection(tid, node.characterId, dgsm, fieldsMap.targets)
      )
      .join("\n\n");
  }
}
```

Update the inferred shape of `node`:

```ts
interface NodeShape {
  // ... existing
  referencedEntities?: ReferencedEntity[];  // ← rename from targetCharacterIds
}
```

(The exact type/interface name in this file may differ — find it and update.)

- [ ] **Step 6: `tickOrchestrator.ts` — `CharacterAction` payload**

Find both sites at `:245` and `:435`:

```ts
const characterAction: CharacterAction = {
  characterId: step.characterId,
  // ... existing
  referencedEntities: step.referencedEntities,   // ← rename
  // ... existing
};
```

- [ ] **Step 7: `SimulationEventEmitter.ts` — primary char target**

Find `:95-103`:

```ts
emitToScene(
  action.completedAt,
  {
    action: action.actionText,
    characterName,
    outcome: outcomeText,
    gameTime: timePart(action.completedAt),
  },
  // OQ6 / Phase H: pick first character ref as primary highlight target
  action.referencedEntities.find((r) => r.kind === "character")?.id
)
```

(Method signature for `emitToScene` may take `string` for the last arg; if the new value is `string | undefined`, ensure the param type accepts undefined or default to `""`.)

---

## Task 8: Final batch verification + single commit

Run all checks; user reviews diff; one commit captures the entire Phase H change.

**Files (verify only):** All of the above.

- [ ] **Step 1: Run full test suite**

```bash
pnpm test
```

Expected: all tests pass. If failures, fix in place. Most likely failures:
- Integration tests in `__tests__/simulation/` using `targetCharacterIds` in fixtures — search-and-replace with `referencedEntities: [{ id: "...", kind: "character" }]`.
- Any test mocking `interpretAction` callback shape — update to two-arg form.

- [ ] **Step 2: Run biome (lint + format)**

```bash
pnpm check
```

Expected: clean. If unsafe lints surface (e.g., `useTemplate`, `noUnusedTemplateLiteral`), fix manually since `pnpm check`'s auto-apply may not handle them.

- [ ] **Step 3: Run TypeScript type-check**

```bash
pnpm build:tsc
```

Expected: clean compile. Errors here usually mean a stale `targetCharacterIds` reference somewhere — grep:

```bash
grep -rn "targetCharacterIds" src/ --include="*.ts"
```

Any remaining hit (outside test fixtures explicitly testing the renaming) is a bug; fix it.

- [ ] **Step 4: Show diff to user; await approval**

```bash
git status
git diff --stat
```

Wait for user approval before committing. **DO NOT auto-commit per `feedback_no_auto_commit.md`.**

- [ ] **Step 5: Single commit (after user approval)**

When user approves:

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(engine): Phase H — agent ↔ engine citation contract

Replace agent-emitted targetCharacterIds with citation-based entity
resolution. Agent writes [Name] brackets in actionText; GameInterpreter
resolves names → IDs against a per-decision PerceivableDirectory; outputs
referencedEntities: { id, kind }[] consumed by 7 engine internal subsystems.

Renderer simplified per first-principles cleanup: god-eye fallback deleted
(violated "subjective perception" mandate). render() returns null on LLM
fail; controller skips that NPC's decide() for the tick.

Spec: docs/superpowers/specs/2026-05-07-agent-engine-citation-contract-design.md
Plan: docs/superpowers/plans/2026-05-07-agent-engine-citation-contract-plan.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Verify final state**

```bash
git status
git log --oneline -3
```

Expected: clean working tree, new commit on top of HEAD.

---

## Self-Review Notes (built-in)

**Spec coverage check:**
- D1 short atomic actions → Task 6 Step 3 (actSkill prompt)
- D2 drop targetCharacterIds from RoleSimDecision/ActionInput → Task 1 + Task 6 Steps 1–2
- D3 [Name] cite syntax → Task 6 Step 3
- D4 interpreter resolves names → Task 3
- D5 referencedEntities format → Task 1 + Task 3
- D6 renderer simplification → Task 5
- D7 (merged into D6) → no separate task
- D8 directory scope → Task 2
- OQ1 reuse stateDomains → no new code (existing pattern; documented in spec)
- OQ2 brackets required + tolerant → Task 3 (parser returns [] when no brackets)
- OQ3 action fail on unresolved → Task 3 (CitationResolutionError)
- OQ4 scene + inventory → Task 2 Step 2
- OQ5 memory keep brackets → no special handling needed (default)
- OQ6 char-only withTargetId → Task 7 Step 4

All spec requirements have implementing tasks.

**Type consistency check:**
- `EntityKind` defined in Task 1, referenced in Tasks 2/3/7 — consistent
- `ReferencedEntity` defined in Task 1, referenced in Tasks 2/3/4/7 — consistent
- `PerceivableDirectory` defined in Task 2, referenced in Tasks 3/4 — consistent
- `referencedEntities` field name consistent across `InterpretedStep` (Task 1), `ActionStep` (Task 1), `CharacterAction` (Task 1), and 7 consumers (Task 7)

**No-placeholder check:** All steps contain actual code or specific commands. No "TBD" / "implement later".

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-07-agent-engine-citation-contract-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task with `superpowers:subagent-driven-development`; per-task spec review only (skip code-quality reviewer per Phase D cadence preference); fast iteration, single commit at end after your approval.

**2. Inline Execution** — Execute tasks in this session via `superpowers:executing-plans`; you watch each task complete; one commit at the end after your review.

Which approach?
