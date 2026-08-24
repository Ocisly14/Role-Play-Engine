// src/roleSim/tools/act.ts

export const actDoc = `---
name: act
description: Take one minute-scale beat in the world (substantive action plus the body language and movement that go with it). Terminates this decision (consumes a tick).
---

# act

Take ONE complete **minute-scale beat** — what someone living through the
scene would consider "the next thing you did." Each \`act\` occupies about
one game minute. Multi-minute intentions (cross-town travel, an hour of
research, a lengthy search) span multiple ticks; submit only the next beat.

## Granularity — minute-scale, not second-scale

A beat is the dramatic unit you'd write into a screenplay: a substantive
action (speak, examine, manipulate, move with purpose, use a skill, target
another character) PLUS the body language, framing, and gaze that
naturally accompany it — all wrapped into one sentence.

Wrong (second-scale fragments — DO NOT submit):
- "我拉了拉他的袖子。"  ← 1 second of body language, no real beat
- "我向前走了一步。"      ← 2 seconds of motion, no destination or purpose
- "我清清嗓子。"          ← 3 seconds of throat-clear, no action

Right (minute-scale beats — submit these):
- "我拽住他的袖子凑近，压低声音问：'今晚到底发现了什么？地点和通报人？'"
- "我跟着他穿过走廊走向问讯室 [1]，一边低声追问'这事跟卡森德拉有关吗？'"
- "我从抽屉里抽出案件笔记 [1] 摊在桌上，指着上面的时间线问：'你看这一段。'"

Rule of thumb: if the action takes < 10 seconds in real life and has no
dialogue, no item interaction, and no skill use, it is **NOT an act** —
fold it into the description of your next real beat, or \`continue\`.

## Meaningfulness — required

An \`act\` MUST change something perceptible: speak meaningful words,
change position with purpose, manipulate an item, use a skill, or visibly
target / affect another character. Pure body language alone (clearing
throat, fidgeting, glancing) is description; the engine narrates you as
continuing your current stance automatically.

## When to use
- Start something new, or react to something that just happened.
- Calling \`act\` while an action is in-flight CANCELS it and starts the new one.

## When NOT to use
- Your current action is fine → \`continue\`.
- Internal-only (forming a belief, planning) → \`writeMemory\`.
- Pure body language with no state change → \`continue\`.

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
  canonical name (e.g. \`Hollins\`); that is meta-knowledge and must NOT
  influence your in-character narrative.

## Output JSON

{ "tool": "act", "actionText": "[narrative]\\n<sentence>\\n\\n[references]\\n[1] id: ...; kind: ..." }

## Examples

### KNOWN character + item

Perception had:
  Person (KNOWN): Smith  (id: Smith)
  Items in inventory: bound ledger [id: ITEM_SCN2_3]

{ "tool": "act", "actionText": "[narrative]\\nI hold up the ledger [1] and ask Smith [2] flatly, \\"What is the meaning of this?\\"\\n\\n[references]\\n[1] id: ITEM_SCN2_3; kind: item\\n[2] id: Smith; kind: character" }

### UNKNOWN stranger you have never heard named

Perception had:
  Person (UNKNOWN): the tall pale man  (id: Hollins)

Narrative uses the description (in-character). References uses the id.

{ "tool": "act", "actionText": "[narrative]\\nI rise and incline my head toward the tall pale man [1], 'Good evening — to what do I owe...'\\n\\n[references]\\n[1] id: Hollins; kind: character" }

### UNKNOWN stranger whose name you DID just learn

Same person, but last tick you heard your housekeeper announce "A Professor
Hollins to see you, sir." You now know his name in-character.

{ "tool": "act", "actionText": "[narrative]\\nI rise — Hollins, of all nights — and incline my head toward [1], 'Good evening, Professor.'\\n\\n[references]\\n[1] id: Hollins; kind: character" }
`;
