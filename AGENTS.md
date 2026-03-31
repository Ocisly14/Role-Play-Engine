# CoC Multi-Agent System - Developer Guidelines

> **Last Updated**: 2026-02-11
> **Project**: AI-powered Call of Cthulhu Game Master with LangGraph multi-agent architecture

---

## Project Overview

CoC Multi-Agent System is a full-stack TypeScript application that runs complete tabletop RPG sessions using 6 specialized AI agents in a sequential pipeline. The system features a React frontend, Express backend, and WebSocket-based real-time communication.

**Tech Stack**: TypeScript, LangGraph, LangChain, SQLite, React, Express, WebSocket, Vite

---

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

---

## Project Structure

```
CoC-AI-agent/
├── src/                                    # Backend source code
│   ├── shared/
│   │   ├── agents/                        # AI agents (action, character, memory, models)
│   │   └── database/                      # SQLite schema & seed data
│   ├── engine/                            # Tick engine, handlers, features, shared runtime logic
│   ├── planning/                          # NPC planning agent, plan types, templates
│   ├── memory/                            # NPC memory system
│   ├── simulation/                        # Simulation runner and runtime persistence
│   ├── state/                             # Dynamic game state and module loading
│   ├── i18n/                              # Simulation/runtime translations
│   ├── models/                            # Shared types
│   ├── rag/                               # RAG infrastructure and session retrieval
│   ├── template.ts                        # Prompt templates
│   └── types/                             # Type definitions
│
├── client/                                 # React frontend
│   ├── server.ts                          # Express server entry point
│   ├── server/                            # Backend API modules
│   │   ├── auth/                          # Authentication & JWT
│   │   ├── character/                     # Character CRUD
│   │   ├── game/                          # Game state management
│   │   ├── turn/                          # Turn execution (LangGraph invocation)
│   │   ├── checkpoint/                    # Save/load endpoints
│   │   │   ├── controller.ts              # ✨ Includes batch delete API
│   │   │   └── routes.ts
│   │   ├── mod/                           # Module management
│   │   ├── core/                          # DatabaseManager, GraphManager
│   │   ├── websocket/                     # WebSocket for real-time updates
│   │   └── utils/                         # Shared utilities
│   └── src/                               # React UI
│       ├── App.tsx                        # Main application
│       ├── components/                    # UI components
│       │   ├── GameChat.tsx               # ✨ Refactored (733 lines, was 2161)
│       │   ├── gamechat/                  # ✨ GameChat subcomponents
│       │   │   ├── InputArea.tsx          # Message input with skill selection
│       │   │   ├── MessageList.tsx        # Message display
│       │   │   ├── MessageItem.tsx        # Single message
│       │   │   ├── SessionInfoBar.tsx     # Character info + save button
│       │   │   ├── SkillSelectionModal.tsx
│       │   │   └── utils.ts
│       │   ├── layout/
│       │   │   └── LanguageToggle.tsx     # ✨ EN/中文 switcher
│       │   └── modals/
│       │       └── CheckpointSelectorModal.tsx  # ✨ Batch delete UI
│       ├── hooks/                         # ✨ Custom React hooks (7 total)
│       │   ├── useWebSocket.ts            # WebSocket connection (515 lines)
│       │   ├── useGameMessages.ts         # Message state management
│       │   ├── useDiceAnimation.ts        # Dice roll animations
│       │   ├── useSkillSelection.ts       # Skill suggestion & selection
│       │   ├── useAutoSave.ts             # Auto-save on exit
│       │   ├── useSceneTransition.ts      # Scene change effects
│       │   └── useInputCollapse.ts        # Input area collapse/expand
│       ├── contexts/                      # React contexts
│       │   ├── AppSettingsContext.tsx     # ✨ Language settings (default: EN)
│       │   └── GameSessionContext.tsx
│       ├── views/                         # Page-level components
│       └── services/                      # API client
│
├── data/
│   ├── db.sqlite                          # Game database (auto-generated)
│   └── Mods/                              # Module packages
│       └── [Module Name]/
│           ├── module_digest.json         # Module metadata
│           ├── [Module]_npc/              # NPC profiles (JSON/docs)
│           └── [Module]_Scenarios/        # Scenario/location files
│
├── scripts/                                # Deployment scripts
├── deployment/                             # AWS Elastic Beanstalk config
└── *.md                                   # Documentation
    ├── CLAUDE.md                          # ✨ Main project guide (authoritative)
    ├── AGENTS.md                          # This file
    ├── GAMECHAT_REFACTOR_COMPLETE.md      # ✨ Component refactoring report
    └── README.md
```

---

## Recent Major Changes (2026-02-11)

### ✨ GameChat Component Refactored
- **Before**: 2161-line monolithic component
- **After**: 16 modular files (7 hooks + 5 UI components + utils + types)
- **Benefits**:
  - 10x better maintainability
  - Fully testable components
  - Reusable hooks
  - Performance optimized (React.memo, useCallback)
- **Details**: See `GAMECHAT_REFACTOR_COMPLETE.md`

### ✨ Batch Delete Checkpoints
- **Backend**: `POST /api/checkpoints/batch-delete` endpoint
- **Frontend**:
  - Batch selection mode with checkboxes
  - "Select All" / "Delete Selected (N)" buttons
  - Permission verification for all checkpoints
- **Location**: `client/server/checkpoint/controller.ts`, `CheckpointSelectorModal.tsx`

### ✨ Language System Improvements
- **Default Language**: English (was Chinese)
- **UI**: EN/中文 toggle in bottom-right corner (EN first, 中文 second)
- **Persistence**: Saved to localStorage
- **Context**: `AppSettingsContext.tsx`

### ✨ UI/UX Enhancements
- **Auto-scroll**: Messages auto-scroll when input expands
- **Dynamic Padding**: Message list adjusts bottom spacing (500px when expanded)
- **Save Feedback**: Simplified to "✓ Checkpoint saved successfully"

---

## Multi-Agent Pipeline Architecture

The system processes player input through a **sequential agent pipeline**:

```
Player Input → Entry → Orchestrator → Memory → Action → Character → Director → Keeper → Output
```

**Agent Responsibilities:**

1. **Entry**: Routes input type, clears temporary state for new player turns
2. **Orchestrator**: Analyzes player intent and determines action type
3. **Memory**: Enriches context with game rules, scenario details, and RAG results
4. **Action**: Executes dice rolls, updates character stats, manages inventory
5. **Character**: Determines NPC responses and behaviors
6. **Director**: Manages scene transitions, time progression, game ending conditions
7. **Keeper**: Generates narrative output for the player

**Key State Management:**
- `GraphState` (graph-level): Messages, game state, turn tracking
- `GameState` (`src/state.ts`): Session data, character profiles, scenarios, clues, temporary agent outputs
- `temporaryInfo`: Cleared at start of each player turn, holds intermediate agent results

---

## Development Best Practices

### Coding Style

- TypeScript strict mode with NodeNext ES modules
- Always use `.js` extensions on internal imports (ESM requirement)
- 2-space indentation (enforced by Biome)
- Explicit return types preferred
- Avoid `any` type
- Use React.memo for presentational components
- Use useCallback for event handlers
- Keep components under 400 lines (extract to hooks/subcomponents)

### Component Development Guidelines

When creating/modifying React components:

1. **Extract Complex Logic to Hooks**:
   - State management → custom hooks
   - Side effects → custom hooks
   - Keep component focused on rendering

2. **Optimize Performance**:
   - Use `React.memo` for presentational components
   - Use `useCallback` for event handlers
   - Use `useMemo` for expensive computations
   - Use refs for values that don't trigger re-renders

3. **Maintain Single Responsibility**:
   - One component = one purpose
   - Extract subcomponents when logic becomes complex
   - Aim for <400 lines per file

**Example**: See `client/src/components/GameChat.tsx` (refactored from 2161 lines to 733 lines + 15 support files)

### Backend API Development

When adding new endpoints:

1. **Controller Pattern**:
   ```typescript
   // client/server/[module]/controller.ts
   export function myEndpoint(req: Request, res: Response): void {
     try {
       // Verify user permissions
       // Execute logic
       // Return JSON response
     } catch (error) {
       res.status(500).json({ error: message });
     }
   }
   ```

2. **Route Registration**:
   ```typescript
   // client/server/[module]/routes.ts
   router.post("/my-endpoint", controller.myEndpoint);
   ```

3. **Always**:
   - Verify user permissions (check ownership via email)
   - Use try-catch error handling
   - Return consistent JSON format: `{ success: boolean, data?, error? }`
   - Log important actions with timestamps

**Example**: See `client/server/checkpoint/controller.ts::batchDeleteCheckpoints`

### Database Access

- Always use `DatabaseManager.getInstance()` singleton
- Never mutate database directly in agent code
- Use TurnManager for persisting turns
- Use CheckpointManager for save/restore
- Close database on shutdown (handled in `client/server.ts`)

---

## Testing Strategy

### Current Status
- No automated test suite configured yet
- Manual testing workflow:

### Manual Testing

1. **Build Verification**:
   ```bash
   pnpm build          # Backend (should succeed, ~86 files)
   cd client && pnpm build  # Frontend (should succeed, ~1111 modules)
   ```

2. **Full Stack Testing**:
   ```bash
   pnpm chat:dev       # Runs both backend + frontend
   ```

3. **Module Loading Tests**:
   - Standalone scripts exist in root:
     - `test-moduleloader.ts`
     - `test-npcloader.ts`
     - `test-playerloader.ts`
     - `test-scenarioloader.ts`

### When Adding Tests (Future)

- Place in `tests/` or alongside modules as `*.spec.ts`
- Use Vitest (`vitest.config.ts` is configured)
- Mock SQLite layer to avoid mutating real data
- Test hooks in isolation using React Testing Library
- Test components with user interaction scenarios

---

## Commit & Pull Request Guidelines

### Commit Messages

Use concise, imperative messages (optionally Conventional Commits):

```bash
# Good examples
feat: add batch delete checkpoints API
fix: message list auto-scroll on input expand
refactor: extract GameChat into 16 modular files
docs: update AGENTS.md with latest changes

# Bad examples
"updated stuff"
"fixes"
"WIP"
```

### Pull Requests Should Include

1. **Summary**: Brief description of changes
2. **Testing**: Commands executed and results
   ```
   ✓ pnpm build (86 files)
   ✓ pnpm build (client: 1111 modules)
   ✓ Manual testing: batch delete works
   ```
3. **Breaking Changes**: Note any API or schema changes
4. **Screenshots**: For UI changes, include before/after
5. **Related Issues**: Link to relevant issues/discussions

---

## Configuration & Environment

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

---

## Security Notes

### Critical Security Rules

1. **Never commit secrets**:
   - Keep `.env` out of git
   - Never hardcode API keys
   - Use environment variables for all credentials

2. **Database Safety**:
   - `data/db.sqlite` is auto-created at runtime
   - Ensure `data/` directory is writable
   - Database is gitignored

3. **User Permission Verification**:
   - Always verify user owns resources before modification
   - Check email-based ownership in all endpoints
   - Example: See `batchDeleteCheckpoints` verification logic

4. **Input Validation**:
   - Validate all user inputs
   - Sanitize data before database operations
   - Prevent SQL injection (use parameterized queries)

---

## Monorepo Structure

This is a **pnpm workspace** with two packages:

- **Root**: Backend (Express server, LangGraph agents)
- **client/**: Frontend (React app)

**Shared Dependencies**: Root `pnpm install` installs both backend and frontend dependencies.

**Build System**: `turbo.json` configures monorepo tasks. Use `pnpm build:turbo` for optimized builds.

---

## Known Limitations & Future Work

### Current Limitations

1. **Single Player Only**: Multiplayer support under development
2. **RAG Disabled**: System being redesigned for better retrieval
3. **No Automated Tests**: Manual testing only
4. **Large Bundle Size**: Frontend bundle is 925 KB (consider code splitting)

### Planned Improvements

1. **Testing Coverage**:
   - [ ] Unit tests for all hooks
   - [ ] Component tests for UI
   - [ ] E2E tests for critical flows

2. **Performance**:
   - [ ] Implement virtual scrolling for long message lists
   - [ ] Code splitting for modals and heavy components
   - [ ] Optimize WebSocket reconnection logic

3. **Features**:
   - [ ] Multiplayer support
   - [ ] Voice input/output
   - [ ] Mobile-responsive design
   - [ ] Advanced checkpoint management (tags, search)

---

## Quick Reference

### Important Files

- **CLAUDE.md**: Main project documentation (most authoritative)
- **README.md**: Project overview and getting started
- **GAMECHAT_REFACTOR_COMPLETE.md**: GameChat refactoring details
- **package.json**: Scripts and dependencies
- **.env.example**: Environment variable template

### Key Directories

- `src/shared/agents/`: Backend AI agents
- `client/src/components/`: React UI components
- `client/src/hooks/`: Custom React hooks
- `client/server/`: Express API endpoints
- `data/Mods/`: Game modules (scenarios, NPCs)

### Useful Commands

```bash
# Quick start
pnpm install && pnpm chat:dev

# Check code quality
pnpm check

# Full rebuild
pnpm build && cd client && pnpm build

# View logs
pnpm dev:debug

# Run specific module test
tsx test-moduleloader.ts
```

---

## Getting Help

- **Project Issues**: Check existing issues or create new one
- **Documentation**: See CLAUDE.md for comprehensive guide
- **Code Examples**: Reference existing components/hooks
- **Architecture**: See `src/shared/README.md` for agent details

---

*Last updated: 2026-02-11 | Maintained by: Development Team*
