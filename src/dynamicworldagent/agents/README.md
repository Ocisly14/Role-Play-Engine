# Dynamic World Agents

This directory contains specialized agent implementations for World Builder generated modules.

## Key Differences from Base Agents

These agents extend the base CoC multi-agent system with knowledge-first features:

### Character Agent
- **Enhanced with Knowledge Matrix**: NPCs know/don't know information based on knowledge holders
- **Information Distortion**: Implements partial amnesia, deliberate suppression, misinterpretation
- **Red Herring Support**: NPCs can have false beliefs with physical/psychological sources

### Director Agent
- **Truth Timeline Awareness**: Understands objective event sequence vs. NPC beliefs
- **End State Monitoring**: Tracks point of no return and inevitable outcomes
- **Mythos Event Integration**: Considers historical mythos intrusions in decisions

### Keeper Agent
- **Truth-Driven Narration**: References truth timeline for controlled revelation
- **Red Herring Deployment**: Strategically introduces plausible false explanations
- **Knowledge-Aware Clue System**: Reveals information based on what holders know

### Memory Agent
- **World Builder Data Access**: Loads truth timeline, knowledge matrix, red herrings
- **Keeper Guidance Integration**: Uses module-specific running advice
- **End State Context**: Provides inevitable outcome information to other agents

## File Structure

```
agents/
├── character/
│   ├── characterAgent.ts           # Enhanced NPC response analysis
│   ├── characterTemplate.ts        # Template with knowledge matrix context
│   └── characterSimulatedTemplate.ts
├── director/
│   ├── directorAgent.ts           # Enhanced scene/time/ending management
│   ├── directorTemplate.ts        # Template with end state awareness
│   └── progressionMonitor.ts
├── keeper/
│   ├── keeperAgent.ts             # Enhanced narrative generation
│   └── keeperTemplate.ts          # Template with truth/red herring context
└── memory/
    └── memoryAgent.ts             # Enhanced context enrichment
```

## Integration

These agents are used by a separate LangGraph pipeline for world-builder modules,
while regular modules continue to use the base agents in `src/coc_multiagents_system/agents/`.

## Agent Pipeline Order

For world-builder modules, the enhanced pipeline processes player input through:

1. **Entry Node** (shared) - Clears temporary state
2. **Orchestrator Agent** - Analyzes player intent with knowledge context
3. **Memory Agent** - Loads truth timeline, knowledge matrix, red herrings
4. **Action Agent** - Executes game mechanics (dice, combat, etc.)
5. **Character Agent** - NPCs respond based on knowledge holders
6. **Director Agent** - Manages scenes, time, tracks end state
7. **Keeper Agent** - Generates narrative with truth/red herring context

## Complete File List

```
agents/
├── orchestrator/
│   ├── orchestratorAgent.ts       # Intent analysis
│   ├── orchestratorTemplate.ts    # Template
│   └── index.ts
├── action/
│   ├── actionAgent.ts             # Game mechanics execution
│   └── tools.ts                   # Action execution tools
├── memory/
│   └── memoryAgent.ts             # Context enrichment
├── character/
│   ├── characterAgent.ts          # NPC response analysis
│   ├── characterTemplate.ts
│   └── characterSimulatedTemplate.ts
├── director/
│   ├── directorAgent.ts           # Scene/time/ending management
│   ├── directorTemplate.ts
│   └── progressionMonitor.ts
├── keeper/
│   ├── keeperAgent.ts             # Narrative generation
│   └── keeperTemplate.ts
└── index.ts                        # Main exports
```
