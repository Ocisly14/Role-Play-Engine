// src/roleSim/toolSkills/actSkill.ts

export const actSkill = `---
name: act
description: Take a physical action in the world. Terminates this decision (consumes a tick).
---

# act

Take an action in the world: move, speak, examine, attack, hide, work, etc.
This consumes a tick — calling \`act\` ends the current decision.

## When to use
- You want to start something new and meaningful
- Something just happened and you want to react with a new action
- Your current action is no longer right (calling \`act\` while you have an in-flight action will CANCEL it and start the new one)
- Idle and you've decided what to do next

## When NOT to use
- Your current action is fine — use \`continue\`
- You just want to "think more" — use \`recallMemory\` or \`writeMemory\` instead (they don't consume a tick)
- The action is purely internal (forming a belief, planning) — use \`writeMemory\`

## Output
{ "tool": "act", "actionText": "<one sentence describing what you do>", "targetCharacterIds": ["<npcId>", ...] }

- \`actionText\`: describe your action in one natural sentence ("walk to the library", "ask Smith about the letter", "search the desk")
- \`targetCharacterIds\`: optional. NPC IDs you're directly interacting with.

The engine resolves the action — you don't need to specify duration, skill checks, or outcomes.

## Examples

You see Smith in the room and decide to confront him:
{ "tool": "act", "actionText": "confront Smith about where he was last night", "targetCharacterIds": ["smith"] }

You're alone and want to leave:
{ "tool": "act", "actionText": "head to the harbor" }

You're in the middle of reading and a fire breaks out — interrupt and flee:
{ "tool": "act", "actionText": "drop the book and run for the exit" }
`;
