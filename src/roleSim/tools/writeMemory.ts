// src/roleSim/tools/writeMemory.ts

export const writeMemoryDoc = `---
name: writeMemory
description: Record a thought, plan, belief, secret, or new knowledge. Doesn't consume a tick.
---

# writeMemory

Record something to your memory. Doesn't consume a tick — you can chain other tool calls before terminating.

Use this for **internal mental events** that you wouldn't otherwise leave a trace of. Physical events you do (actions) and witness (other people's actions affecting you) are auto-logged by the engine — don't duplicate.

## Allowed types (you may ONLY use these 7)
- \`plan\` — a new plan you formed: "I'll go to the library after dinner"
- \`belief\` — something you came to believe: "Smith is lying"
- \`secret\` — something hidden you realized: "X is the killer"
- \`information\` — a fact you learned: "The library closes at 6 PM"
- \`summary\` — an end-of-day reflection / dated diary entry
- \`long_term_intent\` — your long-term goal genuinely shifted (rare)
- \`map\` — a place / route you learned (use \`mapAdd\`, not \`content\`)


## When NOT to use
- To narrate what just happened — events / witness are auto-recorded by the engine
- To rephrase something you already wrote this decision
- "I think I should do X next" — that's just an action choice, use \`act\` directly
- Routine observations ("the room is dim") — these are perception, not memory

## Output
{ "tool": "writeMemory", "type": "<type>", "content": "<text>" }

For \`type=map\`:
{ "tool": "writeMemory", "type": "map", "mapAdd": { "sceneNames": ["library"], "junctionNames": [], "roadNames": [], "revealHiddenConnection": "" } }

## Cap
Max 3 \`writeMemory\` calls per decision.

## Examples

Forming a belief from observation:
{ "tool": "writeMemory", "type": "belief", "content": "Smith was at the library when I asked, but his coat was wet. He must have been outside earlier." }

Recording a plan:
{ "tool": "writeMemory", "type": "plan", "content": "Tomorrow morning, head to the harbor before anyone notices I'm gone." }

Writing a dated summary-style memory:
{ "tool": "writeMemory", "type": "summary", "content": "[1923-10-17] Today I realized Smith is afraid of the harbor." }

Recording a discovered location:
{ "tool": "writeMemory", "type": "map", "mapAdd": { "sceneNames": ["abandoned warehouse"] } }
`;
