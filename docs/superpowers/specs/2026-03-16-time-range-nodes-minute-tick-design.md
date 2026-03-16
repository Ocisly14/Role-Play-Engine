# Time-Range Plan Nodes and 1-Minute Tick Execution — Design Spec

## Goal

Replace the current single-time, atomic node execution model with a time-range, minute-by-minute execution model:

- The planning agent returns `startTime` and `endTime` instead of a single `gameTime`.
- The simulation clock advances in 1-minute ticks.
- Each `PlanNode` carries persisted runtime metadata such as `pending`, `in_progress`, `completed`, and `failed`.
- Movement becomes incremental: NPC position updates every minute, and if a route becomes blocked mid-move, the NPC stops at the last reachable position and immediately triggers `revisePlans`.

This change makes movement and long-running actions visible in real time to the simulation, encounter system, and future UI viewers.

## Current State

The engine is currently atomic at the node level:

- `PlanNode` uses a single `gameTime: "HH:MM"` field.
- The tick processor runs in fixed 5-minute ticks.
- When a node is due, its handler executes once and immediately returns `completed` or `failed`.
- `timeAdvanceMinutes` still exists on the current node schema, but it is not used as a true runtime duration and should be removed entirely.
- `movementHandler` does full pathfinding up front and then teleports the NPC to the destination if any route exists.
- If no full path exists, movement fails immediately with `location_blocked`; the NPC does not move to any intermediate point.

This creates three problems:

1. Long actions are not visible while they are happening.
2. Movement does not expose intermediate positions, so co-presence and encounters only happen at the final destination.
3. A blocked route is all-or-nothing; the NPC does not walk until the obstacle and then react.

## Design

### 1. Plan Nodes Use Time Ranges

Detailed planning output changes from:

```json
{
  "gameTime": "09:00"
}
```

to:

```json
{
  "startTime": "09:00",
  "endTime": "09:12"
}
```

Rules:

- `startTime` is required.
- `endTime` is required.
- `endTime` must be later than `startTime`.
- `timeAdvanceMinutes` is removed entirely from the authored/stored node shape.
- Duration is derived only from `endTime - startTime`.
- A single movement plan should still be emitted as one node, not split by the LLM.

### 2. Plan Nodes Gain Runtime Metadata

`PlanNode.status` changes from:

- `pending | completed | failed`

to:

- `pending | in_progress | completed | failed`

Each node also gets persisted runtime metadata:

```ts
executionMeta: {
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  remainingMinutes: number;
  activeDay?: number;
}
```

Movement nodes add movement-specific runtime state:

```ts
movementMeta: {
  routeSnapshot: MovementRouteSegment[];
  currentSegmentIndex: number;
  minutesIntoSegment: number;
  lastReachablePosition: CharacterPosition;
}
```

This runtime metadata lives in the stored plan JSON so a paused/resumed simulation can continue exactly where it left off.

### 3. Simulation Tick Becomes 1 Minute

The engine changes from fixed 5-minute ticks to 1-minute ticks.

New scheduler behavior:

1. Read all `in_progress` nodes and advance them first.
2. Read `pending` nodes whose `startTime <= currentTime`.
3. Start eligible nodes by marking them `in_progress`.
4. Advance active nodes by one minute.
5. Apply completion/failure transitions.
6. Run encounter detection and feature ticks using the new minute-level positions/state.
7. Advance world time by exactly 1 minute.

This makes minute-level movement observable without requiring the LLM to generate minute-level plans.

### 4. Node Execution Model

#### Non-movement nodes

For `routine`, `character_interaction`, `object_interaction`, and `scene_interaction`:

- At `startTime`, the node becomes `in_progress`.
- Each tick decrements `remainingMinutes`.
- The underlying handler is only executed on the completion minute.
- Before completion, there are no side effects beyond runtime state.
- On the final minute, the existing handler logic runs and determines `completed` or `failed`.

This preserves existing handler semantics while making duration meaningful to the scheduler.

#### Movement nodes

Movement is special and is executed incrementally.

At `startTime`:

- Resolve the destination to a target `CharacterPosition`.
- Compute a shortest-travel-time route snapshot from the current position to the target.
- The route snapshot is directional and minute-steppable.
- Do not reject the whole move because a later edge is currently blocked.

Each minute:

1. Check only the immediate next traversed edge.
2. If that next edge is passable, advance one minute along the route.
3. Update `characterPositions` immediately.
4. Emit `npc_moved`.
5. If the next edge is blocked, stop at the current reachable position, mark the node `failed`, and trigger `revisePlans` in the same tick.

Result:

- NPCs can walk partway along a route.
- Encounters can happen during travel.
- Blocking a door or road affects movement when the NPC actually reaches that edge, not when the move starts.

### 5. Route Strategy for Movement

Movement route planning uses:

- shortest travel time
- one route snapshot computed at movement start

The engine does **not** replan every minute by default.

This keeps movement behavior stable and makes it easier to explain:

- NPC starts a route
- continues along it minute by minute
- if the next edge becomes blocked, stops and replans

### 6. NPC Concurrency Rule

An NPC may have only one active `in_progress` node at a time.

Implications:

- If a movement node is active, later nodes for that NPC wait.
- If a 12-minute object interaction is active, the next planned scene interaction does not begin early.
- Ordering remains deterministic and close to the authored intent.

### 7. Day Boundary Rule

This design keeps node time ranges within a single day for v1.

Rules:

- `endTime` must stay on the same day as `startTime`.
- If a planner proposes a cross-midnight range, it is invalid and must be rejected or normalized before storage.
- Cross-day running nodes are out of scope for the first implementation.

This avoids immediately coupling the scheduler redesign to cross-day plan persistence.

## Planning Prompt Changes

The detailed node prompt must be updated to require:

- `startTime`
- `endTime`
- no `gameTime`

Prompt rules should explicitly say:

- Use the current time as the default `startTime` for the first node.
- Choose realistic end times based on the action.
- Return one movement node for travel; do not split into smaller movement steps.
- Only output the next actionable step, not the whole day.

## Type and Storage Changes

### `PlanNode`

Current:

```ts
{
  gameTime: string;
  status: "pending" | "completed" | "failed";
}
```

New:

```ts
{
  startTime: string;
  endTime: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  executionMeta: {
    remainingMinutes: number;
    startedAt?: string;
    completedAt?: string;
    failedAt?: string;
  };
}
```

### Plan persistence

Stored daily-plan JSON should persist:

- new status values
- execution metadata
- movement route metadata for active movement nodes

Stored daily-plan JSON should **not** include `timeAdvanceMinutes` anymore. Duration is derived from the time range and runtime state only.

The scheduler should update node state in place rather than immediately removing the node on start.

Nodes should only be removed from the active plan view after reaching terminal state or after a later cleanup pass.

## Tick Processor Changes

The tick processor must be refactored from “execute due nodes now” to “advance active work”.

Required changes:

1. Replace fixed 5-minute tick with 1-minute tick.
2. Load `in_progress` nodes in addition to `pending` nodes.
3. Start nodes whose `startTime` has arrived.
4. Advance active nodes by exactly one minute.
5. Only mark terminal state when a node completes or fails.
6. Trigger `revisePlans` immediately on failure, including mid-movement blockage.
7. Ensure encounter detection runs after minute-level movement updates.

## Movement Data Model

Movement needs a route representation that supports partial progress.

Example segment model:

```ts
type MovementStep =
  | {
      kind: "to_junction";
      from: CharacterPosition;
      to: { type: "junction"; junctionId: string };
      durationMinutes: number;
    }
  | {
      kind: "along_road";
      from: CharacterPosition;
      to: CharacterPosition;
      roadId: string;
      durationMinutes: number;
    }
  | {
      kind: "to_scene";
      from: CharacterPosition;
      to: { type: "scene"; sceneId: string };
      durationMinutes: number;
    };
```

The exact shape can vary, but it must support:

- directional travel
- minute-by-minute advancement
- immediate blocked-edge validation
- reconstruction of the current `CharacterPosition`

This keeps the movement runtime model aligned with the existing topology system:

- `from` and `to` are real `CharacterPosition` values
- step execution updates `characterPositions` directly
- block checks are performed against the edge implied by the current step
- route state stays close to the existing `scene` / `junction` / `road` concepts already used by pathfinding

## Failure and Revise Behavior

Movement failure rule:

- If the immediate next edge is blocked, fail the movement node in that tick.
- Keep the NPC at the last valid position.
- Use `failureReason: "location_blocked"`.
- Include the concrete blocked-edge reason in failure payload/metadata, e.g. door locked, fire, storm, barricade.
- Trigger `revisePlans` immediately after marking the node failed.

Non-movement failure rule:

- Existing failure semantics remain.
- Failure still removes the node from future execution and triggers revise.

## Encounter and Event Behavior

Because position updates are now minute-level:

- `npc_moved` should be emitted on each movement minute, not only on final arrival.
- Encounter detection should use live positions after movement advancement.
- A movement node only produces final `action_executed` or `action_failed` once it reaches terminal state.

This preserves the meaning of action logs while allowing high-resolution movement events.

## Compatibility

This design is not backward-compatible with legacy `gameTime`-only detailed nodes.

Expected handling:

- new planning output must use `startTime/endTime`
- `timeAdvanceMinutes` should be removed from prompts, types, examples, persistence, and runtime logic
- old nodes should be considered invalid unless explicitly migrated

No dual-field compatibility path is planned. The system should converge on one source of truth: `startTime/endTime`.

## Test Plan

### Planning output

- Reject nodes with only `gameTime`
- Accept nodes with valid `startTime/endTime`
- Derive `remainingMinutes` correctly from the time range

### Scheduler

- A node with `09:00-09:05` stays `in_progress` for 5 ticks
- A node only starts when current time reaches `startTime`
- A second node for the same NPC does not start while the first one is active

### Movement

- NPC position updates every minute during a long movement
- Partial road traversal updates `CharacterPosition` correctly
- A block encountered mid-route stops movement at the last reachable point
- Mid-route failure triggers revise in the same tick

### Encounters and events

- `npc_moved` emits per-minute updates
- Encounter detection can see NPCs meeting during travel, not only at final destination

## Summary

This redesign shifts the simulation from atomic node execution to persisted, minute-level progression:

- time range instead of single start time
- active runtime state on nodes
- 1-minute scheduler
- real incremental movement
- immediate revise when movement is interrupted

It is the minimum architecture needed to make path blocking, travel visibility, and long-duration actions behave like a live simulation instead of a sequence of teleports.
