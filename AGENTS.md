# CoC Dynamic World Simulation - Developer Notes

> Last Updated: 2026-03-31

## Project Shape

This repository no longer exposes the old single-player turn pipeline. The active system is a tick-based simulation runtime with these core pieces:

- `src/simulation/SimulationRunner.ts`
- `src/engine/runtime/tickProcessor.ts`
- `src/planning/NPCPlanningAgent.ts`
- `src/engine/handlers/*`
- `src/engine/features/*`

LLMs are used for planning, interpretation, and content generation inside the simulation loop. State progression itself is owned by the runtime and persisted through Prisma.

## What Is Gone

These legacy surfaces are retired and should not be reintroduced:

- old chat-era pipeline terminology
- single-player chat UI flow
- turn polling and turn persistence
- player memos
- turn-based RAG QA endpoints
- onboarding demo routes built around the removed chat UI

## Commands

```bash
pnpm install
pnpm build
pnpm build:tsc
pnpm chat
pnpm chat:frontend
pnpm chat:dev
pnpm check
pnpm test
```

## Key Paths

```text
src/engine/        Tick execution, handlers, world features
src/planning/      NPC planning prompts and agents
src/simulation/    Runner and runtime persistence
src/state/         Dynamic game state and module loading
src/memory/        NPC memory retrieval and storage
client/server/     Express routes and WebSocket server
client/src/        React simulation UI
prisma/schema.prisma
```

## Conventions

- Use `.js` extensions on internal TypeScript imports.
- Prefer simulation terminology over chat or turn terminology.
- Treat `SimulationRuntime` and `SimulationEvent` as the source of truth for analytics and ownership checks.
- Keep discovery retrieval scoped to simulation discoveries, not past-turn narrative replay.
- Do not add compatibility layers for removed chat-era APIs unless explicitly requested.
