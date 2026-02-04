# Repository Guidelines

## Project Structure & Module Organization
- Source lives in `src/`; `index.ts` is the CLI entry that seeds the SQLite DB and runs the LangGraph flow.
- Graph wiring and orchestrator logic sit in `src/graph.ts` and `src/runtime.ts`; shared state types are in `src/state.ts` with prompt helpers in `src/template.ts` and utilities in `src/utils.ts`.
- Game-specific agents and data access are under `src/shared/`: `agents/` (orchestrator, memory, keeper, character stub) and `shared/database/` (schema, seed data).
- Build artifacts land in `dist/` after compilation; the runtime creates `data/coc_game.db` if it does not exist.
- Architecture notes: see `ARCHITECTURE.md` and `src/shared/README.md` for agent roles and DB shape.

## Build, Test, and Development Commands
- `npm install` — install dependencies.
- `npm run dev -- --prompt "..."` — run via tsx for quick iteration; seeds the DB each run.
- `npm run build` — TypeScript compilation to `dist/` (fails on type errors).
- `npm start -- --prompt "..."` — execute the compiled build; use this for release checks.
- For ad hoc smoke tests, run with a known prompt (e.g., `--prompt "Investigate the study for clues"`); inspect agent transcripts printed to stdout.

## Coding Style & Naming Conventions
- TypeScript with `strict` mode and NodeNext ES modules; keep `.js` extensions on internal imports.
- Prefer 2-space indentation, explicit return types, and narrow unions (e.g., `AgentId = "character" | "memory"`; keeper is invoked implicitly).
- Keep orchestrator prompts/json parsing deterministic; avoid `any` and prefer small helpers over inline logic.
- Name files and symbols descriptively (`buildKeeperPrompt`, `parseRoutingDecision`); align new agents under `src/shared/agents/<agent>/`.

## Testing Guidelines
- No automated test runner is configured yet; at minimum run `npm run build` before sending changes to catch type regressions.
- When adding tests, place them under `tests/` or alongside modules as `*.spec.ts`; mock the SQLite layer or seed with fixtures to avoid mutating real data.
- For behaviour checks today, run `npm run dev` with a deterministic prompt and confirm the agent queue and keeper output match expectations.

## Commit & Pull Request Guidelines
- Current branch has no history; use concise, imperative commit messages (optionally Conventional Commits like `feat:`/`fix:`) that describe the change surface.
- PRs should include: a short summary, relevant issues/links, commands executed (`npm run build`, manual prompt checks), and any schema or agent contract changes noted.
- If output formatting or prompts change, paste a short transcript from `npm run dev -- --prompt "..."` so reviewers can see behavioural impact.

## Security & Configuration Notes
- Keep secrets in `.env` (`OPENAI_API_KEY` required); never commit `.env` or API keys.
- The app will create `data/coc_game.db` at runtime; ensure the `data/` directory is writable locally and excluded from version control unless fixtures are intentional.
