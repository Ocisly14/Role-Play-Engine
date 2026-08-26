// src/roleSim/tools/recallMemory.ts

export const recallMemoryDoc = `---
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

## Output
recallMemory({ "query": "<keyword phrase>", "types": ["<type>", ...], "gameDates": ["YYYY-MM-DD", ...], "limit": <1-20> })

All fields optional:
- \`query\`: semantic search string (omit for chronological dump)
- \`types\`: filter by memory type (event, witness, belief, secret, plan, information, summary, long_term_intent, map)
- \`gameDates\`: array of ISO 8601 dates ("YYYY-MM-DD", no time/T separator). Restricts results to memories written on **any** of the listed days. Pass a single-element array for one day, or multiple for an OR-set. Example: \`["1923-10-15", "1923-10-16"]\`.
- \`limit\`: 1-20 (default 5; clamped)

## Cap
Max 10 \`recallMemory\` calls per decision.

## Examples

Recalling a past conversation:
recallMemory({ "query": "Smith said about the harbor" })

Listing your beliefs about a person:
recallMemory({ "query": "Smith", "types": ["belief"] })

Recent plans:
recallMemory({ "types": ["plan"], "limit": 5 })

What happened over the weekend:
recallMemory({ "gameDates": ["1923-10-14", "1923-10-15"] })
`;
