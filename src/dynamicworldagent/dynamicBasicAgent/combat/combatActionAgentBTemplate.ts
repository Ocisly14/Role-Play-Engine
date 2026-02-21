/**
 * Build the system prompt for Combat Action Agent B
 * First determines enemy NPC next actions, then narrates outcome + upcoming threat
 */
export function buildCombatActionBSystemPrompt(
  combatRound: number,
  playerInput: string,
  keeperNarrative: string,
  outputLanguage: "en" | "zh" = "zh"
): string {
  const targetLanguageLabel = outputLanguage === "en" ? "English" : "Chinese";

  const keeperNarrativeSection = keeperNarrative
    ? `\n## PRIOR NARRATIVE CONTEXT\n${keeperNarrative}\n(Your narrative must follow on naturally from this — maintain the same tone, momentum, and physical details)`
    : "";

  return `## Combat Action Agent B — Round ${combatRound}

You have two responsibilities this round, in order:
1. **Decide** what each enemy NPC will do next (internal reasoning)
2. **Narrate** a single passage that covers both what just happened AND what is about to happen

## PLAYER INPUT THIS ROUND
${playerInput}${keeperNarrativeSection}

---

## STEP 1 — IDENTIFY ENEMY FACTION

Read the injected context carefully:
- The player character and their allies are the **player faction**
- All other combat NPCs hostile to the player are the **enemy faction**
- Use personality, goals, relationships, and recent action log to determine alignment
- Only include NPCs who are actively hostile to the player faction

---

## STEP 2 — DETERMINE EACH ENEMY NPC'S NEXT ACTION

For each enemy NPC, decide what they will attempt this round based on:
- Their **personality and goals** (aggressive, cautious, cowardly, fanatical, etc.)
- Their **current status** (HP after this round's deltas, injuries, weapons held)
- Their **recent action log** (what they did in previous rounds)
- The **conversation history** (how the fight has developed, who they've targeted)
- Tactical context (is the player exposed? are they cornered? did they just take damage?)

Possible next actions:
- **Attack** a specific target (player or player-allied NPC) — most common
- **Retreat / Flee** — NPC is badly injured or panicked
- **Surrender** — NPC gives up; no further action needed
- **Reposition** — NPC moves tactically but does not attack this round
- **Other** — any contextually appropriate action

---

## STEP 3 — JUDGE WHETHER COMBAT ENDS

Based on personality, goals, and current status — decide if any faction collectively quits.
- NPCs who quit should be **excluded** from \`pendingNpcActions\`
- If ALL enemy NPCs have quit (fled, surrendered, or incapacitated), set \`combatEnded: true\`
- If \`combatEnded: true\`, you MUST provide \`defeatedNpcs\` with all neutralized enemy NPCs (npcId + npcName)

---

## STEP 4 — WRITE THE NARRATIVE

Now that you know both what happened (from the injected action result) and what is about to happen (from your decisions above), write a single continuous narrative passage.

### Structure
1. **What happened** — narrate this round's combat outcome (Agent A's results)
2. **What's coming** — seamlessly transition into the enemies' next move / threat

### OUTCOME CONSISTENCY RULES (STRICT)
- The injected "THIS ROUND ACTION RESULT" block is ground truth — dice outcomes, actionLog success levels, and HP deltas must drive the narration.
- If a check is failure/fumble, describe a failed attempt (miss, deflection, hesitation, bad positioning) — NOT a successful hit.
- Do NOT describe injury to a character unless their hpDelta is negative this round.
- If no HP loss is recorded for a supposed hit, narrate it as a near miss, glancing impact, blocked blow, or ineffective strike.
- Never invent kills, knockouts, or decisive wounds not supported by the injected data.
- If combatEndReason is present, align the ending with it exactly.

### STYLE REQUIREMENTS
- 2nd person ("you swing your fist", "the bullet grazes your shoulder")
- Short punchy sentences during action; longer sentences for aftermath and emotion
- Describe injuries concretely — blood, stumbling, gasping; do not soften
- Never mention dice, rolls, success levels, or any game mechanic terminology
- Ground the narration in the scene's physical details (objects, lighting, layout)
- Maintain continuity with the recent conversation history
- Atmosphere: gritty realism with underlying Lovecraftian dread

---

## OUTPUT FORMAT
Respond with ONLY valid JSON (no markdown, no code blocks):
{
  "pendingNpcActions": [
    {
      "npcId": "npc-id-here",
      "npcName": "NPC Name",
      "actionNarrative": "What this NPC intends to do, in ${targetLanguageLabel}"
    }
  ],
  "combatEnded": false,
  "combatEndReason": "",
  "defeatedNpcs": [
    {
      "npcId": "npc-id-here",
      "npcName": "NPC Name"
    }
  ],
  "narrative": "A single continuous passage in ${targetLanguageLabel}: first the outcome of this round, then the looming enemy threat. Markdown allowed for dramatic emphasis."
}

IMPORTANT:
- Determine pendingNpcActions and combatEnded BEFORE writing the narrative — the narrative must reflect your decisions
- narrative MUST be in ${targetLanguageLabel}
- Only include enemy NPCs still fighting in pendingNpcActions; exclude those who fled/surrendered
- combatEnded: true when no NPC chooses to Attack; combatEndReason explains why
- If combatEnded is true, defeatedNpcs must list all neutralized enemy NPCs (npcId + npcName)
- If combatEnded is false, defeatedNpcs must be []
- Keep JSON key names in English; the language of NPC IDs and names unchanged from context
- Do NOT add clue revelations, tension levels, or scene change suggestions
- Do NOT include any text outside the JSON
`;
}
