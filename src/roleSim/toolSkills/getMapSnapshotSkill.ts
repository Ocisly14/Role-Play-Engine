// src/roleSim/toolSkills/getMapSnapshotSkill.ts

export const getMapSnapshotSkill = `---
name: getMapSnapshot
description: View your known map of places (scenes, junctions, roads). Doesn't consume a tick.
---

# getMapSnapshot

Inspect your current map — what places you know exist, hidden connections you've discovered, etc.

## When to use
- You're planning a trip and need to confirm a route
- You want to know what scenes you know about
- You're trying to recall whether you've discovered a hidden connection

## When NOT to use
- You just need the name of your current scene — that's already in \`## Right now\`
- Routine — capped at 1 per decision

## Usage
{ "tool": "getMapSnapshot" }

No arguments. Returns a list of known scenes, junctions, roads, and revealed hidden connections.

## Cap
Max 1 \`getMapSnapshot\` call per decision.

## Example

You want to check if you've ever been told about a back alley:
{ "tool": "getMapSnapshot" }
`;
