# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

CoC Multi-Agent System — an AI-powered Call of Cthulhu 7e Game Master. TypeScript full-stack: Express + WebSocket backend, React frontend, PostgreSQL with Prisma ORM. Uses LangChain/LangGraph for multi-agent orchestration. Supports both single-player and multiplayer sessions.

## Commands

```bash
# Development
pnpm install              # Install all deps (root + client)
pnpm chat:dev             # Run backend + frontend concurrently
pnpm chat                 # Backend only (Express + WebSocket, port 3000)
pnpm chat:frontend        # Frontend only (Vite dev server)
pnpm dev:debug            # Backend with DEBUG=coc:* logging

# Build
pnpm build                # SWC compile src → dist (fast, for dev)
pnpm build:tsc            # TypeScript strict type checking
cd client && pnpm build   # Frontend build

# Code quality
pnpm check                # Biome format + lint + auto-fix
pnpm format               # Format only
pnpm lint                 # Lint only

# Test
pnpm test                 # Vitest (watch mode)
pnpm test:coverage        # With v8 coverage
npx vitest run path/to/file.test.ts  # Single test file

# Database
pnpm prisma:studio        # Prisma Studio GUI
pnpm prisma:generate      # Regenerate Prisma client
prisma db push            # Apply schema changes (use this, NOT migrate dev — schema drift with reminder_embeddings)
```

## Architecture

### Dynamic World Simulation Engine (`src/dynamicworldagent/engine/`)
Tick-based world simulation:

- **Registry** (`registry.ts`): Central registry for handlers and features. Collects skill modifiers, manages propagation state.
- **Handlers** (5 types in `handlers/`): Process NPC action nodes — `routine`, `movement`, `characterInteraction`, `objectInteraction`, `sceneInteraction`.
- **Features** (6 systems in `features/`): Pluggable world systems — `fire`, `weather`, `lighting`, `sanity`, `stamina`, `eventTrigger`. Each follows a lifecycle: `planningPrompt()` → `tick()` → `onNodeStart()` → `activate()` → `propagate()`.
- **SimulationRunner** (`simulation/SimulationRunner.ts`): Orchestrates tick processing, time progression, WebSocket broadcasting.
- **TickProcessor** (`dynamicBasicAgent/npcPlanning/tickProcessor.ts`): Executes one game-minute per tick — runs skill rolls, applies features, records actions to memory.

### NPC Intelligence

**Planning** (`dynamicBasicAgent/npcPlanning/`): LLM generates daily schedules decomposed into action nodes. Plans revise dynamically based on world events.

**Memory** (`memory/`): 7 memory types (event, witness, information, belief, plan, secret, summary). FastEmbed local embeddings for semantic search. Decay engine for realistic forgetting.

### State Management

- **DynamicGameState** (`state/DynamicGameState.ts`): Complete runtime state — NPCs, scenes, topology (junctions/roads), feature state, inventory, relationships.
- **Multiplayer state** (`multiplayerState/`): Scene rooms with freeze-fork-merge tree history for party splitting.

### Server & Client

- **Server entry**: `client/server.ts` — Express + WebSocket on port 3000
- **API routes**: `client/server/` — organized by domain (`auth/`, `simulation/`, `mod/`, `character/`, `multiplayer/`)
- **Frontend**: `client/src/` — React 18 + Vite + TailwindCSS + Phaser (scene viz)
- **i18n**: English + Chinese (`client/src/i18n/locales/`)
- **WebSocket**: Real-time simulation events, multiplayer sync (`client/server/websocket/`)

### Database

PostgreSQL via Prisma (`prisma/schema.prisma`). Key tables: Module/ModuleNpc/ModuleScene (game content), Session/SimulationRuntime/SimulationEvents (runtime), NpcMemory (embeddings), NpcDailyPlan, multiplayer tables.

## Code Conventions

- ESM with `.js` extensions on all internal imports (NodeNext resolution)
- ES2022 target, TypeScript strict mode
- Biome enforced: 2-space indent, double quotes, semicolons, trailing commas (ES5), LF line endings
- `useImportType` / `useExportType` enforced (Biome errors)
- `noUnusedImports` / `noUnusedVariables` enforced (Biome errors)
- Tests co-located: `**/__tests__/*.test.ts`
- Path alias: `@/` maps to `src/` in vitest
- Vitest globals enabled (no need to import `describe`/`it`/`expect`)
- Backend API pattern: `client/server/[domain]/controller.ts` + `routes.ts`, return `{ success, data?, error? }`
