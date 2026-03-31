# Single-Node Planning & Immediate Execution

## Overview

Refactor NPC planning from batch node generation to single-node-at-a-time generation with a short-term intent relay mechanism. Simplify tick processor to an immediate execution model where nodes are generated and executed on demand.

Two core changes:

1. **Single-node planning**: `generateDetailedNodes()` (which expands one schedule entry into multiple nodes) becomes `generateNextNode()` (generates exactly one node + updates short-term intent)
2. **Immediate execution model**: Nodes no longer carry pre-scheduled startTime/endTime. Generated → immediately executed → duration determined by resolver → state applied on completion

## Data Model Changes

### PlanNode

Remove:

- `startTime: string` (pre-scheduled "HH:MM")
- `endTime: string` (pre-scheduled "HH:MM")

Add:

- `expectedDuration: string` — LLM's estimate ("15min", "1h"), used as guidance for resolver
- `actualStartTime?: string` — system fills when node enters in_progress
- `actualEndTime?: string` — resolver/movement determines, system fills after execution

### ShortTermIntent

New field on `npcDailyPlan`:

```typescript
shortTermIntent: string; // e.g. "找到禁书后带回家研究"
```

Updated every time a node is generated. Acts as a relay baton between consecutive nodes, giving the next node generation call context about what the NPC is working toward.

### Schedule (read-only)

`npcDailyPlan.schedule` is no longer consumed (no more `schedule.slice(1)`). The full daily schedule is preserved as read-only context passed into planning prompts. The LLM uses the schedule as directional guidance, with short-term intent tracking actual progress.

## Planning Layer Changes

### `generateNextNode()` replaces `generateDetailedNodes()`

Called whenever an NPC has no pending/in_progress node. Returns:

```json
{
  "node": {
    "nodeId": "uuid",
    "action": "在书架间搜索那本提到过的禁书",
    "type": "scene_interaction",
    "location": "Library",
    "skill": "Library Use",
    "impact": 2,
    "expectedDuration": "30min"
  },
  "shortTermIntent": "找到禁书后带回家研究"
}
```

### Prompt context (`buildNextNodePrompt()`)

- NPC identity, long-term intent
- Daily schedule (read-only, full day)
- Current short-term intent (from previous node generation)
- Current location, scene, co-located NPCs
- Today's completed actions (memory summary)
- Current game time
- World state (weather, fatigue, sanity, feature states)

### `revisePlans()` adaptation

When impact gate returns `shouldRevise=true`, `revisePlans()` also produces a single node + updated short-term intent (same output format as `generateNextNode()`), rather than generating multiple replacement nodes.

### `reviseSchedule()` unchanged

Still revises the daily schedule when `shouldReviseSchedule=true`.

## Tick Processor: Immediate Execution Model

### Per-NPC per-tick flow

```
1. Has in_progress node?
   ├─ movement → advance one step, if arrived → completed → impact pipeline
   ├─ other → check if actualEndTime reached
   │          reached → apply state changes → completed → impact pipeline
   └─ not reached → wait, continue to next tick

2. No active node?
   └─ generateNextNode()
      → mark in_progress (fill actualStartTime = current game time)
      ├─ movement → initialize path, advance per tick
      └─ other → immediately execute handler (skill roll)
                → immediately execute resolver (determine outcome + duration)
                → stash results, compute actualEndTime
                → state changes NOT applied yet
                → wait for duration to elapse
                → on actualEndTime: apply state changes → completed → impact pipeline
```

### Key changes from current architecture

- **Remove time-based sorting/scheduling**: No more "sort by startTime, wait until due". Each NPC has at most one active node.
- **Handler + resolver execute at node start**: Currently they run at endTime. Now they run immediately, but results are stashed until duration elapses.
- **Movement unchanged**: Still advances one step per tick across multiple ticks.

## Impact Pipeline Changes

The impact pipeline's core logic is largely unchanged. Changes:

- **Trigger timing**: Still triggers on node completion (no change)
- **shouldRevise=true**: Interrupt target NPC's current node (mark as `interrupted`), call `generateNextNode()` for them → new node + updated short-term intent
- **shouldRevise=false**: Update target NPC's short-term intent only (next node generation will be informed by the event)
- **shouldReviseSchedule=true**: Call `reviseSchedule()` as before
- **Impact threshold**: Unchanged (`impact >= 2`, or `impact === 1 && skill`)

## What Does NOT Change

- Daily schedule generation (`generateDailySchedule()`)
- Handler system (5 handler types: routine, movement, characterInteraction, objectInteraction, sceneInteraction)
- Feature system (fire, weather, lighting, sanity, stamina, eventTrigger)
- Post-processing: relationship updates, memory recording, discovery logic
- Impact gate criteria and prompt logic (except prompt content adjustments for new node format)
- LLM resolver's role in determining state changes

## Summary of Flow

```
NPC has no active node
  ↓
generateNextNode(schedule, shortTermIntent, memory, worldState)
  → returns { node, shortTermIntent }
  ↓
node marked in_progress (actualStartTime = now)
  ↓
handler executes immediately (skill roll)
  ↓
resolver executes immediately (outcome + duration → stashed)
  ↓
wait for duration (node stays in_progress, no state changes yet)
  ↓
actualEndTime reached
  ↓
apply stashed state changes (HP/SAN/items/position)
  ↓
node marked completed
  ↓
impact pipeline runs on affected NPCs
  ├─ shouldRevise=true → interrupt their node, generateNextNode()
  ├─ shouldRevise=false → update their shortTermIntent
  └─ shouldReviseSchedule=true → reviseSchedule()
  ↓
next tick: NPC has no active node → loop
```
