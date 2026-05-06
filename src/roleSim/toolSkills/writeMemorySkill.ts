// src/roleSim/toolSkills/writeMemorySkill.ts

export const writeMemorySkill = `---
name: writeMemory
description: Record a thought, plan, belief, secret, or new knowledge. Doesn't consume a tick.
---

# writeMemory

Record something to your memory. Doesn't consume a tick — you can chain other tool calls before terminating.

Use this for **internal mental events** that you wouldn't otherwise leave a trace of. Physical events you do (actions) and witness (other people's actions affecting you) are auto-logged by the engine — don't duplicate.

## When to use
- You formed a new plan: "I'll go to the library after dinner" → \`type=plan\`
- You came to believe something: "Smith is lying" → \`type=belief\`
- You learned something hidden: "I just realized X is the killer" → \`type=secret\`
- You learned a fact: "The library closes at 6 PM" → \`type=information\`
- Your long-term goal genuinely shifted (rare) → \`type=long_term_intent\`
- You learned about a place / route → \`type=map\` (use \`mapAdd\` not \`content\`)

## When NOT to use
- To narrate what just happened — events / witness are auto-recorded by the engine
- To rephrase something you already wrote this decision
- "I think I should do X next" — that's just an action choice, use \`act\` directly
- Routine observations ("the room is dim") — these are perception, not memory

## Usage
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
