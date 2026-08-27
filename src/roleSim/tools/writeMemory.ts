// src/roleSim/tools/writeMemory.ts

export const writeMemoryDoc = `---
name: writeMemory
description: Keep something in long-term memory. Free — may be called alongside act/continue in the same turn.
---

# writeMemory

**Nothing is remembered for you.** What you perceive is what reached your
senses in the moment — it is not memory. Memory is what YOU decided was
worth keeping: it comes back to you as your own words, and it is what
remains of the day. The world no longer keeps a diary on your behalf.

So each turn, decide: is anything here worth carrying? Most minutes are
not. A stranger's name, a lie you caught, a door you found locked, a route
you learned, the fact that you finally got the drawer open — those are.
The colour of the wallpaper is not.

## Cost

Free. It does NOT consume a tick, and it may be called **in the same turn
as \`act\` or \`continue\`** — decide your action and record your memory
together.

## Types

- \`general\` — 普通记忆. The default. What you did and how it turned
  out, what you saw someone else do, a conclusion you reached, a fact you
  learned. One memory = one thing worth recalling later; do not dump a
  whole minute of scenery into it.
- \`plan\` — 计划. An intention you mean to hold beyond this minute:
  "tomorrow morning, get to the harbour before anyone notices". Not your
  next action — that is \`act\`.
- \`secret\` — 秘密. Something hidden you worked out and would not say
  aloud. These fade slowly; you will still be carrying them days later.
- \`relationship\` — 角色关系. What you now think of a specific person.
  Requires \`targetId\` — the tag beside that person in what you perceive,
  exactly as you would write it in \`objectRefs\`. Use it when your read on someone
  changes: they lied, they helped, they frightened you, you decided to
  trust them.
- \`map\` — 地图记忆. A place or route you learned *today* — a door you
  had never noticed, a shortcut, where someone actually lives. The town you
  already knew before this morning is not this; only what today taught you.
- \`long_term_intent\` — 长期目标. ONLY when the goal driving your whole
  life here genuinely changes. Rare — an ordinary intention is a \`plan\`.

## Writing well

- First person, past tense, self-contained. "Hollins claimed he was at the
  harbor all evening, but his coat was dry." — readable months later
  without the surrounding scene.
- One fact per call. Two unrelated things = two calls (max 3 per decision).
- Write what it MEANS to you, not a transcript of what was said.
- Do not record what you are about to do — that is your action, not a
  memory. Use \`plan\` only for an intention that outlives this minute.

## Cap

Max 3 \`writeMemory\` calls per decision.

## Examples

You formed an intention for later:
writeMemory({ "type": "plan", "content": "Tomorrow morning, reach the harbour before the constable's rounds." })

You worked something out you would not say aloud:
writeMemory({ "type": "secret", "content": "The handwriting in the ledger is the professor's own. He forged the entries himself." })

You just caught an inconsistency:
writeMemory({ "type": "general", "content": "The professor said the ledger never left his office, but I saw it in the parlour an hour earlier." })

Your read on someone changed:
writeMemory({ "type": "relationship", "targetId": "stranger_a", "content": "He went pale when I mentioned the harbor. He knows something and he is afraid of it." })

Your own action finally paid off:
writeMemory({ "type": "general", "content": "The cabinet lock gave way after a few minutes of work. Inside: a bundle of letters tied with string." })

You learned where something is:
writeMemory({ "type": "map", "content": "There is a back stairwell behind the kitchen at the boarding house — it comes out on the alley, not the street." })

A quiet minute with nothing to keep — write nothing at all.
`;
