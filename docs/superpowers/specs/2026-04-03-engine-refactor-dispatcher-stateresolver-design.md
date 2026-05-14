# Engine Refactor: Dispatcher + StateResolver Architecture

## Summary

Refactor the game engine from a handler-based execution model to a **Dispatcher + Action Definition + StateResolver** architecture. The current 4 handlers and actionPostProcessing are replaced by:

- **Dispatcher** (LLM): matches natural language action to an action definition file
- **Action Definition Files** (md/json): declarative game rules specifying skill checks, movement, and state change guidance
- **StateResolver** (LLM): reads definition file guidance + skill check results + current state, outputs structured state changes
- **Code Tools**: skillCheckTool (dice rolls) and movementTool (pathfinding + cross-tick)

All existing features are preserved: interruptions, impact pipeline, encounter scanning, feature system (fire, weather, sanity, etc.).

## Architecture

```
Planner (LLM)
  Output: natural language composite action + startTime/endTime
    |
Queue (stateful scheduler)
  Manages status (pending -> in_progress -> completed/failed/interrupted)
  startTime reached -> in_progress
  endTime reached -> trigger execution
  Movement cross-tick -> call movementTool.tick()
  Sort by time + DEX
    |
Dispatcher (LLM, single round)
  Decomposes action -> ordered steps, each referencing a definition file
  No match -> generic.md fallback
    |
Engine executes steps in order
  Per step:
    If movement.md -> movementTool (pure code, cross-tick capable)
    Else:
      1. Skill Check (if definition requires) -> skillCheckTool (pure code)
      2. StateResolver (LLM) -> definition guidance + check result + state snapshot -> StateResolution
      3. Apply StateResolution -> write to game state
  Next step begins only after previous completes
    |
tickProcessor continues
  Encounter scanning (unchanged)
  Impact Pipeline (unchanged)
  Feature lifecycle (unchanged)
```

### LLM Call Count

3 calls per action: Planner(1) + Dispatcher(1) + StateResolver(1)

Compare to current: Planner(1) + handler(0) + actionPostProcessing(1) = 2 calls. The extra call is the Dispatcher.

## Components

### Planner (unchanged)

Outputs natural language composite actions. Does not know about tools, definitions, or the execution layer. Example output:

```json
{
  "action": "Go to the harbor and ask the captain about the missing ship",
  "startTime": "09:00",
  "endTime": "09:20",
  "impact": 2
}
```

### Queue

Stateful scheduler that manages per-NPC execution state. Replaces the node scheduling logic currently spread across tickProcessor and NPCPlanningAgent.

```typescript
interface QueueEntry {
  nodeId: string;
  characterId: string;
  action: string;
  startTime: string;
  endTime: string;
  impact: number;
  status: "pending" | "in_progress" | "completed" | "failed" | "interrupted";

  // Filled when endTime reached and Dispatcher runs
  steps?: Array<{
    definitionId: string;
    args?: Record<string, unknown>;
  }>;
  currentStepIndex?: number;          // which step is executing
  skillCheckResult?: ToolResult;      // current step's skill check result

  // Movement cross-tick state (if current step is movement)
  activeMovement?: {
    tickState: unknown;
  };
}
```

**Per-tick logic:**

1. Entries reaching startTime -> set status: in_progress
2. in_progress with activeMovement -> call movementTool.tick(), if done: true, clear activeMovement, advance to next step
3. in_progress reaching endTime -> execute: Dispatcher -> begin executing steps in order
4. in_progress with steps, current step not movement -> execute step (skillCheck + StateResolver), advance to next step. When all steps done -> status: completed
5. Remaining in_progress (no steps yet, waiting for endTime) -> skip
6. Sort execution order: by startTime ASC, then by DEX DESC

### Dispatcher

Single-round LLM call that decomposes an action into an ordered sequence of definition file steps.

**Input:**
- Action description (natural language)
- List of available definition files (id + title + short description, auto-generated from registry)

**Output:**

```typescript
interface DispatchResult {
  steps: Array<{
    definitionId: string;                // "movement" | "social" | "search" | "generic" | ...
    args?: Record<string, unknown>;      // destination, targetId, etc.
  }>;
}
```

A simple action like "search the room" produces one step. A composite action like "go to the harbor and ask the captain" produces two steps: `[{ definitionId: "movement", args: { destination: "harbor_docks" } }, { definitionId: "social", args: { targetId: "captain_wang" } }]`.

Queue executes steps in order. The next step only begins after the previous completes (including cross-tick).

If no definition matches, the step falls back to `"generic"`.

**Prompt is auto-generated from registered definitions.** Adding a new definition file and registering it automatically makes it available to the Dispatcher. No code changes needed.

### Action Definition Files

Declarative game rules stored as md or json in an `actions/` directory. Each file specifies:

- Whether a skill check is needed, which skill, difficulty, type (single/opposed)
- State change guidance per outcome (success/failure), organized by state domain
- Feature overlay triggers

Movement is not a section within definitions — it is its own definition file (`movement.md`). The Dispatcher composes movement with other definitions as separate steps.

**Example: `actions/movement.md`**

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

Note: movement.md is handled specially by the Engine — it delegates to movementTool (pure code, cross-tick capable) rather than StateResolver.

**Example: `actions/trap.md`**

```markdown
# Trap

## Skill Check
- skill: Mechanical Repair | Electrical Repair
- difficulty: regular
- type: single
- failBehavior: partial

## State Changes

### On Success
#### scene
- Add trap condition at current location (hidden=true, quality based on success level)
#### item
- Consume trap materials (rope/tools) from actor inventory
#### character
- fatigue: +2
- memory: "Set a trap at [location]"

### On Failure
#### scene
- Add trap condition at current location (hidden=false, quality=poor)
#### item
- Consume trap materials
#### character
- fatigue: +2
- memory: "Tried to set a trap but it failed"

## Feature Overlay
- eventTrigger: "trap_set" (on success only)
```

**Example: `actions/combat.md`**

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

**Example: `actions/search.md`**

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

**Example: `actions/social.md`**

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

**Example: `actions/generic.md`**

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

### Code Tools

Two pure-code tools that handle deterministic game mechanics.

#### skillCheckTool

Extracted from current ExecutionContext. Handles all dice rolling logic.

```typescript
interface SkillCheckArgs {
  skill: string;
  difficulty: "regular" | "hard" | "extreme";
  type: "single" | "opposed";
  // For opposed checks
  targetId?: string;
  opposedDefense?: string;
}

interface SkillCheckResult {
  successLevel: SuccessLevel;   // critical | hard | regular | failed | fumble
  actorWon?: boolean;           // for opposed checks
  detail: string;               // human-readable roll description
  perTargetResults?: Record<string, PerTargetResult>;  // for opposed checks
}
```

Applies scene penalties and character penalties (from features) before rolling. Pure code, no LLM.

#### movementTool

Extracted from current movementHandler. Handles pathfinding and cross-tick position updates.

```typescript
interface MovementArgs {
  destination: string;
  skill?: string;    // for creative movement (Stealth, Climb, etc.)
}

// resolve: calculate path, return done: false + remainingMinutes
// tick: advance 1 minute per tick, handle stealth checks
// apply: dgsm.setCharacterPosition()
```

Implements `tick()` for cross-tick execution. Queue directly calls `movementTool.tick()` each tick without going through Dispatcher.

### StateResolver

Single LLM call that generates structured state changes.

**Input:**
- Action description
- Actor state (HP, SAN, skills, inventory, conditions, position)
- Target state(s) if applicable
- Scene state (conditions, items, characters present)
- Skill check result (from skillCheckTool, if applicable)
- Action definition file content (the relevant "On Success" or "On Failure" section)
- Feature state context (fire, weather, lighting, etc.)

**Output: `StateResolution`**

```typescript
interface StateResolution {
  // Character changes
  characterChanges?: Array<{
    characterId: string;
    hp?: number;              // delta
    san?: number;             // delta
    fatigue?: number;         // delta
    addConditions?: string[];
    removeConditions?: string[];
    position?: CharacterPosition;
  }>;

  // Item changes
  itemChanges?: Array<{
    itemId: string;
    action: "move" | "destroy" | "create" | "modify";
    from?: string;            // characterId | sceneId
    to?: string;              // characterId | sceneId
    properties?: Record<string, unknown>;
  }>;

  // Scene changes
  sceneChanges?: Array<{
    sceneId: string;
    addConditions?: string[];
    removeConditions?: string[];
  }>;

  // Memories
  memories?: Array<{
    characterId: string;
    type: string;
    content: string;
  }>;

  // Relationships
  relationships?: Array<{
    from: string;
    to: string;
    change: string;
  }>;

  // Feature overlays
  featureOverlays?: Record<string, unknown>;

  // Narrative description
  narrative: string;
}
```

### Registry Changes

```typescript
class GameEngineRegistry {
  // REMOVED: handler management
  // private handlers

  // KEPT: feature management (unchanged)
  private features = new Map<string, WorldFeature>();

  // MODIFIED: tool management (skillCheckTool + movementTool only)
  private tools = new Map<string, ActionTool>();

  // NEW: action definition management
  private definitions = new Map<string, ActionDefinition>();
  registerDefinition(def: ActionDefinition): void;
  getDefinition(id: string): ActionDefinition | undefined;
  getAllDefinitions(): ActionDefinition[];

  // MODIFIED: prompt building
  buildDispatcherPrompt(): string;    // lists all definitions for Dispatcher
  buildResolverPrompt(): string;      // StateResolver base prompt
  buildPlanningPrompt(): string;      // for Planner (unchanged)
  buildWorldStatePrompt(): string;    // feature world state (unchanged)

  // KEPT: feature lifecycle
  startNodeFeatures / activateNodeFeatures
  shouldPropagationFire / getPropagationSources
}
```

## Execution Flow

### Normal Action: "Search the study for clues"

```
Tick 1 (09:00): Planner outputs action, Queue entry created, status: pending
                Queue sets status: in_progress (startTime reached)

Tick 5 (09:05): endTime reached, trigger execution
  1. Dispatcher: "search the study" -> matches search.md
  2. Read search.md: skill check required (Spot Hidden, regular, single)
  3. skillCheckTool: roll d100, Spot Hidden(50) - darkness(-10) = 40, rolled 35 -> regular success
  4. StateResolver input:
     - action: "Search the study for clues"
     - skill check: regular success
     - search.md "On Success" guidance
     - scene state: study items, conditions
     -> output: discover fingerprint_evidence, mark study as searched, +1 fatigue, memory written
  5. Apply StateResolution
  6. Queue: status: completed
  7. tickProcessor: impact=0, no impact pipeline
```

### Composite Action with Movement: "Go to harbor and ask captain"

The Dispatcher decomposes this into two ordered steps: movement.md then social.md. Queue executes them in sequence.

```
Tick 1 (09:00): Queue entry in_progress

Tick 20 (09:20): endTime reached
  1. Dispatcher: "go to harbor and ask captain"
     -> steps: [
          { definitionId: "movement", args: { destination: "harbor_docks" } },
          { definitionId: "social", args: { targetId: "captain_wang" } }
        ]

  2. Step 0 — movement.md:
     movementTool.resolve(harbor_docks) -> done: false, remainingMinutes: 4
     Queue: activeMovement set, currentStepIndex: 0

Tick 21-23: Queue calls movementTool.tick() -> done: false
Tick 24: movementTool.tick() -> done: true
  Queue: clears activeMovement, advances currentStepIndex to 1

  3. Step 1 — social.md:
     skillCheckTool(Persuade, opposed, captain_wang) -> failed, actor lost
     StateResolver(social.md "On Failure" + context) -> captain suspicious, relationship worsened

  4. Apply StateResolution
  5. All steps done, Queue: status: completed
  6. tickProcessor: impact=2, enter Impact Pipeline
     -> nearby NPCs witness, runImpactGateForNpc decides reactions
```

Note: movement after endTime extends the action beyond its original endTime. The Queue allows this — the entry stays in_progress until all steps complete.

### Interrupted Action

```
Tick 1: NPC starts "repair engine" (endTime: 11:00), status: in_progress
Tick 30: Impact Pipeline detects fire nearby
  -> runImpactGateForNpc: NPC decides to interrupt
  -> Queue: status: interrupted
  -> StateResolver runs with partial completion context
  -> Planner triggered to revise schedule
```

## Preserved Features

All existing engine features continue to work unchanged:

### Encounter Scanning
After all actions execute in a tick, scan for unplanned co-location. Generate encounter events. Unchanged.

### Impact Pipeline
Actions with impact >= 2 broadcast to nearby NPCs. runImpactGateForNpc (LLM) decides reactions. May interrupt in_progress entries in Queue. Unchanged.

### Feature System
- **tick()**: each feature updates per tick (fire growth, weather transition, etc.). Unchanged.
- **propagate()**: spatial spread on schedule (fire spreads to adjacent scenes). Unchanged. Injects new actions into Queue.
- **onNodeStart()**: triggered before execution. Adapts to read from QueueEntry instead of PlanNode.
- **activate()**: triggered after StateResolution applied. Reads featureOverlays from StateResolution.
- **planningPrompt()**: injected into Planner prompt. Unchanged.
- **Skill modifiers**: features provide scene/character penalties consumed by skillCheckTool. Unchanged.

### Engagement Tracking
NPCs targeted by character_interaction (now handled via social.md / combat.md definitions) are marked as engaged. Their own Queue entries are held until interaction completes. Unchanged logic, different trigger point.

### NPC Schedule Revision
Impact gate can trigger schedule revision via Planner. Unchanged.

## File Structure

```
src/engine/
  registry.ts                # Modified: remove handler, add definitions
  registerDefaults.ts        # Modified: register tools + definitions
  types.ts                   # Modified: remove NodeHandler, update ActionTool

  handlers/                  # DELETE entire directory

  tools/
    skillCheckTool.ts        # New: extracted from executionContext
    movementTool.ts          # New: extracted from movementHandler
    index.ts

  actions/                   # NEW: action definition files
    combat.md
    social.md
    search.md
    movement.md
    trap.md
    generic.md               # Fallback
    index.ts                 # Loads and registers definitions

  dispatcher/
    dispatcher.ts            # New: action -> definition matching (LLM)
    index.ts

  resolver/
    stateResolver.ts         # New: definition + context -> StateResolution (LLM)
    stateResolution.ts       # New: StateResolution type + apply logic
    index.ts

  queue/
    actionQueue.ts           # New: stateful scheduler
    index.ts

  runtime/
    tickProcessor.ts         # Modified: replace handler execution with Queue + Dispatcher + StateResolver
    impactPipeline.ts        # Unchanged
    discoveryPipeline.ts     # Unchanged
    actionPostProcessing.ts  # DELETE

  features/                  # Interface adaptation only
  shared/                    # skillRoll.ts referenced by skillCheckTool
```

## Extensibility

Adding a new action type (e.g., "trap") requires:

1. Create `actions/trap.md` with skill check, movement, and state change guidance
2. Register in `registerDefaults.ts` (or auto-load from actions/ directory)
3. Done. Dispatcher prompt auto-includes the new definition. StateResolver reads it when matched.

No code changes to Dispatcher, StateResolver, Engine, Queue, or any other component.

## Migration

### Deleted Components
- `actionHandler.ts` -> logic absorbed by skillCheckTool + StateResolver
- `movementHandler.ts` -> logic absorbed by movementTool
- `characterInteractionHandler.ts` -> logic absorbed by social.md/combat.md + skillCheckTool + StateResolver
- `objectInteractionHandler.ts` -> already dead code (not registered)
- `actionPostProcessing.ts` -> replaced by StateResolver
- `actionStateResolver.ts` -> replaced by StateResolver
- `interactionStateResolver.ts` -> replaced by StateResolver

### Modified Components
- `tickProcessor.ts` -> replace handler dispatch with Queue + Dispatcher + StateResolver flow
- `registry.ts` -> remove handler management, add definition management, update prompt builders
- `types.ts` -> remove NodeHandler interface, simplify ActionTool interface
- `itemTool.ts` -> remove (item changes handled by StateResolver)
- Feature files -> adapt onNodeStart/activate to work with QueueEntry/StateResolution

### Preserved Components
- `impactPipeline.ts` -> unchanged
- `discoveryPipeline.ts` -> unchanged
- Feature system (fire, weather, lighting, sanity, stamina, eventTrigger) -> logic unchanged, interface adapted
- `NPCPlanningAgent.ts` -> unchanged
- `SimulationRunner.ts` -> unchanged
