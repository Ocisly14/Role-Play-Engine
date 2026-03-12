# Simulation with Injected Characters Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the NPC autonomous simulation system so players can inject custom AI-controlled characters, observe their autonomous behavior, and pause to adjust their intents.

**Architecture:** Injected characters are stored as `DynamicNPCProfile` entries with `isPlayerInjected: true` in the existing `npcCharacters` array. Player intents are written directly to the `npcLongTermIntent` Prisma table. `SimulationRunner` gains character injection/removal methods and extended `resume()` that calls `reviseSchedule` for modified characters. Four new REST endpoints handle character CRUD.

**Tech Stack:** TypeScript, Prisma, Express, Vitest

**Spec:** `docs/superpowers/specs/2026-03-12-simulation-with-injected-characters-design.md`

**Hard Prerequisite:** The base simulation plan (`docs/superpowers/plans/2026-03-11-npc-autonomous-simulation.md`) Chunks 1–6 must be implemented first. This plan only covers the **additive** character injection features.

---

## File Structure

```
New files:
  src/dynamicworldagent/simulation/characterInjection.ts    # injectCharacter, removeCharacter, state init helpers
  client/server/simulation/characterController.ts           # Character CRUD request handlers
  __tests__/simulation/characterInjection.test.ts           # Unit tests for injection/removal

Modified files:
  src/dynamicworldagent/world_builder/types.ts:80            # Add isPlayerInjected to DynamicNPCProfile
  src/dynamicworldagent/simulation/SimulationRunner.ts       # Add character + intent methods, extend resume()
  client/server/simulation/routes.ts                         # Add character endpoints with auth
  client/server/simulation/service.ts                        # Wire character operations to runner
```

---

## Chunk 1: Type Extension + Character Injection Logic

### Task 1: Add `isPlayerInjected` to DynamicNPCProfile

**Files:**
- Modify: `src/dynamicworldagent/world_builder/types.ts:79`

- [ ] **Step 1: Add field to interface**

In `src/dynamicworldagent/world_builder/types.ts`, before the closing brace of `DynamicNPCProfile` (line 80), add:

```typescript
  isPlayerInjected?: boolean; // true = player-created character in simulation mode
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: Clean build. Existing code is unaffected since the field is optional.

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/world_builder/types.ts
git commit -m "feat(simulation): add isPlayerInjected flag to DynamicNPCProfile"
```

---

### Task 2: Create characterInjection module

**Files:**
- Create: `src/dynamicworldagent/simulation/characterInjection.ts`

This module contains pure functions for injecting/removing characters from DynamicGameState. Separated from SimulationRunner for testability.

- [ ] **Step 1: Create the module**

```typescript
// src/dynamicworldagent/simulation/characterInjection.ts

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { DynamicNPCProfile } from "../world_builder/types.js";

/**
 * Build a complete DynamicNPCProfile from player-provided partial input.
 * Auto-sets: id, isNPC, isPlayerInjected, status, inventory, knowledge, relationships.
 */
export function buildInjectedProfile(
  input: {
    name: string;
    attributes: DynamicNPCProfile["attributes"];
    skills: Record<string, number>;
    backstory: string;
    residence: string;
    personality?: string;
    occupation?: string;
    age?: number;
    gender?: string;
  }
): DynamicNPCProfile {
  const id = randomUUID();
  const hp = Math.floor((input.attributes.CON + input.attributes.SIZ) / 10);
  const san = input.attributes.POW;

  return {
    id,
    name: input.name,
    attributes: input.attributes,
    status: { hp, maxHp: hp, sanity: san, maxSanity: 99, luck: input.attributes.luck ?? 50, conditions: [] },
    inventory: [],
    skills: input.skills,
    backstory: input.backstory,
    residence: input.residence,
    personality: input.personality,
    occupation: input.occupation,
    age: input.age,
    gender: input.gender,
    isNPC: true,
    isPlayerInjected: true,
    knowledge: [],
    relationships: [],
  };
}

/**
 * Inject a character into DynamicGameState via manager methods.
 * Does NOT handle Prisma writes or schedule generation — caller does that.
 *
 * NOTE: DynamicGameStateManager.getState() returns Readonly<DynamicGameState>.
 * State mutations must go through manager methods. Since the manager doesn't
 * have an addNpcCharacter method yet, we use updateNpcs() for the character
 * array and direct state access for the Record<> maps (shallow Readonly allows
 * nested property mutation). If the manager gains dedicated setters later,
 * migrate to those.
 */
export function injectCharacterIntoState(
  dgsm: DynamicGameStateManager,
  profile: DynamicNPCProfile,
  entrySceneId: string
): void {
  // Add to npcCharacters via updateNpcs (merges into array)
  dgsm.updateNpcs([profile]);

  // Initialize all per-NPC state maps via manager methods where available
  dgsm.setNpcLocation(profile.id, entrySceneId);
  dgsm.setCharacterPosition(profile.id, { type: "scene", sceneId: entrySceneId });

  // For maps without dedicated setters, access state directly
  // (shallow Readonly allows nested property writes)
  const state = dgsm.getState();
  (state.npcStats as Record<string, { hp: number; san: number }>)[profile.id] = {
    hp: profile.status.hp,
    san: profile.status.sanity,
  };
  (state.npcResidences as Record<string, string>)[profile.id] = profile.residence!;
  (state.npcInventories as Record<string, unknown[]>)[profile.id] = [];
  (state.npcDiscoveredKnowledge as Record<string, string[]>)[profile.id] = [];
  (state.npcRelationshipGraph as Record<string, Record<string, unknown>>)[profile.id] = {};
}

/**
 * Remove an injected character from DynamicGameState.
 * Also cleans up Prisma records.
 */
export async function removeCharacterFromState(
  dgsm: DynamicGameStateManager,
  prisma: PrismaClient,
  sessionId: string,
  characterId: string
): Promise<void> {
  const state = dgsm.getState();

  // Remove from npcCharacters array — use updateNpcs with filtered list
  const filtered = state.npcCharacters.filter((npc) => npc.id !== characterId);
  // updateNpcs merges, so we need direct state access for removal
  (state as { npcCharacters: typeof filtered }).npcCharacters = filtered;

  // Clean up all per-NPC state maps
  delete (state.npcLocations as Record<string, unknown>)[characterId];
  delete (state.npcStats as Record<string, unknown>)[characterId];
  delete (state.npcResidences as Record<string, unknown>)[characterId];
  delete (state.npcInventories as Record<string, unknown>)[characterId];
  delete (state.npcDiscoveredKnowledge as Record<string, unknown>)[characterId];
  delete (state.characterPositions as Record<string, unknown>)[characterId];

  // Bidirectional relationship cleanup
  const graph = state.npcRelationshipGraph as Record<string, Record<string, unknown>>;
  delete graph[characterId];
  for (const npcId of Object.keys(graph)) {
    delete graph[npcId][characterId];
  }

  // Prisma cleanup
  await Promise.all([
    prisma.npcLongTermIntent.deleteMany({
      where: { sessionId, npcId: characterId },
    }),
    prisma.npcDailyPlan.deleteMany({
      where: { sessionId, npcId: characterId },
    }),
    prisma.npcMemory.deleteMany({
      where: { sessionId, npcId: characterId },
    }),
  ]);
}

/**
 * Resolve a macro location (scenarioOutline.id) to its entry scene ID.
 * Returns null if the macro location is not found.
 */
export function resolveEntryScene(
  dgsm: DynamicGameStateManager,
  macroLocationId: string
): string | null {
  const state = dgsm.getState();
  const outline = state.scenarioOutlines.find(
    (s) => s.id === macroLocationId
  );
  return outline?.entrySceneId ?? null;
}

/**
 * Upsert a long-term intent for an injected character.
 * Uses the deterministic ID convention: `${sessionId}_${characterId}`.
 */
export async function upsertIntent(
  prisma: PrismaClient,
  sessionId: string,
  moduleId: string,
  characterId: string,
  characterName: string,
  intent: string
): Promise<void> {
  const id = `${sessionId}_${characterId}`;
  await prisma.npcLongTermIntent.upsert({
    where: { id },
    update: { intent },
    create: {
      id,
      sessionId,
      moduleId,
      npcId: characterId,
      npcName: characterName,
      intent,
    },
  });
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/simulation/characterInjection.ts
git commit -m "feat(simulation): add character injection/removal helpers"
```

---

### Task 3: Unit tests for characterInjection

**Files:**
- Create: `__tests__/simulation/characterInjection.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// __tests__/simulation/characterInjection.test.ts

import { describe, it, expect } from "vitest";
import {
  buildInjectedProfile,
} from "../../src/dynamicworldagent/simulation/characterInjection.js";

describe("buildInjectedProfile", () => {
  const baseInput = {
    name: "Alice",
    attributes: {
      STR: 50, CON: 60, SIZ: 70, DEX: 55,
      APP: 65, INT: 75, POW: 80, EDU: 70, luck: 50,
    },
    skills: { "Library Use": 60, "Spot Hidden": 45 },
    backstory: "A curious journalist",
    residence: "MACRO_HOTEL",
  };

  it("should generate a UUID id", () => {
    const profile = buildInjectedProfile(baseInput);
    expect(profile.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("should set isNPC and isPlayerInjected flags", () => {
    const profile = buildInjectedProfile(baseInput);
    expect(profile.isNPC).toBe(true);
    expect(profile.isPlayerInjected).toBe(true);
  });

  it("should derive HP from (CON + SIZ) / 10", () => {
    const profile = buildInjectedProfile(baseInput);
    // (60 + 70) / 10 = 13
    expect(profile.status.hp).toBe(13);
    expect(profile.status.maxHp).toBe(13);
  });

  it("should derive SAN from POW", () => {
    const profile = buildInjectedProfile(baseInput);
    expect(profile.status.sanity).toBe(80);
  });

  it("should include luck and conditions in status", () => {
    const profile = buildInjectedProfile(baseInput);
    expect(profile.status.luck).toBe(50);
    expect(profile.status.conditions).toEqual([]);
  });

  it("should initialize empty arrays for knowledge, relationships, inventory", () => {
    const profile = buildInjectedProfile(baseInput);
    expect(profile.knowledge).toEqual([]);
    expect(profile.relationships).toEqual([]);
    expect(profile.inventory).toEqual([]);
  });

  it("should pass through optional fields", () => {
    const profile = buildInjectedProfile({
      ...baseInput,
      personality: "Brave and reckless",
      occupation: "Journalist",
      age: 28,
      gender: "Female",
    });
    expect(profile.personality).toBe("Brave and reckless");
    expect(profile.occupation).toBe("Journalist");
    expect(profile.age).toBe(28);
    expect(profile.gender).toBe("Female");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test -- __tests__/simulation/characterInjection.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add __tests__/simulation/characterInjection.test.ts
git commit -m "test(simulation): add characterInjection unit tests"
```

---

## Chunk 2: SimulationRunner Extensions

### Task 4: Add character management methods to SimulationRunner

**Files:**
- Modify: `src/dynamicworldagent/simulation/SimulationRunner.ts`

This task assumes the base `SimulationRunner` from the simulation plan is already implemented.

- [ ] **Step 1: Add imports and private fields**

At the top of `SimulationRunner.ts`, add imports:

```typescript
import {
  injectCharacterIntoState,
  removeCharacterFromState,
  resolveEntryScene,
  upsertIntent,
} from "./characterInjection.js";
import type { DynamicNPCProfile } from "../world_builder/types.js";
```

In the class body, add private fields:

```typescript
  private modifiedCharacterIds: Set<string> = new Set();
  private prisma: PrismaClient;
```

Update the constructor to accept and store `prisma`:

```typescript
  constructor(
    config: SimulationConfig,
    dgsm: DynamicGameStateManager,
    npcPlanningAgent: NPCPlanningAgent,
    registry: GameEngineRegistry,
    ctx: ExecutionContext,
    language: string = "en",
    memoryManager?: NpcMemoryManager,
    prisma: PrismaClient  // new required param
  ) {
    // ... existing constructor body ...
    this.prisma = prisma;
  }
```

- [ ] **Step 2: Add `injectCharacter` method**

```typescript
  async injectCharacter(
    profile: DynamicNPCProfile,
    intent: string
  ): Promise<void> {
    // Allow injection when paused (including initial "paused" state before first start)
    if (this.state !== "paused") {
      throw new Error("Can only inject characters when simulation is paused");
    }

    // Validate residence
    const entrySceneId = resolveEntryScene(this.dgsm, profile.residence!);
    if (!entrySceneId) {
      throw new Error(
        `Invalid residence: ${profile.residence} is not a valid macro location in this module`
      );
    }

    // Inject into game state
    injectCharacterIntoState(this.dgsm, profile, entrySceneId);

    // Upsert intent to DB
    await upsertIntent(
      this.prisma,
      this.config.sessionId,
      this.config.moduleId,
      profile.id,
      profile.name,
      intent
    );

    // Generate day-1 schedule
    const gameState = this.dgsm.getState();
    await this.npcPlanningAgent.generateSingleNpcSchedule(
      this.dgsm,
      this.config.sessionId,
      this.config.moduleId,
      profile.id,
      gameState.gameDay,
      this.language,
      this.registry
    );
  }
```

- [ ] **Step 3: Add `removeCharacter` method**

```typescript
  async removeCharacter(characterId: string): Promise<void> {
    if (this.state !== "paused") {
      throw new Error("Can only remove characters when simulation is paused");
    }

    const state = this.dgsm.getState();
    const npc = state.npcCharacters.find(
      (n) => n.id === characterId && n.isPlayerInjected
    );
    if (!npc) {
      throw new Error(`Injected character ${characterId} not found`);
    }

    await removeCharacterFromState(
      this.dgsm,
      this.prisma,
      this.config.sessionId,
      characterId
    );
    this.modifiedCharacterIds.delete(characterId);
  }
```

- [ ] **Step 4: Add `updateIntent` and `getInjectedCharacters` methods**

```typescript
  async updateIntent(characterId: string, intent: string): Promise<void> {
    if (this.state !== "paused") {
      throw new Error("Can only update intent when simulation is paused");
    }

    const state = this.dgsm.getState();
    const npc = state.npcCharacters.find(
      (n) => n.id === characterId && n.isPlayerInjected
    );
    if (!npc) {
      throw new Error(`Injected character ${characterId} not found`);
    }

    await upsertIntent(
      this.prisma,
      this.config.sessionId,
      this.config.moduleId,
      characterId,
      npc.name,
      intent
    );
    this.modifiedCharacterIds.add(characterId);
  }

  getInjectedCharacters(): DynamicNPCProfile[] {
    const state = this.dgsm.getState();
    return state.npcCharacters.filter(
      (n): n is DynamicNPCProfile & { isPlayerInjected: true } =>
        n.isPlayerInjected === true
    );
  }
```

- [ ] **Step 5: Verify build**

Run: `pnpm build`
Expected: Clean build.

- [ ] **Step 6: Commit**

```bash
git add src/dynamicworldagent/simulation/SimulationRunner.ts
git commit -m "feat(simulation): add character injection/removal/intent methods to SimulationRunner"
```

---

### Task 5: Extend `resume()` to reviseSchedule for modified characters

**Files:**
- Modify: `src/dynamicworldagent/simulation/SimulationRunner.ts`

- [ ] **Step 1: Replace `resume()` method**

Find the existing `resume()` method (which is just `return this.start()`) and replace with:

```typescript
  async resume(): Promise<void> {
    if (this.state !== "paused") return;

    // Revise schedules for characters whose intent was modified during pause
    if (this.modifiedCharacterIds.size > 0) {
      for (const charId of this.modifiedCharacterIds) {
        await this.npcPlanningAgent.reviseSchedule(
          this.dgsm,
          this.config.sessionId,
          charId,
          "Player updated character intent",
          this.language
        );
      }
      this.modifiedCharacterIds.clear();
    }

    return this.start();
  }
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/simulation/SimulationRunner.ts
git commit -m "feat(simulation): extend resume() to reviseSchedule for modified characters"
```

---

## Chunk 3: API Endpoints + Auth

### Task 6: Character management controller

**Files:**
- Create: `client/server/simulation/characterController.ts`

- [ ] **Step 1: Create controller**

```typescript
// client/server/simulation/characterController.ts

import type { Request, Response } from "express";
import * as simulationService from "./service.js";
import {
  buildInjectedProfile,
  resolveEntryScene,
} from "../../../src/dynamicworldagent/simulation/characterInjection.js";

export async function injectCharacter(req: Request, res: Response) {
  try {
    const runner = simulationService.getRunner(req.params.id);
    if (!runner) {
      return res.status(404).json({ error: "Simulation not found" });
    }

    const { name, attributes, skills, backstory, residence, personality, occupation, age, gender, intent } = req.body;
    if (!name || !attributes || !skills || !backstory || !residence) {
      return res.status(400).json({
        error: "Missing required fields: name, attributes, skills, backstory, residence",
      });
    }
    if (!intent) {
      return res.status(400).json({ error: "Missing required field: intent" });
    }

    const profile = buildInjectedProfile({
      name, attributes, skills, backstory, residence,
      personality, occupation, age, gender,
    });

    await runner.injectCharacter(profile, intent);
    return res.status(201).json({ characterId: profile.id, profile });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.includes("Invalid residence") ? 400
      : message.includes("only inject") ? 409
      : 500;
    return res.status(status).json({ error: message });
  }
}

export function listInjectedCharacters(req: Request, res: Response) {
  try {
    const runner = simulationService.getRunner(req.params.id);
    if (!runner) {
      return res.status(404).json({ error: "Simulation not found" });
    }
    const characters = runner.getInjectedCharacters();
    return res.json({ characters });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export async function updateIntent(req: Request, res: Response) {
  try {
    const runner = simulationService.getRunner(req.params.id);
    if (!runner) {
      return res.status(404).json({ error: "Simulation not found" });
    }

    const { intent } = req.body;
    if (!intent) {
      return res.status(400).json({ error: "Missing required field: intent" });
    }

    await runner.updateIntent(req.params.charId, intent);
    return res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.includes("not found") ? 404
      : message.includes("only update") ? 409
      : 500;
    return res.status(status).json({ error: message });
  }
}

export async function removeCharacter(req: Request, res: Response) {
  try {
    const runner = simulationService.getRunner(req.params.id);
    if (!runner) {
      return res.status(404).json({ error: "Simulation not found" });
    }

    await runner.removeCharacter(req.params.charId);
    return res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.includes("not found") ? 404
      : message.includes("only remove") ? 409
      : 500;
    return res.status(status).json({ error: message });
  }
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add client/server/simulation/characterController.ts
git commit -m "feat(simulation): add character management controller"
```

---

### Task 7: Add character routes with JWT auth

**Files:**
- Modify: `client/server/simulation/routes.ts`

The base simulation plan creates `routes.ts` with NO auth. This task adds auth to ALL simulation routes and adds character management routes.

- [ ] **Step 1: Update routes.ts**

Replace the existing `routes.ts` content with auth-guarded version:

```typescript
// client/server/simulation/routes.ts

import { Router } from "express";
import { authenticate } from "../auth/middleware.js";
import * as simulationController from "./controller.js";
import * as characterController from "./characterController.js";

const router = Router();

// All simulation routes require authentication
router.use(authenticate);

// Simulation lifecycle (from base simulation plan)
router.post("/simulation", simulationController.createSimulation);
router.post("/simulation/:id/start", simulationController.startSimulation);
router.post("/simulation/:id/pause", simulationController.pauseSimulation);
router.post("/simulation/:id/resume", simulationController.resumeSimulation);
router.post("/simulation/:id/step", simulationController.stepSimulation);
router.post("/simulation/:id/stop", simulationController.stopSimulation);
router.get("/simulation/:id/status", simulationController.getStatus);
router.get("/simulation/:id/events", simulationController.getEvents);
router.get("/simulations", simulationController.listSimulations);

// Character management (new)
router.post("/simulation/:id/characters", characterController.injectCharacter);
router.get("/simulation/:id/characters", characterController.listInjectedCharacters);
router.put("/simulation/:id/characters/:charId/intent", characterController.updateIntent);
router.delete("/simulation/:id/characters/:charId", characterController.removeCharacter);

export default router;
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add client/server/simulation/routes.ts
git commit -m "feat(simulation): add auth + character management routes"
```

---

## Chunk 4: Integration Verification

### Task 8: Build + manual test

- [ ] **Step 1: Full build**

Run: `pnpm build`
Expected: Clean build, no type errors.

- [ ] **Step 2: Prisma schema sync**

Run: `npx prisma db push`
Expected: Schema already in sync (prerequisite plan handles schema changes).

- [ ] **Step 3: Start server and test character injection flow**

Run: `pnpm chat:dev`

Then in another terminal, test the character injection API:

```bash
# 1. Login to get JWT token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"test"}' | jq -r '.token')

# 2. Create simulation
SIM_ID=$(curl -s -X POST http://localhost:3000/api/simulation \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"moduleName":"Cassandra"}' | jq -r '.sessionId')

# 3. Inject character
curl -s -X POST http://localhost:3000/api/simulation/$SIM_ID/characters \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "Alice Reed",
    "attributes": {"STR":50,"CON":60,"SIZ":70,"DEX":55,"APP":65,"INT":75,"POW":80,"EDU":70,"luck":50},
    "skills": {"Library Use":60,"Spot Hidden":45,"Persuade":55},
    "backstory": "A journalist investigating strange disappearances",
    "residence": "SCN_OUTLINE_HOTEL",
    "personality": "Curious and persistent",
    "occupation": "Journalist",
    "intent": "Investigate the recent disappearances at the hospital and interview Dr. Smith"
  }'

# 4. List injected characters
curl -s http://localhost:3000/api/simulation/$SIM_ID/characters \
  -H "Authorization: Bearer $TOKEN"

# 5. Step one tick
curl -s -X POST http://localhost:3000/api/simulation/$SIM_ID/step \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"ticks":1}'

# 6. Pause, update intent, resume
curl -s -X POST http://localhost:3000/api/simulation/$SIM_ID/pause \
  -H "Authorization: Bearer $TOKEN"

curl -s -X PUT http://localhost:3000/api/simulation/$SIM_ID/characters/<charId>/intent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"intent":"Abandon the hospital lead. Go to the police station and check records."}'

curl -s -X POST http://localhost:3000/api/simulation/$SIM_ID/resume \
  -H "Authorization: Bearer $TOKEN"

# 7. Check events
curl -s http://localhost:3000/api/simulation/$SIM_ID/events \
  -H "Authorization: Bearer $TOKEN"
```

Expected: All endpoints return 200/201 with expected data. Injected character appears in NPC list and participates in tick execution.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(simulation): complete character injection system integration"
```
