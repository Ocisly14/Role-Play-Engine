# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CoC Multi-Agent System is an AI-powered Call of Cthulhu (7th Edition) game master built with LangGraph multi-agent architecture. The system uses 6 specialized AI agents working in a sequential pipeline to run complete tabletop RPG sessions.

**Tech Stack:** TypeScript, LangGraph, LangChain, SQLite, React, Express, WebSocket

**Current Branch:** `weaktime` (development branch for time mechanics improvements)
**Main Branch:** `main` (use for PRs)

## Essential Commands

### Development Workflow

```bash
# Install dependencies (required: pnpm >= 9.0.0)
pnpm install

# Build the project (compiles TypeScript to dist/)
pnpm build

# Run backend server (starts Express API + WebSocket server)
pnpm chat

# Run frontend (in separate terminal, starts Vite dev server)
pnpm chat:frontend

# Run both backend + frontend concurrently
pnpm chat:dev

# Development mode with debug logs
pnpm dev:debug
```

### Code Quality

```bash
# Format code with Biome
pnpm format

# Lint code
pnpm lint

# Format + lint + auto-fix
pnpm check

# Run tests
pnpm test

# Run tests with coverage
pnpm test:coverage
```

### Build Variants

```bash
# Default build (uses SWC for speed)
pnpm build

# Build with TypeScript compiler (slower, stricter type checking)
pnpm build:tsc

# Build with Turbo (monorepo-optimized)
pnpm build:turbo
```

## Architecture

### Multi-Agent Pipeline

The system processes player input through a **sequential agent pipeline** defined in `src/graph.ts`:

```
Player Input → Entry → Orchestrator → Memory → Action → Character → Director → Keeper → Output
```

**Agent Responsibilities:**

1. **Entry** (`src/graph.ts:60`): Routes input type, clears temporary state for new player turns
2. **Orchestrator** (`src/coc_multiagents_system/agents/orchestrator/orchestratorAgent.ts`): Analyzes player intent and determines action type
3. **Memory** (`src/coc_multiagents_system/agents/memory/memoryAgent.ts`): Enriches context with relevant game rules, scenario details, and RAG results
4. **Action** (`src/coc_multiagents_system/agents/action/actionAgent.ts`): Executes dice rolls, updates character stats, manages inventory
5. **Character** (`src/coc_multiagents_system/agents/character/characterAgent.ts`): Determines NPC responses and behaviors
6. **Director** (`src/coc_multiagents_system/agents/director/directorAgent.ts`): Manages scene transitions, time progression, and game ending conditions
7. **Keeper** (`src/coc_multiagents_system/agents/keeper/keeperAgent.ts`): Generates narrative output for the player

**Key State Management:**
- `GraphState` (graph-level): Messages, game state, turn tracking
- `GameState` (`src/state.ts`): Session data, character profiles, scenarios, clues, temporary agent outputs
- `temporaryInfo`: Cleared at start of each player turn, holds intermediate agent results

### Project Structure

```
CoC-AI-agent/
├── src/                                    # Backend source code
│   ├── graph.ts                           # LangGraph workflow definition
│   ├── state.ts                           # GameState types and manager
│   ├── index.ts                           # CLI entry point
│   ├── coc_multiagents_system/
│   │   ├── agents/                        # 6 specialized AI agents
│   │   │   ├── orchestrator/              # Intent analysis
│   │   │   ├── memory/                    # Context enrichment & loaders
│   │   │   │   ├── database/              # SQLite schema & seed data
│   │   │   │   ├── moduleloader/          # Module digest loading
│   │   │   │   ├── scenarioloader/        # Scenario/location loading
│   │   │   │   ├── RagManager.ts          # RAG system (currently disabled)
│   │   │   │   ├── turnManager.ts         # Turn persistence
│   │   │   │   └── checkpointManager.ts   # Save/load functionality
│   │   │   ├── action/                    # Dice rolls & mechanics
│   │   │   │   └── tools.ts               # Action execution tools
│   │   │   ├── character/                 # NPC behavior
│   │   │   │   ├── npcloader/             # NPC profile loading
│   │   │   │   └── playerloader/          # Player character loading
│   │   │   ├── director/                  # Scene & time management
│   │   │   │   └── progressionMonitor.ts  # Story progression tracking
│   │   │   ├── keeper/                    # Narrative generation
│   │   │   └── models/                    # Shared types
│   │   │       ├── gameTypes.ts           # Character, inventory types
│   │   │       ├── scenarioTypes.ts       # Scenario, clue types
│   │   │       └── moduleTypes.ts         # Module digest types
│   │   └── rules/                         # CoC 7e mechanics (8 action types)
│   │       ├── exploration.ts
│   │       ├── social.ts
│   │       ├── combat.ts
│   │       ├── stealth.ts
│   │       ├── chase.ts
│   │       ├── mental.ts
│   │       ├── environmental.ts
│   │       └── narrative.ts
│   └── rag/                               # RAG infrastructure (WIP)
│
├── client/                                 # React frontend
│   ├── server.ts                          # Express server entry point
│   ├── server/                            # Backend API modules
│   │   ├── auth/                          # Authentication & JWT
│   │   ├── character/                     # Character CRUD
│   │   ├── game/                          # Game state management
│   │   ├── turn/                          # Turn execution (LangGraph invocation)
│   │   ├── checkpoint/                    # Save/load endpoints
│   │   ├── mod/                           # Module management
│   │   ├── core/                          # DatabaseManager, GraphManager
│   │   ├── websocket/                     # WebSocket for real-time updates
│   │   └── utils/                         # Shared utilities
│   └── src/                               # React UI
│       ├── App.tsx                        # Main application (82KB, complex)
│       ├── components/                    # UI components
│       │   └── GameChat.tsx               # Main chat interface
│       ├── views/                         # Page-level components
│       └── services/                      # API client

├── data/
│   ├── db.sqlite                          # Game database (auto-generated)
│   └── Mods/                              # Module packages
│       └── [Module Name]/
│           ├── module_digest.json         # Module metadata
│           ├── [Module]_npc/              # NPC profiles (JSON/docs)
│           └── [Module]_Scenarios/        # Scenario/location files

├── scripts/                                # Deployment scripts
├── deployment/                             # AWS Elastic Beanstalk config
└── test-*.ts                              # Standalone loader tests
```

## Key Workflows

### Turn Execution Flow

When a player submits an action via the web UI:

1. **Frontend** (`client/src/components/GameChat.tsx`) sends POST to `/api/turns/:sessionId`
2. **Turn Controller** (`client/server/turn/controller.ts`) validates session and invokes graph
3. **Graph Execution** (`src/graph.ts`):
   - Entry node clears temporary state, increments turn counter
   - Orchestrator analyzes intent → outputs `ActionAnalysis`
   - Memory enriches context (rules, scenario data, RAG if enabled)
   - Action executes mechanics → outputs `ActionResult[]`
   - Character determines NPC responses → outputs `NPCResponseAnalysis[]`
   - Director checks scene transitions, time progression, game ending → outputs `DirectorDecision`
   - Keeper generates narrative using all previous agent outputs
4. **Turn Manager** (`src/coc_multiagents_system/agents/memory/turnManager.ts`) persists turn to database
5. **WebSocket** broadcasts updated game state to connected clients

### Module Loading

The system supports custom Call of Cthulhu scenarios (modules) with NPCs, locations, and clues.

**Module Structure:**
- `data/Mods/[Module Name]/module_digest.json`: Title, background, story outline, keeper guidance, initial game time
- `data/Mods/[Module Name]/[Module]_npc/`: NPC JSON files or documents (.docx, .pdf)
- `data/Mods/[Module Name]/[Module]_Scenarios/`: Scenario JSON files or documents

**Loaders:**
- `ModuleLoader` (`src/coc_multiagents_system/agents/memory/moduleloader/`): Parses module digest
- `NPCLoader` (`src/coc_multiagents_system/agents/character/npcloader/`): Loads NPC profiles with AI-powered document parsing
- `ScenarioLoader` (`src/coc_multiagents_system/agents/memory/scenarioloader/`): Loads scenarios/locations

**Document Parsing:**
- Supports both structured JSON and unstructured documents (.docx, .pdf)
- Uses LLM-powered extraction when JSON is not available

### Database Schema

SQLite database (`data/db.sqlite`) managed by `src/coc_multiagents_system/agents/memory/database/schema.ts`:

**Core Tables:**
- `users`: User authentication
- `sessions`: Game sessions (links user + module)
- `characters`: Player and NPC profiles
- `scenarios`: Scenario/location instances
- `turns`: Turn history with full state snapshots
- `checkpoints`: Manual save points
- `game_state`: Current game state per session

**Important:** Database is auto-created on first run. Use `DatabaseManager` singleton for all DB access.

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Model Provider (openai, google, anthropic)
MODEL_PROVIDER=google

# API Keys
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...

# Model Selection (SMALL for speed, MEDIUM for quality)
SMALL_GOOGLE_MODEL=gemini-2.0-flash
MEDIUM_GOOGLE_MODEL=gemini-2.5-flash

# Database
DATABASE_PATH=./data/db.sqlite

# Server
PORT=3000
NODE_ENV=development

# JWT (change in production!)
JWT_SECRET=CHANGE-THIS-TO-A-SECURE-RANDOM-STRING
```

**Model Strategy:**
- SMALL models: Orchestrator, Memory, Action, Character, Director (fast, structured output)
- MEDIUM models: Keeper only (creative narrative generation)

### RAG System Status

RAG (Retrieval-Augmented Generation) is currently **disabled** by default in production:
- `SKIP_RAG = true` in memory agent
- System under active redesign for better semantic search and graph traversal
- See `RAG.md` for architecture design notes

## Important Implementation Details

### Time System (weaktime branch)

The `weaktime` branch implements in-game time tracking:
- `GameState.gameDay`: Current day number
- `GameState.timeOfDay`: HH:MM format
- `scenarioTimeState`: Tracks time consumption per player action
- Time advances based on action types and Director decisions
- Modified files: `client/server/turn/controller.ts`, `client/server/turn/routes.ts`, `client/src/App.tsx`, `client/src/components/GameChat.tsx`

### Simulated vs Real Input

The graph distinguishes between real player input and Director-simulated queries:
- `state.isSimulatedQuery`: If true, skips Orchestrator and Memory agents
- `state.simulatedQueryCount`: Safety counter (max 5) to prevent infinite loops
- Used when Director needs to generate autonomous NPC actions or environmental events

### Action Types (8 Categories)

CoC 7e mechanics organized into 8 action types (`src/state.ts:10-19`):
1. **Exploration**: Finding clues, gathering information
2. **Social**: Influencing NPCs, persuasion, interrogation
3. **Combat**: Fighting, causing damage
4. **Stealth**: Sneaking, hiding, acting undetected
5. **Chase**: Pursuit or escape
6. **Mental**: Sanity checks, resisting psychological horror
7. **Environmental**: Surviving harsh conditions, physical endurance
8. **Narrative**: Key story choices, plot decisions

Each type has corresponding rules in `src/coc_multiagents_system/rules/[type].ts`

### NPC Response System

NPCs can respond autonomously to player actions:
- Character agent analyzes context and determines `NPCResponseAnalysis[]`
- Each NPC response has `responseType` (one of 8 action types or "none")
- `executionOrder`: Determines sequence when multiple NPCs respond
- Responses are processed in order, each can trigger additional mechanics

### State Cleanup

**Critical:** `temporaryInfo` in `GameState` is cleared at the start of each real player turn (Entry node):
- `actionResults`: Cleared
- `npcResponseAnalyses`: Cleared
- `currentActionAnalysis`: Cleared
- `narrativeDirection`: Cleared
- `rules`, `ragResults`: Cleared

Do not persist temporary agent outputs across turns unless explicitly moved to permanent state.

## Testing

**Current Status:** No automated test suite configured.

**Manual Testing:**
1. Run `pnpm build` to catch type errors
2. Use `pnpm chat:dev` to test full stack
3. Test module loading with standalone scripts:
   - `test-moduleloader.ts`: Module digest parsing
   - `test-npcloader.ts`: NPC loading
   - `test-playerloader.ts`: Player character loading
   - `test-scenarioloader.ts`: Scenario loading

**When Adding Tests:**
- Place in `tests/` or alongside modules as `*.spec.ts`
- Use Vitest (`vitest.config.ts` is configured)
- Mock SQLite layer to avoid mutating real data

## Known Issues & Limitations

1. **Single Player Only**: Multiplayer support under development
2. **RAG Disabled**: System being redesigned for better retrieval
3. **Frontend UX**: UI improvements in progress
4. **Large App.tsx**: Main app component is 82KB, needs refactoring
5. **Time Mechanics**: Still experimental on `weaktime` branch

## API Architecture (client/server)

The backend API is organized by domain:

**Authentication** (`/api/auth/*`):
- POST `/login`, `/register`, `/logout`
- JWT-based with refresh tokens
- Session management with idle timeout

**Game Management** (`/api/game/*`):
- POST `/game/init`: Initialize new game session
- GET `/game/:sessionId`: Get current game state
- PUT `/game/:sessionId`: Update game state

**Turn Execution** (`/api/turns/*`, `/api/sessions/*`):
- POST `/turns/:sessionId`: Execute player action (invokes LangGraph)
- GET `/sessions/:sessionId/turns`: Get turn history
- WebSocket `/ws`: Real-time game state updates

**Character Management** (`/api/character*`):
- GET `/characters`: List all characters in session
- POST `/character`: Create new character
- PUT `/character/:id`: Update character

**Module Management** (`/api/mod/*`, `/api/module/*`):
- GET `/mods`: List available modules
- POST `/mod/load`: Load specific module into session

**Checkpoint System** (`/api/checkpoints/*`):
- POST `/checkpoints/:sessionId`: Create save point
- GET `/checkpoints/:sessionId`: List checkpoints
- POST `/checkpoints/:checkpointId/restore`: Load from checkpoint

## Development Best Practices

### Code Style

- TypeScript strict mode with NodeNext ES modules
- Always use `.js` extensions on internal imports (ESM requirement)
- 2-space indentation (enforced by Biome)
- Explicit return types preferred
- Avoid `any` type

### Agent Development

When adding/modifying agents:
1. Agent logic goes in `src/coc_multiagents_system/agents/[agent-name]/[agent-name]Agent.ts`
2. Prompt templates in `[agent-name]Template.ts`
3. Update `src/graph.ts` to wire into pipeline
4. Update `GraphState` or `GameState` if new state fields needed
5. Document agent's role and outputs

### Database Access

- Always use `DatabaseManager.getInstance()` singleton
- Never mutate database directly in agent code
- Use TurnManager for persisting turns
- Use CheckpointManager for save/restore
- Close database on shutdown (handled in `client/server.ts`)

### Module Creation

See README.md section "How to Upload Your Own Module" for detailed instructions. Key points:
- Use structured JSON for complex data
- Documents (.docx, .pdf) work for rapid prototyping
- Always include `module_digest.json`
- Test with standalone loaders before running full game

## Monorepo Structure

This is a pnpm workspace with two packages:
- Root: Backend (Express server, LangGraph agents)
- `client/`: Frontend (React app)

**Shared Dependencies:** Root `pnpm install` installs both backend and frontend dependencies.

**Build System:** Turbo.json configures monorepo tasks. Use `pnpm build:turbo` for optimized builds.
