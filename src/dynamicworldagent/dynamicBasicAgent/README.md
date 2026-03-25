# Dynamic World Agents

NPC planning, tick-based simulation, and knowledge retrieval for the dynamic world engine.

## Structure

```
dynamicBasicAgent/
├── index.ts                  # Exports NPCPlanningAgent
├── skillDefaults.ts          # Default skill values
├── npcPlanning/
│   ├── NPCPlanningAgent.ts   # Daily schedule generation via LLM
│   ├── tickProcessor.ts      # Per-minute tick execution
│   ├── npcPlanningTemplates.ts
│   ├── types.ts
│   ├── autoMovementHelpers.ts
│   ├── itemFormatHelpers.ts
│   ├── revisionHelpers.ts
│   ├── sceneMapFormatter.ts
│   ├── cocSkillList.ts
│   └── __tests__/
└── knowledge/
    ├── sessionRagService.ts      # RAG retrieval for session context
    ├── sessionRagQaService.ts    # RAG-based Q&A
    ├── buildRagQueryTemplate.ts  # Query template construction
    ├── ragQueryRewriter.ts       # Query rewriting
    └── textChunker.ts            # Text chunking for embeddings
```
