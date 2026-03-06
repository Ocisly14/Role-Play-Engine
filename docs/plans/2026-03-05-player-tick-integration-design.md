# Player Tick Integration Design

**Date:** 2026-03-05
**Branch:** tick
**Status:** Approved

## Overview

Unify player actions into the tick-based NPC planning system. Replace the LLM-driven ActionAgent with a new PlayerPlanAgent that generates structured `PlanNode[]`, executed by the same TickProcessor that handles NPC nodes. Remove the separate combat system entirely — combat becomes tick-based.

## Core Decisions

| Topic | Decision |
|---|---|
| Orchestrator | Simplified to 3 fields: `targetScenarioName?`, `targetNpcId?`, `impact` |
| PlayerPlanAgent (NEW) | Generates 1+ `PlanNode[]` from player input; decides `actionType` or not based on context |
| Skill selection | Per-node: every node with `actionType` interrupts for player skill selection |
| No `actionType` for player | Auto-succeed (no luck-based failure) |
| Node failure | Stops all remaining player nodes; one more round of NPC nodes + impact gate executes; results to Keeper |
| Combat | Fully tick-based — no separate CombatActionAgentA/B system |
| TickProcessor | Single execution engine for player + NPC nodes |
| Difficulty | Player nodes: LLM decides; NPC nodes: TickProcessor auto-derives from relationship/context |

---

## Type Changes

### Renames

- `NpcPlanNode` -> `PlanNode`
- `NpcPlanNodeType` -> `PlanNodeType`

### PlanNode (updated)

```typescript
interface PlanNode {
  nodeId: string;
  characterId: string;
  characterName: string;
  gameTime: string;              // "HH:MM"
  action: string;
  location: string;
  type: PlanNodeType;
  actionType?: ActionType;       // present = skill check needed
  difficulty?: "regular" | "hard" | "extreme";  // player: LLM sets; NPC: omitted, TickProcessor derives
  impact: 0 | 1 | 2 | 3;
  isPlayer?: boolean;
  targetCharacterId?: string;
  characterInteractionPayload?: CharacterInteractionPayload;
  objectInteractionPayload?: ObjectInteractionPayload;
  sceneConnectionEffect?: SceneConnectionEffect;
  status: "pending" | "completed" | "failed";
  outcome?: string;
  timeAdvanceMinutes: number;    // per-node time
}
```

### Deleted Types

- `ActionAnalysis`
- `ActionResult`
- `NPCResponseAnalysis`
- `SceneChangeRequest`
- `CombatState`
- `PendingNpcAction`
- `OrchestratorPlayerNode` (replaced by `PlanNode`)

---

## New Pipeline Architecture

```
Player Input
  |
[Orchestrator] (simplified)
  - Outputs: { targetScenarioName?, targetNpcId?, impact }
  - Still does: context retrieval (conversation history, relevant history)
  |
[Memory] (unchanged)
  - Enriches context with scenario data, NPC profiles, rules
  |
[PlayerPlanAgent] (NEW)
  - Input: player natural language + full game context
  - Output: PlanNode[] (1 or more)
  - Decides per node: type, actionType or omit, difficulty, impact, timeAdvanceMinutes, payloads
  - Selects clues/secrets player is attempting to discover
  |
[tickExecutionLoop] (graph node, iterative)
  - For each player node:
    1. has actionType? -> interrupt for skill selection
    2. execute this player node + due NPC nodes up to this time point
    3. impact gate for this bucket
    4. player node failed? -> execute remaining NPC due nodes + impact gate -> break
  - Output: CharacterAction[]
  |
[Director] (game ending checks only, unchanged)
  |
[Keeper]
  - Player CharacterActions + relevant NPC CharacterActions (filtered by impact)
  - Full game context (clues, NPC profiles, scene conditions, inventory changes)
  - Generates narrative
```

---

## Simplified Orchestrator

### Output

```typescript
interface OrchestratorOutput {
  targetScenarioName?: string;  // only if player wants to move
  targetNpcId?: string;         // only if player interacts with specific NPC
  impact: 0 | 1 | 2 | 3;
}
```

### Still does

- Extract conversation history from DB (last 3 turns)
- Retrieve relevant history via RAG (score >= 0.7)
- Store both in `contextualData` for downstream agents
- Resolve NPC name -> ID matching
- Resolve scenario name matching from connections

### No longer does

- Node type classification (-> PlayerPlanAgent)
- actionType / time estimation (-> PlayerPlanAgent)
- `requiresSkillSelection` (-> derived from PlanNode.actionType)
- `ActionAnalysis` generation (deleted)
- `SceneChangeRequest` generation (-> PlayerPlanAgent handles movement nodes)

---

## PlayerPlanAgent

**New file**: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanAgent.ts`

Lives alongside NPCPlanningAgent — shares the same types and TickProcessor.

### Input context (injected into LLM prompt)

- Player's natural language input
- Orchestrator output (`targetScenarioName`, `targetNpcId`, `impact`)
- Player character profile (skills, inventory, stats)
- Current scenario (name, description, conditions, connections)
- Target NPC profile (if `targetNpcId` set): personality, goals, secrets, relationship score with player
- Other NPCs in current scene (names, brief profiles)
- Scene conditions (`scenarioConditions[currentScene]`)
- Available clues/secrets in current scene (for discovery actions)
- Recent conversation history (from `contextualData`)
- Selected skill (if player pre-selected one)

### Output

`PlanNode[]` — 1 or more nodes, same structure as NPCPlanningAgent produces.

### LLM responsibilities

- Decompose player input into 1+ `PlanNode` (type, action, location, payloads)
- Decide `actionType` or omit — based on NPC relationships, scene conditions, action nature, clue difficulty
- Decide `difficulty` — based on roleplay quality + clue/action difficulty:
  - Good roleplay / obvious target -> lower difficulty or no actionType
  - Vague action / hidden target -> higher difficulty
- Select which clue/secret the player is attempting to discover (specify in payload)
- Per-node `impact` and `timeAdvanceMinutes`
- For `movement` nodes: use `targetScenarioName` from Orchestrator
- For `character_interaction`: use `targetNpcId` from Orchestrator

### Key difference from NPCPlanningAgent

- NPCPlanningAgent generates full daily plans (many nodes across the day)
- PlayerPlanAgent generates per-turn nodes (1-3 typically)
- Player nodes have no luck-based failure
- Player gets skill selection interrupt per actionType node

---

## TickProcessor Changes

### Signature

```typescript
async function runTick(
  playerNodes: PlanNode[],
  dgsm: DynamicGameStateManager,
  npcPlanningAgent: NPCPlanningAgent,
  sessionId: string,
  selectedSkill?: string | null,
  language?: string
): Promise<CharacterAction[]>
```

### Player node execution rules

- No `actionType` -> auto-succeed (no luck-based failure, unlike NPCs)
- `actionType` present -> skill roll with player-selected skill
- Each `actionType` node triggers graph interrupt for skill selection
- Player node failure -> skip remaining player nodes, but execute remaining NPC due nodes + impact gate

### NPC node difficulty (auto-derived by TickProcessor)

| Context | Relationship Score | Difficulty |
|---|---|---|
| Scene interaction (clues, objects, environment) | N/A | regular |
| Character interaction | >= 70 | luck-based roll only (skip skill) |
| Character interaction | 30 ~ 69 | regular |
| Character interaction | -30 ~ 29 | hard |
| Character interaction | < -30 | extreme |

```typescript
function getNodeDifficulty(
  node: PlanNode,
  dgsm: DynamicGameStateManager
): "regular" | "hard" | "extreme" | "luck_only" {
  // Player nodes: use explicit difficulty
  if (node.isPlayer) return node.difficulty ?? "regular";

  // NPC scene interactions: always regular
  if (node.type !== "character_interaction") return "regular";

  // NPC character interactions: derive from relationship
  const rel = dgsm.getRelationship(node.characterId, node.targetCharacterId!);
  const score = rel?.score ?? 0;
  if (score >= 70) return "luck_only";
  if (score >= 30) return "regular";
  if (score >= -30) return "hard";
  return "extreme";
}
```

### Combat via tick

No special combat mode. Player attacks are `character_interaction` + `actionType: "combat"` nodes.

NPC retaliation flow:
1. Player attacks NPC -> TickProcessor resolves (dice roll)
2. Impact gate fires -> NPC witnesses attack -> `shouldRevise: true`
3. NPC plan revised -> adds combat retaliation nodes
4. Same tick window: retaliation nodes execute in next bucket
5. Next turn: NPC pending combat nodes are "due" and execute alongside player's next action

---

## Graph Routing (Simplified)

### New flow

```
START -> orchestrator -> memory -> playerPlanAgent -> tickExecutionLoop -> director -> keeper -> END
```

### tickExecutionLoop node

Iterative, handles per-node interrupt:

```
for each player node:
  1. has actionType? -> interrupt(skillCandidates) -> receive selectedSkill
  2. execute this player node + due NPC nodes up to this time point
  3. impact gate for this bucket
  4. player node failed? -> execute remaining NPC due nodes + impact gate -> break

return CharacterAction[]
```

### Deleted graph nodes

- `skillSelectionCheck`
- `skillSelectionRequired`
- `action` (ActionAgent)
- `combatActionA`
- `combatActionB`
- `battleKeeper`
- All combat conditional routing

### Deleted DynamicGraphState fields

- `skillSelectionMode`
- `isRestAction`

---

## KeeperAgent Changes

### Input

- `playerActions: CharacterAction[]` — what the player did, each with status + outcome
- `relevantNpcActions: CharacterAction[]` — NPC actions filtered by impact:
  - impact=3: always included
  - impact=2: if NPC in player scene or adjacent
  - impact=1: if targetCharacterId is player
- Full game context: clues (content, not just IDs), NPC profiles, scene conditions, inventory changes, relationship context, conversation history

### No longer needs

- `ActionResult.diceRolls[]` interpretation
- `NPCResponseAnalysis.responseType`
- `SceneChangeRequest`
- `BattleKeeperAgent` — regular Keeper narrates combat like any other action

---

## Deletions

### Files to delete

| File | Reason |
|---|---|
| `dynamicBasicAgent/action/actionAgent.ts` | Replaced by PlayerPlanAgent + TickProcessor |
| `dynamicBasicAgent/action/actionTemplate.ts` | Template for deleted ActionAgent |
| `dynamicBasicAgent/combat/combatActionAgentA.ts` | Combat is now tick-based |
| `dynamicBasicAgent/combat/combatActionAgentB.ts` | Combat is now tick-based |
| `dynamicBasicAgent/combat/battleKeeperAgent.ts` | Combat is now tick-based |
| `dynamicBasicAgent/heartbeat/heartbeatAgent.ts` | Already deleted |

### DynamicGameState fields to remove

- `isBattle`
- `combatState` (entire CombatState interface)
- `combatRound`
- `pendingNpcActions`
- Related temporary fields

### DynamicGraphState fields to remove

- `skillSelectionMode`
- `isRestAction`

### Types to remove from shared/state

- `ActionAnalysis`
- `ActionResult`
- `NPCResponseAnalysis`
- `SceneChangeRequest`
- `CombatState`
- `PendingNpcAction`
- `OrchestratorPlayerNode`

---

## Files Changed Summary

| File | Action |
|---|---|
| `npcPlanning/types.ts` | Rename NpcPlanNode -> PlanNode, add `difficulty`, `isPlayer`, `timeAdvanceMinutes` |
| `npcPlanning/PlayerPlanAgent.ts` | **Create** — new agent |
| `npcPlanning/PlayerPlanTemplate.ts` | **Create** — prompt template |
| `npcPlanning/tickProcessor.ts` | Modify — multi-node player support, difficulty system, per-node interrupt |
| `npcPlanning/index.ts` | Add PlayerPlanAgent export |
| `orchestrator/orchestratorAgent.ts` | Rewrite — strip to 3 fields + context retrieval |
| `orchestrator/orchestratorTemplate.ts` | Rewrite — simplified prompt |
| `keeper/keeperAgent.ts` | Modify — consume CharacterAction[] instead of ActionResult[] |
| `keeper/keeperTemplate.ts` | Modify — new prompt format |
| `graph/dynamicGraph.ts` | Rewrite — remove combat routing, add tickExecutionLoop with per-node interrupt |
| `state/DynamicGameState.ts` | Remove combat state fields |
| `action/actionAgent.ts` | **Delete** |
| `action/actionTemplate.ts` | **Delete** |
| `combat/combatActionAgentA.ts` | **Delete** |
| `combat/combatActionAgentB.ts` | **Delete** |
| `combat/battleKeeperAgent.ts` | **Delete** |
