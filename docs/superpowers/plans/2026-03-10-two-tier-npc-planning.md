# Two-Tier NPC Planning System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace one-shot full-day NPC planning with a two-tier system: coarse daily schedule + on-demand detailed node generation, saving tokens and improving item interaction accuracy.

**Architecture:** Layer 1 generates a cheap daily schedule (time + location + one-line activity). Layer 2 consumes schedule entries one at a time to generate 1-3 detailed PlanNodes using current scene context. Impact events can trigger revision of either layer independently.

**Tech Stack:** TypeScript, Prisma, Vitest

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `prisma/schema.prisma` | Add `schedule` JSON field to `NpcDailyPlan` |
| Modify | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts` | Add `ScheduleEntry` type |
| Create | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/scheduleTemplates.ts` | Prompt templates for schedule generation, detailed node generation, schedule revision |
| Create | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/scheduleTemplates.test.ts` | Template unit tests |
| Modify | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts` | Replace `generateDailyPlans` with `generateDailySchedule`, add `generateDetailedNodes`, `reviseSchedule`, `consumeNextScheduleEntry` |
| Modify | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts` | Update impact gate output to include `shouldReviseSchedule` |
| Modify | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` | Add node refill step before `getDueNpcNodes`, update impact gate handling |
| Modify | `src/dynamicworldagent/graph/dynamicGraph.ts` | Pass `registry` to tick processor for detailed node generation |

---

## Chunk 1: Data Model + Types + Templates

### Task 1: Add ScheduleEntry type

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts`

- [ ] **Step 1: Add ScheduleEntry interface**

In `types.ts`, add after the `ObjectInteractionPayload` interface (around line 36):

```typescript
export interface ScheduleEntry {
  time: string;       // "HH:MM"
  location: string;   // scene ID
  activity: string;   // natural language description
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts
git commit -m "feat(npc-planning): add ScheduleEntry type for coarse daily schedule"
```

---

### Task 2: Add schedule field to Prisma schema

**Files:**
- Modify: `prisma/schema.prisma:907-922`

- [ ] **Step 1: Add schedule field to NpcDailyPlan model**

Add `schedule Json?` field after the `nodes` field (line 914):

```prisma
model NpcDailyPlan {
  id          String   @id @default(uuid()) @db.Uuid
  sessionId   String   @map("session_id")
  moduleId    String   @map("module_id") @db.Uuid
  npcId       String   @map("npc_id")
  npcName     String   @map("npc_name")
  gameDay     Int      @map("game_day")
  nodes       Json
  schedule    Json?
  generatedAt DateTime @default(now()) @map("generated_at")

  session     Session  @relation(fields: [sessionId], references: [sessionId], onDelete: Cascade)
  module      Module   @relation(fields: [moduleId], references: [moduleId], onDelete: Cascade)

  @@unique([sessionId, npcId, gameDay])
  @@index([sessionId, gameDay])
  @@map("npc_daily_plans")
}
```

- [ ] **Step 2: Push schema changes**

Run: `npx prisma db push`
Expected: Schema updated (using `db push` not `migrate dev` per project conventions — schema drift with reminder_embeddings)

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(npc-planning): add schedule JSON field to NpcDailyPlan"
```

---

### Task 3: Create schedule prompt templates

**Files:**
- Create: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/scheduleTemplates.ts`
- Create: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/scheduleTemplates.test.ts`

- [ ] **Step 1: Write tests for template functions**

Create `__tests__/scheduleTemplates.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  buildDailySchedulePrompt,
  buildDetailedNodesPrompt,
  buildReviseSchedulePrompt,
} from "../scheduleTemplates.js";

describe("buildDailySchedulePrompt", () => {
  it("includes NPC name, profile, and scene map", () => {
    const result = buildDailySchedulePrompt({
      npcName: "Dr. Morgan",
      npcId: "npc_morgan",
      npcProfile: "Name: Dr. Morgan\nOccupation: Physician",
      longTermIntent: "Investigate strange occurrences at the hospital",
      memoryLog: "Day1 09:00 - Arrived at hospital",
      relationships: "- Player: score=30 (wary acquaintance)",
      sceneMap: "Current Scene: hospital_lobby",
      scenarioConditions: "",
      gameDay: 2,
      currentTime: "08:00",
      language: "en",
    });
    expect(result).toContain("Dr. Morgan");
    expect(result).toContain("npc_morgan");
    expect(result).toContain("Physician");
    expect(result).toContain("hospital_lobby");
    expect(result).toContain("Day 2");
  });

  it("instructs LLM to output ScheduleEntry array", () => {
    const result = buildDailySchedulePrompt({
      npcName: "Test",
      npcId: "npc_test",
      npcProfile: "",
      longTermIntent: "",
      memoryLog: "",
      relationships: "",
      sceneMap: "",
      scenarioConditions: "",
      gameDay: 1,
      currentTime: "08:00",
      language: "en",
    });
    expect(result).toContain('"time"');
    expect(result).toContain('"location"');
    expect(result).toContain('"activity"');
    // Must NOT mention PlanNode fields like actionType, objectInteractionPayload
    expect(result).not.toContain("actionType");
    expect(result).not.toContain("objectInteractionPayload");
  });
});

describe("buildDetailedNodesPrompt", () => {
  it("includes schedule entry and scene items", () => {
    const result = buildDetailedNodesPrompt({
      npcName: "Dr. Morgan",
      npcId: "npc_morgan",
      npcProfile: "Name: Dr. Morgan",
      longTermIntent: "Investigate strange occurrences",
      memoryLog: "",
      scheduleEntry: { time: "09:00", location: "library_main", activity: "Search for ritual texts" },
      sceneDescription: "A dusty old library with towering shelves.",
      sceneItems: "- Ancient Tome (id: tome_1, type: document)\n- Locked Cabinet (id: cabinet, type: container, locked)",
      sceneNpcs: "- Librarian (npc_librarian)",
      sceneConditions: "Dim lighting",
      npcInventory: "- Flashlight (id: flashlight, type: lighting, unlit)",
      currentTime: "09:00",
      gameDay: 2,
      language: "en",
    });
    expect(result).toContain("Search for ritual texts");
    expect(result).toContain("tome_1");
    expect(result).toContain("cabinet");
    expect(result).toContain("flashlight");
  });

  it("includes handler and output schema prompts when provided", () => {
    const result = buildDetailedNodesPrompt({
      npcName: "Test",
      npcId: "npc_test",
      npcProfile: "",
      longTermIntent: "",
      memoryLog: "",
      scheduleEntry: { time: "09:00", location: "room_a", activity: "Do something" },
      sceneDescription: "",
      sceneItems: "",
      sceneNpcs: "",
      sceneConditions: "",
      npcInventory: "",
      currentTime: "09:00",
      gameDay: 1,
      language: "en",
      handlerPrompt: "## Custom Handlers\ntest handler info",
      outputSchemaPrompt: "## Custom Schema\ntest schema info",
    });
    expect(result).toContain("Custom Handlers");
    expect(result).toContain("Custom Schema");
  });
});

describe("buildReviseSchedulePrompt", () => {
  it("includes trigger description and remaining schedule", () => {
    const result = buildReviseSchedulePrompt({
      npcName: "Dr. Morgan",
      npcProfile: "Name: Dr. Morgan",
      longTermIntent: "Investigate occurrences",
      memoryLog: "",
      remainingSchedule: JSON.stringify([
        { time: "12:00", location: "home", activity: "Lunch" },
        { time: "15:00", location: "church", activity: "Meet pastor" },
      ]),
      triggerDescription: "Witnessed: explosion at the hospital",
      language: "en",
    });
    expect(result).toContain("explosion at the hospital");
    expect(result).toContain("12:00");
    expect(result).toContain("Meet pastor");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/scheduleTemplates.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement schedule templates**

Create `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/scheduleTemplates.ts`:

```typescript
import type { ScheduleEntry } from "./types.js";

// ===================== Daily Schedule (Layer 1 — coarse) =====================

export interface DailyScheduleParams {
  npcName: string;
  npcId: string;
  npcProfile: string;
  longTermIntent: string;
  memoryLog: string;
  relationships: string;
  sceneMap: string;
  scenarioConditions: string;
  gameDay: number;
  currentTime: string;
  language: string;
}

export function buildDailySchedulePrompt(params: DailyScheduleParams): string {
  return `You are the Game Master for a Call of Cthulhu tabletop RPG.

## Task
Generate a high-level daily schedule for NPC "${params.npcName}" (ID: "${params.npcId}", Day ${params.gameDay}).
Create a sequence of time-stamped entries describing WHERE the NPC goes and WHAT they intend to do, from current time onward.

**Important:** This is a coarse schedule, NOT a detailed action plan. Each entry is one sentence describing the NPC's intent at that time and place. Do NOT include mechanical details like skill checks, payloads, or item interactions — those will be generated later when the NPC arrives at each location.

## NPC Profile
${params.npcProfile}

## Long-Term Intent
${params.longTermIntent}

## Memory Log
${params.memoryLog || "No actions recorded yet."}

## Relationships
${params.relationships}

## Scene Map (connections)
${params.sceneMap}

## Current Scene Conditions
${params.scenarioConditions || "None."}

## Current Time
Day ${params.gameDay}, ${params.currentTime}

## Guidelines
- Build a realistic full-day schedule reflecting the NPC's nature, occupation, and personality.
- Mix routine activities (meals, work, rest) with goal-driven entries that advance the NPC's long-term intent.
- Use scene IDs from the Scene Map for locations.
- Anchor entries at realistic times — don't schedule a break-in during daylight if the NPC would wait for darkness.
- Keep entries to 6-12 items for a full day. Fewer if starting late in the day.

## Output
Return a JSON array. No extra text. Always write in English.

\`\`\`json
[
  { "time": "08:00", "location": "home_kitchen", "activity": "Have breakfast and review notes from yesterday" },
  { "time": "09:30", "location": "library_main", "activity": "Search the archives for information about the ritual" },
  { "time": "12:00", "location": "home_kitchen", "activity": "Lunch break" }
]
\`\`\`

Each entry has exactly three fields:
- \`"time"\`: "HH:MM" — when this activity starts
- \`"location"\`: scene ID — where the NPC will be
- \`"activity"\`: one sentence — what the NPC intends to do there`;
}

// ===================== Detailed Nodes (Layer 2 — fine) =====================

export interface DetailedNodesParams {
  npcName: string;
  npcId: string;
  npcProfile: string;
  longTermIntent: string;
  memoryLog: string;
  scheduleEntry: ScheduleEntry;
  sceneDescription: string;
  sceneItems: string;
  sceneNpcs: string;
  sceneConditions: string;
  npcInventory: string;
  currentTime: string;
  gameDay: number;
  language: string;
  handlerPrompt?: string;
  planningPrompt?: string;
  outputSchemaPrompt?: string;
}

const DEFAULT_DETAILED_NODE_TYPE_REF = `## Node Type Reference
- **"routine"**: Self-contained action, no interaction target.
- **"movement"**: Move to a destination scene. Set location to the target scene ID.
- **"character_interaction"**: Interact with a specific character. Requires targetCharacterId.
- **"object_interaction"**: Interact with a physical object. Include objectInteractionPayload. For creative non-standard uses, set actionType and include itemUpdates/targetItemUpdates.
- **"scene_interaction"**: Search, investigate, or modify the environment.

## ActionType (optional — set when skill roll is needed)
exploration | social | combat | stealth | chase | mental | environmental | narrative`;

const DEFAULT_DETAILED_OUTPUT_SCHEMA = `## Output
Return a JSON array of 1-3 PlanNode objects. No extra text. Always write in English.

### Fields
\`\`\`json
{
  "nodeId": "unique-id",
  "gameTime": "HH:MM",
  "action": "description of what the NPC does",
  "location": "sceneId",
  "type": "routine|movement|character_interaction|object_interaction|scene_interaction",
  "actionType": "OMIT if no skill check needed",
  "impact": 0,
  "status": "pending"
}
\`\`\`

Add type-specific fields as needed:
- **character_interaction**: \`"targetCharacterId"\`, optional \`"characterInteractionPayload"\`
- **object_interaction**: \`"objectInteractionPayload"\` with \`itemUpdates\`/\`targetItemUpdates\` for non-standard use
- **scene_interaction**: optional \`"sceneConnectionEffect"\``;

export function buildDetailedNodesPrompt(params: DetailedNodesParams): string {
  return `You are the Game Master for a Call of Cthulhu tabletop RPG.

## Task
Generate 1-3 detailed action nodes for NPC "${params.npcName}" (ID: "${params.npcId}") to fulfill the following schedule entry:

**Schedule Entry:** ${params.scheduleEntry.time} | ${params.scheduleEntry.location} | ${params.scheduleEntry.activity}

Break this high-level intent into concrete, executable actions based on what is actually present in the scene right now.

## NPC Profile
${params.npcProfile}

## Long-Term Intent
${params.longTermIntent}

## Memory Log (recent)
${params.memoryLog || "No actions recorded yet."}

## Current Scene
${params.sceneDescription || "No description available."}

## Scene Conditions
${params.sceneConditions || "None."}

## Items in Current Scene
${params.sceneItems || "No items in this scene."}

## NPCs Present in Scene
${params.sceneNpcs || "No NPCs present."}

## NPC Inventory
${params.npcInventory || "Empty."}

## Current Time
Day ${params.gameDay}, ${params.currentTime}

## Movement
If the NPC is not at the schedule entry's target location, generate a movement node FIRST to get there. Then generate 1-2 action nodes for the activity itself.

## When to Set actionType
- Routine activities, simple movement, friendly conversation → **no actionType** (auto-succeed)
- Searching for hidden things, persuading reluctant NPCs, sneaking, combat → **set actionType**

${params.handlerPrompt || DEFAULT_DETAILED_NODE_TYPE_REF}

${params.planningPrompt || ""}

${params.outputSchemaPrompt || DEFAULT_DETAILED_OUTPUT_SCHEMA}`;
}

// ===================== Schedule Revision =====================

export interface ReviseScheduleParams {
  npcName: string;
  npcProfile: string;
  longTermIntent: string;
  memoryLog: string;
  remainingSchedule: string;
  triggerDescription: string;
  language: string;
}

export function buildReviseSchedulePrompt(params: ReviseScheduleParams): string {
  return `You are the Game Master for a Call of Cthulhu tabletop RPG.

## Task
Revise the remaining daily schedule for NPC "${params.npcName}" after a significant event.

## NPC Profile
${params.npcProfile}

## Long-Term Intent
${params.longTermIntent}

## Memory Log
${params.memoryLog || "No actions recorded yet."}

## Remaining Schedule
${params.remainingSchedule}

## Trigger Event
${params.triggerDescription}

## Instructions
- Revise the remaining schedule entries to account for the trigger event.
- You may reorder, modify, add, or remove entries.
- Keep the same format: each entry has "time", "location", "activity".
- Only change what the event actually affects. Keep unrelated entries as-is.

## Output
Return a single JSON object. No extra text. Always write in English.

\`\`\`json
{
  "revisedSchedule": [
    { "time": "HH:MM", "location": "scene_id", "activity": "what the NPC will do" }
  ],
  "shouldUpdateLongTermIntent": false,
  "updatedLongTermIntent": "only if shouldUpdateLongTermIntent is true"
}
\`\`\``;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/scheduleTemplates.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/scheduleTemplates.ts \
        src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/scheduleTemplates.test.ts
git commit -m "feat(npc-planning): add schedule prompt templates for two-tier planning"
```

---

## Chunk 2: NPCPlanningAgent Methods

### Task 4: Add generateDailySchedule method

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts:1-17,87-167`

- [ ] **Step 1: Add import for schedule templates**

At the top of `NPCPlanningAgent.ts`, add import:

```typescript
import {
  buildDailySchedulePrompt,
  buildDetailedNodesPrompt,
  buildReviseSchedulePrompt,
} from "./scheduleTemplates.js";
import type { ScheduleEntry } from "./types.js";
```

- [ ] **Step 2: Replace `generateDailyPlans` with `generateDailySchedule`**

Replace the `generateDailyPlans` method (lines 87-167) with:

```typescript
  async generateDailySchedule(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    moduleId: string,
    gameDay: number,
    language: string = "en"
  ): Promise<void> {
    const state = dgsm.getState();
    const npcs = state.npcCharacters;

    await Promise.all(
      npcs.map(async (npc) => {
        const longTermIntent = await this.getLongTermIntent(sessionId, npc.id);
        const memoryLog = await this.getMemoryLog(sessionId, npc.id);
        const npcProfile = this.formatNpcProfile(npc);
        const relationships = this.formatRelationships(dgsm, npc.id);
        const sceneMap = this.formatSceneMap(dgsm, npc.id);
        const scenarioConditions = this.formatScenarioConditions(dgsm);

        const prompt = buildDailySchedulePrompt({
          npcName: npc.name,
          npcId: npc.id,
          npcProfile,
          longTermIntent,
          memoryLog: memoryLog.join("\n"),
          relationships,
          sceneMap,
          scenarioConditions,
          gameDay,
          currentTime: state.timeOfDay,
          language,
        });

        const response = await generateText({
          runtime: this.runtime,
          context: prompt,
          modelClass: ModelClass.SMALL,
        });

        const schedule = parseJsonResponse<ScheduleEntry[]>(response);

        await this.prisma.npcDailyPlan.upsert({
          where: {
            sessionId_npcId_gameDay: { sessionId, npcId: npc.id, gameDay },
          },
          create: {
            sessionId,
            moduleId,
            npcId: npc.id,
            npcName: npc.name,
            gameDay,
            nodes: [] as any,
            schedule: schedule as any,
          },
          update: {
            schedule: schedule as any,
          },
        });
      })
    );
  }
```

- [ ] **Step 3: Build to verify no type errors**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts
git commit -m "feat(npc-planning): replace generateDailyPlans with generateDailySchedule"
```

---

### Task 5: Add generateDetailedNodes and consumeNextScheduleEntry

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts`

- [ ] **Step 1: Add consumeNextScheduleEntry method**

Add after the `generateDailySchedule` method:

```typescript
  async consumeNextScheduleEntry(
    sessionId: string,
    npcId: string,
    gameDay: number,
    currentTime: string
  ): Promise<ScheduleEntry | null> {
    const plan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    if (!plan?.schedule) return null;

    const schedule = plan.schedule as unknown as ScheduleEntry[];
    // Find next entry at or after current time
    const idx = schedule.findIndex((e) => e.time >= currentTime);
    if (idx === -1) return null;

    const entry = schedule[idx];
    // Remove consumed entry
    const remaining = [...schedule.slice(0, idx), ...schedule.slice(idx + 1)];
    await this.prisma.npcDailyPlan.update({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
      data: { schedule: remaining as any },
    });

    return entry;
  }
```

- [ ] **Step 2: Add generateDetailedNodes method**

Add after `consumeNextScheduleEntry`:

```typescript
  async generateDetailedNodes(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    npcId: string,
    entry: ScheduleEntry,
    gameDay: number,
    language: string = "en",
    registry?: GameEngineRegistry
  ): Promise<PlanNode[]> {
    const state = dgsm.getState();
    const npc = state.npcCharacters.find((n) => n.id === npcId);
    if (!npc) return [];

    const longTermIntent = await this.getLongTermIntent(sessionId, npcId);
    const memoryLog = await this.getMemoryLog(sessionId, npcId, gameDay);

    // Get scene context for the target location
    const targetScene = state.scenes.get(entry.location) ?? null;
    const sceneDescription = targetScene?.description ?? "";
    const sceneItems = formatSceneItems(targetScene);
    const sceneConditions = targetScene
      ? dgsm.getSceneConditions(targetScene.id).map((c) => `- ${c.description}`).join("\n")
      : "";

    // NPCs at target location
    const npcsAtLocation = state.npcCharacters
      .filter((n) => n.id !== npcId && state.npcLocations[n.id] === entry.location)
      .map((n) => `- ${n.name} (${n.id})`)
      .join("\n");

    const npcInventory = formatItemList(dgsm.getNpcInventory(npcId));

    const prompt = buildDetailedNodesPrompt({
      npcName: npc.name,
      npcId: npc.id,
      npcProfile: this.formatNpcProfile(npc),
      longTermIntent,
      memoryLog: memoryLog.join("\n"),
      scheduleEntry: entry,
      sceneDescription,
      sceneItems,
      sceneNpcs: npcsAtLocation,
      sceneConditions,
      npcInventory,
      currentTime: entry.time,
      gameDay,
      language,
      handlerPrompt: registry?.buildHandlerPrompt(),
      planningPrompt: registry?.buildPlanningPrompt(),
      outputSchemaPrompt: registry?.buildOutputSchemaPrompt({
        isPlayer: false,
        extraInstructions: "Generate 1-3 nodes. Use the schedule entry time as the starting gameTime.",
      }),
    });

    const response = await generateText({
      runtime: this.runtime,
      context: prompt,
      modelClass: ModelClass.SMALL,
    });

    const rawNodes = parseJsonResponse<any[]>(response);
    const enrichedNodes: PlanNode[] = rawNodes.map((node) => ({
      ...node,
      nodeId: node.nodeId || randomUUID(),
      characterId: npcId,
      characterName: npc.name,
      status: "pending" as const,
    }));

    // Append new nodes to existing nodes in DB
    const plan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    const existingNodes = (plan?.nodes as unknown as PlanNode[]) ?? [];
    const mergedNodes = [...existingNodes, ...enrichedNodes];

    await this.prisma.npcDailyPlan.update({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
      data: { nodes: mergedNodes as any },
    });

    return enrichedNodes;
  }
```

- [ ] **Step 3: Add ensureNpcNodesAvailable method**

This is the "refill" entry point that tickProcessor will call:

```typescript
  async ensureNpcNodesAvailable(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    npcId: string,
    gameDay: number,
    currentTime: string,
    language: string = "en",
    registry?: GameEngineRegistry
  ): Promise<void> {
    const pendingNodes = await this.getPendingNodes(sessionId, npcId, gameDay);
    if (pendingNodes.length > 0) return; // Already has nodes, nothing to do

    const entry = await this.consumeNextScheduleEntry(sessionId, npcId, gameDay, currentTime);
    if (!entry) return; // No more schedule entries for today

    await this.generateDetailedNodes(dgsm, sessionId, npcId, entry, gameDay, language, registry);
  }
```

- [ ] **Step 4: Build to verify no type errors**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts
git commit -m "feat(npc-planning): add detailed node generation and schedule consumption"
```

---

### Task 6: Add reviseSchedule method

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts`

- [ ] **Step 1: Add reviseSchedule method**

Add after `ensureNpcNodesAvailable`:

```typescript
  async reviseSchedule(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    npcId: string,
    triggerDescription: string,
    language: string = "en"
  ): Promise<void> {
    const state = dgsm.getState();
    const npc = state.npcCharacters.find((n) => n.id === npcId);
    if (!npc) return;

    const gameDay = state.gameDay;
    const plan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    if (!plan?.schedule) return;

    const schedule = plan.schedule as unknown as ScheduleEntry[];
    if (schedule.length === 0) return;

    const longTermIntent = await this.getLongTermIntent(sessionId, npcId);
    const memoryLog = await this.getMemoryLog(sessionId, npcId, gameDay);

    const prompt = buildReviseSchedulePrompt({
      npcName: npc.name,
      npcProfile: this.formatNpcProfile(npc),
      longTermIntent,
      memoryLog: memoryLog.join("\n"),
      remainingSchedule: JSON.stringify(schedule, null, 2),
      triggerDescription,
      language,
    });

    const response = await generateText({
      runtime: this.runtime,
      context: prompt,
      modelClass: ModelClass.SMALL,
    });

    const parsed = parseJsonResponse<{
      revisedSchedule: ScheduleEntry[];
      shouldUpdateLongTermIntent: boolean;
      updatedLongTermIntent?: string;
    }>(response);

    await this.prisma.npcDailyPlan.update({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
      data: { schedule: parsed.revisedSchedule as any },
    });

    if (parsed.shouldUpdateLongTermIntent && parsed.updatedLongTermIntent) {
      await this.prisma.npcLongTermIntent.updateMany({
        where: { sessionId, npcId },
        data: { intent: parsed.updatedLongTermIntent },
      });
    }
  }
```

- [ ] **Step 2: Build to verify no type errors**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts
git commit -m "feat(npc-planning): add reviseSchedule method for coarse plan revision"
```

---

## Chunk 3: Impact Gate + TickProcessor Integration

### Task 7: Update impact gate to support schedule revision

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts:254-296`

- [ ] **Step 1: Update impact gate output format**

In `buildImpactGatePrompt()`, update the Output section to add `shouldReviseSchedule`:

Replace the JSON output block (around lines 292-296):

```typescript
\`\`\`json
{
  "shouldRevise": false,
  "shouldReviseSchedule": false,
  "witnessEntry": "Brief description of what this NPC perceived."
}
\`\`\`
```

And update the Instructions section to explain the two revision levels:

Replace the Instructions section (around lines 285-287):

```typescript
## Instructions
1. Write a brief witness entry from this NPC's perspective — what they perceived and how.
2. Decide whether these events should cause the NPC to revise their **immediate actions** (shouldRevise). Set true if the events meaningfully affect what the NPC is doing right now.
3. Decide whether these events should cause the NPC to revise their **daily schedule** (shouldReviseSchedule). Set true only if the events fundamentally change the NPC's plans for the rest of the day (e.g., a building they planned to visit was destroyed, or someone they need to meet was arrested).
```

- [ ] **Step 2: Update runImpactGateForNpc return type in NPCPlanningAgent**

In `NPCPlanningAgent.ts`, update `runImpactGateForNpc` return type (around line 235):

Change:
```typescript
  ): Promise<{ shouldRevise: boolean; witnessEntry: string }> {
```
To:
```typescript
  ): Promise<{ shouldRevise: boolean; shouldReviseSchedule: boolean; witnessEntry: string }> {
```

And update the parseJsonResponse call:
```typescript
    return parseJsonResponse<{ shouldRevise: boolean; shouldReviseSchedule: boolean; witnessEntry: string }>(response);
```

- [ ] **Step 3: Build to verify no type errors**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts \
        src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts
git commit -m "feat(npc-planning): add shouldReviseSchedule to impact gate output"
```

---

### Task 8: Update tickProcessor for two-tier planning

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts:298-390,504-590`

- [ ] **Step 1: Add node refill step to executeSingleTick**

In `executeSingleTick()`, after the `tickRuntime` setup (around line 359) and BEFORE `getDueNpcNodes` (line 362), add:

```typescript
  // 0. Ensure NPCs have detailed nodes available (two-tier planning refill)
  const allNpcIds = state.npcCharacters.map((n) => n.id);
  await Promise.all(
    allNpcIds.map((npcId) =>
      npcPlanningAgent.ensureNpcNodesAvailable(
        dgsm, sessionId, npcId, gameDay, tickStartTime, language, registry
      )
    )
  );
```

- [ ] **Step 2: Update SingleTickParams to include registry**

The `SingleTickParams` interface (line 298) already has `registry: GameEngineRegistry`, so no change needed here.

- [ ] **Step 3: Update impact propagation to handle schedule revision**

In the impact propagation section (around line 574), after the existing `if (result.shouldRevise)` block, add schedule revision:

```typescript
          if (result.shouldReviseSchedule) {
            const sortedEvents = [...npcEvents].sort((a, b) => b.impact - a.impact);
            const triggerDesc = `Witnessed: ${sortedEvents[0].event.action} by ${sortedEvents[0].event.characterName} (${sortedEvents[0].event.outcome})`;
            await npcPlanningAgent.reviseSchedule(dgsm, sessionId, npcId, triggerDesc, language);
          }
```

- [ ] **Step 4: Update NPC failure handler to also revise schedule for high-impact failures**

In the NPC failure handler (around line 486), after the existing `revisePlans` call (line 500), add:

```typescript
      // Also revise schedule if the failure was significant
      if (action.impact >= 2) {
        const triggerDesc = `Own action "${action.action}" at ${action.gameTime} failed: ${action.failureReason}`;
        await npcPlanningAgent.reviseSchedule(dgsm, sessionId, node.characterId, triggerDesc, language);
      }
```

- [ ] **Step 5: Build and run all tests**

Run: `pnpm build && pnpm vitest run src/dynamicworldagent/`
Expected: Build succeeds, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts
git commit -m "feat(npc-planning): integrate two-tier planning into tick processor"
```

---

### Task 9: Clean up old generateDailyPlans references

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/index.ts` (if it exports generateDailyPlans)
- Modify: `src/dynamicworldagent/graph/dynamicGraph.ts` (if it references the old method)

- [ ] **Step 1: Check for remaining references to generateDailyPlans**

Run: `grep -r "generateDailyPlans" src/ --include="*.ts" -l`
Expected: Only `NPCPlanningAgent.ts` should remain (the method was already replaced in Task 4).

- [ ] **Step 2: Export new types from index.ts**

In `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/index.ts`, ensure `ScheduleEntry` is exported:

```typescript
export type { ScheduleEntry } from "./types.js";
```

- [ ] **Step 3: Final build and full test run**

Run: `pnpm build && pnpm vitest run src/dynamicworldagent/`
Expected: Build succeeds, all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/index.ts
git commit -m "chore(npc-planning): export ScheduleEntry type and clean up old references"
```
