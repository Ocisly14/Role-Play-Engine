// src/roleSim/toolSkills/recallMemorySkill.ts

export const recallMemorySkill = `---
name: recallMemory
description: Query your past memories (across days). Doesn't consume a tick.
---

# recallMemory

Search your memories for something specific. Today's events / witness are already in your prompt — use this for **older or topic-specific** memories.

## When to use
- You want to remember an event from a previous day
- You want to recall what someone said, what you believed, what secret you wrote
- You're filtering by type ("what did I plan recently?", "what beliefs do I hold about Smith?")
- The current situation reminds you of something — semantic search

## When NOT to use
- The information is already in \`## Today's memories\` — reading is free, no tool needed
- For trivial / spammy queries — costs a tool call
- More than 10 times per decision — capped

## Usage
{ "tool": "recallMemory", "query": "<keyword phrase>", "types": ["<type>", ...], "gameDay": <number>, "limit": <1-20> }

All fields optional:
- \`query\`: semantic search string (omit for chronological dump)
- \`types\`: filter by memory type (event, witness, belief, secret, plan, information, summary, long_term_intent, map)
- \`gameDay\`: only memories from a specific day
- \`limit\`: 1-20 (default 5; clamped)

## Cap
Max 10 \`recallMemory\` calls per decision.

## Examples

Recalling a past conversation:
{ "tool": "recallMemory", "query": "Smith said about the harbor" }

Listing your beliefs about a person:
{ "tool": "recallMemory", "query": "Smith", "types": ["belief"] }

Recent plans:
{ "tool": "recallMemory", "types": ["plan"], "limit": 5 }
`;
