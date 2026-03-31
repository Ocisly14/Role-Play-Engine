# CoC Dynamic World Simulation

Tick-based Call of Cthulhu runtime built around NPC planning, world-state mutation, and persistent simulation data.

## Current Architecture

The active runtime is simulation-only:

- `SimulationRunner` drives ticks, persistence, and event broadcast.
- `tickProcessor` advances one in-world minute per tick.
- `NPCPlanningAgent` generates daily plans and replans when state changes.
- `handlers/` and `features/` apply state transitions and world systems.
- PostgreSQL + Prisma persist `sessions`, `simulation_runtime`, `simulation_events`, NPC plans, and NPC memory.

Legacy single-player chat, turn polling, memos, and the earlier chat-era orchestration chain have been removed from the active product surface.

## Commands

```bash
pnpm install
pnpm build
pnpm build:tsc
pnpm chat
pnpm chat:frontend
pnpm chat:dev
pnpm dev:debug
pnpm check
pnpm test
```

## Repo Layout

```text
src/
  engine/        Tick runtime, handlers, features
  planning/      NPC planning agent, prompts, plan types
  simulation/    Simulation runner and persistence helpers
  state/         Dynamic game state and module loading
  memory/        NPC memory system
  rag/           Discovery retrieval infrastructure

client/
  server/        Express API and WebSocket server
  src/           React application for simulation management and inspection

prisma/
  schema.prisma
  migrations/
```

## Runtime Data

Core persisted entities:

- `sessions`
- `simulation_runtime`
- `simulation_events`
- `npc_daily_plans`
- `npc_long_term_intents`
- `npc_memories`
- `user_token_usage`

## Notes

- `CLAUDE.md` is the current high-signal developer reference.
- Analytics now report simulation counts and simulation event counts rather than message or turn counts.
- Discovery RAG is retained for simulation discoveries only; turn-based QA has been removed.
