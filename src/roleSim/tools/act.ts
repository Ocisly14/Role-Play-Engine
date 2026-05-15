// src/roleSim/tools/act.ts

export const actDoc = `---
name: act
description: Take a single short physical action in the world. Terminates this decision (consumes a tick).
---

# act

Take ONE short atomic action: move, speak, examine, attack, hide, work, etc.
Each \`act\` fits within the next tick (~1 game minute). Multi-step intentions
must be broken across ticks.

## When to use
- Start something new, or react to something that just happened.
- Calling \`act\` while an action is in-flight CANCELS it and starts the new one.

## When NOT to use
- Your current action is fine → \`continue\`.
- Internal-only (forming a belief, planning) → \`writeMemory\`.

## actionText format

Two labeled sections in one string:

  [narrative]
  <One short sentence. Free prose, in-character voice. Insert numbered
   references [1], [2], ... right after the entity you point at.>

  [references]
  [1] id: <entity-id>; kind: <character|item|scene>
  [2] id: <entity-id>; kind: <character|item|scene>

Rules:
- \`id\` and \`kind\` are required. \`id\` MUST come from this tick's perception
  (its [references] block lists every id you may cite). Inventing one is rejected.
- Numbers are local to this action; reuse the same [N] for the same entity.
- Every [N] in the narrative needs a matching reference line.
- The references block is optional when no entity is cited.

## Two layers — narrative vs. references

These serve different purposes:

- **Narrative** is your in-character voice. Use only names you actually know
  in-game. If perception calls a stranger "the tall pale man", call them
  that — unless you've separately learned their name (heard it spoken,
  recalled from memory, etc.), in which case you may use it.
- **References** is the system citation handle. \`id\` may "leak" the
  canonical name (e.g. \`npc_hollins\`); that is meta-knowledge and must NOT
  influence your in-character narrative.

## Output JSON

{ "tool": "act", "actionText": "[narrative]\\n<sentence>\\n\\n[references]\\n[1] id: ...; kind: ..." }

## Examples

### KNOWN character + item

Perception had:
  Person (KNOWN): Smith  (id: npc_smith)
  Items in inventory: bound ledger [id: item_ledger]

{ "tool": "act", "actionText": "[narrative]\\nI hold up the ledger [1] and ask Smith [2] flatly, \\"What is the meaning of this?\\"\\n\\n[references]\\n[1] id: item_ledger; kind: item\\n[2] id: npc_smith; kind: character" }

### UNKNOWN stranger you have never heard named

Perception had:
  Person (UNKNOWN): the tall pale man  (id: npc_hollins)

Narrative uses the description (in-character). References uses the id.

{ "tool": "act", "actionText": "[narrative]\\nI rise and incline my head toward the tall pale man [1], 'Good evening — to what do I owe...'\\n\\n[references]\\n[1] id: npc_hollins; kind: character" }

### UNKNOWN stranger whose name you DID just learn

Same person, but last tick you heard your housekeeper announce "A Professor
Hollins to see you, sir." You now know his name in-character.

{ "tool": "act", "actionText": "[narrative]\\nI rise — Hollins, of all nights — and incline my head toward [1], 'Good evening, Professor.'\\n\\n[references]\\n[1] id: npc_hollins; kind: character" }
`;
