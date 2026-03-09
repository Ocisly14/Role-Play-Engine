# Tick Engine Plugin Architecture Design

**Date:** 2026-03-09
**Branch:** tick
**Status:** Approved

## Problem

The current tick processor (`tickProcessor.ts`, ~1645 lines) handles all node types via a monolithic `executeNode` function with 5 hardcoded branches. Adding new game mechanics (fire, weather, traps, etc.) requires modifying `executeNode` directly, which doesn't scale.

## Goal

Make the tick processor a pluggable game engine where new mechanics can be added as independent files without modifying core code.

## Architecture: Feature Registry + Node Handler Pattern

Two-layer plugin system:

```
┌─────────────────────────────────────┐
│          Tick Processor              │
│  ┌───────────┐  ┌────────────────┐  │
│  │  Feature   │  │  Node Handler  │  │
│  │  Registry  │  │  Registry      │  │
│  └───────────┘  └────────────────┘  │
│       │                  │           │
│  Between buckets    executeNode()    │
│  (self-propagate)   (dispatch)       │
└─────────────────────────────────────┘
```

- **NodeHandler** = LLM's toolbox ("you can use these action types"). LLM selects → tick executes.
- **WorldFeature** = Self-running world systems ("these things happen on their own"). Tick runs automatically → LLM is informed via context.
- **SceneCondition** = Communication medium between handlers and features.

## Core Interfaces

```typescript
interface NodeHandler {
  // Tick execution
  type: string;
  execute(node: PlanNode, dgsm: DynamicGameStateManager): CharacterAction;

  // LLM prompt metadata (auto-injected into plan agent prompts)
  description: string;
  requiredFields: string[];
  optionalFields?: string[];
  exampleNode: Partial<PlanNode>;
}

interface WorldFeature {
  id: string;
  conditionTypes: string[];    // which SceneCondition types this feature manages
  description: string;

  onBucketEnd(bucketActions: CharacterAction[], dgsm: DynamicGameStateManager): PlanNode[];
  onTickStart?(dgsm: DynamicGameStateManager): void;
  onTickEnd?(allActions: CharacterAction[], dgsm: DynamicGameStateManager): void;
  stateDescription(dgsm: DynamicGameStateManager): string; // dynamic state → injected into LLM context
}

class GameEngineRegistry {
  private handlers: Map<string, NodeHandler>;
  private features: Map<string, WorldFeature>;

  registerHandler(handler: NodeHandler): void;
  registerFeature(feature: WorldFeature): void;

  getHandler(type: string): NodeHandler;
  getAllFeatures(): WorldFeature[];

  buildHandlerPrompt(): string;              // all available types with descriptions + examples
  buildWorldStatePrompt(dgsm): string;       // all active feature states
}
```

## Tick Processor Dispatch Flow

```typescript
async function runTick(playerNodes, dgsm, registry, sessionId, language): Promise<TickResult> {
  const features = registry.getAllFeatures();

  // 1. tick start hooks
  features.forEach(f => f.onTickStart?.(dgsm));

  // 2. merge player + NPC nodes, build 5-min buckets
  const buckets = buildBuckets(playerNodes, npcNodes);

  for (const bucket of buckets) {
    // 3. sort by DEX, execute sequentially
    for (const node of bucket.nodes) {
      const handler = registry.getHandler(node.type);
      const action = handler.execute(node, dgsm);
      bucketActions.push(action);
    }

    // 4. bucket end → all WorldFeatures run
    const newNodes: PlanNode[] = [];
    for (const feature of features) {
      const generated = feature.onBucketEnd(bucketActions, dgsm);
      newNodes.push(...generated);
    }

    // 5. inject feature-generated nodes into subsequent buckets
    injectNodes(newNodes, buckets);
  }

  // 6. tick end hooks
  features.forEach(f => f.onTickEnd?.(allActions, dgsm));

  return { type: "completed", actions: allActions };
}
```

## Prompt Auto-Assembly

Plan agents no longer hardcode available types. Registry generates prompt fragments:

```typescript
// Handler prompt: auto-generated list of available action types with examples
buildHandlerPrompt(): string {
  let prompt = "## Available Action Types\n\n";
  for (const handler of this.handlers.values()) {
    prompt += `### ${handler.type}\n`;
    prompt += `${handler.description}\n`;
    prompt += `Required: ${handler.requiredFields.join(", ")}\n`;
    if (handler.optionalFields?.length)
      prompt += `Optional: ${handler.optionalFields.join(", ")}\n`;
    prompt += `Example:\n\`\`\`json\n${JSON.stringify(handler.exampleNode, null, 2)}\n\`\`\`\n\n`;
  }
  return prompt;
}

// World state prompt: only active features inject state (saves tokens)
buildWorldStatePrompt(dgsm): string {
  let prompt = "## Current World State\n\n";
  for (const feature of this.features.values()) {
    const state = feature.stateDescription(dgsm);
    if (state) {
      prompt += `### ${feature.description}\n${state}\n\n`;
    }
  }
  return prompt;
}
```

PlayerPlanAgent and NPCPlanningAgent templates consume these:

```typescript
const prompt = `
${baseInstructions}
${registry.buildHandlerPrompt()}
${registry.buildWorldStatePrompt(dgsm)}
${playerContext}

Output PlanNode[] as JSON.
`;
```

## State Communication

Handlers and features communicate through SceneCondition:

```
NodeHandler writes state → SceneCondition → WorldFeature reads state → generates new nodes → NodeHandler executes
```

Plugins get **full dgsm access** (Option A). The dgsm API itself serves as the abstraction layer — plugins use methods like `getSceneConditions()`, `appendSceneCondition()`, `updateNpcLocation()`, etc.

## File Structure

```
src/dynamicworldagent/engine/
├── types.ts                    # NodeHandler, WorldFeature, GameEngineRegistry interfaces
├── registry.ts                 # GameEngineRegistry implementation
├── handlers/
│   ├── routineHandler.ts       # extracted from executeNode L936-951
│   ├── movementHandler.ts      # extracted from executeNode L953-993
│   ├── characterInteractionHandler.ts  # from L995-1054
│   ├── objectInteractionHandler.ts     # from L1056-1114
│   └── sceneInteractionHandler.ts      # from L1116-1159
├── features/
│   ├── impactGateFeature.ts    # extracted from runImpactGate L722-864
│   └── clueDiscoveryFeature.ts # extracted from discoverClues L516-678
├── shared/
│   ├── skillRoll.ts            # resolveSkillRoll — shared across handlers
│   ├── scenePenalty.ts         # getScenePenalties / applyPenalties
│   └── buildOutcome.ts         # buildOutcome utility
└── tickProcessor.ts            # slimmed-down runTick — pure dispatch logic
```

## Migration Strategy

Incremental, not big-bang:

### Phase 1: Build skeleton
- Create types.ts, registry.ts
- tickProcessor imports registry but falls back to existing executeNode for unregistered types

### Phase 2: Extract handlers one by one
- Extract one type → register → delete corresponding branch in executeNode
- Test after each extraction

### Phase 3: Extract WorldFeatures
- impact gate → impactGateFeature
- clue discovery → clueDiscoveryFeature

### Phase 4: Prompt automation
- PlayerPlanAgent / NPCPlanningAgent switch to registry.buildHandlerPrompt()
- Remove hardcoded type lists from templates

## Example: Adding Fire System

One file adds a complete new game system:

```typescript
// src/dynamicworldagent/engine/features/fireFeature.ts

export const fireSpreadHandler: NodeHandler = {
  type: "fire_spread",
  description: "Fire spreads to adjacent scene, increases severity of existing fires",
  requiredFields: ["location"],
  optionalFields: [],
  exampleNode: {
    type: "fire_spread",
    location: "dining_room",
    action: "Fire spreads from kitchen to dining room",
    impact: 3,
    timeAdvanceMinutes: 5,
  },
  execute(node, dgsm): CharacterAction {
    const existing = dgsm.getSceneConditions(node.location).find(c => c.type === "fire");
    if (existing) {
      existing.severity = Math.min(existing.severity + 1, 5);
    } else {
      dgsm.appendSceneCondition(node.location, {
        type: "fire",
        severity: 1,
        mechanicalEffect: {
          skillPenalty: [
            { skill: "spot_hidden", delta: -20 },
            { skill: "listen", delta: -10 },
          ],
        },
      });
    }
    return {
      ...baseAction(node),
      status: "completed",
      outcome: `${node.location} on fire, severity ${existing?.severity ?? 1}`,
    };
  },
};

export const fireFeature: WorldFeature = {
  id: "fire",
  conditionTypes: ["fire"],
  description: "Fire system: flames spread between connected scenes over time",
  onBucketEnd(bucketActions, dgsm): PlanNode[] {
    const newNodes: PlanNode[] = [];
    for (const scene of dgsm.getAllScenes()) {
      const fire = scene.conditions?.find(c => c.type === "fire");
      if (!fire || fire.severity < 2) continue;
      for (const neighbor of dgsm.getConnectedScenes(scene.id)) {
        if (neighbor.conditions?.some(c => c.type === "fire")) continue;
        if (Math.random() * 100 < fire.severity * 20) {
          newNodes.push({
            nodeId: randomUUID(),
            type: "fire_spread",
            location: neighbor.id,
            action: `Fire spreads from ${scene.name} to ${neighbor.name}`,
            impact: 3,
            timeAdvanceMinutes: 5,
            characterId: "system",
            characterName: "environment",
            gameTime: dgsm.getTimeOfDay(),
            status: "pending",
          });
        }
      }
    }
    return newNodes;
  },
  stateDescription(dgsm): string {
    const fires = dgsm.getAllScenes()
      .filter(s => s.conditions?.some(c => c.type === "fire"))
      .map(s => {
        const fire = s.conditions.find(c => c.type === "fire");
        return `${s.name}: fire(severity ${fire.severity})`;
      });
    return fires.length ? fires.join(", ") : "";
  },
};

// Registration
registry.registerHandler(fireSpreadHandler);
registry.registerFeature(fireFeature);
```

Developer experience: write one file → register two lines → new system is live.
