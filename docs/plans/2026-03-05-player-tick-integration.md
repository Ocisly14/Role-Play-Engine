# Player Tick Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Unify player actions into the tick-based NPC planning system. Replace ActionAgent with PlayerPlanAgent, simplify Orchestrator to 3 fields, remove the separate combat system, and make TickProcessor the single execution engine for both player and NPC nodes.

**Architecture:** Orchestrator classifies player intent (targetScenarioName, targetNpcId, impact) -> PlayerPlanAgent generates PlanNode[] with LLM-decided actionType/difficulty -> TickProcessor executes player + NPC nodes in 5-minute buckets with per-node skill selection interrupts. Combat is fully tick-based (no CombatActionAgentA/B).

**Tech Stack:** TypeScript (NodeNext ESM), LangGraph (interrupt for skill selection), LangChain/generateText, Prisma, existing DynamicGameStateManager pattern.

**Design doc:** `docs/plans/2026-03-05-player-tick-integration-design.md`

---

## Before You Start

- All imports use `.js` extensions (ESM requirement)
- Run `pnpm build:tsc` after each task to catch type errors
- Working directory: `/Users/sunyining/project_SentiEdge/CoC-AI-agent`
- Read any file fully before modifying it
- This plan only touches single-player (`dynamicBasicAgent/` + `graph/`). Multiplayer (`multiplayerAgent/` + `multiplayerGraph/`) is NOT modified.

---

## Task 1: Rename NpcPlanNode -> PlanNode in types.ts

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts`

**Step 1:** Read `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts`.

**Step 2:** Rename all occurrences:
- `NpcPlanNodeType` -> `PlanNodeType`
- `NpcPlanNode` -> `PlanNode`
- Remove `OrchestratorPlayerNode` interface (will be replaced by `PlanNode`)

**Step 3:** Add new fields to `PlanNode`:
```typescript
difficulty?: "regular" | "hard" | "extreme";  // player: LLM sets; NPC: omitted
isPlayer?: boolean;
timeAdvanceMinutes: number;    // per-node time
```

**Step 4:** Update `CharacterAction` — add:
```typescript
isPlayer?: boolean;
difficulty?: "regular" | "hard" | "extreme" | "luck_only";
```

**Step 5:** Remove `TimeConsumptionLevel` type (no longer used).

**Step 6:** Build check:
```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -30
```
Expect errors from files still using old names — that's OK, we fix them next.

**Step 7:** Commit:
```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts
git commit -m "refactor: rename NpcPlanNode to PlanNode, add difficulty/isPlayer/timeAdvanceMinutes"
```

---

## Task 2: Update index.ts exports

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/index.ts`

**Step 1:** Read the file.

**Step 2:** Update exports to use new names:
```typescript
export type {
  PlanNode,
  PlanNodeType,
  CharacterAction,
  CharacterInteractionPayload,
  ObjectInteractionPayload,
  SceneConnectionEffect,
  SceneCondition,
  FailureTrigger,
  ImpactTrigger,
  RevisePlansContext,
  FailureReason,
} from "./types.js";

export { NPCPlanningAgent } from "./NPCPlanningAgent.js";
export { runTick } from "./tickProcessor.js";
export { ACTION_TYPE_SKILL_MAP } from "./actionTypeSkillMap.js";
export { BASELINE_HORROR_SOURCES } from "./horrorSourceData.js";
```

Note: `OrchestratorPlayerNode` and `TimeConsumptionLevel` removed from exports.

**Step 3:** Commit:
```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/index.ts
git commit -m "refactor: update npcPlanning index exports for PlanNode rename"
```

---

## Task 3: Update NPCPlanningAgent for PlanNode rename

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts`

**Step 1:** Read the file.

**Step 2:** Replace all `NpcPlanNode` references with `PlanNode` in imports and type annotations.

**Step 3:** Build check:
```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -20
```

**Step 4:** Commit:
```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts
git commit -m "refactor: update NPCPlanningAgent for PlanNode rename"
```

---

## Task 4: Update TickProcessor for PlanNode rename + difficulty system

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

**Step 1:** Read the entire file.

**Step 2:** Replace all `NpcPlanNode` with `PlanNode` and `OrchestratorPlayerNode` with `PlanNode` in imports and type annotations.

**Step 3:** Add difficulty derivation function:
```typescript
function getNodeDifficulty(
  node: PlanNode,
  dgsm: DynamicGameStateManager
): "regular" | "hard" | "extreme" | "luck_only" {
  if (node.isPlayer) return node.difficulty ?? "regular";
  if (node.type !== "character_interaction") return "regular";
  if (!node.targetCharacterId) return "regular";
  const rel = dgsm.getRelationship(node.characterId, node.targetCharacterId);
  const score = rel?.score ?? 0;
  if (score >= 70) return "luck_only";
  if (score >= 30) return "regular";
  if (score >= -30) return "hard";
  return "extreme";
}
```

**Step 4:** Update `getSuccessLevel` to support difficulty levels:
```typescript
function getSuccessLevelWithDifficulty(
  roll: number,
  skillValue: number,
  difficulty: "regular" | "hard" | "extreme"
): SuccessLevel {
  if (roll === 1) return "critical";
  const threshold =
    difficulty === "extreme" ? Math.floor(skillValue / 5)
    : difficulty === "hard" ? Math.floor(skillValue / 2)
    : skillValue;
  if (roll <= threshold) return "regular"; // passes at required difficulty
  return "fail";
}
```

**Step 5:** Update `resolveSkillRoll` to use `getNodeDifficulty`. For each skill check, get the node's difficulty and use `getSuccessLevelWithDifficulty` instead of `getSuccessLevel`.

**Step 6:** Update `executeNode`:
- For player nodes (`node.isPlayer === true`): skip luck-based failure (no `luckFailureRate` check)
- For NPC nodes with `difficulty === "luck_only"`: skip skill roll, use luck-based roll only

**Step 7:** Update `runTick` signature to accept `PlanNode[]` (multiple player nodes):
```typescript
export async function runTick(
  playerNodes: (PlanNode & { characterId: string; characterName: string })[],
  dgsm: DynamicGameStateManager,
  npcPlanningAgent: NPCPlanningAgent,
  sessionId: string,
  language?: string
): Promise<CharacterAction[]>
```

**Step 8:** Update `runTick` body:
- Merge all `playerNodes` into the priority queue (not just one)
- Track player node failure: if any player node fails, mark remaining player nodes as skipped
- After a player node failure, continue executing NPC nodes in the current bucket + impact gate, then break out of the bucket loop
- Remove the single `playerNode.timeAdvanceMinutes` time advance; instead sum `timeAdvanceMinutes` from all executed player nodes

**Step 9:** Build check:
```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -30
```

**Step 10:** Commit:
```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts
git commit -m "feat: update TickProcessor for multi-node player, difficulty system, player failure cascade"
```

---

## Task 5: Create PlayerPlanAgent template

**Files:**
- Create: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanTemplate.ts`

**Step 1:** Create the template file with a single function:

```typescript
export interface PlayerPlanParams {
  playerInput: string;
  playerName: string;
  playerProfile: string;         // skills, inventory, stats
  currentScenarioName: string;
  currentScenarioDescription: string;
  scenarioClues: string;         // available clues in current scene
  sceneConditions: string;
  connections: string;            // connected scenes
  targetNpcProfile: string;       // full profile if targetNpcId set
  targetNpcRelationship: string;  // relationship score + note
  sceneNpcs: string;             // other NPCs in scene
  conversationHistory: string;
  orchestratorHints: string;      // targetScenarioName, targetNpcId, impact
  language: string;
}

export function buildPlayerPlanPrompt(params: PlayerPlanParams): string {
  // ... prompt content
}
```

The prompt should instruct the LLM to:
- Decompose player input into 1+ PlanNode (JSON array)
- Decide `type` from: routine, movement, character_interaction, object_interaction, scene_interaction
- Decide `actionType` or omit — based on context:
  - NPC relationships: friendly NPC + casual conversation -> no actionType
  - Clue difficulty: obvious clue -> no actionType; hidden clue -> actionType with difficulty
  - Action nature: attacking -> always actionType: combat
- Decide `difficulty` when actionType is present — based on roleplay quality:
  - Detailed, creative roleplay -> lower difficulty
  - Vague or generic action -> higher difficulty
- Set per-node `impact`, `timeAdvanceMinutes`, payloads
- Select clue/secret being attempted (reference by ID from available clues list)
- For movement: use `targetScenarioName` from orchestrator hints
- For character_interaction: use `targetNpcId` from orchestrator hints

Output schema:
```json
[
  {
    "nodeId": "unique-id",
    "gameTime": "HH:MM",
    "action": "description",
    "location": "current scenario id",
    "type": "...",
    "actionType": "optional",
    "difficulty": "regular|hard|extreme (only when actionType present)",
    "impact": 0,
    "timeAdvanceMinutes": 15,
    "targetCharacterId": "optional",
    "characterInteractionPayload": {},
    "objectInteractionPayload": {},
    "sceneConnectionEffect": {},
    "status": "pending"
  }
]
```

**Step 2:** Build check:
```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -10
```

**Step 3:** Commit:
```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanTemplate.ts
git commit -m "feat: add PlayerPlanAgent prompt template"
```

---

## Task 6: Create PlayerPlanAgent

**Files:**
- Create: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanAgent.ts`

**Step 1:** Check existing `generateText` usage pattern:
```bash
grep -n "generateText" src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts | head -5
```

**Step 2:** Implement the agent class:

```typescript
import { generateText, ModelClass } from "../../../models/index.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { buildPlayerPlanPrompt } from "./PlayerPlanTemplate.js";
import type { PlanNode } from "./types.js";

export class PlayerPlanAgent {
  constructor(private runtime: any) {}

  async generatePlayerNodes(
    playerInput: string,
    dgsm: DynamicGameStateManager,
    orchestratorOutput: {
      targetScenarioName?: string;
      targetNpcId?: string;
      impact: 0 | 1 | 2 | 3;
    },
    selectedSkill?: string | null,
    language?: string
  ): Promise<PlanNode[]> {
    const state = dgsm.getState();
    // ... build context from state (player profile, scenario, NPCs, clues, relationships)
    // ... call generateText with buildPlayerPlanPrompt
    // ... parse JSON response
    // ... inject characterId, characterName, isPlayer=true, location into each node
    // ... return PlanNode[]
  }
}
```

Key implementation details:
- Read player character profile from `state.playerCharacter`
- Read target NPC profile from `state.npcCharacters.find(n => n.id === targetNpcId)`
- Read relationship from `dgsm.getRelationship(playerId, targetNpcId)`
- Read available clues from `state.currentScenario?.clues` or scenario snapshot
- Read scene conditions from `dgsm.getSceneConditions(currentScenarioId)`
- Read connections from `state.scenarioOutlines` matching current scenario
- Read conversation history from `state.temporaryInfo.contextualData.conversationHistory`
- Set `isPlayer: true` on all output nodes
- Set `location` to current scenario ID
- Set `gameTime` to current `state.timeOfDay` + cumulative `timeAdvanceMinutes`

**Step 3:** Build check:
```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -20
```

**Step 4:** Commit:
```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanAgent.ts
git commit -m "feat: add PlayerPlanAgent"
```

---

## Task 7: Update npcPlanning index.ts with PlayerPlanAgent

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/index.ts`

**Step 1:** Add export:
```typescript
export { PlayerPlanAgent } from "./PlayerPlanAgent.js";
```

**Step 2:** Commit:
```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/index.ts
git commit -m "feat: export PlayerPlanAgent from npcPlanning index"
```

---

## Task 8: Simplify Orchestrator

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/orchestrator/orchestratorAgent.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/orchestrator/orchestratorTemplate.ts`

**Step 1:** Read both files fully.

**Step 2:** Rewrite `orchestratorTemplate.ts`:

The new template asks the LLM for only 3 things:
```json
{
  "targetScenarioName": "exact scenario name from connections (omit if not moving)",
  "targetNpcId": "NPC id from Available NPCs (omit if not interacting with specific NPC)",
  "impact": 0
}
```

Keep the existing context sections in the template (game context, NPC list, connections, conversation history, relevant history) — these help the LLM make accurate decisions about target matching and impact.

**Step 3:** Rewrite `orchestratorAgent.ts`:

Keep:
- Context retrieval logic (conversation history, relevant history via RAG)
- Storing context in `contextualData` for downstream agents
- NPC name/ID resolution logic
- Scenario name matching from connections

Remove:
- `ActionAnalysis` generation and `setActionAnalysis()` call
- `SceneChangeRequest` generation and `setSceneChangeRequest()` call
- `playerNode` generation and `setPlayerNode()` call
- `requiresSkillSelection` logic
- All ActionType/timeAdvanceMinutes handling

New output: Store orchestrator result in `contextualData` for PlayerPlanAgent:
```typescript
gameStateManager.setContextualData("orchestratorOutput", {
  targetScenarioName: parsed.targetScenarioName ?? null,
  targetNpcId: parsed.targetNpcId ?? null,
  impact: parsed.impact ?? 0,
});
```

Remove imports of `ActionAnalysis`, `ActionType`, `SceneChangeRequest` from `../../shared/state/index.js`.

**Step 4:** Build check:
```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -30
```
Expect errors — downstream consumers of `ActionAnalysis`, `SceneChangeRequest` etc. will break. That's OK, we fix those in subsequent tasks.

**Step 5:** Commit:
```bash
git add src/dynamicworldagent/dynamicBasicAgent/orchestrator/
git commit -m "refactor: simplify Orchestrator to targetScenarioName/targetNpcId/impact"
```

---

## Task 9: Remove combat state from DynamicGameState

**Files:**
- Modify: `src/dynamicworldagent/state/DynamicGameState.ts`

**Step 1:** Read the file fully (it's large).

**Step 2:** Remove interfaces:
- `PendingNpcAction` (lines ~50-54)
- `CombatState` (lines ~59-64)

**Step 3:** Remove from `DynamicGameState` interface:
- `isBattle: boolean`
- `combatState: CombatState | null`
- Keep `defeatedNpcHistory` (may still be useful for Keeper narrative context)

**Step 4:** Remove from `DynamicTemporaryInfo` interface:
- `actionResults: ActionResult[]`
- `actionResultsDetailed: Array<Record<string, unknown>>`
- `currentActionAnalysis: ActionAnalysis | null`
- `npcResponseAnalyses: NPCResponseAnalysis[]`
- `sceneChangeRequest: SceneChangeRequest | null`
- Keep `playerNode` — but change type from `OrchestratorPlayerNode` to `PlanNode[]`:
  ```typescript
  playerNodes: import("../dynamicBasicAgent/npcPlanning/types.js").PlanNode[];
  ```
- Keep `characterActions`

**Step 5:** Remove from `initialDynamicGameState`:
- `isBattle: false`
- `combatState: null`
- `actionResults: []`
- `actionResultsDetailed: []`
- `currentActionAnalysis: null`
- `npcResponseAnalyses: []`
- `sceneChangeRequest: null`
- Change `playerNode: null` to `playerNodes: []`

**Step 6:** Remove imports of `ActionAnalysis`, `ActionResult`, `NPCResponseAnalysis`, `SceneChangeRequest` from `../../shared/state/index.js`.

**Step 7:** Remove/update DynamicGameStateManager methods:
- Remove: `setActionAnalysis()`, `setSceneChangeRequest()`, `clearSceneChangeRequest()`, `addActionResult()`, `addActionResultDetail()`
- Update `setPlayerNode()` -> `setPlayerNodes(nodes: PlanNode[])` and `getPlayerNode()` -> `getPlayerNodes(): PlanNode[]`
- Remove any combat-related helper methods (search for `isBattle`, `combatState`, `combatRound`)

**Step 8:** Build check:
```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -40
```
Expect many errors — graph, keeper, director, memory agents all reference removed fields. Fixed in subsequent tasks.

**Step 9:** Commit:
```bash
git add src/dynamicworldagent/state/DynamicGameState.ts
git commit -m "refactor: remove combat state and legacy ActionResult/ActionAnalysis from DynamicGameState"
```

---

## Task 10: Update DynamicGameState state/index.ts exports

**Files:**
- Modify: `src/dynamicworldagent/state/index.ts`

**Step 1:** Read the file.

**Step 2:** Remove any re-exports of `PendingNpcAction`, `CombatState` if present. Ensure `ScenarioConnectionState` is still exported.

**Step 3:** Commit:
```bash
git add src/dynamicworldagent/state/index.ts
git commit -m "refactor: update state index exports"
```

---

## Task 11: Update dynamicBasicAgent/index.ts

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/index.ts`

**Step 1:** Read the file.

**Step 2:** Remove `ActionAgent` export. Add `PlayerPlanAgent` export:
```typescript
export { OrchestratorAgent } from "./orchestrator/orchestratorAgent.js";
export { PlayerPlanAgent } from "./npcPlanning/PlayerPlanAgent.js";
export { CharacterAgent } from "./character/characterAgent.js";
export { DirectorAgent } from "./director/directorAgent.js";
export { KeeperAgent } from "./keeper/keeperAgent.js";
export * from "./memory/memoryAgent.js";
```

**Step 3:** Commit:
```bash
git add src/dynamicworldagent/dynamicBasicAgent/index.ts
git commit -m "refactor: replace ActionAgent with PlayerPlanAgent in index exports"
```

---

## Task 12: Update DirectorAgent

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/director/directorAgent.ts`

**Step 1:** Read the file.

**Step 2:** Remove any references to `ActionResult`, `ActionAnalysis`, `NPCResponseAnalysis`, `SceneChangeRequest`, `isBattle`, `combatState`. The director should only check game ending conditions using `CharacterAction[]` from `state.temporaryInfo.characterActions` and the current game state.

**Step 3:** Build check:
```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -20
```

**Step 4:** Commit:
```bash
git add src/dynamicworldagent/dynamicBasicAgent/director/directorAgent.ts
git commit -m "refactor: update DirectorAgent for removed ActionResult/combat state"
```

---

## Task 13: Update CharacterAgent

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/character/characterAgent.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/character/characterTemplate.ts`

**Step 1:** Read both files.

**Step 2:** The CharacterAgent's NPC response functionality is now handled by TickProcessor's impact gate. If CharacterAgent is still used elsewhere (e.g., for NPC profile loading), keep that functionality. Remove any logic that produces `NPCResponseAnalysis[]` or references `ActionResult`.

**Step 3:** Build check:
```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -20
```

**Step 4:** Commit:
```bash
git add src/dynamicworldagent/dynamicBasicAgent/character/
git commit -m "refactor: update CharacterAgent, remove NPCResponseAnalysis generation"
```

---

## Task 14: Update KeeperAgent

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/keeper/keeperAgent.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/keeper/keeperTemplate.ts`

**Step 1:** Read both files fully.

**Step 2:** Rewrite KeeperAgent input to consume `CharacterAction[]`:

The agent should:
1. Get `characterActions` from `state.temporaryInfo.characterActions`
2. Split into `playerActions` (where `isPlayer === true`) and `npcActions`
3. Filter `npcActions` by impact:
   - `impact === 3`: always include
   - `impact === 2`: include if NPC in player scene or adjacent scene
   - `impact === 1`: include if `targetCharacterId` is player
4. Inject into prompt:
   - Player action outcomes (action description + status + outcome)
   - Relevant NPC action outcomes
   - Full game context: current scenario, clue content (cross-reference clue IDs from scenario), NPC profiles (personality, appearance for dialogue), scene conditions, inventory changes, relationship context, conversation history

**Step 3:** Rewrite KeeperTemplate:

Remove references to:
- `ActionResult.diceRolls[]`
- `NPCResponseAnalysis`
- `SceneChangeRequest`
- `BattleKeeperAgent` format

New template structure:
```
## Player Actions This Turn
{{#each playerActions}}
- [{{status}}] {{action}}: {{outcome}}
{{/each}}

## NPC Activities (perceived by player)
{{#each relevantNpcActions}}
- {{characterName}} at {{location}}: {{outcome}}
{{/each}}

## Scene Context
...existing scene/NPC/clue context...
```

**Step 4:** Remove imports of `ActionResult`, `NPCResponseAnalysis`, `SceneChangeRequest`.

**Step 5:** Build check:
```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -20
```

**Step 6:** Commit:
```bash
git add src/dynamicworldagent/dynamicBasicAgent/keeper/
git commit -m "feat: rewrite KeeperAgent to consume CharacterAction[] from TickProcessor"
```

---

## Task 15: Update Memory Agent / TurnManager

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/memory/memoryAgent.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/memory/turnManager.ts`

**Step 1:** Read both files.

**Step 2:** In `memoryAgent.ts`: remove any references to `ActionAnalysis`, `ActionResult`, `NPCResponseAnalysis`. The memory enrichment logic should still work with the simplified state — it enriches scenario data, NPC profiles, rules. The `ActionAnalysis` was used to determine which rules to load; now use `characterActions` or `playerNodes` instead.

**Step 3:** In `turnManager.ts`: update turn persistence to store `CharacterAction[]` instead of `ActionResult[]`. Remove references to `ActionAnalysis`, `NPCResponseAnalysis`, `SceneChangeRequest`. The turn record should capture `characterActions` as the primary action data.

**Step 4:** Build check:
```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -20
```

**Step 5:** Commit:
```bash
git add src/dynamicworldagent/dynamicBasicAgent/memory/
git commit -m "refactor: update memoryAgent and turnManager for CharacterAction[]"
```

---

## Task 16: Rewrite Graph Routing

**Files:**
- Modify: `src/dynamicworldagent/graph/dynamicGraph.ts`

This is the biggest task. Read the entire file first.

**Step 1:** Read `src/dynamicworldagent/graph/dynamicGraph.ts` fully.

**Step 2:** Remove imports:
```typescript
// DELETE these imports:
import { ActionAgent } from "../dynamicBasicAgent/action/actionAgent.js";
import { BattleKeeperAgent } from "../dynamicBasicAgent/combat/battleKeeperAgent.js";
import { CombatActionAgentA } from "../dynamicBasicAgent/combat/combatActionAgentA.js";
import type { CombatActionAResult } from "../dynamicBasicAgent/combat/combatActionAgentA.js";
import { CombatActionAgentB } from "../dynamicBasicAgent/combat/combatActionAgentB.js";
```

Add imports:
```typescript
import { PlayerPlanAgent } from "../dynamicBasicAgent/npcPlanning/PlayerPlanAgent.js";
import type { PlanNode } from "../dynamicBasicAgent/npcPlanning/types.js";
import { ACTION_TYPE_SKILL_MAP } from "../dynamicBasicAgent/npcPlanning/actionTypeSkillMap.js";
```

**Step 3:** Remove `DynamicGraphState` fields:
- `skillSelectionMode`
- `isRestAction`

**Step 4:** Remove agent instantiations:
```typescript
// DELETE:
const actionAgent = new ActionAgent(...);
const combatAgentA = new CombatActionAgentA();
const combatAgentB = new CombatActionAgentB();
const battleKeeper = new BattleKeeperAgent();
```

Add:
```typescript
const playerPlanAgent = new PlayerPlanAgent(runtime);
```

**Step 5:** Replace the `action` node with `playerPlanAgent` node:

```typescript
graph.addNode("playerPlanAgent", async (state: DynamicGraphState) => {
  const dgsm = new DynamicGameStateManager(state.dynamicGameState);
  const userInput = latestHumanMessage(state.messages);
  const language = state.language ?? "zh";
  const selectedSkill = state.selectedSkill ?? null;

  const orchestratorOutput = dgsm.getState().temporaryInfo.contextualData?.orchestratorOutput ?? {
    targetScenarioName: null,
    targetNpcId: null,
    impact: 0,
  };

  const playerNodes = await playerPlanAgent.generatePlayerNodes(
    userInput,
    dgsm,
    orchestratorOutput,
    selectedSkill,
    language
  );

  dgsm.setPlayerNodes(playerNodes);
  return { ...state, dynamicGameState: dgsm.getState() };
});
```

**Step 6:** Replace `skillSelectionCheck` + `skillSelectionRequired` + `action` with `tickExecutionLoop` node:

```typescript
graph.addNode("tickExecutionLoop", async (state: DynamicGraphState) => {
  const dgsm = new DynamicGameStateManager(state.dynamicGameState);
  const language = state.language ?? "zh";
  const selectedSkill = state.selectedSkill ?? null;
  const playerNodes = dgsm.getPlayerNodes();

  if (playerNodes.length === 0) {
    return { ...state, dynamicGameState: dgsm.getState() };
  }

  // Check if first unprocessed player node with actionType needs skill selection
  const nextActionTypeNode = playerNodes.find(
    n => n.status === "pending" && n.actionType && !n.isPlayer // wrong — should check isPlayer
  );
  // Actually: find first pending player node with actionType
  const nextPlayerNodeNeedingSkill = playerNodes.find(
    n => n.status === "pending" && n.actionType
  );

  if (nextPlayerNodeNeedingSkill && !selectedSkill) {
    // Interrupt for skill selection
    const candidates = ACTION_TYPE_SKILL_MAP[nextPlayerNodeNeedingSkill.actionType!] ?? [];
    const playerSkills = dgsm.getState().playerCharacter?.skills ?? {};
    const availableSkills = candidates.filter(s => playerSkills[s] !== undefined);

    interrupt({
      action: nextPlayerNodeNeedingSkill.action,
      actionType: nextPlayerNodeNeedingSkill.actionType,
      difficulty: nextPlayerNodeNeedingSkill.difficulty,
      availableSkills,
      requiresSkillSelection: true,
    });
  }

  // Execute via TickProcessor
  const characterActions = await runTick(
    playerNodes.filter(n => n.status === "pending"),
    dgsm,
    npcPlanningAgent,
    dgsm.getState().sessionId,
    language
  );

  dgsm.setCharacterActions(characterActions);
  return { ...state, dynamicGameState: dgsm.getState() };
});
```

Note: The per-node interrupt logic is complex. When the graph resumes after interrupt, `selectedSkill` will be populated. TickProcessor uses it for the first actionType node and auto-selects for the rest. If another player node with actionType remains after execution, the graph will need to loop back. This may require a conditional edge from tickExecutionLoop back to itself.

**Step 7:** Remove all combat nodes:
- Delete `combatActionA` node
- Delete `combatActionB` node
- Delete `battleKeeper` node
- Delete all combat conditional edges

**Step 8:** Set up new graph edges:

```typescript
graph.addEdge(START, "orchestrator");
graph.addEdge("orchestrator", "memory");
graph.addEdge("memory", "playerPlanAgent");
graph.addEdge("playerPlanAgent", "tickExecutionLoop");

// tickExecutionLoop may interrupt and resume, then continues to director
graph.addEdge("tickExecutionLoop", "director");
graph.addEdge("director", "keeper");
graph.addEdge("keeper", END);
```

**Step 9:** Build check:
```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -40
```

**Step 10:** Commit:
```bash
git add src/dynamicworldagent/graph/dynamicGraph.ts
git commit -m "feat: rewrite graph with PlayerPlanAgent + tickExecutionLoop, remove combat routing"
```

---

## Task 17: Delete Old Files

**Files:**
- Delete: `src/dynamicworldagent/dynamicBasicAgent/action/actionAgent.ts`
- Delete: `src/dynamicworldagent/dynamicBasicAgent/action/actionTemplate.ts`
- Delete: `src/dynamicworldagent/dynamicBasicAgent/combat/combatActionAgentA.ts`
- Delete: `src/dynamicworldagent/dynamicBasicAgent/combat/combatActionAgentATemplate.ts`
- Delete: `src/dynamicworldagent/dynamicBasicAgent/combat/combatActionAgentB.ts`
- Delete: `src/dynamicworldagent/dynamicBasicAgent/combat/combatActionAgentBTemplate.ts`
- Delete: `src/dynamicworldagent/dynamicBasicAgent/combat/battleKeeperAgent.ts`
- Delete: `src/dynamicworldagent/dynamicBasicAgent/combat/battleKeeperTemplate.ts`

**Step 1:** Verify no remaining imports:
```bash
grep -rn "actionAgent\|actionTemplate\|combatActionAgentA\|combatActionAgentB\|battleKeeperAgent\|battleKeeperTemplate" src/dynamicworldagent/dynamicBasicAgent/ --include="*.ts" | grep -v "node_modules"
grep -rn "actionAgent\|combatActionAgentA\|combatActionAgentB\|battleKeeperAgent" src/dynamicworldagent/graph/ --include="*.ts"
```

If any imports remain, fix them first.

**Step 2:** Delete files:
```bash
rm src/dynamicworldagent/dynamicBasicAgent/action/actionAgent.ts
rm src/dynamicworldagent/dynamicBasicAgent/action/actionTemplate.ts
rm -rf src/dynamicworldagent/dynamicBasicAgent/combat/
```

**Step 3:** Build check:
```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -20
```

**Step 4:** Commit:
```bash
git add -A
git commit -m "refactor: delete ActionAgent, combat agents (replaced by PlayerPlanAgent + tick-based combat)"
```

---

## Task 18: Final Build + Cleanup

**Step 1:** Full build:
```bash
pnpm build:tsc 2>&1 | grep -E "error TS"
```

**Step 2:** Fix any remaining type errors. Common issues:
- Stale imports of deleted types
- References to removed `temporaryInfo` fields
- Missing `timeAdvanceMinutes` on PlanNode instances
- `updateGameTime` calls that need updating

**Step 3:** Run formatter:
```bash
pnpm check
```

**Step 4:** Final commit:
```bash
git add -A
git commit -m "fix: resolve all type errors after player tick integration"
```

---

## File Map Summary

| File | Action |
|---|---|
| `npcPlanning/types.ts` | Rename NpcPlanNode -> PlanNode, add fields |
| `npcPlanning/index.ts` | Update exports |
| `npcPlanning/NPCPlanningAgent.ts` | Update for PlanNode rename |
| `npcPlanning/tickProcessor.ts` | Multi-node player, difficulty system, failure cascade |
| `npcPlanning/PlayerPlanTemplate.ts` | **Create** |
| `npcPlanning/PlayerPlanAgent.ts` | **Create** |
| `orchestrator/orchestratorAgent.ts` | Simplify to 3 fields |
| `orchestrator/orchestratorTemplate.ts` | Simplify prompt |
| `state/DynamicGameState.ts` | Remove combat state, legacy types |
| `state/index.ts` | Update exports |
| `dynamicBasicAgent/index.ts` | Replace ActionAgent with PlayerPlanAgent |
| `director/directorAgent.ts` | Remove ActionResult/combat refs |
| `character/characterAgent.ts` | Remove NPCResponseAnalysis |
| `keeper/keeperAgent.ts` | Consume CharacterAction[] |
| `keeper/keeperTemplate.ts` | New prompt format |
| `memory/memoryAgent.ts` | Remove ActionAnalysis refs |
| `memory/turnManager.ts` | Store CharacterAction[] |
| `graph/dynamicGraph.ts` | Rewrite routing |
| `action/actionAgent.ts` | **Delete** |
| `action/actionTemplate.ts` | **Delete** |
| `combat/combatActionAgentA.ts` | **Delete** |
| `combat/combatActionAgentATemplate.ts` | **Delete** |
| `combat/combatActionAgentB.ts` | **Delete** |
| `combat/combatActionAgentBTemplate.ts` | **Delete** |
| `combat/battleKeeperAgent.ts` | **Delete** |
| `combat/battleKeeperTemplate.ts` | **Delete** |
