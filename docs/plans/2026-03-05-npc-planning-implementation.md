# NPC Planning System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the reactive NPC model with a proactive tick-plan system where NPCs execute autonomous daily plans as game time advances, driven by a deterministic TickProcessor (no LLM) and a 5-minute bucket impact gate for plan revision.

**Architecture:** Orchestrator parses player intent → outputs structured player NpcPlanNode + timeAdvanceMinutes → TickProcessor builds a priority queue of player node + all due NPC nodes → executes serially in 5-minute buckets, with a batched LLM impact gate between buckets that can trigger plan revision before subsequent nodes execute.

**Tech Stack:** TypeScript (NodeNext ESM), Prisma (db push), LangChain/generateText, EmbeddingClient for Skill RAG + Horror RAG, existing DynamicGameStateManager pattern.

**Design doc:** `docs/plans/2026-03-05-npc-planning-system-design.md`

---

## Before You Start

- All imports use `.js` extensions (ESM requirement)
- Run `pnpm build:tsc` (not `pnpm build`) after each task to catch type errors
- DB changes: use `prisma db push` (NOT `prisma migrate dev` — schema has drift from reminder_embeddings)
- Working directory: `/Users/sunyining/project_SentiEdge/CoC-AI-agent`
- All new files go under `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/`
- Read `src/dynamicworldagent/state/DynamicGameState.ts` before touching it — it is large

---

## Task 1: DB Schema — Add 3 Prisma Tables

**Files:**
- Modify: `prisma/schema.prisma`

**Step 1: Open schema and find where to add**

Read the end of `prisma/schema.prisma` to find a good insertion point near related session/state tables.

**Step 2: Add 3 models**

Add after the last existing model:

```prisma
model NpcLongTermIntent {
  id        String   @id @default(uuid()) @db.Uuid
  sessionId String   @map("session_id")
  moduleId  String   @map("module_id") @db.Uuid
  npcId     String   @map("npc_id")
  npcName   String   @map("npc_name")
  intent    String
  updatedAt DateTime @updatedAt @map("updated_at")
  createdAt DateTime @default(now()) @map("created_at")

  session   Session  @relation(fields: [sessionId], references: [sessionId], onDelete: Cascade)
  module    Module   @relation(fields: [moduleId], references: [moduleId], onDelete: Cascade)

  @@index([sessionId])
  @@map("npc_long_term_intents")
}

model NpcDailyPlan {
  id          String   @id @default(uuid()) @db.Uuid
  sessionId   String   @map("session_id")
  moduleId    String   @map("module_id") @db.Uuid
  npcId       String   @map("npc_id")
  npcName     String   @map("npc_name")
  gameDay     Int      @map("game_day")
  nodes       Json
  generatedAt DateTime @default(now()) @map("generated_at")

  session     Session  @relation(fields: [sessionId], references: [sessionId], onDelete: Cascade)
  module      Module   @relation(fields: [moduleId], references: [moduleId], onDelete: Cascade)

  @@unique([sessionId, npcId, gameDay])
  @@index([sessionId, gameDay])
  @@map("npc_daily_plans")
}

model NpcActionLog {
  id        String   @id @default(uuid()) @db.Uuid
  sessionId String   @map("session_id")
  npcId     String   @map("npc_id")
  gameDay   Int      @map("game_day")
  gameTime  String   @map("game_time")
  location  String
  entry     String
  createdAt DateTime @default(now()) @map("created_at")

  session   Session  @relation(fields: [sessionId], references: [sessionId], onDelete: Cascade)

  @@index([sessionId, npcId])
  @@map("npc_action_logs")
}
```

Also add back-relations to `Session` and `Module` models:
- On `Session`: `npcLongTermIntents NpcLongTermIntent[]`, `npcDailyPlans NpcDailyPlan[]`, `npcActionLogs NpcActionLog[]`
- On `Module`: `npcLongTermIntents NpcLongTermIntent[]`, `npcDailyPlans NpcDailyPlan[]`

**Step 3: Apply schema**

```bash
cd /Users/sunyining/project_SentiEdge/CoC-AI-agent
npx prisma db push
```

Expected: `Your database is now in sync with your Prisma schema.`

**Step 4: Regenerate Prisma client**

```bash
npx prisma generate
```

**Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: add NpcLongTermIntent, NpcDailyPlan, NpcActionLog DB tables"
```

---

## Task 2: New Type Definitions

**Files:**
- Create: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts`

**Step 1: Write the types file**

```typescript
import type { ActionType } from "../../../shared/state/index.js";

export type NpcPlanNodeType =
  | "routine"
  | "movement"
  | "character_interaction"
  | "object_interaction"
  | "scene_interaction";

export interface SceneCondition {
  description: string;
  mechanicalEffect?: {
    skillPenalty?: Array<{ skill: string; delta: number }>;
    blocked?: boolean;
  };
}

export interface CharacterInteractionPayload {
  transferType: "item" | "clue" | "information";
  itemId?: string;
  clueId?: string;
  informationContent?: string;
}

export interface ObjectInteractionPayload {
  action: "pickup" | "place" | "use" | "inspect" | "destroy";
  itemId?: string;
}

export interface SceneConnectionEffect {
  targetScenarioId: string;
  action: "block" | "unblock";
}

export interface NpcPlanNode {
  nodeId: string;
  characterId: string;
  characterName: string;
  gameTime: string;
  action: string;
  location: string;
  type: NpcPlanNodeType;
  actionType?: ActionType;
  impact: 0 | 1 | 2 | 3;
  targetCharacterId?: string;
  characterInteractionPayload?: CharacterInteractionPayload;
  objectInteractionPayload?: ObjectInteractionPayload;
  sceneConnectionEffect?: SceneConnectionEffect;
  status: "pending" | "completed" | "failed";
  outcome?: string;
}

export interface CharacterAction {
  characterId: string;
  characterName: string;
  gameTime: string;
  action: string;
  location: string;
  type: NpcPlanNodeType;
  actionType?: ActionType;
  impact: 0 | 1 | 2 | 3;
  status: "completed" | "failed";
  outcome: string;
  failureReason?: FailureReason;
}

export type FailureReason =
  | "location_mismatch"
  | "location_blocked"
  | "target_absent"
  | "object_not_found"
  | "skill_roll_failed"
  | "bad_luck";

export type FailureTrigger = {
  type: "failure";
  failureReason: FailureReason;
  action: string;
  gameTime: string;
};

export type ImpactTrigger = {
  type: "impact";
  triggeringAction: CharacterAction;
};

export interface RevisePlansContext {
  longTermIntent: string;
  actionLog: string[];
  pendingNodes: NpcPlanNode[];
  trigger: FailureTrigger | ImpactTrigger;
}

export type TimeConsumptionLevel =
  | "instant"
  | "short"
  | "medium"
  | "long"
  | "very long";

export interface OrchestratorPlayerNode {
  type: NpcPlanNodeType;
  actionType?: ActionType;
  location: string;
  targetCharacterId?: string;
  impact: 0 | 1 | 2 | 3;
  gameTime: string;
  timeAdvanceMinutes: number;
  timeConsumption: TimeConsumptionLevel;
  characterInteractionPayload?: CharacterInteractionPayload;
  objectInteractionPayload?: ObjectInteractionPayload;
  sceneConnectionEffect?: SceneConnectionEffect;
}
```

**Step 2: Type check**

```bash
pnpm build:tsc 2>&1 | head -30
```

**Step 3: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts
git commit -m "feat: add NPC planning system type definitions"
```

---

## Task 3: DynamicGameState — Add Runtime State Fields

**Files:**
- Modify: `src/dynamicworldagent/state/DynamicGameState.ts`

**Step 1: Read the file first**

Read `src/dynamicworldagent/state/DynamicGameState.ts`. Focus on:
- The `DynamicGameState` interface definition
- The `initialDynamicGameState` object
- The `DynamicGameStateManager` class

**Step 2: Add ScenarioConnectionState interface near the top**

```typescript
export interface ScenarioConnectionState {
  fromScenarioId: string;
  toScenarioId: string;
  blocked: boolean;
  conditions: string[];
}
```

**Step 3: Add new fields to DynamicGameState interface**

In the `DynamicGameState` interface, add:

```typescript
// NPC Planning System runtime state (all initialized from module at load time)
npcLocations:         Record<string, string>;
npcStats:             Record<string, { hp: number; san: number }>;
npcInventories:       Record<string, string[]>;
npcDiscoveredClues:   Record<string, string[]>;
npcRelationshipGraph: Record<string, Record<string, { score: number; note: string }>>;
scenarioConditions:   Record<string, import("../dynamicBasicAgent/npcPlanning/types.js").SceneCondition[]>;
connectionStates:     ScenarioConnectionState[];
```

**Step 4: Initialize new fields in initialDynamicGameState**

```typescript
npcLocations: {},
npcStats: {},
npcInventories: {},
npcDiscoveredClues: {},
npcRelationshipGraph: {},
scenarioConditions: {},
connectionStates: [],
```

**Step 5: Add helper methods to DynamicGameStateManager**

```typescript
getNpcLocation(npcId: string): string | undefined {
  return this.state.npcLocations[npcId];
}
setNpcLocation(npcId: string, scenarioId: string): void {
  this.state.npcLocations[npcId] = scenarioId;
}
getNpcStats(npcId: string): { hp: number; san: number } | undefined {
  return this.state.npcStats[npcId];
}
updateNpcHp(npcId: string, delta: number): void {
  if (!this.state.npcStats[npcId]) return;
  this.state.npcStats[npcId].hp = Math.max(0, this.state.npcStats[npcId].hp + delta);
}
updateNpcSan(npcId: string, delta: number): void {
  if (!this.state.npcStats[npcId]) return;
  this.state.npcStats[npcId].san = Math.max(0, this.state.npcStats[npcId].san + delta);
}
getNpcInventory(npcId: string): string[] {
  return this.state.npcInventories[npcId] ?? [];
}
addItemToNpc(npcId: string, itemId: string): void {
  if (!this.state.npcInventories[npcId]) this.state.npcInventories[npcId] = [];
  this.state.npcInventories[npcId].push(itemId);
}
removeItemFromNpc(npcId: string, itemId: string): void {
  if (!this.state.npcInventories[npcId]) return;
  this.state.npcInventories[npcId] = this.state.npcInventories[npcId].filter(id => id !== itemId);
}
transferClue(fromNpcId: string, toNpcId: string, clueId: string): void {
  if (!this.state.npcDiscoveredClues[toNpcId]) this.state.npcDiscoveredClues[toNpcId] = [];
  if (!this.state.npcDiscoveredClues[toNpcId].includes(clueId)) {
    this.state.npcDiscoveredClues[toNpcId].push(clueId);
  }
  if (this.state.npcDiscoveredClues[fromNpcId]) {
    this.state.npcDiscoveredClues[fromNpcId] = this.state.npcDiscoveredClues[fromNpcId].filter(id => id !== clueId);
  }
}
getRelationship(npcId: string, targetId: string): { score: number; note: string } | undefined {
  return this.state.npcRelationshipGraph[npcId]?.[targetId];
}
updateRelationship(npcId: string, targetId: string, scoreDelta: number, note: string): void {
  if (!this.state.npcRelationshipGraph[npcId]) this.state.npcRelationshipGraph[npcId] = {};
  const current = this.state.npcRelationshipGraph[npcId][targetId] ?? { score: 0, note: "" };
  const newScore = Math.max(-100, Math.min(100, current.score + scoreDelta));
  this.state.npcRelationshipGraph[npcId][targetId] = { score: newScore, note };
  if (!this.state.npcRelationshipGraph[targetId]) this.state.npcRelationshipGraph[targetId] = {};
  this.state.npcRelationshipGraph[targetId][npcId] = { score: newScore, note };
}
getSceneConditions(scenarioId: string): import("../dynamicBasicAgent/npcPlanning/types.js").SceneCondition[] {
  return this.state.scenarioConditions[scenarioId] ?? [];
}
appendSceneCondition(scenarioId: string, condition: import("../dynamicBasicAgent/npcPlanning/types.js").SceneCondition): void {
  if (!this.state.scenarioConditions[scenarioId]) this.state.scenarioConditions[scenarioId] = [];
  this.state.scenarioConditions[scenarioId].push(condition);
}
isConnectionBlocked(fromId: string, toId: string): boolean {
  const conn = this.state.connectionStates.find(
    c => (c.fromScenarioId === fromId && c.toScenarioId === toId) ||
         (c.fromScenarioId === toId && c.toScenarioId === fromId)
  );
  return conn?.blocked ?? false;
}
setConnectionBlocked(fromId: string, toId: string, blocked: boolean, reason: string): void {
  let conn = this.state.connectionStates.find(
    c => (c.fromScenarioId === fromId && c.toScenarioId === toId) ||
         (c.fromScenarioId === toId && c.toScenarioId === fromId)
  );
  if (!conn) {
    conn = { fromScenarioId: fromId, toScenarioId: toId, blocked, conditions: [] };
    this.state.connectionStates.push(conn);
  }
  conn.blocked = blocked;
  conn.conditions.push(reason);
}
```

**Step 6: Build check**

```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -20
```

Fix any errors before continuing.

**Step 7: Commit**

```bash
git add src/dynamicworldagent/state/DynamicGameState.ts src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts
git commit -m "feat: add NPC runtime state fields to DynamicGameState"
```

---

## Task 4: Static Data Files

**Files:**
- Create: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/actionTypeSkillMap.ts`
- Create: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/horrorSourceData.ts`

**Step 1: Create actionTypeSkillMap.ts**

Copy the full `ACTION_TYPE_SKILL_MAP` from the design doc (`docs/plans/2026-03-05-npc-planning-system-design.md` section "ActionType → Skill Mapping"). Wrap with:

```typescript
import type { ActionType } from "../../../shared/state/index.js";

export const ACTION_TYPE_SKILL_MAP: Record<ActionType, string[]> = {
  // ... full map from design doc
};
```

**Step 2: Create horrorSourceData.ts**

```typescript
export interface HorrorSource {
  id: string;
  description: string;
  sanLossMin: number;
  sanLossMax: number;
}

export const BASELINE_HORROR_SOURCES: HorrorSource[] = [
  { id: "corpse_fresh",     description: "Seeing a fresh human corpse",                     sanLossMin: 0, sanLossMax: 1 },
  { id: "corpse_mutilated", description: "Seeing a mutilated or dismembered corpse",        sanLossMin: 1, sanLossMax: 5 },
  { id: "undead",           description: "Encountering an undead creature zombie ghoul",     sanLossMin: 0, sanLossMax: 7 },
  { id: "deep_one",         description: "Seeing a Deep One or fish-hybrid creature",        sanLossMin: 0, sanLossMax: 7 },
  { id: "shoggoth",         description: "Encountering a Shoggoth",                         sanLossMin: 7, sanLossMax: 16 },
  { id: "great_old_one",    description: "Seeing a Great Old One or cosmic deity",           sanLossMin: 10, sanLossMax: 20 },
  { id: "mythos_tome",      description: "Reading a Mythos tome cover to cover",             sanLossMin: 7, sanLossMax: 8 },
  { id: "alien_geometry",   description: "Witnessing non-Euclidean geometry or alien space", sanLossMin: 1, sanLossMax: 11 },
  { id: "possession",       description: "Watching someone become possessed",               sanLossMin: 0, sanLossMax: 7 },
  { id: "ritual_sacrifice", description: "Witnessing a ritual sacrifice or murder",         sanLossMin: 0, sanLossMax: 7 },
  { id: "insane_person",    description: "Encountering a violently insane person",           sanLossMin: 0, sanLossMax: 4 },
  { id: "dark_young",       description: "Encountering a Dark Young of Shub-Niggurath",     sanLossMin: 4, sanLossMax: 11 },
  { id: "mi_go",            description: "Seeing a Mi-Go Fungi from Yuggoth",               sanLossMin: 0, sanLossMax: 7 },
  { id: "byakhee",          description: "Seeing a Byakhee",                               sanLossMin: 0, sanLossMax: 7 },
  { id: "nightgaunt",       description: "Seeing a Nightgaunt",                            sanLossMin: 0, sanLossMax: 5 },
  { id: "haunting",         description: "Witnessing a poltergeist or haunting event",     sanLossMin: 0, sanLossMax: 5 },
  { id: "dream_horror",     description: "Experiencing a Mythos nightmare or dream vision", sanLossMin: 0, sanLossMax: 4 },
];
```

**Step 3: Build and commit**

```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -10
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/actionTypeSkillMap.ts \
        src/dynamicworldagent/dynamicBasicAgent/npcPlanning/horrorSourceData.ts
git commit -m "feat: add actionTypeSkillMap and baseline horror sources"
```

---

## Task 5: NPCPlanningAgent — Templates

**Files:**
- Create: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts`

Write 5 template builder functions (see design doc for full context):

1. `buildGenerateLongTermIntentPrompt(params)` — returns string prompt asking for 1 NPC's multi-day intent
2. `buildGenerateDailyPlanPrompt(params)` — returns string prompt for today's node sequence (output: JSON array)
3. `buildRevisePlansPrompt(params)` — returns string prompt for revising pending nodes after failure/impact (output: `{ revisedNodes, shouldUpdateLongTermIntent, updatedLongTermIntent? }`)
4. `buildImpactGatePrompt(params)` — batched prompt for multiple NPCs in one bucket (output: `[{ npcId, shouldRevise, witnessEntry }]`)
5. `buildRelationshipUpdatePrompt(params)` — after character_interaction, update score+note (output: `{ scoreDelta, note }`)

Each prompt must specify:
- Output language (zh/en)
- Exact JSON output schema
- No extra explanation in output

**Build and commit:**

```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -10
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts
git commit -m "feat: add NPCPlanning prompt templates"
```

---

## Task 6: NPCPlanningAgent — Core Class

**Files:**
- Create: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts`

**Step 1: Check existing generateText signature**

```bash
grep -n "generateText" src/dynamicworldagent/dynamicBasicAgent/action/actionAgent.ts | head -5
```

**Step 2: Implement NPCPlanningAgent class with these public methods:**

```typescript
class NPCPlanningAgent {
  constructor(private prisma: PrismaClient) {}

  async generateLongTermIntents(dgsm, sessionId, moduleId, language): Promise<void>
  async generateDailyPlans(dgsm, sessionId, moduleId, gameDay, language): Promise<void>
  async revisePlans(dgsm, sessionId, npcId, context: RevisePlansContext, language): Promise<void>
  async runImpactGate(sessionId, bucketTime, candidates[], language): Promise<Array<{npcId, shouldRevise, witnessEntry}>>
  async updateRelationship(dgsm, npcAId, npcBId, interactionOutcome, language): Promise<void>
  async appendActionLog(sessionId, npcId, entry, gameDay, gameTime, location): Promise<void>
  async getActionLog(sessionId, npcId): Promise<string[]>
  async getPendingNodes(sessionId, npcId, gameDay): Promise<NpcPlanNode[]>
  async getLongTermIntent(sessionId, npcId): Promise<string>
  async getDueNpcNodes(sessionId, gameDay, upToTime, dgsm): Promise<NpcPlanNode[]>
}
```

Key implementation notes:
- `generateLongTermIntents`: parallel `Promise.all` across all NPCs; upsert by `sessionId_npcId` composite ID
- `generateDailyPlans`: parallel across NPCs; parse JSON array from LLM; inject `characterId` + `characterName` into each node before storing
- `revisePlans`: update `NpcDailyPlan.nodes` with revised pending nodes; optionally update `NpcLongTermIntent`
- `runImpactGate`: single LLM call for all candidates; parse JSON array response
- `getDueNpcNodes`: query all `NpcDailyPlan` for the session+day; filter nodes where `gameTime <= upToTime` and `status = "pending"`; parse `nodes` JSON field

**Build and commit:**

```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -20
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts
git commit -m "feat: add NPCPlanningAgent"
```

---

## Task 7: TickProcessor

**Files:**
- Create: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

**Step 1: Check how EmbeddingClient is used elsewhere**

```bash
grep -rn "EmbeddingClient\|embedText" src/dynamicworldagent/ --include="*.ts" | head -10
```

**Step 2: Implement helper functions (pure, no LLM)**

```typescript
// Time helpers
function timeToMinutes(hhmm: string): number
function minutesToBucket(minutes: number, bucketSize = 5): number
function getBucketLabel(bucketMinutes: number): string

// Dice
function rollD100(): number
type SuccessLevel = "critical" | "hard" | "regular" | "fail"
function getSuccessLevel(roll: number, skillValue: number): SuccessLevel

// Skill RAG (keyword overlap — production would use EmbeddingClient)
function selectBestSkill(actionDesc: string, actionType: ActionType, npcSkills: Record<string, number>)
  : { skill: string; value: number } | null

// Horror RAG
function matchHorrorSource(actionDesc: string): { sanLossMin: number; sanLossMax: number }

// Luck failure
function luckFailureRate(luck: number): number  // 0.025 + (100 - luck) * 0.0005

// Damage bonus table (STR + SIZ)
function getDamageBonus(str: number, siz: number): string  // e.g. "+1d4"
```

**Step 3: Implement executeNode**

```typescript
async function executeNode(
  node: NpcPlanNode,
  dgsm: DynamicGameStateManager,
  sessionId: string
): Promise<CharacterAction>
```

Handles all 5 node types per design doc logic. Returns `CharacterAction` with `status` + `outcome` + optional `failureReason`.

**Step 4: Implement resolveSkillRoll**

```typescript
function resolveSkillRoll(
  node: NpcPlanNode,
  adjustedSkills: Record<string, number>,
  attackerId: string,
  defenderId: string | undefined,
  dgsm: DynamicGameStateManager,
  state: DynamicGameState
): { failed: boolean; reason?: string }
```

Handles `combat` (opposed roll + damage), `social` (opposed roll), `chase` (opposed roll), `mental` (SAN roll + Horror RAG), and single-roll for remaining types.

**Step 5: Implement main runTick**

```typescript
export async function runTick(
  playerNode: OrchestratorPlayerNode & { characterId: string; characterName: string },
  dgsm: DynamicGameStateManager,
  npcPlanningAgent: NPCPlanningAgent,
  sessionId: string,
  language?: "en" | "zh"
): Promise<CharacterAction[]>
```

Algorithm:
1. `getDueNpcNodes(sessionId, gameDay, newGameTime, dgsm)` → all due NPC nodes
2. Merge with playerNode → sort by `gameTime ASC`, then DEX DESC
3. Scan unplanned encounters (same-scene NPC pairs with `|score| >= 60`) → insert temp nodes
4. Group into 5-minute buckets
5. For each bucket (sequential):
   - Execute all nodes serially → collect `CharacterAction[]`
   - Append action log for each NPC node
   - On `character_interaction` success → `updateRelationship()`
   - On failure → `revisePlans()` with `FailureTrigger` (no gate)
   - Collect impact > 0 events → determine candidate NPCs per impact level
   - One batched `runImpactGate()` call for all candidates
   - For each gate result (parallel): append witness entry to log; if `shouldRevise` → `revisePlans()` with `ImpactTrigger`
   - Await all `revisePlans` to complete before next bucket
6. `dgsm.advanceGameTime(playerNode.timeAdvanceMinutes)`
7. Return all `CharacterAction[]`

**Build and commit:**

```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -30
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts
git commit -m "feat: add TickProcessor with 5-minute bucket execution and batched impact gate"
```

---

## Task 8: Extend Orchestrator Output

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/orchestrator/orchestratorAgent.ts`
- Modify: corresponding template file (`orchestratorTemplate.ts` or similar)

**Step 1: Read existing orchestrator output type**

```bash
grep -n "ActionAnalysis\|interface.*Output\|outputSchema" src/dynamicworldagent/dynamicBasicAgent/orchestrator/orchestratorAgent.ts | head -20
```

**Step 2: Extend output type to include playerNode**

Add `playerNode?: OrchestratorPlayerNode` to the orchestrator output interface.

**Step 3: Update template**

In the orchestrator JSON output schema, add:

```json
"playerNode": {
  "type": "routine|movement|character_interaction|object_interaction|scene_interaction",
  "actionType": "exploration|social|combat|stealth|chase|mental|environmental|narrative (omit if no skill roll needed)",
  "location": "current scenarioId",
  "targetCharacterId": "npcId (only for character_interaction)",
  "impact": 0,
  "gameTime": "HH:MM",
  "timeAdvanceMinutes": 15,
  "timeConsumption": "instant|short|medium|long|very long"
}
```

Add time estimation guidelines to prompt:
- instant (1-10 min): glancing, brief conversation, opening doors
- short (10-30 min): searching a room, examining clues, simple conversation
- medium (30-120 min): combat, lengthy negotiation, research session
- long (120-360 min): long distance travel, surveillance, extended tasks
- very long (360+ min): sleeping, all-day journeys

**Step 4: Build and commit**

```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -20
git add src/dynamicworldagent/dynamicBasicAgent/orchestrator/
git commit -m "feat: extend Orchestrator to output playerNode with timeAdvanceMinutes"
```

---

## Task 9: Wire TickProcessor into the Graph

**Files:**
- Modify: `src/dynamicworldagent/graph/dynamicGraph.ts`

**Step 1: Read the graph**

Read `src/dynamicworldagent/graph/dynamicGraph.ts` to understand how nodes are connected and where ActionAgent is invoked.

**Step 2: Replace ActionAgent invocation**

Find the graph node that calls `actionAgent.processAction(...)`. Replace with:

```typescript
import { runTick } from "../dynamicBasicAgent/npcPlanning/tickProcessor.js";
import { NPCPlanningAgent } from "../dynamicBasicAgent/npcPlanning/NPCPlanningAgent.js";

// In the action node:
const npcPlanningAgent = new NPCPlanningAgent(prisma);
const playerNodeSpec = state.currentActionAnalysis?.playerNode;
if (playerNodeSpec) {
  const playerChar = dgsm.getState().playerCharacter;
  const characterActions = await runTick(
    { ...playerNodeSpec, characterId: playerChar?.characterId ?? "player", characterName: playerChar?.name ?? "Investigator" },
    dgsm,
    npcPlanningAgent,
    sessionId,
    language
  );
  // Store for KeeperAgent
  state.characterActions = characterActions;
}
```

**Step 3: Wire game initialization**

Find the game init handler (likely in `client/server/game/` or `client/server/turn/`). After module loading completes, add:

```typescript
const npcPlanningAgent = new NPCPlanningAgent(prisma);
await npcPlanningAgent.generateLongTermIntents(dgsm, sessionId, moduleId, language);
await npcPlanningAgent.generateDailyPlans(dgsm, sessionId, moduleId, 1, language);
```

**Step 4: Wire day change**

Find where midnight/day-change is detected. Add:

```typescript
await npcPlanningAgent.generateDailyPlans(dgsm, sessionId, moduleId, newDay, language);
```

**Step 5: Build and commit**

```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -30
git add src/dynamicworldagent/graph/dynamicGraph.ts
git commit -m "feat: wire TickProcessor into graph, replace ActionAgent call"
```

---

## Task 10: Simplify DirectorAgent

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/director/directorAgent.ts`

**Step 1: Read DirectorAgent**

Read the file. Identify what to remove vs keep.

**Step 2: Remove replaced responsibilities**

Remove:
- NPC action timeline / heartbeat generation
- Scene entry snapshot generation
- Global trigger RAG checks

Keep:
- Game ending condition checks (player death, scenario completion, time limit, etc.)

**Step 3: Build and commit**

```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -20
git add src/dynamicworldagent/dynamicBasicAgent/director/directorAgent.ts
git commit -m "refactor: simplify DirectorAgent to game ending checks only"
```

---

## Task 11: Remove HeartbeatAgent

**Files:**
- Delete: `src/dynamicworldagent/dynamicBasicAgent/heartbeat/heartbeatAgent.ts`
- Modify: all files importing it

**Step 1: Find all imports**

```bash
grep -rn "heartbeatAgent\|HeartbeatAgent\|heartbeatActions" src/ --include="*.ts"
```

**Step 2: Remove imports and usages from each file found**

**Step 3: Delete the file**

```bash
rm src/dynamicworldagent/dynamicBasicAgent/heartbeat/heartbeatAgent.ts
```

**Step 4: Build check and commit**

```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -30
git add -A
git commit -m "refactor: remove HeartbeatAgent (replaced by NPCPlanningAgent + TickProcessor)"
```

---

## Task 12: Initialize Runtime State from Module Data

**Files:**
- Modify: `src/dynamicworldagent/state/DynamicGameStateLoader.ts`

**Step 1: Read DynamicGameStateLoader**

Find where NPC profiles and scenario connections are loaded into state.

**Step 2: Populate new runtime fields after loading**

After NPCs and scenarios are loaded:

```typescript
// npcLocations: from NPC profile's initialLocation field
const npcLocations: Record<string, string> = {};
for (const npc of loadedNpcs) {
  npcLocations[npc.characterId] = (npc as any).initialLocation ?? scenarios[0]?.id ?? "unknown";
}

// npcStats: from NPC profile hp/san/con/pow
const npcStats: Record<string, { hp: number; san: number }> = {};
for (const npc of loadedNpcs) {
  npcStats[npc.characterId] = {
    hp: (npc as any).hp ?? (npc as any).con ?? 10,
    san: (npc as any).san ?? (npc as any).pow ?? 50,
  };
}

// npcInventories: from NPC profile inventory field
const npcInventories: Record<string, string[]> = {};
for (const npc of loadedNpcs) {
  npcInventories[npc.characterId] = (npc as any).inventory ?? [];
}

// npcDiscoveredClues: start empty
const npcDiscoveredClues: Record<string, string[]> = {};
for (const npc of loadedNpcs) {
  npcDiscoveredClues[npc.characterId] = [];
}

// npcRelationshipGraph: from module relationship config
const npcRelationshipGraph: Record<string, Record<string, { score: number; note: string }>> = {};
for (const npc of loadedNpcs) {
  const rels: Record<string, { score: number; note: string }> = {};
  for (const rel of (npc as any).relationships ?? []) {
    rels[rel.targetId] = { score: rel.score ?? 0, note: rel.note ?? "" };
  }
  npcRelationshipGraph[npc.characterId] = rels;
}

// connectionStates: from scenario adjacency
const connectionStates = scenarios.flatMap(s =>
  ((s as any).connections ?? []).map((conn: any) => ({
    fromScenarioId: s.id,
    toScenarioId: conn.targetId,
    blocked: conn.blocked ?? false,
    conditions: [],
  }))
);

// Assign to state
state.npcLocations = npcLocations;
state.npcStats = npcStats;
state.npcInventories = npcInventories;
state.npcDiscoveredClues = npcDiscoveredClues;
state.npcRelationshipGraph = npcRelationshipGraph;
state.connectionStates = connectionStates;
state.scenarioConditions = {};
```

**Step 3: Build and commit**

```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -20
git add src/dynamicworldagent/state/DynamicGameStateLoader.ts
git commit -m "feat: initialize NPC runtime state from module data"
```

---

## Task 13: KeeperAgent — Inject NPC CharacterActions

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/keeper/keeperAgent.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/keeper/keeperTemplate.ts`

**Step 1: Read KeeperAgent and template**

Understand what context is currently injected.

**Step 2: Filter and inject relevant NPC actions**

In the KeeperAgent input preparation, filter `state.characterActions` by impact:

```typescript
const playerScene = dgsm.getNpcLocation(playerCharacterId) ?? currentScenarioId;
const relevantNpcActions = (state.characterActions ?? []).filter(action => {
  if (action.characterId === playerCharacterId) return false;
  if (action.impact === 3) return true;
  if (action.impact === 1 && action.targetCharacterId === playerCharacterId) return true;
  if (action.impact === 2) {
    const npcScene = action.location;
    const adjacent = dgsm.getState().connectionStates?.some(c =>
      !c.blocked && (
        (c.fromScenarioId === playerScene && c.toScenarioId === npcScene) ||
        (c.toScenarioId === playerScene && c.fromScenarioId === npcScene)
      )
    );
    return npcScene === playerScene || adjacent;
  }
  return false;
});
```

Inject `relevantNpcActions` into the Keeper prompt as "NPC activities this turn".

**Step 3: Build and commit**

```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -20
git add src/dynamicworldagent/dynamicBasicAgent/keeper/
git commit -m "feat: inject NPC CharacterActions into KeeperAgent narrative"
```

---

## Task 14: Create Index + Final Smoke Test

**Files:**
- Create: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/index.ts`

**Step 1: Create index**

```typescript
export type {
  NpcPlanNode, NpcPlanNodeType, CharacterAction,
  CharacterInteractionPayload, ObjectInteractionPayload,
  SceneConnectionEffect, SceneCondition,
  FailureTrigger, ImpactTrigger, RevisePlansContext,
  OrchestratorPlayerNode, TimeConsumptionLevel, FailureReason,
} from "./types.js";

export { NPCPlanningAgent } from "./NPCPlanningAgent.js";
export { runTick } from "./tickProcessor.js";
export { ACTION_TYPE_SKILL_MAP } from "./actionTypeSkillMap.js";
export { BASELINE_HORROR_SOURCES } from "./horrorSourceData.js";
```

**Step 2: Full build check**

```bash
pnpm build:tsc 2>&1 | grep -E "error TS"
```

Expected: no errors.

**Step 3: Smoke test**

```bash
pnpm build && pnpm chat
```

Test:
1. Start a new game session with an existing module
2. Verify: no startup errors, NpcLongTermIntent and NpcDailyPlan rows appear in DB
3. Submit a player action (e.g., "I look around the room")
4. Verify: narrative response returned, NpcActionLog rows appear, game time advanced

**Step 4: Final commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/index.ts
git commit -m "feat: NPC planning system index and smoke test passed"
```

---

## File Map Summary

| File | Action |
|---|---|
| `prisma/schema.prisma` | Add 3 tables |
| `src/.../npcPlanning/types.ts` | Create |
| `src/.../npcPlanning/actionTypeSkillMap.ts` | Create |
| `src/.../npcPlanning/horrorSourceData.ts` | Create |
| `src/.../npcPlanning/NPCPlanningTemplate.ts` | Create |
| `src/.../npcPlanning/NPCPlanningAgent.ts` | Create |
| `src/.../npcPlanning/tickProcessor.ts` | Create |
| `src/.../npcPlanning/index.ts` | Create |
| `src/dynamicworldagent/state/DynamicGameState.ts` | Add runtime fields + helpers |
| `src/dynamicworldagent/state/DynamicGameStateLoader.ts` | Initialize runtime fields from module |
| `src/.../orchestrator/orchestratorAgent.ts` | Add playerNode output |
| `src/.../director/directorAgent.ts` | Simplify to game ending only |
| `src/.../keeper/keeperAgent.ts` | Inject NPC CharacterActions |
| `src/.../heartbeat/heartbeatAgent.ts` | Delete |
| `src/dynamicworldagent/graph/dynamicGraph.ts` | Wire TickProcessor |
