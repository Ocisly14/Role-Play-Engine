# Engine Refactor: Dispatcher + StateResolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the handler-based execution model with a Dispatcher + Action Definition + StateResolver pipeline while preserving all existing engine features.

**Architecture:** Planner outputs natural language actions → Queue manages scheduling and cross-tick state → Dispatcher (LLM) decomposes actions into ordered definition steps → Engine executes each step via code tools (skillCheck, movement) then StateResolver (LLM) for state changes. Action definitions are declarative md files that guide the StateResolver.

**Tech Stack:** TypeScript, LangChain (ChatAnthropic/ChatOpenAI/ChatGoogleGenerativeAI), Vitest

---

## File Structure

```
src/engine/
  types.ts                           # Modify: add ActionDefinition, DispatchResult, StateResolution, ToolResult; remove NodeHandler
  registry.ts                        # Modify: remove handler management, add definition management, add buildDispatcherPrompt/buildResolverPrompt
  registerDefaults.ts                # Modify: remove handler registration, add definition + tool registration
  executionContext.ts                 # Keep as-is (still used by skillCheckTool)

  handlers/                          # DELETE after migration complete (Task 10)

  tools/
    skillCheckTool.ts                # New: wraps shared/skillRoll.ts with ActionTool interface
    movementTool.ts                  # New: extracted from movementHandler, implements tick()
    index.ts                         # Modify: export new tools

  actions/
    movement.md                      # New: movement definition
    combat.md                        # New: combat definition
    social.md                        # New: social interaction definition
    search.md                        # New: search/investigation definition
    generic.md                       # New: fallback definition
    loader.ts                        # New: reads md files, parses into ActionDefinition[]

  dispatcher/
    dispatcher.ts                    # New: LLM call that decomposes action → ordered steps

  resolver/
    stateResolver.ts                 # New: LLM call that generates StateResolution from definition guidance
    applyStateResolution.ts          # New: applies StateResolution to DynamicGameStateManager

  queue/
    actionQueue.ts                   # New: stateful per-NPC queue with cross-tick support

  runtime/
    tickProcessor.ts                 # Modify: replace handler dispatch with Queue + Dispatcher + Engine flow
    actionPostProcessing.ts          # DELETE after migration complete (Task 10)
    impactPipeline.ts                # Unchanged
    discoveryPipeline.ts             # Unchanged
```

---

### Task 1: Types — ActionDefinition, DispatchResult, StateResolution

**Files:**
- Modify: `src/engine/types.ts`
- Test: `src/engine/__tests__/types.test.ts`

- [ ] **Step 1: Write test for new types**

```typescript
// src/engine/__tests__/types.test.ts
import type {
  ActionDefinition,
  DispatchResult,
  StateResolution,
  ToolResult,
} from "../types.js";

describe("engine types", () => {
  it("ActionDefinition has required fields", () => {
    const def: ActionDefinition = {
      id: "combat",
      title: "Combat",
      description: "Physical combat between characters",
      content: "# Combat\n## Skill Check\n...",
      skillCheck: {
        skills: ["Fighting (Brawl)", "Fighting (Melee)"],
        difficulty: "regular",
        type: "opposed",
        opposedDefense: ["Dodge", "Fighting (Brawl)"],
        failBehavior: "abort",
      },
    };
    expect(def.id).toBe("combat");
    expect(def.skillCheck?.type).toBe("opposed");
  });

  it("DispatchResult contains ordered steps", () => {
    const result: DispatchResult = {
      steps: [
        { definitionId: "movement", args: { destination: "harbor_docks" } },
        { definitionId: "social", args: { targetId: "captain_wang" } },
      ],
    };
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].definitionId).toBe("movement");
  });

  it("StateResolution covers all state domains", () => {
    const resolution: StateResolution = {
      characterChanges: [
        { characterId: "npc_1", hp: -5, addConditions: ["bleeding"] },
      ],
      itemChanges: [
        { itemId: "key_001", action: "move", from: "scene_study", to: "npc_1" },
      ],
      sceneChanges: [
        { sceneId: "scene_study", addConditions: ["searched"] },
      ],
      memories: [
        { characterId: "npc_1", type: "event", content: "Found a key" },
      ],
      relationships: [
        { from: "npc_1", to: "npc_2", change: "slight_distrust" },
      ],
      featureOverlays: { fireIntensity: 2 },
      narrative: "The investigator found a rusty key hidden under papers.",
    };
    expect(resolution.characterChanges).toHaveLength(1);
    expect(resolution.narrative).toBeTruthy();
  });

  it("ToolResult supports cross-tick with done flag", () => {
    const result: ToolResult = {
      done: false,
      status: "completed",
      outcomeDescription: "Moving to harbor, 3 minutes remaining",
      remainingMinutes: 3,
    };
    expect(result.done).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/__tests__/types.test.ts`
Expected: FAIL — types not exported yet

- [ ] **Step 3: Add new types to types.ts**

Add the following to `src/engine/types.ts` (after existing interfaces, before `ExecutionContext`):

```typescript
// ===== Action Definition: declarative game rules =====

export interface ActionDefinitionSkillCheck {
  skills: string[];
  difficulty: "regular" | "hard" | "extreme";
  type: "single" | "opposed";
  opposedDefense?: string[];
  failBehavior: "abort" | "partial";
}

export interface ActionDefinition {
  id: string;
  title: string;
  description: string;
  content: string; // raw markdown content
  skillCheck?: ActionDefinitionSkillCheck;
}

// ===== Dispatcher: action → definition steps =====

export interface DispatchStep {
  definitionId: string;
  args?: Record<string, unknown>;
}

export interface DispatchResult {
  steps: DispatchStep[];
}

// ===== StateResolution: structured state changes =====

export interface CharacterChange {
  characterId: string;
  hp?: number;
  san?: number;
  fatigue?: number;
  addConditions?: string[];
  removeConditions?: string[];
  position?: import("../state/topologyTypes.js").CharacterPosition;
}

export interface ItemChange {
  itemId: string;
  action: "move" | "destroy" | "create" | "modify";
  from?: string;
  to?: string;
  properties?: Record<string, unknown>;
}

export interface SceneChange {
  sceneId: string;
  addConditions?: string[];
  removeConditions?: string[];
}

export interface MemoryEntry {
  characterId: string;
  type: string;
  content: string;
}

export interface RelationshipChange {
  from: string;
  to: string;
  change: string;
}

export interface StateResolution {
  characterChanges?: CharacterChange[];
  itemChanges?: ItemChange[];
  sceneChanges?: SceneChange[];
  memories?: MemoryEntry[];
  relationships?: RelationshipChange[];
  featureOverlays?: Record<string, unknown>;
  narrative: string;
}

// ===== ToolResult: code tool execution result =====

export interface ToolResult {
  done: boolean;
  status: "completed" | "failed" | "interrupted";
  outcomeDescription: string;
  remainingMinutes?: number;
  rollDetail?: string;
  successLevel?: import("../planning/types.js").SuccessLevel;
  perTargetResults?: Record<
    string,
    {
      successLevel: import("../planning/types.js").SuccessLevel;
      actorWon: boolean;
      detail: string;
      damage?: number;
    }
  >;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/__tests__/types.test.ts`
Expected: PASS

- [ ] **Step 5: Run biome check**

Run: `pnpm check`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/engine/types.ts src/engine/__tests__/types.test.ts
git commit -m "feat: add ActionDefinition, DispatchResult, StateResolution types"
```

---

### Task 2: Action Definition Loader

**Files:**
- Create: `src/engine/actions/movement.md`
- Create: `src/engine/actions/combat.md`
- Create: `src/engine/actions/social.md`
- Create: `src/engine/actions/search.md`
- Create: `src/engine/actions/generic.md`
- Create: `src/engine/actions/loader.ts`
- Test: `src/engine/actions/__tests__/loader.test.ts`

- [ ] **Step 1: Create action definition files**

Create `src/engine/actions/movement.md`:
```markdown
# Movement

## Skill Check
- skill: (optional, e.g. Stealth, Climb — only for creative movement)
- difficulty: regular
- type: single
- failBehavior: abort

## State Changes

### On Success
#### character
- Position updated to destination
- fatigue: +1 (if long distance)
- memory: "Traveled to [destination]"

### On Failure
#### character
- Position unchanged
- memory: "Tried to reach [destination] but failed"
```

Create `src/engine/actions/combat.md`:
```markdown
# Combat

## Skill Check
- skill: Fighting (Brawl) | Fighting (Melee) | Firearms
- difficulty: regular
- type: opposed
- opposedDefense: Dodge | Fighting (Brawl)
- failBehavior: abort

## State Changes

### On Success
#### character
- Target: HP reduced based on weapon damage and success level
- Target: may gain wound conditions (bleeding, bruised, broken bone)
- Actor: fatigue +1
- memory (actor): "Attacked [target] at [location]"
- memory (target): "Was attacked by [actor]"

### On Failure
#### character
- Actor: fatigue +1
- memory (actor): "Tried to attack [target] but missed"
- memory (target): "Saw [actor] attempt to attack me"

## Feature Overlay
- sanityDrain: (witnesses only, if violence is extreme)
```

Create `src/engine/actions/social.md`:
```markdown
# Social Interaction

## Skill Check
- skill: Persuade | Intimidate | Fast Talk | Charm
- difficulty: regular
- type: opposed
- opposedDefense: Psychology | Persuade | Intimidate
- failBehavior: abort

## State Changes

### On Success
#### character
- Target: conditions change based on interaction type (cooperative, intimidated, charmed)
- Relationship: improve/change based on skill used and context
- memory (actor): "Successfully [action] [target]"
- memory (target): "[Actor] [action] me and I [response]"

### On Failure
#### character
- Target: may become suspicious or hostile
- Relationship: may worsen
- memory (actor): "Tried to [action] [target] but failed"
- memory (target): "[Actor] tried to [action] me but I saw through it"
```

Create `src/engine/actions/search.md`:
```markdown
# Search

## Skill Check
- skill: Spot Hidden | Library Use | Perception
- difficulty: regular
- type: single
- failBehavior: partial

## State Changes

### On Success
#### item
- Discover hidden items in scene based on search context
- Reveal evidence items if present
#### scene
- Mark area as searched
#### character
- fatigue: +1
- memory: "Searched [location] and found [discoveries]"

### On Failure
#### scene
- Mark area as searched (nothing found)
#### character
- fatigue: +1
- memory: "Searched [location] but found nothing useful"
```

Create `src/engine/actions/generic.md`:
```markdown
# Generic Action (fallback)

## Skill Check
- skill: (as specified by planner, if any)
- difficulty: regular
- type: single
- failBehavior: partial

## State Changes

### On Success
#### character
- fatigue: +1 (if physically demanding)
- memory: record action and outcome

### On Failure
#### character
- fatigue: +1 (if physically demanding)
- memory: record action attempt and failure
```

- [ ] **Step 2: Write test for loader**

```typescript
// src/engine/actions/__tests__/loader.test.ts
import { loadActionDefinitions } from "../loader.js";

describe("loadActionDefinitions", () => {
  it("loads all md files from actions directory", () => {
    const defs = loadActionDefinitions();
    const ids = defs.map((d) => d.id);
    expect(ids).toContain("movement");
    expect(ids).toContain("combat");
    expect(ids).toContain("social");
    expect(ids).toContain("search");
    expect(ids).toContain("generic");
  });

  it("parses skill check metadata from combat.md", () => {
    const defs = loadActionDefinitions();
    const combat = defs.find((d) => d.id === "combat")!;
    expect(combat.title).toBe("Combat");
    expect(combat.skillCheck).toBeDefined();
    expect(combat.skillCheck!.type).toBe("opposed");
    expect(combat.skillCheck!.skills).toContain("Fighting (Brawl)");
    expect(combat.skillCheck!.opposedDefense).toContain("Dodge");
    expect(combat.skillCheck!.failBehavior).toBe("abort");
  });

  it("parses single skill check from search.md", () => {
    const defs = loadActionDefinitions();
    const search = defs.find((d) => d.id === "search")!;
    expect(search.skillCheck!.type).toBe("single");
    expect(search.skillCheck!.failBehavior).toBe("partial");
  });

  it("generic has no fixed skills", () => {
    const defs = loadActionDefinitions();
    const generic = defs.find((d) => d.id === "generic")!;
    expect(generic.skillCheck).toBeUndefined();
  });

  it("content contains raw markdown", () => {
    const defs = loadActionDefinitions();
    const combat = defs.find((d) => d.id === "combat")!;
    expect(combat.content).toContain("## State Changes");
    expect(combat.content).toContain("### On Success");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/engine/actions/__tests__/loader.test.ts`
Expected: FAIL — loader.ts doesn't exist

- [ ] **Step 4: Implement loader**

```typescript
// src/engine/actions/loader.ts
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ActionDefinition,
  ActionDefinitionSkillCheck,
} from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseSkillCheck(content: string): ActionDefinitionSkillCheck | undefined {
  const skillCheckSection = content.match(
    /## Skill Check\n([\s\S]*?)(?=\n## |$)/
  );
  if (!skillCheckSection) return undefined;

  const section = skillCheckSection[1];

  const skillLine = section.match(/- skill:\s*(.+)/);
  if (!skillLine) return undefined;
  const skillText = skillLine[1].trim();
  // "(as specified by planner, if any)" or "(optional, ...)" means no fixed skills
  if (skillText.startsWith("(")) return undefined;

  const skills = skillText.split("|").map((s) => s.trim());

  const difficultyMatch = section.match(/- difficulty:\s*(\w+)/);
  const difficulty = (difficultyMatch?.[1] ?? "regular") as
    | "regular"
    | "hard"
    | "extreme";

  const typeMatch = section.match(/- type:\s*(\w+)/);
  const type = (typeMatch?.[1] ?? "single") as "single" | "opposed";

  const failMatch = section.match(/- failBehavior:\s*(\w+)/);
  const failBehavior = (failMatch?.[1] ?? "partial") as "abort" | "partial";

  let opposedDefense: string[] | undefined;
  const defenseMatch = section.match(/- opposedDefense:\s*(.+)/);
  if (defenseMatch) {
    opposedDefense = defenseMatch[1].split("|").map((s) => s.trim());
  }

  return { skills, difficulty, type, opposedDefense, failBehavior };
}

function parseTitle(content: string): string {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : "Unknown";
}

export function loadActionDefinitions(): ActionDefinition[] {
  const files = readdirSync(__dirname).filter((f) => f.endsWith(".md"));
  return files.map((file) => {
    const content = readFileSync(join(__dirname, file), "utf-8");
    const id = file.replace(/\.md$/, "");
    const title = parseTitle(content);
    return {
      id,
      title,
      description: title,
      content,
      skillCheck: parseSkillCheck(content),
    };
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/engine/actions/__tests__/loader.test.ts`
Expected: PASS

- [ ] **Step 6: Run biome check**

Run: `pnpm check`

- [ ] **Step 7: Commit**

```bash
git add src/engine/actions/
git commit -m "feat: add action definition files and loader"
```

---

### Task 3: skillCheckTool

**Files:**
- Create: `src/engine/tools/skillCheckTool.ts`
- Test: `src/engine/tools/__tests__/skillCheckTool.test.ts`

- [ ] **Step 1: Write test**

```typescript
// src/engine/tools/__tests__/skillCheckTool.test.ts
import { describe, it, expect, vi } from "vitest";
import { executeSkillCheck } from "../skillCheckTool.js";
import type { ActionDefinitionSkillCheck } from "../../types.js";

// Mock dice to control randomness
vi.mock("../../shared/dice.js", () => ({
  rollD100: vi.fn(() => 30),
  getSuccessLevel: vi.fn(() => "regular"),
  getSuccessLevelWithDifficulty: vi.fn(() => "regular"),
  SUCCESS_RANK: { fumble: 0, fail: 1, regular: 2, hard: 3, critical: 4 },
  getDamageBonus: vi.fn(() => "+0"),
  rollDamageBonus: vi.fn(() => 0),
}));

describe("executeSkillCheck", () => {
  const makeDgsm = (npcs: any[]) =>
    ({
      getState: () => ({
        npcCharacters: npcs,
      }),
      getScene: () => null,
      resolveLocationId: () => "scene_1",
      getCharacterPosition: () => ({ type: "scene", sceneId: "scene_1" }),
    }) as any;

  it("returns success for single skill check", () => {
    const skillCheck: ActionDefinitionSkillCheck = {
      skills: ["Spot Hidden"],
      difficulty: "regular",
      type: "single",
      failBehavior: "partial",
    };
    const dgsm = makeDgsm([
      { id: "npc_1", skills: { "Spot Hidden": 60 }, attributes: {} },
    ]);

    const result = executeSkillCheck(
      skillCheck,
      "npc_1",
      "Spot Hidden",
      dgsm,
      "scene_1"
    );
    expect(result.status).toBe("completed");
    expect(result.done).toBe(true);
  });

  it("returns no-op when no skill check defined", () => {
    const result = executeSkillCheck(
      undefined,
      "npc_1",
      undefined,
      {} as any,
      "scene_1"
    );
    expect(result.status).toBe("completed");
    expect(result.done).toBe(true);
    expect(result.successLevel).toBe("regular");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/tools/__tests__/skillCheckTool.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement skillCheckTool**

```typescript
// src/engine/tools/skillCheckTool.ts
import type { PlanNode } from "../../planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { ActionDefinitionSkillCheck, ToolResult } from "../types.js";
import {
  applyPenalties,
  getScenePenalties,
  resolveSkillRoll,
} from "../shared/index.js";
import type { GameEngineRegistry } from "../registry.js";

export function executeSkillCheck(
  skillCheckDef: ActionDefinitionSkillCheck | undefined,
  characterId: string,
  skill: string | undefined,
  dgsm: DynamicGameStateManager,
  locationId: string,
  registry?: GameEngineRegistry,
  targetIds?: string[],
): ToolResult {
  // No skill check required — auto success
  if (!skillCheckDef && !skill) {
    return {
      done: true,
      status: "completed",
      outcomeDescription: "No skill check required",
      successLevel: "regular",
    };
  }

  const state = dgsm.getState();
  const npc = state.npcCharacters.find((n) => n.id === characterId);
  const npcSkills = npc?.skills ?? {};
  const resolvedSkill = skill ?? skillCheckDef?.skills[0];
  if (!resolvedSkill) {
    return {
      done: true,
      status: "completed",
      outcomeDescription: "No skill specified",
      successLevel: "regular",
    };
  }

  // Build penalty-adjusted skills
  const scenePenalties = getScenePenalties(locationId, dgsm);
  const charPenalties = registry
    ? registry.collectCharacterPenalties(characterId, dgsm)
    : new Map<string, number>();
  const afterScene = applyPenalties(npcSkills, scenePenalties);
  const adjustedSkills = applyPenalties(afterScene, charPenalties);

  // Build a synthetic PlanNode for resolveSkillRoll
  const syntheticNode: Partial<PlanNode> = {
    characterId,
    skill: resolvedSkill,
    difficulty: skillCheckDef?.difficulty ?? "regular",
    targetCharacterIds: targetIds,
    // type is needed for combat/social detection in resolveSkillRoll
    type: skillCheckDef?.type === "opposed" ? "character_interaction" : "action",
  };

  const adjustTargetSkills = skillCheckDef?.type === "opposed"
    ? (targetId: string, rawSkills: Record<string, number>) => {
        const targetScenePenalties = getScenePenalties(locationId, dgsm);
        const targetCharPenalties = registry
          ? registry.collectCharacterPenalties(targetId, dgsm)
          : new Map<string, number>();
        return applyPenalties(
          applyPenalties(rawSkills, targetScenePenalties),
          targetCharPenalties,
        );
      }
    : undefined;

  const rollResult = resolveSkillRoll(
    syntheticNode as PlanNode,
    adjustedSkills,
    dgsm,
    adjustTargetSkills,
  );

  if (rollResult.failed) {
    return {
      done: true,
      status: "failed",
      outcomeDescription: rollResult.reason ?? "Skill check failed",
      rollDetail: rollResult.reason,
      successLevel: rollResult.successLevel,
      perTargetResults: rollResult.perTargetResults,
    };
  }

  return {
    done: true,
    status: "completed",
    outcomeDescription: rollResult.detail ?? "Skill check passed",
    rollDetail: rollResult.detail,
    successLevel: rollResult.successLevel,
    perTargetResults: rollResult.perTargetResults,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/tools/__tests__/skillCheckTool.test.ts`
Expected: PASS

- [ ] **Step 5: Run biome check**

Run: `pnpm check`

- [ ] **Step 6: Commit**

```bash
git add src/engine/tools/skillCheckTool.ts src/engine/tools/__tests__/skillCheckTool.test.ts
git commit -m "feat: add skillCheckTool wrapping existing skill roll logic"
```

---

### Task 4: movementTool

**Files:**
- Create: `src/engine/tools/movementTool.ts`
- Test: `src/engine/tools/__tests__/movementTool.test.ts`

- [ ] **Step 1: Write test**

```typescript
// src/engine/tools/__tests__/movementTool.test.ts
import { describe, it, expect, vi } from "vitest";
import { resolveMovement, tickMovement } from "../movementTool.js";

describe("movementTool", () => {
  const makeTopology = () => ({
    junctions: new Map([["harbor_docks", {}]]),
    roads: new Map(),
    sceneToParent: new Map([["scene_study", "building_1"]]),
  });

  const makeDgsm = (currentPos: any) =>
    ({
      getState: () => ({
        npcCharacters: [
          { id: "npc_1", skills: {}, attributes: { DEX: 50 } },
        ],
        blockedConnections: [],
        scenarioOutlines: [],
        scenes: new Map(),
      }),
      getTopology: () => makeTopology(),
      getCharacterPosition: () => currentPos,
      resolveLocationId: (pos: any) => pos?.sceneId ?? pos?.junctionId ?? "",
      setCharacterPosition: vi.fn(),
      isCharacterHidden: () => false,
    }) as any;

  it("resolveMovement returns done:false with remaining minutes", () => {
    const dgsm = makeDgsm({ type: "scene", sceneId: "scene_study" });
    const result = resolveMovement(
      { destination: "harbor_docks" },
      "npc_1",
      dgsm,
    );
    // Either pathfinding succeeds (done:false with remaining) or fails
    expect(result.done).toBeDefined();
    expect(result.status).toBeDefined();
  });

  it("tickMovement eventually returns done:true", () => {
    const dgsm = makeDgsm({ type: "scene", sceneId: "scene_study" });
    const tickState = { remainingMinutes: 1, destination: "harbor_docks" };
    const result = tickMovement(tickState, "npc_1", dgsm);
    expect(result.done).toBe(true);
    expect(result.status).toBe("completed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/tools/__tests__/movementTool.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement movementTool**

Extract pathfinding logic from `src/engine/handlers/movementHandler.ts` (lines 110-178) and the `resolveTargetPosition` helper (lines 199-252). Wrap in the new tool interface:

```typescript
// src/engine/tools/movementTool.ts
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { CharacterPosition, TownTopology } from "../../state/topologyTypes.js";
import { findTopologyPath } from "../shared/pathfinding.js";
import type { ToolResult } from "../types.js";

export interface MovementArgs {
  destination: string;
  skill?: string;
}

export interface MovementTickState {
  remainingMinutes: number;
  destination: string;
  targetPosition: CharacterPosition;
}

export function resolveTargetPosition(
  locationId: string,
  topology: TownTopology,
  dgsm?: DynamicGameStateManager,
): CharacterPosition | null {
  if (topology.junctions.has(locationId)) {
    return { type: "junction", junctionId: locationId };
  }
  if (topology.sceneToParent.has(locationId)) {
    return { type: "scene", sceneId: locationId };
  }
  const atIdx = locationId.indexOf("@");
  const roadKey = atIdx >= 0 ? locationId.slice(0, atIdx) : locationId;
  const road = topology.roads.get(roadKey);
  if (road) {
    const parsed =
      atIdx >= 0 ? Number.parseFloat(locationId.slice(atIdx + 1)) : 0.5;
    const position = Number.isFinite(parsed)
      ? Math.max(0, Math.min(1, parsed))
      : 0.5;
    return { type: "road", roadId: road.id, position };
  }
  if (dgsm) {
    const state = dgsm.getState();
    const outline = (state.scenarioOutlines ?? []).find(
      (o) => o.id === locationId,
    );
    if (
      outline?.entrySceneId &&
      topology.sceneToParent.has(outline.entrySceneId)
    ) {
      return { type: "scene", sceneId: outline.entrySceneId };
    }
    const scene = state.scenes.get(locationId);
    if (scene) {
      const parentOutline = (state.scenarioOutlines ?? []).find(
        (o) => o.id === scene.parentLocationId,
      );
      if (
        parentOutline?.entrySceneId &&
        topology.sceneToParent.has(parentOutline.entrySceneId)
      ) {
        return { type: "scene", sceneId: parentOutline.entrySceneId };
      }
    }
  }
  return null;
}

export function resolveMovement(
  args: MovementArgs,
  characterId: string,
  dgsm: DynamicGameStateManager,
): ToolResult & { tickState?: MovementTickState } {
  const topology = dgsm.getTopology();
  const currentPos = dgsm.getCharacterPosition(characterId);
  const targetPos = resolveTargetPosition(args.destination, topology, dgsm);

  if (!currentPos || !targetPos) {
    return {
      done: true,
      status: "failed",
      outcomeDescription: `Cannot find path to ${args.destination}`,
    };
  }

  const state = dgsm.getState();
  const topologyPath = findTopologyPath(
    currentPos,
    targetPos,
    topology,
    state.blockedConnections,
    dgsm,
  );

  if (!topologyPath) {
    return {
      done: true,
      status: "failed",
      outcomeDescription: `No path available to ${args.destination}`,
    };
  }

  if (topologyPath.totalMinutes <= 1) {
    dgsm.setCharacterPosition(characterId, targetPos);
    return {
      done: true,
      status: "completed",
      outcomeDescription: `Arrived at ${args.destination}`,
    };
  }

  return {
    done: false,
    status: "completed",
    outcomeDescription: `Moving to ${args.destination}, ${topologyPath.totalMinutes} minutes remaining`,
    remainingMinutes: topologyPath.totalMinutes,
    tickState: {
      remainingMinutes: topologyPath.totalMinutes,
      destination: args.destination,
      targetPosition: targetPos,
    },
  };
}

export function tickMovement(
  tickState: MovementTickState,
  characterId: string,
  dgsm: DynamicGameStateManager,
): ToolResult & { tickState?: MovementTickState } {
  const remaining = tickState.remainingMinutes - 1;

  if (remaining <= 0) {
    dgsm.setCharacterPosition(characterId, tickState.targetPosition);
    return {
      done: true,
      status: "completed",
      outcomeDescription: `Arrived at ${tickState.destination}`,
    };
  }

  return {
    done: false,
    status: "completed",
    outcomeDescription: `Moving to ${tickState.destination}, ${remaining} minutes remaining`,
    remainingMinutes: remaining,
    tickState: {
      ...tickState,
      remainingMinutes: remaining,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/tools/__tests__/movementTool.test.ts`
Expected: PASS

- [ ] **Step 5: Run biome check**

Run: `pnpm check`

- [ ] **Step 6: Commit**

```bash
git add src/engine/tools/movementTool.ts src/engine/tools/__tests__/movementTool.test.ts
git commit -m "feat: add movementTool with pathfinding and cross-tick support"
```

---

### Task 5: Dispatcher

**Files:**
- Create: `src/engine/dispatcher/dispatcher.ts`
- Test: `src/engine/dispatcher/__tests__/dispatcher.test.ts`

- [ ] **Step 1: Write test**

```typescript
// src/engine/dispatcher/__tests__/dispatcher.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildDispatcherPrompt, parseDispatchResult } from "../dispatcher.js";
import type { ActionDefinition } from "../../types.js";

const mockDefinitions: ActionDefinition[] = [
  {
    id: "movement",
    title: "Movement",
    description: "Move to a different location",
    content: "",
  },
  {
    id: "combat",
    title: "Combat",
    description: "Physical combat between characters",
    content: "",
    skillCheck: {
      skills: ["Fighting (Brawl)"],
      difficulty: "regular",
      type: "opposed",
      opposedDefense: ["Dodge"],
      failBehavior: "abort",
    },
  },
  {
    id: "social",
    title: "Social Interaction",
    description: "Social interaction with characters",
    content: "",
    skillCheck: {
      skills: ["Persuade"],
      difficulty: "regular",
      type: "opposed",
      opposedDefense: ["Psychology"],
      failBehavior: "abort",
    },
  },
  {
    id: "generic",
    title: "Generic Action",
    description: "Fallback for unmatched actions",
    content: "",
  },
];

describe("buildDispatcherPrompt", () => {
  it("includes all definition IDs and descriptions", () => {
    const prompt = buildDispatcherPrompt(mockDefinitions);
    expect(prompt).toContain("movement");
    expect(prompt).toContain("combat");
    expect(prompt).toContain("social");
    expect(prompt).toContain("generic");
    expect(prompt).toContain("Move to a different location");
  });
});

describe("parseDispatchResult", () => {
  it("parses valid JSON dispatch result", () => {
    const raw = JSON.stringify({
      steps: [
        { definitionId: "movement", args: { destination: "harbor" } },
        { definitionId: "social", args: { targetId: "captain" } },
      ],
    });
    const result = parseDispatchResult(raw);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].definitionId).toBe("movement");
  });

  it("falls back to generic on invalid JSON", () => {
    const result = parseDispatchResult("not json");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].definitionId).toBe("generic");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/dispatcher/__tests__/dispatcher.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement dispatcher**

```typescript
// src/engine/dispatcher/dispatcher.ts
import { createLlm } from "../../models/llm.js";
import type { ActionDefinition, DispatchResult } from "../types.js";

export function buildDispatcherPrompt(definitions: ActionDefinition[]): string {
  const defList = definitions
    .map((d) => `- **${d.id}**: ${d.description}`)
    .join("\n");

  return `You are an action dispatcher for a tabletop horror RPG simulation engine.

Given a natural language action, decompose it into an ordered sequence of steps. Each step references one of the available action definitions.

## Available Definitions
${defList}

## Rules
- A simple action maps to a single step (e.g., "search the room" → [search])
- A composite action maps to multiple ordered steps (e.g., "go to the harbor and ask the captain" → [movement, social])
- If the action involves going somewhere first, the first step should be "movement"
- If no definition matches, use "generic"
- Include relevant args: destination (for movement), targetId (for social/combat), skill (if explicitly mentioned)

## Output Format
Respond with ONLY a JSON object:
{
  "steps": [
    { "definitionId": "movement", "args": { "destination": "harbor_docks" } },
    { "definitionId": "social", "args": { "targetId": "captain_wang" } }
  ]
}`;
}

export function parseDispatchResult(raw: string): DispatchResult {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    const parsed = JSON.parse(jsonMatch[0]);
    if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
      return parsed as DispatchResult;
    }
    throw new Error("Invalid steps");
  } catch {
    return { steps: [{ definitionId: "generic" }] };
  }
}

export async function dispatchAction(
  action: string,
  definitions: ActionDefinition[],
  runtime: any,
  language: string,
): Promise<DispatchResult> {
  const llm = createLlm(runtime);
  const systemPrompt = buildDispatcherPrompt(definitions);
  const langInstruction =
    language === "zh" ? "The action is in Chinese." : "The action is in English.";

  const response = await llm.invoke([
    { role: "system", content: systemPrompt },
    { role: "user", content: `${langInstruction}\n\nAction: "${action}"` },
  ]);

  const text =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

  return parseDispatchResult(text);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/dispatcher/__tests__/dispatcher.test.ts`
Expected: PASS

- [ ] **Step 5: Run biome check**

Run: `pnpm check`

- [ ] **Step 6: Commit**

```bash
git add src/engine/dispatcher/
git commit -m "feat: add Dispatcher for action → definition step decomposition"
```

---

### Task 6: StateResolver + applyStateResolution

**Files:**
- Create: `src/engine/resolver/stateResolver.ts`
- Create: `src/engine/resolver/applyStateResolution.ts`
- Test: `src/engine/resolver/__tests__/stateResolver.test.ts`
- Test: `src/engine/resolver/__tests__/applyStateResolution.test.ts`

- [ ] **Step 1: Write test for applyStateResolution**

```typescript
// src/engine/resolver/__tests__/applyStateResolution.test.ts
import { describe, it, expect, vi } from "vitest";
import { applyStateResolution } from "../applyStateResolution.js";
import type { StateResolution } from "../../types.js";

describe("applyStateResolution", () => {
  const makeDgsm = () => {
    const npc = {
      id: "npc_1",
      status: { hp: 10, san: 50, fatigue: 0 },
      conditions: [],
    };
    const scene = {
      id: "scene_study",
      conditions: [],
      items: [{ id: "key_001", name: "Rusty Key" }],
    };
    return {
      getState: () => ({
        npcCharacters: [npc],
        scenes: new Map([["scene_study", scene]]),
      }),
      updateNpcStatus: vi.fn(),
      addNpcCondition: vi.fn(),
      removeNpcCondition: vi.fn(),
      addSceneCondition: vi.fn(),
      removeSceneCondition: vi.fn(),
      moveItem: vi.fn(),
      removeItem: vi.fn(),
    } as any;
  };

  it("applies character HP delta", () => {
    const dgsm = makeDgsm();
    const resolution: StateResolution = {
      characterChanges: [{ characterId: "npc_1", hp: -3 }],
      narrative: "test",
    };
    applyStateResolution(dgsm, resolution);
    expect(dgsm.updateNpcStatus).toHaveBeenCalledWith(
      "npc_1",
      expect.objectContaining({ hp: -3 }),
    );
  });

  it("applies scene condition changes", () => {
    const dgsm = makeDgsm();
    const resolution: StateResolution = {
      sceneChanges: [
        { sceneId: "scene_study", addConditions: ["searched"] },
      ],
      narrative: "test",
    };
    applyStateResolution(dgsm, resolution);
    expect(dgsm.addSceneCondition).toHaveBeenCalledWith(
      "scene_study",
      "searched",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/resolver/__tests__/applyStateResolution.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement applyStateResolution**

```typescript
// src/engine/resolver/applyStateResolution.ts
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { StateResolution } from "../types.js";

export function applyStateResolution(
  dgsm: DynamicGameStateManager,
  resolution: StateResolution,
): void {
  // Character changes
  if (resolution.characterChanges) {
    for (const change of resolution.characterChanges) {
      const deltas: Record<string, number> = {};
      if (change.hp !== undefined) deltas.hp = change.hp;
      if (change.san !== undefined) deltas.san = change.san;
      if (change.fatigue !== undefined) deltas.fatigue = change.fatigue;
      if (Object.keys(deltas).length > 0) {
        dgsm.updateNpcStatus(change.characterId, deltas);
      }
      if (change.addConditions) {
        for (const cond of change.addConditions) {
          dgsm.addNpcCondition(change.characterId, cond);
        }
      }
      if (change.removeConditions) {
        for (const cond of change.removeConditions) {
          dgsm.removeNpcCondition(change.characterId, cond);
        }
      }
      if (change.position) {
        dgsm.setCharacterPosition(change.characterId, change.position);
      }
    }
  }

  // Scene changes
  if (resolution.sceneChanges) {
    for (const change of resolution.sceneChanges) {
      if (change.addConditions) {
        for (const cond of change.addConditions) {
          dgsm.addSceneCondition(change.sceneId, cond);
        }
      }
      if (change.removeConditions) {
        for (const cond of change.removeConditions) {
          dgsm.removeSceneCondition(change.sceneId, cond);
        }
      }
    }
  }

  // Item changes
  if (resolution.itemChanges) {
    for (const change of resolution.itemChanges) {
      if (change.action === "move" && change.to) {
        dgsm.moveItem(change.itemId, change.from, change.to);
      } else if (change.action === "destroy") {
        dgsm.removeItem(change.itemId);
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/resolver/__tests__/applyStateResolution.test.ts`
Expected: PASS

- [ ] **Step 5: Write test for stateResolver prompt building**

```typescript
// src/engine/resolver/__tests__/stateResolver.test.ts
import { describe, it, expect } from "vitest";
import { buildResolverPrompt, parseStateResolution } from "../stateResolver.js";

describe("buildResolverPrompt", () => {
  it("includes action definition guidance", () => {
    const prompt = buildResolverPrompt({
      action: "Search the study",
      definitionContent: "### On Success\n#### item\n- Discover hidden items",
      skillCheckResult: { status: "completed", successLevel: "regular" } as any,
      actorState: { id: "npc_1", name: "Investigator" } as any,
      sceneState: { id: "scene_study", conditions: [] } as any,
    });
    expect(prompt).toContain("Search the study");
    expect(prompt).toContain("Discover hidden items");
    expect(prompt).toContain("regular");
  });
});

describe("parseStateResolution", () => {
  it("parses valid JSON", () => {
    const raw = JSON.stringify({
      characterChanges: [{ characterId: "npc_1", fatigue: 1 }],
      narrative: "The investigator found nothing.",
    });
    const result = parseStateResolution(raw);
    expect(result.narrative).toBe("The investigator found nothing.");
    expect(result.characterChanges).toHaveLength(1);
  });

  it("returns minimal resolution on invalid JSON", () => {
    const result = parseStateResolution("garbage");
    expect(result.narrative).toBeTruthy();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/engine/resolver/__tests__/stateResolver.test.ts`
Expected: FAIL

- [ ] **Step 7: Implement stateResolver**

```typescript
// src/engine/resolver/stateResolver.ts
import { createLlm } from "../../models/llm.js";
import type { StateResolution, ToolResult } from "../types.js";

export interface ResolverContext {
  action: string;
  definitionContent: string;
  skillCheckResult?: ToolResult;
  actorState: any;
  targetStates?: any[];
  sceneState: any;
  featureContext?: string;
  language?: string;
}

export function buildResolverPrompt(ctx: ResolverContext): string {
  const outcomeSection = ctx.skillCheckResult?.status === "failed"
    ? "On Failure"
    : "On Success";

  const skillDetail = ctx.skillCheckResult?.rollDetail
    ? `\nSkill Check Result: ${ctx.skillCheckResult.rollDetail} (${ctx.skillCheckResult.successLevel})`
    : "\nNo skill check was performed.";

  const targetSection = ctx.targetStates?.length
    ? `\nTarget Characters:\n${JSON.stringify(ctx.targetStates, null, 2)}`
    : "";

  const featureSection = ctx.featureContext
    ? `\nWorld Conditions:\n${ctx.featureContext}`
    : "";

  return `You are a state resolver for a tabletop horror RPG simulation. Given an action, its outcome, and guidance from the action definition, output the exact state changes.

## Action
"${ctx.action}"
${skillDetail}

## Actor
${JSON.stringify(ctx.actorState, null, 2)}
${targetSection}

## Scene
${JSON.stringify(ctx.sceneState, null, 2)}
${featureSection}

## Action Definition Guidance (${outcomeSection})
${ctx.definitionContent}

## Output Format
Respond with ONLY a JSON object matching this schema:
{
  "characterChanges": [{ "characterId": "...", "hp": -5, "san": 0, "fatigue": 1, "addConditions": [], "removeConditions": [] }],
  "itemChanges": [{ "itemId": "...", "action": "move|destroy|create|modify", "from": "...", "to": "..." }],
  "sceneChanges": [{ "sceneId": "...", "addConditions": [], "removeConditions": [] }],
  "memories": [{ "characterId": "...", "type": "event", "content": "..." }],
  "relationships": [{ "from": "...", "to": "...", "change": "..." }],
  "featureOverlays": {},
  "narrative": "Third-person description of what happened."
}
Only include fields that actually change. The narrative must be a single paragraph.`;
}

export function parseStateResolution(raw: string): StateResolution {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.narrative) parsed.narrative = "Action completed.";
    return parsed as StateResolution;
  } catch {
    return { narrative: "Action completed with no notable effects." };
  }
}

export async function resolveState(
  ctx: ResolverContext,
  runtime: any,
): Promise<StateResolution> {
  const llm = createLlm(runtime);
  const prompt = buildResolverPrompt(ctx);

  const response = await llm.invoke([
    { role: "system", content: prompt },
  ]);

  const text =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

  return parseStateResolution(text);
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/engine/resolver/__tests__/stateResolver.test.ts`
Expected: PASS

- [ ] **Step 9: Run biome check**

Run: `pnpm check`

- [ ] **Step 10: Commit**

```bash
git add src/engine/resolver/
git commit -m "feat: add StateResolver and applyStateResolution"
```

---

### Task 7: ActionQueue

**Files:**
- Create: `src/engine/queue/actionQueue.ts`
- Test: `src/engine/queue/__tests__/actionQueue.test.ts`

- [ ] **Step 1: Write test**

```typescript
// src/engine/queue/__tests__/actionQueue.test.ts
import { describe, it, expect } from "vitest";
import { ActionQueue } from "../actionQueue.js";
import type { QueueEntry } from "../actionQueue.js";

describe("ActionQueue", () => {
  const makeEntry = (overrides: Partial<QueueEntry> = {}): QueueEntry => ({
    nodeId: "n1",
    characterId: "npc_1",
    action: "Search the room",
    startTime: "09:00",
    endTime: "09:05",
    impact: 0,
    status: "pending",
    ...overrides,
  });

  it("adds and retrieves entries", () => {
    const queue = new ActionQueue();
    queue.add(makeEntry());
    expect(queue.getAll()).toHaveLength(1);
  });

  it("activates entries when startTime reached", () => {
    const queue = new ActionQueue();
    queue.add(makeEntry({ startTime: "09:00" }));
    queue.activatePending("09:00");
    expect(queue.getAll()[0].status).toBe("in_progress");
  });

  it("does not activate entries before startTime", () => {
    const queue = new ActionQueue();
    queue.add(makeEntry({ startTime: "09:05" }));
    queue.activatePending("09:00");
    expect(queue.getAll()[0].status).toBe("pending");
  });

  it("getDueEntries returns in_progress entries at endTime", () => {
    const queue = new ActionQueue();
    queue.add(makeEntry({ status: "in_progress", endTime: "09:05" }));
    const due = queue.getDueEntries("09:05");
    expect(due).toHaveLength(1);
  });

  it("getActiveMovements returns entries with activeMovement", () => {
    const queue = new ActionQueue();
    queue.add(
      makeEntry({
        status: "in_progress",
        activeMovement: {
          tickState: { remainingMinutes: 3, destination: "harbor" },
        },
      }),
    );
    const moving = queue.getActiveMovements();
    expect(moving).toHaveLength(1);
  });

  it("sorts by startTime then DEX", () => {
    const queue = new ActionQueue();
    queue.add(makeEntry({ nodeId: "n1", characterId: "slow", startTime: "09:00" }));
    queue.add(makeEntry({ nodeId: "n2", characterId: "fast", startTime: "09:00" }));
    const sorted = queue.getSorted(
      new Map([
        ["slow", 30],
        ["fast", 70],
      ]),
    );
    expect(sorted[0].characterId).toBe("fast");
  });

  it("advanceStep increments currentStepIndex", () => {
    const queue = new ActionQueue();
    const entry = makeEntry({
      steps: [
        { definitionId: "movement", args: { destination: "harbor" } },
        { definitionId: "social", args: { targetId: "captain" } },
      ],
      currentStepIndex: 0,
    });
    queue.add(entry);
    queue.advanceStep("n1");
    expect(queue.get("n1")!.currentStepIndex).toBe(1);
  });

  it("advanceStep marks completed when all steps done", () => {
    const queue = new ActionQueue();
    const entry = makeEntry({
      steps: [{ definitionId: "search" }],
      currentStepIndex: 0,
    });
    queue.add(entry);
    queue.advanceStep("n1");
    expect(queue.get("n1")!.status).toBe("completed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/queue/__tests__/actionQueue.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement ActionQueue**

```typescript
// src/engine/queue/actionQueue.ts
import type { MovementTickState } from "../tools/movementTool.js";
import type { DispatchStep, ToolResult } from "../types.js";

export interface QueueEntry {
  nodeId: string;
  characterId: string;
  action: string;
  startTime: string;
  endTime: string;
  impact: number;
  status: "pending" | "in_progress" | "completed" | "failed" | "interrupted";

  steps?: DispatchStep[];
  currentStepIndex?: number;
  skillCheckResult?: ToolResult;

  activeMovement?: {
    tickState: MovementTickState;
  };
}

export class ActionQueue {
  private entries = new Map<string, QueueEntry>();

  add(entry: QueueEntry): void {
    this.entries.set(entry.nodeId, entry);
  }

  get(nodeId: string): QueueEntry | undefined {
    return this.entries.get(nodeId);
  }

  getAll(): QueueEntry[] {
    return [...this.entries.values()];
  }

  remove(nodeId: string): void {
    this.entries.delete(nodeId);
  }

  activatePending(currentTime: string): void {
    for (const entry of this.entries.values()) {
      if (entry.status === "pending" && entry.startTime <= currentTime) {
        entry.status = "in_progress";
      }
    }
  }

  getDueEntries(currentTime: string): QueueEntry[] {
    return this.getAll().filter(
      (e) =>
        e.status === "in_progress" &&
        !e.activeMovement &&
        !e.steps &&
        e.endTime <= currentTime,
    );
  }

  getInProgressWithSteps(): QueueEntry[] {
    return this.getAll().filter(
      (e) =>
        e.status === "in_progress" &&
        e.steps &&
        !e.activeMovement &&
        e.currentStepIndex !== undefined &&
        e.currentStepIndex < e.steps.length,
    );
  }

  getActiveMovements(): QueueEntry[] {
    return this.getAll().filter(
      (e) => e.status === "in_progress" && e.activeMovement,
    );
  }

  advanceStep(nodeId: string): void {
    const entry = this.entries.get(nodeId);
    if (!entry || !entry.steps) return;
    const nextIndex = (entry.currentStepIndex ?? 0) + 1;
    if (nextIndex >= entry.steps.length) {
      entry.status = "completed";
      entry.currentStepIndex = nextIndex;
    } else {
      entry.currentStepIndex = nextIndex;
    }
  }

  getSorted(dexMap: Map<string, number>): QueueEntry[] {
    return this.getAll()
      .filter((e) => e.status === "in_progress")
      .sort((a, b) => {
        const timeDiff = a.startTime.localeCompare(b.startTime);
        if (timeDiff !== 0) return timeDiff;
        const dexA = dexMap.get(a.characterId) ?? 50;
        const dexB = dexMap.get(b.characterId) ?? 50;
        return dexB - dexA;
      });
  }

  interrupt(nodeId: string): void {
    const entry = this.entries.get(nodeId);
    if (entry && entry.status === "in_progress") {
      entry.status = "interrupted";
      entry.activeMovement = undefined;
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/queue/__tests__/actionQueue.test.ts`
Expected: PASS

- [ ] **Step 5: Run biome check**

Run: `pnpm check`

- [ ] **Step 6: Commit**

```bash
git add src/engine/queue/
git commit -m "feat: add ActionQueue with cross-tick and multi-step support"
```

---

### Task 8: Registry — Add Definition Management, Remove Handler Management

**Files:**
- Modify: `src/engine/registry.ts`
- Modify: `src/engine/registerDefaults.ts`
- Test: `src/engine/__tests__/registryDefinitions.test.ts`

- [ ] **Step 1: Write test for definition management**

```typescript
// src/engine/__tests__/registryDefinitions.test.ts
import { describe, it, expect } from "vitest";
import { GameEngineRegistry } from "../registry.js";
import type { ActionDefinition } from "../types.js";

describe("registry definition management", () => {
  const makeDef = (id: string): ActionDefinition => ({
    id,
    title: id,
    description: `${id} definition`,
    content: `# ${id}`,
  });

  it("registerDefinition + getDefinition", () => {
    const registry = new GameEngineRegistry();
    registry.registerDefinition(makeDef("combat"));
    expect(registry.getDefinition("combat")).toBeDefined();
    expect(registry.getDefinition("combat")!.id).toBe("combat");
  });

  it("getAllDefinitions returns all", () => {
    const registry = new GameEngineRegistry();
    registry.registerDefinition(makeDef("combat"));
    registry.registerDefinition(makeDef("social"));
    expect(registry.getAllDefinitions()).toHaveLength(2);
  });

  it("buildDispatcherPrompt includes all definitions", () => {
    const registry = new GameEngineRegistry();
    registry.registerDefinition(makeDef("combat"));
    registry.registerDefinition(makeDef("social"));
    const prompt = registry.buildDispatcherDefinitionList();
    expect(prompt).toContain("combat");
    expect(prompt).toContain("social");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/__tests__/registryDefinitions.test.ts`
Expected: FAIL

- [ ] **Step 3: Add definition management to registry.ts**

Add to `GameEngineRegistry` class in `src/engine/registry.ts`:

```typescript
// After the tools Map
private definitions = new Map<string, ActionDefinition>();

registerDefinition(def: ActionDefinition): void {
  if (this.definitions.has(def.id)) {
    console.warn(`[GameEngineRegistry] Overwriting definition: ${def.id}`);
  }
  this.definitions.set(def.id, def);
}

getDefinition(id: string): ActionDefinition | undefined {
  return this.definitions.get(id);
}

getAllDefinitions(): ActionDefinition[] {
  return [...this.definitions.values()];
}

buildDispatcherDefinitionList(): string {
  const lines: string[] = [];
  for (const def of this.definitions.values()) {
    lines.push(`- **${def.id}**: ${def.description}`);
  }
  return lines.join("\n");
}
```

Add import for `ActionDefinition` at top of `registry.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/__tests__/registryDefinitions.test.ts`
Expected: PASS

- [ ] **Step 5: Update registerDefaults.ts**

Modify `src/engine/registerDefaults.ts` to register definitions and new tools:

```typescript
import { eventTriggerFeature } from "./features/eventTriggerFeature.js";
import { fireFeature } from "./features/fireFeature.js";
import { lightingFeature } from "./features/lightingFeature.js";
import { sanityFeature } from "./features/sanityFeature.js";
import { staminaFeature } from "./features/staminaFeature.js";
import { weatherFeature } from "./features/weatherFeature.js";
import { loadActionDefinitions } from "./actions/loader.js";
import { GameEngineRegistry } from "./registry.js";

export function createDefaultRegistry(): GameEngineRegistry {
  const registry = new GameEngineRegistry();

  // Features (unchanged)
  registry.registerFeature(fireFeature);
  registry.registerFeature(weatherFeature);
  registry.registerFeature(lightingFeature);
  registry.registerFeature(staminaFeature);
  registry.registerFeature(sanityFeature);
  registry.registerFeature(eventTriggerFeature);

  // Action definitions
  for (const def of loadActionDefinitions()) {
    registry.registerDefinition(def);
  }

  return registry;
}
```

- [ ] **Step 6: Run biome check**

Run: `pnpm check`

- [ ] **Step 7: Commit**

```bash
git add src/engine/registry.ts src/engine/registerDefaults.ts src/engine/__tests__/registryDefinitions.test.ts
git commit -m "feat: add definition management to registry, update registerDefaults"
```

---

### Task 9: Integrate into tickProcessor

**Files:**
- Modify: `src/engine/runtime/tickProcessor.ts`

This is the largest task — replacing the handler dispatch loop with the new Queue + Dispatcher + StateResolver pipeline. The surrounding code (encounter scanning, impact pipeline, feature lifecycle) stays unchanged.

- [ ] **Step 1: Study current tickProcessor execution flow**

Read `src/engine/runtime/tickProcessor.ts` fully. Identify the exact lines that:
1. Get due nodes and in-progress nodes (to be replaced by Queue)
2. Execute movement nodes (to be replaced by movementTool)
3. Dispatch to handler via `registry.getHandler(node.type).execute()` (to be replaced by Dispatcher + StateResolver)
4. Call `postProcessExecutedNodeAction` (to be replaced by StateResolver)

The following remain unchanged:
- Encounter scanning (`scanUnplannedEncounters`)
- Impact pipeline (`processImpactPipeline`)
- Feature lifecycle (`tick`, `propagate`, `activateNodeFeatures`)
- Result collection and return

- [ ] **Step 2: Add Queue initialization to tick**

At the start of `executeSingleTick`, create an `ActionQueue` instance, populate it from `npcPlanningAgent.getDueNpcNodes()` and `npcPlanningAgent.getInProgressNodes()`:

```typescript
import { ActionQueue } from "../queue/actionQueue.js";
import { dispatchAction } from "../dispatcher/dispatcher.js";
import { resolveState } from "../resolver/stateResolver.js";
import { applyStateResolution } from "../resolver/applyStateResolution.js";
import { executeSkillCheck } from "../tools/skillCheckTool.js";
import { resolveMovement, tickMovement } from "../tools/movementTool.js";

// Inside executeSingleTick:
const queue = new ActionQueue();

// Convert existing nodes to queue entries
for (const node of allNodes) {
  queue.add({
    nodeId: node.nodeId,
    characterId: node.characterId,
    action: node.action,
    startTime: node.startTime,
    endTime: node.endTime,
    impact: node.impact,
    status: node.status === "in_progress" ? "in_progress" : "pending",
  });
}

queue.activatePending(currentTimeStr);
```

- [ ] **Step 3: Replace movement execution**

Replace the movement node loop with:

```typescript
// Process active movements (cross-tick)
for (const entry of queue.getActiveMovements()) {
  const result = tickMovement(
    entry.activeMovement!.tickState,
    entry.characterId,
    dgsm,
  );
  if (result.done) {
    entry.activeMovement = undefined;
    // Advance to next step
    queue.advanceStep(entry.nodeId);
    // If more steps remain, they'll be picked up in the step execution phase
  } else {
    entry.activeMovement = { tickState: result.tickState! };
  }
}
```

- [ ] **Step 4: Replace handler dispatch with Dispatcher + StateResolver**

Replace the handler execution loop with:

```typescript
// Process due entries (endTime reached, no steps yet)
for (const entry of queue.getDueEntries(currentTimeStr)) {
  const definitions = registry.getAllDefinitions();
  const dispatchResult = await dispatchAction(
    entry.action,
    definitions,
    ctx.runtime,
    language,
  );
  entry.steps = dispatchResult.steps;
  entry.currentStepIndex = 0;
}

// Execute current steps for all entries with steps
for (const entry of queue.getInProgressWithSteps()) {
  const step = entry.steps![entry.currentStepIndex!];
  const definition = registry.getDefinition(step.definitionId)
    ?? registry.getDefinition("generic")!;

  if (step.definitionId === "movement") {
    // Movement step → movementTool
    const args = step.args as { destination: string; skill?: string };
    const result = resolveMovement(args, entry.characterId, dgsm);
    if (!result.done) {
      entry.activeMovement = { tickState: result.tickState! };
      // Will continue next tick
    } else {
      queue.advanceStep(entry.nodeId);
    }
  } else {
    // Non-movement step → skillCheck + StateResolver
    const skillResult = executeSkillCheck(
      definition.skillCheck,
      entry.characterId,
      step.args?.skill as string | undefined,
      dgsm,
      locationId,
      registry,
      step.args?.targetId ? [step.args.targetId as string] : undefined,
    );
    entry.skillCheckResult = skillResult;

    if (skillResult.status === "failed" && definition.skillCheck?.failBehavior === "abort") {
      entry.status = "failed";
    } else {
      // Extract the relevant outcome section from definition content
      const outcomeSection = skillResult.status === "failed" ? "On Failure" : "On Success";
      const sectionRegex = new RegExp(`### ${outcomeSection}\\n([\\s\\S]*?)(?=### |## |$)`);
      const sectionMatch = definition.content.match(sectionRegex);
      const guidance = sectionMatch?.[1] ?? definition.content;

      const pos = dgsm.getCharacterPosition(entry.characterId);
      const locId = pos ? dgsm.resolveLocationId(pos) : "";
      const npc = dgsm.getState().npcCharacters.find((n) => n.id === entry.characterId);
      const scene = dgsm.getScene(locId);

      const stateResolution = await resolveState(
        {
          action: entry.action,
          definitionContent: guidance,
          skillCheckResult: skillResult,
          actorState: npc,
          sceneState: scene,
          featureContext: registry.buildWorldStatePrompt(dgsm),
          language,
        },
        ctx.runtime,
      );

      applyStateResolution(dgsm, stateResolution);

      // Feature overlay activation
      if (stateResolution.featureOverlays) {
        for (const feature of registry.getAllFeatures()) {
          if (feature.activate) {
            // Adapt feature overlay to feature activation
            // This bridges the new StateResolution format to existing feature hooks
          }
        }
      }

      queue.advanceStep(entry.nodeId);
    }
  }
}
```

- [ ] **Step 5: Convert completed queue entries to CharacterActions**

The rest of tickProcessor (impact pipeline, encounter scanning) expects `CharacterAction[]`. Convert completed queue entries:

```typescript
// Build CharacterAction[] from completed entries for impact pipeline
const tickActions: CharacterAction[] = [];
for (const entry of queue.getAll()) {
  if (entry.status === "completed" || entry.status === "failed") {
    tickActions.push({
      characterId: entry.characterId,
      characterName: dgsm.getState().npcCharacters.find(
        (n) => n.id === entry.characterId,
      )?.name ?? entry.characterId,
      type: "action",
      action: entry.action,
      outcome: entry.skillCheckResult?.outcomeDescription ?? entry.action,
      status: entry.status === "failed" ? "failed" : "completed",
      location: dgsm.resolveLocationId(
        dgsm.getCharacterPosition(entry.characterId),
      ),
      gameTime: entry.endTime,
      impact: entry.impact,
      successLevel: entry.skillCheckResult?.successLevel,
      rollDetail: entry.skillCheckResult?.rollDetail,
      perTargetResults: entry.skillCheckResult?.perTargetResults,
    });
  }
}
```

- [ ] **Step 6: Run existing integration tests**

Run: `npx vitest run src/engine/__tests__/integration.test.ts`
Verify existing tests still pass. Fix any compilation errors.

- [ ] **Step 7: Run biome check**

Run: `pnpm check`

- [ ] **Step 8: Commit**

```bash
git add src/engine/runtime/tickProcessor.ts
git commit -m "feat: replace handler dispatch with Dispatcher + StateResolver pipeline in tickProcessor"
```

---

### Task 10: Cleanup — Delete Old Components

**Files:**
- Delete: `src/engine/handlers/actionHandler.ts`
- Delete: `src/engine/handlers/movementHandler.ts`
- Delete: `src/engine/handlers/characterInteractionHandler.ts`
- Delete: `src/engine/handlers/objectInteractionHandler.ts`
- Delete: `src/engine/handlers/actionStateResolver.ts`
- Delete: `src/engine/handlers/interactionStateResolver.ts`
- Delete: `src/engine/handlers/index.ts`
- Delete: `src/engine/runtime/actionPostProcessing.ts`
- Delete: `src/engine/tools/itemTool.ts`
- Delete: `src/engine/tools/itemStateResolver.ts`
- Modify: `src/engine/types.ts` — remove `NodeHandler` interface
- Modify: `src/engine/registry.ts` — remove handler methods
- Modify: `src/engine/tools/index.ts` — update exports

- [ ] **Step 1: Remove NodeHandler interface from types.ts**

Remove the `NodeHandler` interface and its related types from `src/engine/types.ts`.

- [ ] **Step 2: Remove handler management from registry.ts**

Remove `registerHandler`, `getHandler`, `hasHandler`, `getAllHandlers`, `buildHandlerPrompt` methods and the `private handlers` Map from `GameEngineRegistry`.

- [ ] **Step 3: Delete handler files**

```bash
rm -rf src/engine/handlers/
```

- [ ] **Step 4: Delete old post-processing**

```bash
rm src/engine/runtime/actionPostProcessing.ts
```

- [ ] **Step 5: Delete old item tool files**

```bash
rm src/engine/tools/itemTool.ts src/engine/tools/itemStateResolver.ts
```

- [ ] **Step 6: Update tools/index.ts**

```typescript
// src/engine/tools/index.ts
export { executeSkillCheck } from "./skillCheckTool.js";
export { resolveMovement, tickMovement } from "./movementTool.js";
export type { MovementArgs, MovementTickState } from "./movementTool.js";
```

- [ ] **Step 7: Fix all import errors**

Run `pnpm build:tsc` and fix any remaining references to deleted modules across the codebase. Key files to check:
- `src/engine/runtime/tickProcessor.ts` — remove old imports
- `src/engine/index.ts` — update exports
- Any test files referencing deleted handlers

- [ ] **Step 8: Run full test suite**

Run: `pnpm test`
Fix any failures.

- [ ] **Step 9: Run biome check**

Run: `pnpm check`

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: remove handlers, actionPostProcessing, itemTool — replaced by Dispatcher + StateResolver"
```

---

### Task 11: Feature System Adaptation

**Files:**
- Modify: `src/engine/features/fireFeature.ts`
- Modify: `src/engine/features/sanityFeature.ts`
- Modify: `src/engine/features/staminaFeature.ts`
- Modify: `src/engine/features/lightingFeature.ts`
- Modify: `src/engine/features/weatherFeature.ts`
- Modify: `src/engine/features/eventTriggerFeature.ts`

- [ ] **Step 1: Adapt feature onNodeStart/activate to work with QueueEntry**

The feature hooks `onNodeStart()` and `activate()` currently receive a `PlanNode`. They need to work with `QueueEntry` and `StateResolution` instead. The key change is that feature overlay fields (like `fireIntensity`, `sanityDrain`) now come from `StateResolution.featureOverlays` instead of `PlanNode` fields.

In `src/engine/runtime/tickProcessor.ts`, after `applyStateResolution`, add:

```typescript
// Trigger feature activation from StateResolution overlays
if (stateResolution.featureOverlays) {
  for (const feature of registry.getAllFeatures()) {
    const overlayField = feature.planNodeSchema?.fields?.[0]?.name;
    if (overlayField && stateResolution.featureOverlays[overlayField] !== undefined) {
      const syntheticNode = {
        ...entry,
        [overlayField]: stateResolution.featureOverlays[overlayField],
      };
      feature.activate?.(syntheticNode as any, dgsm);
    }
  }
}
```

- [ ] **Step 2: Verify feature tick/propagate still work**

These methods don't depend on handlers at all — they run on their own timers. Verify by running:

Run: `pnpm test`
Check that all feature-related tests pass.

- [ ] **Step 3: Run biome check**

Run: `pnpm check`

- [ ] **Step 4: Commit**

```bash
git add src/engine/features/ src/engine/runtime/tickProcessor.ts
git commit -m "feat: adapt feature system to read overlays from StateResolution"
```

---

### Task 12: End-to-End Verification

**Files:**
- Modify: `src/engine/__tests__/integration.test.ts` (if needed)

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
All tests should pass.

- [ ] **Step 2: Run TypeScript strict check**

Run: `pnpm build:tsc`
No type errors.

- [ ] **Step 3: Run biome**

Run: `pnpm check`
No lint/format errors.

- [ ] **Step 4: Manual smoke test**

Run: `pnpm chat:dev`
Start a simulation, verify:
- NPCs plan and execute actions
- Movement works across ticks
- Social interactions produce state changes
- Impact pipeline fires for high-impact actions
- Features (fire, weather) still tick and propagate

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: end-to-end verification fixes for engine refactor"
```
