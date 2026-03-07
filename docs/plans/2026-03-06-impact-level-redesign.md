# Impact Level Redesign (0–3 → 0–5) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expand the impact system from 4 levels (0–3) to 6 levels (0–5) to match the two-level scene graph architecture (sub-scenes within macro locations connected by a transport network).

**Architecture:** The impact gate in tickProcessor dispatches events to characters based on spatial proximity. Currently uses flat scene adjacency; will use the scene graph hierarchy: sub-scene → macro location → neighborhood (≤15min travel) → global. The impact gate logic is duplicated in `runTick` and `resumeTick` — we extract it into a shared function first.

**Tech Stack:** TypeScript, LangGraph state types, LLM prompt templates

**Dependency:** Requires scene graph types (`DynamicScene.parentLocationId`, `TransportEdge[]`, `ScenarioOutline.subSceneCount`) from the scene-graph-module-generation design. Tasks 1-4 can proceed independently; Tasks 5-6 require scene graph types to exist.

---

### Task 1: Update impact type in types.ts

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts:44,76`

**Step 1: Update PlanNode.impact type**

Change line 44:
```typescript
// Before:
impact: 0 | 1 | 2 | 3;
// After:
impact: 0 | 1 | 2 | 3 | 4 | 5;
```

**Step 2: Update CharacterAction.impact type**

Change line 76:
```typescript
// Before:
impact: 0 | 1 | 2 | 3;
// After:
impact: 0 | 1 | 2 | 3 | 4 | 5;
```

**Step 3: Build to verify no type errors**

Run: `pnpm build`
Expected: SUCCESS (widening a union type is backward-compatible)

**Step 4: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts
git commit -m "refactor: expand impact type from 0-3 to 0-5"
```

---

### Task 2: Update Orchestrator template

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/orchestrator/orchestratorTemplate.ts:59-69`

**Step 1: Replace the Impact Level section**

Replace lines 59-69 in the template string with:

```typescript
### 3. Impact Level
Impact determines **who in the game world perceives and is affected by** the action. Rate on a 0-5 scale based on observability and consequence scope:

- **0 — Private / unnoticed**: Only the acting character knows. No one else perceives or reacts.
  Examples: thinking, reading a book alone, checking personal belongings, quietly observing from afar, writing notes, resting, recalling memories
- **1 — Targeted / one-on-one**: Only the specific target character perceives it. A private exchange between two people.
  Examples: whispering to someone, passing a note, pickpocketing a specific person, private conversation, discreetly handing over an item, subtle gesture to one person
- **2 — Sub-scene / room-wide**: Everyone present in the same room or sub-scene perceives it.
  Examples: speaking loudly, firing a gun, breaking down a door, starting a fight, searching a room openly, screaming, knocking over furniture
- **3 — Building / macro-location-wide**: Everyone in the same building or macro location perceives it (all sub-scenes within the building).
  Examples: fire alarm, shouting down a stairwell, an event audible throughout a building, smoke filling all floors
- **4 — Neighborhood**: Perceived across the immediate area — the current building and nearby buildings within walking distance.
  Examples: explosion heard across the block, gunshot echoing through nearby streets, a building collapse, large fire with visible smoke
- **5 — Global / far-reaching**: The entire game world is affected. The consequences ripple everywhere.
  Examples: triggering a town-wide alarm, completing a summoning ritual, radio/PA broadcast, earthquake, actions that fundamentally alter the story state for all characters
```

**Step 2: Build to verify**

Run: `pnpm build`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/orchestrator/orchestratorTemplate.ts
git commit -m "docs: update orchestrator template impact levels to 0-5"
```

---

### Task 3: Update NPC Planning template

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts:115-124,227-231`

**Step 1: Replace impact levels in daily plan prompt**

Replace lines 115-124 in `buildGenerateDailyPlanPrompt`:

```typescript
## Impact Levels
Impact determines **who perceives and is affected by** the action:
- **0 — Private / unnoticed**: Only the acting character knows. No one else perceives or reacts.
  Examples: thinking, reading alone, checking belongings, observing from afar, writing notes, resting
- **1 — Targeted / one-on-one**: Only the specific target character perceives it. A private exchange.
  Examples: whispering, passing a note, pickpocketing someone, private conversation, discreet item handoff
- **2 — Sub-scene / room-wide**: Everyone in the current room or sub-scene perceives it. Visible/audible to bystanders in the same room.
  Examples: speaking loudly, firing a gun, breaking a door, starting a fight, searching a room openly, screaming
- **3 — Building / macro-location-wide**: Everyone in the same building or macro location perceives it (all rooms/floors).
  Examples: fire alarm, shouting down a stairwell, smoke filling the building, event audible throughout
- **4 — Neighborhood**: Perceived at the current building and nearby buildings within walking distance.
  Examples: explosion heard across the block, gunshot echoing through nearby streets, building collapse, large fire
- **5 — Global / far-reaching**: The entire game world is affected. Consequences ripple everywhere.
  Examples: triggering a town alarm, summoning ritual, building collapse, radio broadcast
```

**Step 2: Replace impact gate witness descriptions**

Replace lines 227-231 in `buildImpactGatePrompt`:

```typescript
Each event has an impact level indicating proximity:
- impact 1: directly targeted (private, one-on-one)
- impact 2: same room/sub-scene (directly witnessed)
- impact 3: same building (heard/felt through walls or floors)
- impact 4: nearby area (distant sound, visible smoke, rumor from next door)
- impact 5: global event (news, supernatural disturbance, widespread effect)
```

**Step 3: Build to verify**

Run: `pnpm build`
Expected: SUCCESS

**Step 4: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts
git commit -m "docs: update NPC planning template impact levels to 0-5"
```

---

### Task 4: Update Player Plan template

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanTemplate.ts:161-170`

**Step 1: Replace impact levels section**

Replace lines 161-170 in `buildPlayerPlanPrompt`:

```typescript
## Impact Levels
Impact determines **who in the game world perceives and is affected by** the action:
- **0 — Private / unnoticed**: Only the acting character knows. No one else perceives or reacts.
  Examples: thinking, reading alone, checking belongings, observing from afar, writing notes, resting
- **1 — Targeted / one-on-one**: Only the specific target character perceives it. A private exchange.
  Examples: whispering, passing a note, pickpocketing someone, private conversation, discreet item handoff
- **2 — Sub-scene / room-wide**: Everyone in the current room or sub-scene perceives it. Visible/audible to bystanders.
  Examples: speaking loudly, firing a gun, breaking a door, starting a fight, searching a room openly, screaming
- **3 — Building / macro-location-wide**: Everyone in the same building or macro location perceives it (all rooms/floors).
  Examples: fire alarm, shouting down a stairwell, smoke filling the building, event audible throughout
- **4 — Neighborhood**: Perceived at the current building and nearby buildings within walking distance.
  Examples: explosion heard across the block, gunshot echoing, building collapse, large fire
- **5 — Global / far-reaching**: The entire game world is affected. Consequences ripple everywhere.
  Examples: triggering a town alarm, summoning ritual, radio broadcast, earthquake
```

**Step 2: Build to verify**

Run: `pnpm build`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanTemplate.ts
git commit -m "docs: update player plan template impact levels to 0-5"
```

---

### Task 5: Extract shared impact gate function from tickProcessor

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

The impact gate logic is duplicated in `runTick` (~lines 1079-1200) and `resumeTick` (~lines 1364-1454). Extract into a shared function before adding new levels.

**Step 1: Add the `findNeighborMacroLocations` helper**

Add near the top of tickProcessor.ts (after existing helpers):

```typescript
import type { TransportEdge } from "../../world_builder/types.js";

/**
 * BFS on transport network to find macro locations reachable within maxTravelMinutes.
 * Returns macroLocationIds (excluding fromLocationId itself).
 */
function findNeighborMacroLocations(
  fromLocationId: string,
  transportEdges: TransportEdge[],
  maxTravelMinutes: number
): string[] {
  const visited = new Map<string, number>(); // locationId -> best travel time
  visited.set(fromLocationId, 0);
  const queue: Array<{ locationId: string; travelTime: number }> = [
    { locationId: fromLocationId, travelTime: 0 },
  ];

  while (queue.length > 0) {
    const { locationId, travelTime } = queue.shift()!;
    for (const edge of transportEdges) {
      let neighbor: string | null = null;
      if (edge.fromLocationId === locationId) neighbor = edge.toLocationId;
      else if (edge.toLocationId === locationId) neighbor = edge.fromLocationId;
      if (!neighbor) continue;

      const newTime = travelTime + edge.travelTimeMinutes;
      if (newTime > maxTravelMinutes) continue;
      if (visited.has(neighbor) && visited.get(neighbor)! <= newTime) continue;

      visited.set(neighbor, newTime);
      queue.push({ locationId: neighbor, travelTime: newTime });
    }
  }

  visited.delete(fromLocationId);
  return [...visited.keys()];
}
```

**Step 2: Add `getParentLocationId` helper**

```typescript
/**
 * Resolve a sub-scene ID to its parent macro location ID.
 */
function getParentLocationId(
  sceneId: string,
  dgsm: DynamicGameStateManager
): string | null {
  const scene = dgsm.getScene(sceneId);
  return scene?.parentLocationId ?? null;
}
```

**Step 3: Extract shared `runImpactGate` function**

Extract the duplicated impact gate logic into a single function. Replace both copies (in `runTick` and `resumeTick`) with a call to this:

```typescript
interface ImpactGateParams {
  bucketActions: CharacterAction[];
  state: DynamicGameState;
  dgsm: DynamicGameStateManager;
  npcPlanningAgent: NPCPlanningAgent;
  sessionId: string;
  gameDay: number;
  bucketTime: string;
  language: string;
}

async function runImpactGate(params: ImpactGateParams): Promise<{
  playerEvents?: Array<{ event: CharacterAction; impact: number }>;
}> {
  const { bucketActions, state, dgsm, npcPlanningAgent, sessionId, gameDay, bucketTime, language } = params;
  const impactEvents = bucketActions.filter((a) => a.impact > 0);
  if (impactEvents.length === 0) return {};

  const characterEventsMap = new Map<string, Array<{ event: CharacterAction; impact: number }>>();
  const playerScene = state.currentSceneId;
  const playerId = state.playerCharacter?.id;

  const addEventForCharacter = (charId: string, event: CharacterAction, impact: number) => {
    if (charId === event.characterId) return;
    if (!characterEventsMap.has(charId)) characterEventsMap.set(charId, []);
    const existing = characterEventsMap.get(charId)!;
    const idx = existing.findIndex((e) => e.event === event);
    if (idx >= 0) {
      if (impact > existing[idx].impact) existing[idx].impact = impact;
    } else {
      existing.push({ event, impact });
    }
  };

  const allCharacterIds = [
    ...state.npcCharacters.map((n) => n.id),
    ...(playerId ? [playerId] : []),
  ];

  const getCharLocation = (charId: string): string | undefined => {
    if (charId === playerId) return playerScene;
    return dgsm.getNpcLocation(charId);
  };

  for (const event of impactEvents) {
    // Level 1: targeted
    if (event.impact >= 1 && event.targetCharacterId) {
      addEventForCharacter(event.targetCharacterId, event, 1);
    }

    // Level 2: same sub-scene
    if (event.impact >= 2) {
      for (const charId of allCharacterIds) {
        if (getCharLocation(charId) === event.location) {
          addEventForCharacter(charId, event, 2);
        }
      }
    }

    // Level 3: same macro location
    if (event.impact >= 3) {
      const eventParent = getParentLocationId(event.location, dgsm);
      if (eventParent) {
        for (const charId of allCharacterIds) {
          const charLoc = getCharLocation(charId);
          if (charLoc && getParentLocationId(charLoc, dgsm) === eventParent) {
            addEventForCharacter(charId, event, 3);
          }
        }
      }
    }

    // Level 4: neighborhood (≤15 min travel on transport network)
    if (event.impact >= 4) {
      const eventParent = getParentLocationId(event.location, dgsm);
      if (eventParent && state.transportEdges) {
        const neighbors = findNeighborMacroLocations(eventParent, state.transportEdges, 15);
        for (const charId of allCharacterIds) {
          const charLoc = getCharLocation(charId);
          if (charLoc) {
            const charParent = getParentLocationId(charLoc, dgsm);
            if (charParent && neighbors.includes(charParent)) {
              addEventForCharacter(charId, event, 4);
            }
          }
        }
      }
    }

    // Level 5: global
    if (event.impact >= 5) {
      for (const charId of allCharacterIds) {
        addEventForCharacter(charId, event, 5);
      }
    }
  }

  // Separate player from NPC candidates
  const playerEvents = playerId ? characterEventsMap.get(playerId) : undefined;
  if (playerId) characterEventsMap.delete(playerId);

  // NPC candidates → one LLM call per NPC, all in parallel
  if (characterEventsMap.size > 0) {
    await Promise.all(
      [...characterEventsMap.entries()].map(async ([npcId, npcEvents]) => {
        const npc = state.npcCharacters.find((n) => n.id === npcId);
        const longTermIntent = await npcPlanningAgent.getLongTermIntent(sessionId, npcId);
        const pendingNodes = await npcPlanningAgent.getPendingNodes(sessionId, npcId, gameDay);
        const triggeringEvents = npcEvents
          .map((e) => `[impact ${e.impact}] ${e.event.characterName}: ${e.event.outcome}`)
          .join("\n");

        const result = await npcPlanningAgent.runImpactGateForNpc(
          {
            npcId,
            npcName: npc?.name ?? npcId,
            currentLocation: dgsm.getNpcLocation(npcId) ?? "unknown",
            longTermIntent,
            pendingNodesSummary: pendingNodes.map((n) => `${n.gameTime} ${n.action}`).join("; "),
            triggeringEvents,
          },
          bucketTime,
          language
        );

        const logEntry = `Day${gameDay} ${bucketTime} [witness] - ${result.witnessEntry}`;
        const npcLoc = dgsm.getNpcLocation(npcId) ?? "unknown";
        await npcPlanningAgent.appendMemoryLog(sessionId, npcId, logEntry, gameDay, bucketTime, npcLoc);

        if (result.shouldRevise) {
          const memoryLog = await npcPlanningAgent.getMemoryLog(sessionId, npcId, gameDay);
          const sortedEvents = [...npcEvents].sort((a, b) => b.impact - a.impact);
          await npcPlanningAgent.revisePlans(dgsm, sessionId, npcId, {
            longTermIntent,
            memoryLog,
            pendingNodes,
            trigger: {
              type: "impact",
              triggeringAction: sortedEvents[0].event,
            },
          }, language);
        }
      })
    );
  }

  return { playerEvents: playerEvents ?? undefined };
}
```

**Step 4: Replace both impact gate blocks in `runTick` and `resumeTick`**

In both functions, replace the entire impact gate block (from `const impactEvents = bucketActions.filter(...)` through the player witness handling) with:

```typescript
const { playerEvents } = await runImpactGate({
  bucketActions, state, dgsm, npcPlanningAgent, sessionId, gameDay, bucketTime, language,
});

if (playerEvents && playerEvents.length > 0) {
  const playerWitnessEvents: PlayerWitnessEvent[] = playerEvents.map((e) => ({
    characterName: e.event.characterName,
    action: e.event.action,
    outcome: e.event.outcome,
    location: e.event.location,
    gameTime: e.event.gameTime,
    impact: e.impact,
  }));
  // ... rest of player interrupt logic (unchanged)
}
```

**Step 5: Build to verify**

Run: `pnpm build`
Expected: SUCCESS

**Step 6: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts
git commit -m "refactor: extract shared runImpactGate function, implement 6-level impact dispatch"
```

---

### Task 6: Add TransportEdge to DynamicGameState (if not yet added by scene graph work)

**Files:**
- Modify: `src/dynamicworldagent/state/DynamicGameState.ts:161`
- Modify: `src/dynamicworldagent/world_builder/types.ts` (add TransportEdge if not present)

**Note:** This task may already be done as part of the scene-graph-module-generation implementation. Check first.

**Step 1: Add TransportEdge type (if missing)**

In `src/dynamicworldagent/world_builder/types.ts`:

```typescript
export interface TransportEdge {
  fromLocationId: string;
  toLocationId: string;
  streetSceneId: string;
  travelTimeMinutes: number;
}
```

**Step 2: Add `parentLocationId` to DynamicScene (if missing)**

In `src/dynamicworldagent/world_builder/types.ts`, add to `DynamicScene`:

```typescript
export interface DynamicScene {
  id: string;
  name: string;
  description: string;
  parentLocationId: string;     // back-ref to ScenarioOutline.id
  // ... rest unchanged
}
```

**Step 3: Add transportEdges to DynamicGameState (if missing)**

In `src/dynamicworldagent/state/DynamicGameState.ts`:

```typescript
// Add to DynamicGameState interface:
transportEdges: TransportEdge[];

// Add to DEFAULT_STATE:
transportEdges: [],
```

**Step 4: Build to verify**

Run: `pnpm build`
Expected: May have errors if other scene-graph types are not yet in place — fix as needed or defer this task.

**Step 5: Commit**

```bash
git add src/dynamicworldagent/world_builder/types.ts src/dynamicworldagent/state/DynamicGameState.ts
git commit -m "feat: add TransportEdge and parentLocationId types for scene graph"
```

---

### Task 7: Update multiplayer orchestrator template (if applicable)

**Files:**
- Modify: `src/dynamicworldagent/multiplayerAgent/orchestrator/orchestratorTemplate.ts`

**Step 1: Check if multiplayer template has impact levels**

If it has the same 0-3 impact guide as the single-player orchestrator, update it to 0-5 with the same text as Task 2.

**Step 2: Build + commit**

```bash
pnpm build
git add src/dynamicworldagent/multiplayerAgent/orchestrator/orchestratorTemplate.ts
git commit -m "docs: update multiplayer orchestrator template impact levels to 0-5"
```
