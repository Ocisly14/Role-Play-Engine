# Planning

LLM-driven NPC planning for the dynamic world engine.

## Structure

```
planning/
├── index.ts                  # Planning entrypoint + re-exports
├── NPCPlanningAgent.ts       # Daily schedule generation and plan revision
├── npcPlanningTemplates.ts   # Planning/revision prompt builders
├── npcSummaryTemplates.ts    # Day-summary prompt builders
├── types.ts                  # Plan/action contracts shared with engine
├── autoMovementHelpers.ts
├── itemFormatHelpers.ts
├── revisionHelpers.ts
├── sceneMapFormatter.ts
├── cocSkillList.ts
├── skillDefaults.ts
└── __tests__/
```

Tick execution runtime lives under `src/engine/runtime/`.
Session RAG helpers live under `src/rag/session/`.
