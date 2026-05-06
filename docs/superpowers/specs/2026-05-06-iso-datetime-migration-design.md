# ISO Datetime Migration — Design

> **Replaces** the dual-field `gameDay: Int + tickTime: String` time representation across the entire stack with a single ISO 8601 datetime string `gameDateTime`. Affects DB schema, in-memory state, simulation engine, roleSim agent, prompts, wire events, and client UI.

**Goal:** Make every "in-game moment" a single ISO 8601 string (`"YYYY-MM-DDTHH:MM:SS"`) end-to-end. Eliminate the integer day counter as a runtime concept.

**Architecture:** Full-stack rewrite — DB columns, Prisma models, `DynamicGameState`, simulation tick advance, memory layer, agent tools, prompt formatters, client wire-event types, and i18n strings all migrate to the single field. A new `gameClock.ts` helper module localizes all date arithmetic as pure-string operations (no JS `Date` object).

**Tech Stack:** TypeScript, Prisma + Postgres, React (client UI), pnpm.

**Branch:** `日期替换`

---

## Brainstorm decisions

| ID | Decision | Rationale |
|---|---|---|
| A2 | Full rewrite to ISO everywhere (internal + DB) | Single conceptual model; no int↔string boundary conversions |
| B1 | `ModuleSetup.startDate` becomes **required** (ISO `YYYY-MM-DD`) | A2 forces every simulation to have a real calendar anchor |
| C2 | Combined ISO 8601 datetime string (`"1923-10-17T08:15:00"`) | One field, lexicographic = chronological ordering, no JS `Date` TZ pitfalls |
| D1 | `SimulationEvent` table + client wire events also migrated | Stack consistency; UI sees the same time format LLM sees |
| E1 | Wipe existing runtime data (Session / SimulationRuntime / SimulationEvents / NpcMemory) | Project still iterating; runtime data is regenerable; module data preserved |
| F2 | New field name `gameDateTime` (replaces `gameDay` + `tickTime`) | Unique name during rename — searches don't collide with old field semantics |
| G2 in / G1 out | Asymmetric format: display `YYYY-MM-DD HH:MM` to LLM, expect ISO 8601 in LLM-emitted dates | Readable in prompt, machine-parseable in tool inputs / memory content |

---

## Out of scope

- Existing prompt-framework structure (Phase F roleSim prompts) — only date formatting points change
- roleSim agent decision logic / tool dispatch flow
- Tick engine internals beyond the time field swap
- Schema fields other than `gameDay` / `tickTime` / `startDate`

---

## Schema changes

### Prisma (`prisma/schema.prisma`)

```prisma
model NpcMemory {
  // ...
  gameDateTime String   @map("game_datetime")     // was: gameDay Int + gameTime String
  location     String?
  // ...
  @@index([sessionId, npcId, gameDateTime])       // was: @@index([sessionId, npcId, gameDay])
}

model SimulationEvent {
  // ...
  gameDateTime String   @map("game_datetime")     // was: gameDay Int + gameTime String
  // ...
  @@index([sessionId, gameDateTime])              // was: @@index([sessionId, gameDay])
}
```

`Session` / `SimulationRuntime` get the same swap if they currently store `gameDay`/`tickTime` (verified during plan).

**Column type:** `String` (text), **not** Postgres `Timestamp`. Virtual game time has no real-world timezone; storing as a string avoids Prisma's auto-conversion to JS `Date` (which would inject local timezone interpretation). Lexicographic ordering on `"YYYY-MM-DDTHH:MM:SS"` equals chronological ordering, so range queries and indexes work without timestamp semantics.

**Migration command:** `prisma db push` (per CLAUDE.md — `migrate dev` causes schema drift via reminder_embeddings). Drop+recreate the affected runtime tables to wipe old data; module tables (`Module`, `ModuleNpc`, `ModuleScene`, ...) untouched.

### `ModuleSetup` (`src/state/types.ts`)

```ts
interface ModuleSetup {
  startDate: string;     // was: startDate?: string  (now REQUIRED, ISO YYYY-MM-DD)
  // ... other fields unchanged
}
```

**Validation:** `moduleLoader.ts` checks `startDate` exists and matches `/^\d{4}-\d{2}-\d{2}$/`. On failure, throws with explicit message: `Module "<id>" missing required ModuleSetup.startDate. Add a "startDate": "YYYY-MM-DD" field (e.g. "1923-10-15") to the module's setup section.`

---

## Internal types & DateTime helper

### `DynamicGameState` (`src/state/DynamicGameState.ts`)

```ts
interface DynamicGameState {
  // ...
  gameDateTime: string;          // was: gameDay: number + tickTime/timeOfDay: string
}
```

`gameDay` and `tickTime`/`timeOfDay` fields are **deleted** (no shim, no fallback). Methods rewritten:

- `setGameClock(params: { gameDateTime: string })` — replaces `setGameClock({ gameDay?, timeOfDay })`
- `getGameDateTime(): string` — replaces `getGameDay()` / `getTickTime()`
- `advanceTime(minutes: number): { dayChanged: boolean; previousDateTime: string }` — internally calls `addMinutes` + checks `datePart` change

`onNewDay` trigger logic (in `SimulationRunner`) changes from integer comparison `dayBefore !== dayAfter` to `datePart(prevDateTime) !== datePart(newDateTime)`.

`maxDays` config semantics retained: simulation stops when `diffDays(gameDateTime, startDate) >= maxDays`.

### New module: `src/state/gameClock.ts`

All date arithmetic centralized here. **No `new Date()` / `Date` object** — pure string + modular arithmetic to avoid timezone interpretation. Unit tests cover every branch.

```ts
export const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Combine date + time strings: ("1923-10-17", "08:15") → "1923-10-17T08:15:00" */
export function makeDateTime(date: string, time: string): string;

/** Slice the date part: "1923-10-17T08:15:00" → "1923-10-17" */
export function datePart(dt: string): string;

/** Slice the time part: "1923-10-17T08:15:00" → "08:15" */
export function timePart(dt: string): string;

/** Advance a datetime by N minutes, returning a new ISO datetime. Handles cross-day, cross-month, cross-year. */
export function addMinutes(dt: string, mins: number): string;

/** Whole-day difference between two datetimes (a - b, in days). Used for maxDays bounds. */
export function diffDays(a: string, b: string): number;

/** True iff two datetimes share the same date part. */
export function isSameDay(a: string, b: string): boolean;

/** Display format for prompts: "1923-10-17T08:15:00" → "1923-10-17 08:15" */
export function formatForPrompt(dt: string): string;

/**
 * Best-effort coercion of LLM-emitted date strings to canonical ISO YYYY-MM-DD.
 * Trims whitespace, slices "1923-10-17T..." or "1923-10-17 08:15" to date part.
 * Returns null when input cannot be salvaged.
 */
export function coerceIsoDate(raw: string): string | null;

/** Same idea for full datetime strings — only used if/when LLM emits one directly. */
export function coerceIsoDateTime(raw: string): string | null;
```

### Shared `GameTime` interface (`src/engine/core/types.ts`)

The interface currently shaped `{ day: number; tickTime: string }` — used by `TickReport.tickTime`, `RoleSimContext.currentTime`, `ActionStep.submittedAt`, and other engine wire types — collapses to a single string:

```ts
// before: export interface GameTime { day: number; tickTime: string; }
export type GameDateTime = string;   // ISO 8601 "YYYY-MM-DDTHH:MM:SS"
```

All consumers of `GameTime` switch from `t.day` / `t.tickTime` to `datePart(t)` / `timePart(t)` (or call `formatForPrompt` for display).

### Tick engine

`src/engine/runtime/tickProcessor.ts` and any other "advance time" caller switches `state.gameDay = ...` / `state.timeOfDay = ...` writes to `state.gameDateTime = addMinutes(state.gameDateTime, 1)`. No other engine internals touched.

---

## Touch surface

33 backend `.ts` files reference `gameDay`. Categorized:

**A. Direct state holders** (5 files — core changes):

- `src/state/DynamicGameState.ts`
- `src/state/types.ts`
- `src/state/DynamicGameStateLoader.ts`
- `src/state/moduleLoader.ts` (adds `startDate` validation)
- `src/simulation/SimulationRunner.ts` (tick advance + onNewDay trigger)

**B. Memory layer** (9 files — field rename + query parameter rename):

- `src/memory/types.ts`, `MemoryStore.ts`, `MemoryRetriever.ts`, `NpcMemoryManager.ts`
- `src/memory/handlers/{EventHandler,WitnessHandler,SummaryHandler}.ts`
- `src/memory/__tests__/{handlers,mapMemory,npcSceneMap}.test.ts`

**C. RoleSim agent layer** (8 files):

- `src/roleSim/{npcActionController,llmAgent,agent,seedIntents,dailySummarization,toolDispatcher}.ts`
- `src/roleSim/toolSkills/recallMemorySkill.ts` — `gameDay: number` parameter → `gameDate: string`
- `src/roleSim/userPromptBuilder.ts` — display format G2
- `src/roleSim/memoryFormatter.ts` — today's memory line format

**D. Engine + simulation periphery** (8 files):

- `src/simulation/{SimulationEventEmitter,PlaybackScheduler,runtimePersistence,types}.ts`
- `src/engine/core/{scriptedEventRunner,featureReadContext}.ts`
- `src/engine/scriptedEvents/{loader,types}.ts`

**E. Tests** (already counted above; all `__tests__/` files in B/C/D update fixture data).

**F. Client (`client/`) — new scope (D1 decision):**

- WebSocket wire-event TypeScript types
- Event card React components (display the new format)
- Playback timeline component (used `gameDay` for ordering)
- `npc_position_snapshot` event payload
- i18n strings: `client/src/i18n/locales/en.json`, `zh.json` — search for "Day {n}" / `Day ` / `天` / day-related templates

Concrete client file list deferred to plan-writing step (full grep + categorize).

---

## LLM format contract (asymmetric I/O)

### Display to LLM (input direction, G2 readable)

| Position | Format | Example |
|---|---|---|
| `userPromptBuilder` "Right now" section | `Today: YYYY-MM-DD, HH:MM` | `Today: 1923-10-17, 08:15` |
| `memoryFormatter` today's memory line (date is implied) | `[HH:MM] (type) content` | `[08:15] (event) saw a stranger` |
| `toolDispatcher.recallMemory` cross-day result line | `[YYYY-MM-DD HH:MM] (type) content` | `[1923-10-16 14:30] (event) ...` |
| Summary memory content embedded prefix (Decision 25, already implemented) | `[YYYY-MM-DD]` | `[1923-10-17] Today I went to the library...` |

`formatForPrompt()` is the **single** display-formatting entry point — every display path routes through it.

### LLM-emitted (output direction, G1 ISO)

`recallMemory` tool input field `gameDate?: string` expects strict `YYYY-MM-DD` (date only, no time). `writeMemory` content prefix follows Decision 25's `[YYYY-MM-DD]` convention.

### Three explicit hints in the prompt

1. **`toolSkills/recallMemorySkill.ts`** — `gameDate` parameter description:
   `gameDate?: string — ISO 8601 date "YYYY-MM-DD" (no time, no T separator). Example: "1923-10-16".`

2. **`toolSkills/writeMemorySkill.ts`** — summary/event examples show `"[1923-10-17] Today I..."` prefix convention.

3. **`systemPrompt.ts` Output Format section** — append:
   `When emitting dates in tool inputs or memory content, use ISO 8601 ("YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS"). Do not copy the readable form shown above.`

### Coercion before bouncing back to LLM

Dispatcher's input handling for `recallMemory.gameDate`:

1. `coerceIsoDate(input.gameDate)` — strips whitespace, slices first 10 chars if input is a full datetime or G2 readable string. Logs a debug line on coercion success.
2. If coercion succeeds → use coerced value.
3. If coercion fails → return error result string `Error: gameDate must be ISO 8601 date "YYYY-MM-DD" (got: "<raw>")`. LLM's next decision can self-correct (no infinite loop — agent already has decision-budget cap).

---

## Migration & wipe strategy

### Schema migration steps

1. Edit `prisma/schema.prisma` per "Schema changes" section.
2. `pnpm prisma:generate` to update generated client types.
3. `prisma db push` — Prisma will warn the column type change is destructive; accept (data is being wiped anyway).

### Runtime data wipe

Drop + recreate, OR truncate, the following tables before `prisma db push`:

- `npc_memories`
- `simulation_events`
- `sessions` and `simulation_runtimes` (whichever holds `gameDay`)

`Module*` tables (module content) **untouched**.

Done via a one-liner `psql` script or `prisma db push --force-reset` if dev DB. Documented in plan's commit-gate task.

### Module file backfill

Existing module JSON files in the repo (under `client/server/mod/seedModules/` or wherever modules live — confirmed during plan) need a `startDate` field added by their authors. **This spec does not batch-edit them**; the moduleLoader's clear failure message guides authors to add it.

A note added to `docs/` or module-authoring README: `ModuleSetup.startDate is required as of YYYY-MM-DD; format is ISO YYYY-MM-DD. Modules without it fail to load.`

---

## Testing strategy

Per `feedback_skip_trivial_tests` and `feedback_batch_test_at_end`:

**TDD (full algorithmic coverage):**

- `gameClock.ts` — every helper. Branches: `addMinutes` cross-minute / cross-hour / cross-day / cross-month / cross-year; `diffDays` positive / negative / zero; `isSameDay` boundary; `coerceIsoDate` valid / coercible / invalid; `coerceIsoDateTime` same.
- `moduleLoader.ts` `startDate` validation — 1 test: missing field; 1 test: invalid format string.

**No new tests** for trivial rename / type substitutions in B/C/D files. Existing tests update their fixtures to use `gameDateTime: string` and continue covering the surrounding logic.

**End-of-plan batch verification:**

1. `pnpm test` — full Vitest suite green.
2. `pnpm build:tsc` — no new TS errors.
3. `pnpm check` — Biome clean.
4. `pnpm chat:dev` smoke test: load a module (with `startDate` added), start a session, advance ticks, verify NPC writes a memory, recall a memory, observe wire events on client, see ISO datetime in event card UI.

---

## Risk register

| Risk | Mitigation |
|---|---|
| `Date` arithmetic timezone bug sneaks into `gameClock.ts` | Helper internals forbid `new Date()` (enforce via review); pure string + modular arithmetic only; unit tests check known TZ-trap inputs (`"2024-03-31T01:30:00"` near DST boundary, `"1900-02-28"` non-leap) |
| Module author forgets to add `startDate` after pulling | Explicit failure message at module-load time; bullet in module-authoring README |
| Hardcoded `"Day {n}"` strings in client i18n keys | Plan step does full-text search across `client/src/i18n/locales/*.json` for day-related templates and replaces uniformly |
| LLM copies the readable G2 format into a tool input | `coerceIsoDate` salvages the common cases (full datetime, G2 readable); only truly garbled inputs bounce back as errors |
| Existing in-flight session (if any) breaks on schema upgrade | Wipe is documented and intentional; warn in commit message |
| `maxDays` semantics drift after rewrite | Test: simulate startDate `"1923-10-15"` + `maxDays: 3` → simulation halts at `"1923-10-18T..."` |

---

## Success criteria

- [ ] Schema: `npc_memories.game_datetime`, `simulation_events.game_datetime` are `String` columns, indexed correctly, `gameDay` and `gameTime`/`tickTime` columns gone.
- [ ] `DynamicGameState.gameDateTime: string` is the only time field; `gameDay` / `timeOfDay` / `tickTime` removed from runtime types; shared `GameTime` interface collapsed to `GameDateTime = string`.
- [ ] `gameClock.ts` exists with all listed helpers + 100% test coverage.
- [ ] Module load fails fast with clear message when `startDate` missing or malformed.
- [ ] `recallMemory` tool input field is `gameDate: string` (not `gameDay: number`); dispatcher salvages malformed inputs via `coerceIsoDate` before erroring.
- [ ] Prompt display uses G2 (`1923-10-17 08:15`) everywhere via `formatForPrompt`; system prompt explicitly tells LLM to emit G1 ISO.
- [ ] Client wire events carry `gameDateTime`; UI / event cards / playback render ISO datetime.
- [ ] All 33 backend files + identified client files migrated.
- [ ] `pnpm test`, `pnpm build:tsc`, `pnpm check` green.
- [ ] One end-to-end dev-server smoke session passes (start → tick → memory write → recall → UI render).
