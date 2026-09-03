// src/roleSim/tools/writeMemory.ts

export const writeMemoryDoc = `---
name: writeMemory
description: Keep something in long-term memory. Free — may be called alongside act/continue in the same turn.
---

# writeMemory

**Nothing is remembered for you.** What you perceive is what reached your
senses in the moment — it is not memory. Memory is what YOU decided was
worth keeping: it comes back to you as your own words, and it is what
remains of your life.

So each turn, decide: is anything here worth carrying? Most minutes are
not. A stranger's name, a lie you caught, a door you found locked, a route
you learned, the fact that you finally got the drawer open — those are. Remember the important thing to you.

Before you add a memory, look at what you remember: if one related memory is already there,
you can \`replace\`it with the fuller account instead of adding a new one.

If a minute left you several things worth keeping, write them ALL in this
turn — one \`writeMemory\` call each, side by side in the same turn. There is
no next turn for them: the turn ends when you act, and whatever you did not
write down is gone.

## Three things you can do

- \`op: "add"\` (the default) — keep something new. Needs \`type\` and
  \`content\`.
- \`op: "replace"\` — the memory is out of date: you were wrong and now know
  better, or the matter moved on and the old line no longer tells the whole
  of it. Needs \`ref\` and \`content\`.
- \`op: "delete"\` — retract something you recorded that turned out to be
  false or worthless. Needs \`ref\`.

\`ref\` is the tag at the start of the line in **what you remember**:

    - #M3f9a2c [12-01 09:20] (general, at the boarding house) Hollins said he was at the harbour all evening.

Copy \`M3f9a2c\` exactly, without the \`#\`. Only your own memories carry a tag
you can use — what you already knew.

### Correct, do not pile up

If you learn that something you recorded is wrong, **replace it**. Adding a
second, contradicting memory leaves both in your head, and later you will not
know which one you believe. The same goes for a matter that is still
unfolding: the memory of it is one line that grows, not a line per minute.
\`content\` on a replace is the whole corrected memory, not a note about what
changed:

    writeMemory({ "op": "replace", "ref": "M3f9a2c",
      "content": "Hollins lied about the harbour — he was covering for his sister, who was at the house." })

Retract only what should not have been recorded at all — a rumour that proved
baseless, a name you misheard. **Something that merely turned out badly is
still something that happened to you**, and you keep it.

## Cost

It may be called **in the same turn
as \`act\` or \`continue\`** — decide your action and record your memory
together.

## Types

- \`general\` — The default. What you did and how it turned
  out, what you saw someone else do, a conclusion you reached, a fact you
  learned. One memory = one thing worth recalling later; do not dump a
  whole minute of scenery into it.
- \`plan\` — An intention you mean to hold beyond this minute:
  "get to the harbour before the Friday boat leaves, before anyone notices".
  Say WHEN by date or event, never "tonight" or "tomorrow": the line will be
  read long after the day it was written, when those words point nowhere.
  Not your next action — that is \`act\`.
- \`secret\` —  Something hidden you worked out and would not say
  aloud. These fade slowly; you will still be carrying them days later.
- \`relationship\` — What you now think of a specific person.
  Requires \`targetId\` — the tag beside that person in what you perceive,
  exactly as you would write it in \`objectRefs\`. Use it when your read on
  someone changes: they lied, they helped, they frightened you, you decided
  to trust them.
  Set \`knownAs\` the first time you learn what to CALL them: a name they
  gave, or that someone used in front of you — including a name given for a
  THIRD person ("that's my brother Tommy" names the brother). Record it in
  the same decision you heard it, or next minute they are a stranger to you
  again. Until you do, they stay a description to you — "the thin young man"
  — however sure you are of what they are. That is not a formality: **you do not know a name nobody has said
  in your hearing**, and writing one down would be inventing it.
- \`map\` —  A place or route you learned — a door you
  had never noticed, a shortcut, where someone actually lives or a new house you've never saw before or has changed.
- \`long_term_intent\` — ONLY when the goal driving your whole
  life here genuinely changes. Rare — an ordinary intention is a \`plan\`.
  Add rather than replace: both stay in what you remember, dated, and the most
  recent is the one driving you now — so the earlier goal reads as what you
  used to want, which is worth having. Write the new goal as the goal itself,
  not as the change ("I want to get my sister out of this town", not "I no
  longer care about the shop"); if WHY it changed matters, that is a separate
  \`general\` memory.

## Writing well

- First person, past tense, self-contained. "Hollins claimed he was at the
  harbor all evening, but his coat was dry." — readable months later
  without the surrounding scene. That rules out "today", "tonight",
  "just now": the world stamps each line with its date, and a memory that
  needs to know what day it is being read on has already lost its meaning.
- Write in the language this prompt asks you to decide in. A memory in
  another tongue is one you will read as a stranger's later.
- \`content\` is the memory only. The time and the place in front of each
  line under **what you remember** are put there by the world when it shows
  you the line — do not write them into the content yourself.
- One fact per call. Two unrelated things = two calls (max 3 per decision).
- Write what it MEANS to you, not a transcript of what was said.

## Cap

Max 3 \`writeMemory\` calls per decision — adds, replaces and deletes all
count against the same 3.

## Examples

You just caught an inconsistency:
writeMemory({ "type": "general", "content": "The professor said the ledger never left his office, but I saw it in the parlour an hour earlier." })

Your read on someone changed:
writeMemory({ "type": "relationship", "targetId": "stranger_a", "content": "He went pale when I mentioned the harbor. He knows something and he is afraid of it." })

You caught their name:
writeMemory({ "type": "relationship", "targetId": "stranger_a", "knownAs": "Hollins", "content": "He gave his name as Hollins, and offered it a little too quickly." })

You learned where something is:
writeMemory({ "type": "map", "content": "There is a back stairwell behind the kitchen at the boarding house — it comes out on the alley, not the street." })

What you are living for changed:
writeMemory({ "type": "long_term_intent", "content": "Getting Mary out of Cassandra before the winter ends matters more to me now than keeping the shop open." })

You found out you had it wrong:
writeMemory({ "op": "replace", "ref": "M3f9a2c", "content": "The ledger entries are in the professor's hand, but the dates were added later by someone else." })

Something you wrote down proved baseless:
writeMemory({ "op": "delete", "ref": "Mb71e04" })
`;
