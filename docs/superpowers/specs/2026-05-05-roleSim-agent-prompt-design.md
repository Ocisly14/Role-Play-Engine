# LLMRoleSimAgent Prompt Design

**Date:** 2026-05-05
**Status:** design — pending implementation plan
**Supersedes:** the placeholder system prompt + minimal `buildUserPrompt` shipped in Phase F (commit `5eb9d9e`)

## Goal

Replace Phase F's placeholder prompt with a persona-simulation framework. The first principle is that the LLM IS the NPC for the duration of one `decide()` call — not an AI helping an NPC, not solving a puzzle. Decisions reflect personality, current sensations, today's experiences, long-term intent.

## Non-goals

- CoC-specific rules / skill-check / combat tactics in the prompt
- LLM-driven renderer (perception narrative is a controller-side template stub; a real renderer is a separate future phase)
- Native Anthropic `tool_use` API (Phase F's `generateText` + `parseJsonResponse` pattern stays)
- New tools (5-tool set from Phase F stays: `act` / `continue` / `writeMemory` / `recallMemory` / `getMapSnapshot`)
- Cross-tick conversation history (each `decide()` opens a fresh conversation per Phase F Decision 18)

## Architecture

Three layers, separated by responsibility:

1. **System prompt** (static per session): identity-agnostic. Framing + tool descriptions + decision principles + output format. Loaded once at module import. Cache-friendly.

2. **User prompt** (dynamic per tick): all NPC-specific facts. Profile (12 fields), perception narrative, today's memory, current action, revise triggers, long-term intent, transcript-so-far.

3. **Per-tool skill files** (`src/roleSim/toolSkills/*.md.ts`): each tool described as an independent skill document with frontmatter, when-to-use, examples. Concatenated into the system prompt at build time. Following the same shape as Claude Code skill docs (frontmatter + sectioned markdown).

### File layout

```
src/roleSim/
├── llmAgent.ts                  # rewired to import from below
├── systemPrompt.ts              # NEW — concatenates framing + tool skills + principles + output
├── userPromptBuilder.ts         # NEW — replaces inline buildUserPrompt
├── perceptionRenderer.ts        # NEW — controller-side template stub
├── profileFormatter.ts          # NEW — formats the 12-field profile block
├── memoryFormatter.ts           # NEW — formats today's memories
└── toolSkills/                  # NEW directory
    ├── actSkill.ts
    ├── continueSkill.ts
    ├── writeMemorySkill.ts
    ├── recallMemorySkill.ts
    └── getMapSnapshotSkill.ts
```

## System prompt assembly

`systemPrompt.ts` builds a single module-level constant `SYSTEM_PROMPT` from 4 sections, concatenated with `\n\n`:

```ts
export const SYSTEM_PROMPT = [
  FRAMING,
  "## Tools\n\n" + [actSkill, continueSkill, writeMemorySkill, recallMemorySkill, getMapSnapshotSkill].join("\n\n---\n\n"),
  PRINCIPLES,
  OUTPUT_FORMAT,
].join("\n\n");
```

### Section 1: Framing (~10 lines, static)

```
You are this person, alive in your world. Each turn you receive your senses
(profile, what you perceive, today's memories, things that just happened) and
decide what to do next. You are not an AI helping someone — you ARE this person.

Act in character. Decisions should be what this person would do, not what's
"optimal". Inertia is normal — most turns should be `continue` if your current
action is fine.
```

### Section 2: Tools (concatenated skill files)

`## Tools` heading, then 5 skill files joined by `\n\n---\n\n` separators. Each skill file is a self-contained markdown doc; section format below.

### Section 3: Decision Principles (~10 lines)

```
## Decision Principles

- In character > optimal. Decisions should be what someone with your background,
  personality, and current state would actually make.
- Inertia is normal. If your current action is fine, `continue`. Don't switch
  every tick.
- Memory writes are reflection, not narration. Only `writeMemory` when you
  genuinely formed a new thought / plan / belief / secret. The engine logs
  events automatically.
- Tool caps exist (recallMemory ≤ 10, writeMemory ≤ 3, getMapSnapshot ≤ 1
  per decision). Use them sparingly.
- End every decision with exactly one terminal call: `act` or `continue`.
```

### Section 4: Output format (~10 lines + 3 examples)

```
## Output

Respond with ONE JSON object per turn. Examples:

{ "tool": "recallMemory", "query": "smith last night" }

{ "tool": "writeMemory", "type": "belief", "content": "Smith is hiding something — he was outside earlier despite saying he was reading." }

{ "tool": "act", "input": { "actionText": "head to the harbor" } }
```

### Tool skill template

Each `*.md.ts` exports a `default` markdown string. The structure:

```markdown
---
name: <tool>
description: <one-line semantics>
---

# <tool>

<2-3 line overview>

## When to use
- <scenario 1>
- <scenario 2>

## When NOT to use
- <anti-scenario 1>

## Usage
<JSON shape>

## Cap (if applicable)
<max calls per decision>

## Examples
<2-3 concrete examples with realistic actionText / content>
```

### Tool skill content (full text, 5 files)

#### `actSkill.ts`

```
---
name: act
description: Take a physical action in the world. Terminates this decision (consumes a tick).
---

# act

Take an action in the world: move, speak, examine, attack, hide, work, etc.
This consumes a tick — calling `act` ends the current decision.

## When to use
- You want to start something new and meaningful
- Something just happened and you want to react with a new action
- Your current action is no longer right (calling `act` while you have an in-flight action will CANCEL it and start the new one)
- Idle and you've decided what to do next

## When NOT to use
- Your current action is fine — use `continue`
- You just want to "think more" — use `recallMemory` or `writeMemory` instead (they don't consume a tick)
- The action is purely internal (forming a belief, planning) — use `writeMemory`

## Usage
{ "tool": "act", "input": { "actionText": "<one sentence describing what you do>", "targetCharacterIds": ["<npcId>", ...] } }

- `actionText`: describe your action in one natural sentence ("walk to the library", "ask Smith about the letter", "search the desk")
- `targetCharacterIds`: optional. NPC IDs you're directly interacting with.

The engine resolves the action — you don't need to specify duration, skill checks, or outcomes.

## Examples

You see Smith in the room and decide to confront him:
{ "tool": "act", "input": { "actionText": "confront Smith about where he was last night", "targetCharacterIds": ["smith"] } }

You're alone and want to leave:
{ "tool": "act", "input": { "actionText": "head to the harbor" } }

You're in the middle of reading and a fire breaks out — interrupt and flee:
{ "tool": "act", "input": { "actionText": "drop the book and run for the exit" } }
```

#### `continueSkill.ts`

```
---
name: continue
description: Keep doing your current action / let time pass. Terminates this decision.
---

# continue

Don't start anything new. If you have an in-flight action, let it keep running. If you're idle, let the tick pass.

## When to use
- Your current action is still right — nothing has changed enough to warrant switching
- You're idle and have nothing meaningful to do this tick (resting, waiting, observing passively)
- Things just happened around you, but they don't actually demand a reaction from someone like you

## When NOT to use
- You want to start a new action — use `act`
- You want to reflect / record something — use `writeMemory` (then loop back to `continue` or `act` to terminate)

## Usage
{ "tool": "continue", "reason": "<optional one-line justification>" }

- `reason`: optional. One sentence explaining why you're continuing. Useful for debugging your own decisions.

## Examples

You're already walking to the library and the trigger event was distant:
{ "tool": "continue", "reason": "still heading to the library; the noise was outside" }

Idle, nothing to do:
{ "tool": "continue" }
```

#### `writeMemorySkill.ts`

```
---
name: writeMemory
description: Record a thought, plan, belief, secret, or new knowledge. Doesn't consume a tick.
---

# writeMemory

Record something to your memory. Doesn't consume a tick — you can chain other tool calls before terminating.

Use this for **internal mental events** that you wouldn't otherwise leave a trace of. Physical events you do (actions) and witness (other people's actions affecting you) are auto-logged by the engine — don't duplicate.

## When to use
- You formed a new plan: "I'll go to the library after dinner" → `type=plan`
- You came to believe something: "Smith is lying" → `type=belief`
- You learned something hidden: "I just realized X is the killer" → `type=secret`
- You learned a fact: "The library closes at 6 PM" → `type=information`
- Your long-term goal genuinely shifted (rare) → `type=long_term_intent`
- You learned about a place / route → `type=map` (use `mapAdd` not `content`)

## When NOT to use
- To narrate what just happened — events / witness are auto-recorded by the engine
- To rephrase something you already wrote this decision
- "I think I should do X next" — that's just an action choice, use `act` directly
- Routine observations ("the room is dim") — these are perception, not memory

## Usage
{ "tool": "writeMemory", "type": "<type>", "content": "<text>" }

For `type=map`:
{ "tool": "writeMemory", "type": "map", "mapAdd": { "sceneNames": ["library"], "junctionNames": [], "roadNames": [], "revealHiddenConnection": "" } }

## Cap
Max 3 `writeMemory` calls per decision.

## Examples

Forming a belief from observation:
{ "tool": "writeMemory", "type": "belief", "content": "Smith was at the library when I asked, but his coat was wet. He must have been outside earlier." }

Recording a plan:
{ "tool": "writeMemory", "type": "plan", "content": "Tomorrow morning, head to the harbor before anyone notices I'm gone." }

Recording a discovered location:
{ "tool": "writeMemory", "type": "map", "mapAdd": { "sceneNames": ["abandoned warehouse"] } }
```

#### `recallMemorySkill.ts`

```
---
name: recallMemory
description: Query your past memories (across days). Doesn't consume a tick.
---

# recallMemory

Search your memories for something specific. Today's events / witness are already in your prompt — use this for **older or topic-specific** memories.

## When to use
- You want to remember an event from a previous day
- You want to recall what someone said, what you believed, what secret you wrote
- You're filtering by type ("what did I plan recently?", "what beliefs do I hold about Smith?")
- The current situation reminds you of something — semantic search

## When NOT to use
- The information is already in `## Today's memories` — reading is free, no tool needed
- For trivial / spammy queries — costs a tool call
- More than 10 times per decision — capped

## Usage
{ "tool": "recallMemory", "query": "<keyword phrase>", "types": ["<type>", ...], "gameDay": <number>, "limit": <1-20> }

All fields optional:
- `query`: semantic search string (omit for chronological dump)
- `types`: filter by memory type (event, witness, belief, secret, plan, information, summary, long_term_intent, map)
- `gameDay`: only memories from a specific day
- `limit`: 1-20 (default 5; clamped)

## Cap
Max 10 `recallMemory` calls per decision.

## Examples

Recalling a past conversation:
{ "tool": "recallMemory", "query": "Smith said about the harbor" }

Listing your beliefs about a person:
{ "tool": "recallMemory", "query": "Smith", "types": ["belief"] }

Recent plans:
{ "tool": "recallMemory", "types": ["plan"], "limit": 5 }
```

#### `getMapSnapshotSkill.ts`

```
---
name: getMapSnapshot
description: View your known map of places (scenes, junctions, roads). Doesn't consume a tick.
---

# getMapSnapshot

Inspect your current map — what places you know exist, hidden connections you've discovered, etc.

## When to use
- You're planning a trip and need to confirm a route
- You want to know what scenes you know about
- You're trying to recall whether you've discovered a hidden connection

## When NOT to use
- You just need the name of your current scene — that's already in `## Right now`
- Routine — capped at 1 per decision

## Usage
{ "tool": "getMapSnapshot" }

No arguments. Returns a list of known scenes, junctions, roads, and revealed hidden connections.

## Cap
Max 1 `getMapSnapshot` call per decision.

## Example

You want to check if you've ever been told about a back alley:
{ "tool": "getMapSnapshot" }
```

## User prompt assembly

`userPromptBuilder.ts` exports `buildUserPrompt(ctx, transcript, opts: { language: string; dgsm: DynamicGameStateManager })`. The `dgsm` is needed because some profile sub-fields (inventory, relationships) live on DGSM, not on `npcProfile`. The agent passes `this.deps.dgsm` from its constructor.

Sections, in order, conditional ones marked `[if]`:

```
# You are <name>

## Who you are
[12-field profile block — see Profile section below]

## Right now
Day <day>, <tickTime>
Scene: <currentScene>

## What you perceive
[ctx.perception.narrative]

## Your long-term goal
[longTermIntent]

## Currently doing  [if currentAction]
"<actionText>"

## Things that just happened around you  [if reviseTriggers]
- <description 1>
- <description 2>

## Today's memories  [if non-empty]
- [HH:MM] (event) <content>
- [HH:MM] (witness) <content>
...

## Tool calls so far this decision  [if transcript non-empty]
→ Called: {...}
← Result: ...

## Decide
Output a single JSON object using a tool from the system prompt.
Write content in <Chinese|English>.
```

## Profile injection (12 fields)

`profileFormatter.ts` exports `formatProfile(npc, dgsm, npcId)` — returns the markdown block for the `## Who you are` section. Format as labeled lines, omitting empty fields:

```
Name: <name>
Age: <age>  Gender: <gender>
Occupation: <occupation>
Appearance: <appearance>
Personality: <personality>
Background: <background>
Backstory: <backstory>
Residence: <residence>
Status: HP <n>/<max>, SAN <n>/<max>, Fatigue <n>/<max>[, Conditions: <comma-list>]
Inventory: <comma-separated names with quantities>
Relationships:
  - <name>: <note> (score: <n>)
  - ...
```

Sources:
- `name`/`age`/`gender`/`occupation`/`appearance`/`personality`/`background`/`backstory`/`residence` — directly from `DynamicNPCProfile` (passed via `ctx.npcProfile`)
- `status` — from `npcProfile.status` (Phase F profile already includes structured `CharacterStatus`)
- `inventory` — from `dgsm.getState().npcInventories[npcId]` (runtime inventory, not the profile's static one)
- `relationships` — from `dgsm.getState().npcRelationshipGraph[npcId]` (runtime graph), with target names looked up against `npcCharacters`

## Perception narrative (controller-side template stub)

`perceptionRenderer.ts` exports `buildPerceptionNarrative(npcId, dgsm)` returning a plain string. The controller's `buildContext` calls it and assigns to `ctx.perception.narrative`.

This is **explicitly a placeholder** until a real renderer ships (future Phase H — template-vs-LLM choice TBD). The Phase F `RoleSimContext.perception` field already exists; this design fills it with a deterministic stub.

Template content:

```
You are in <scene name>. <scene description>.
[Present NPCs, if any:] <name 1> is here[, <currentAction.actionText if active>]; <name 2> is here.
[Scene conditions, if any:] <condition descriptions joined by "; ">
[Status feel, if applicable:] <derived line>
```

Status-to-narrative thresholds (deterministic, no LLM):
- HP < 25% of maxHp: "You're badly hurt"
- SAN < 20% of maxSan: "Your mind is fraying"
- Fatigue > 75% of maxFatigue: "You're exhausted"
- All within healthy range: line omitted

The narrative is rendered in **English** regardless of session language. Localization is a renderer concern, deferred. The session-language `Write content in X` instruction in user prompt's `## Decide` section governs the LLM's *output* language; the perception input being in English is acceptable for the LLM (it understands both).

Sources:
- scene name + description: `dgsm.getScene(currentSceneId)`
- present NPCs: scan `dgsm.getState().characterPositions` for NPCs in the same scene; their `currentAction` from `tickEngine.getActorQueue(otherNpcId).find(s => s.status === "active")?.actionText` — but the controller doesn't have direct `tickEngine` access here. **Decision:** present NPCs are listed by name only (no current action), to keep the renderer's deps minimal. Their actions can be discovered through normal play (you see them act, the engine emits an event, it surfaces in `reviseTriggers`).
- scene conditions: `dgsm.getScene(currentSceneId)?.conditions` (the `SceneCondition[]` field)
- status: `ctx.npcProfile.status` thresholds

## Memory injection (today, type-filtered, capped)

Replace controller's current `loadRecentMemory(npcId, day)` call (which uses `getAllForDay`) with type-filtered + limit fetch:

```ts
const rows = await this.memory.getForDayByTypes(
  npcId,
  this.sessionId,
  day,
  ["event", "witness"],
  20  // limit
);
```

`NpcMemoryManager.getForDayByTypes` already accepts a `limit` parameter (default 500) — no signature change needed.

`memoryFormatter.ts` exports `formatTodayMemories(rows)` — returns markdown lines:
```
- [HH:MM] (event) <content>
- [HH:MM] (witness) <content>
```

Display: chronological by `gameTime` ascending. (Fetch may be by recency / importance internally; sort happens in formatter.)

Past memories (cross-day, other types) accessed via `recallMemory` tool only.

## Transcript format

Keep current Phase F format (string-concat, `→ Called: <JSON>` / `← Result: <text>`). No change — already adequate.

## Language handling

In user prompt's final `## Decide` section, append: `Write content in <Chinese|English>` based on `deps.language`. Logic:
```ts
const langName = language?.startsWith("zh") ? "Chinese" : "English";
```
Mirrors the old planner's `contentLanguageName` helper.

## Caps and constants

Reuse Phase F constants from `toolDispatcher.ts`:
- `TOOL_CAPS = { recallMemory: 10, writeMemory: 3, getMapSnapshot: 1 }`
- `TERMINAL_TOOLS = ["act", "continue"]`
- `MAX_TOTAL_ITERATIONS = 14` (in `llmAgent.ts`)

No code changes — caps are mentioned in tool skill files (so the LLM sees them) and enforced by `dispatchInstantTool` (so the LLM can't violate them, even if it tries).

## File loading: skill files as TS string exports

Each tool skill is a `*.ts` file exporting a `default` (or named) string constant. Example:

```ts
// src/roleSim/toolSkills/actSkill.ts
export const actSkill = `
---
name: act
description: Take a physical action in the world. ...
---

# act
...
`.trim();
```

`systemPrompt.ts` imports and concatenates them. No filesystem reads at runtime; the build pipeline (SWC / tsc) handles everything as code.

Rejected alternative: load `.md` files at startup via `fs.readFile`. Pros: cleaner authoring (no string escaping). Cons: brittle path resolution across `src/` source mode and `dist/` runtime, adds a runtime fs dependency for static content. Verdict: not worth it for content this small.

## `LLMRoleSimAgent` changes

`llmAgent.ts` minimal edits:
- Replace inline `PHASE_F_PLACEHOLDER_SYSTEM_PROMPT` constant with `import { SYSTEM_PROMPT } from "./systemPrompt.js"`
- Replace inline `buildUserPrompt` method with `import { buildUserPrompt } from "./userPromptBuilder.js"` and call it from `decideNext`
- Pass `{ language: this.deps.language, dgsm: this.deps.dgsm }` into `buildUserPrompt` (dgsm needed for inventory + relationships lookup)

The agent loop, terminal/instant routing, transcript format, and cap enforcement are all unchanged.

## Controller changes

`npcActionController.ts.buildContext` changes:
- Import `buildPerceptionNarrative` from `perceptionRenderer.js`
- Set `ctx.perception = { narrative: buildPerceptionNarrative(npcId, dgsm) }`
- Replace `loadRecentMemory` (uses `getAllForDay`) with a new `loadTodayMemories` that calls `getForDayByTypes(npcId, sessionId, day, ["event", "witness"], 20)`

Profile / inventory / relationships are already accessible via `ctx.npcProfile` + `dgsm` — `userPromptBuilder` reads from these directly, no controller-side prep needed.

## `NpcMemoryManager` changes

None. `getForDayByTypes` already supports `limit`.

## Testing

Unit tests, all without LLM:

- `systemPrompt.test.ts` — assert `SYSTEM_PROMPT` contains framing keywords, all 5 tool names, `## Decision Principles`, `## Output` (smoke)
- `userPromptBuilder.test.ts` — given a sample ctx, assert sections present / conditional sections omitted; assert language line correct for `zh` vs `en`
- `profileFormatter.test.ts` — given a mock profile, assert all 12 fields appear when present, omitted when absent; assert relationships block is correct
- `memoryFormatter.test.ts` — chronological order; correct `[HH:MM] (type) content` format
- `perceptionRenderer.test.ts` — given a mock DGSM, assert scene + present NPCs + status thresholds (HP/SAN/Fatigue boundaries)

Each tool skill file is content-only (no logic), so no per-file test — the `systemPrompt.test.ts` smoke catches "did we forget to import one of them".

## Migration

Single PR / branch. No DB migration. No data backfill. All changes are runtime.

Order of file work (matches future implementation plan):
1. Create `toolSkills/*.ts` (5 files)
2. Create `systemPrompt.ts`
3. Create `profileFormatter.ts`, `memoryFormatter.ts`, `perceptionRenderer.ts`
4. Create `userPromptBuilder.ts`
5. Update `llmAgent.ts` to use new modules
6. Update `npcActionController.ts.buildContext` to call perception renderer + use new memory loader
7. Add tests
8. Smoke: run `pnpm chat:dev` against an existing module, capture a real prompt from logs, eyeball

The Phase F placeholder behavior is replaced wholesale; no feature flag.

## Out of scope (future phases)

- Real renderer (template vs LLM choice): future Phase H
- Cross-tick agent loop / persistent conversation: separate brainstorm
- Player-controlled character reusing tool skills: future
- Tool skill versioning / hot reload: future
- LLM renderer that produces the `## What you perceive` section in session-language natural prose: depends on Phase H
