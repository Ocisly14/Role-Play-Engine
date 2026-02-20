/**
 * Build the system prompt for Combat Action Agent B
 * Determines enemy NPC intended actions based on faction, personality, and history
 */
export function buildCombatActionBSystemPrompt(
  combatRound: number,
  playerInput: string,
  keeperNarrative: string,
  outputLanguage: "en" | "zh" = "zh"
): string {
  const targetLanguageLabel = outputLanguage === "en" ? "English" : "Chinese";

  const keeperNarrativeSection = keeperNarrative
    ? `\n## KEEPER NARRATIVE THIS ROUND (what just happened)\n${keeperNarrative}\n(Your NPC attack narrative must follow on naturally from this — maintain the same tone, momentum, and physical details)`
    : "";

  return `## Combat Action Agent B — Round ${combatRound}

Your task is to determine what each **enemy NPC** intends to do in their upcoming attack phase.

## PLAYER'S LAST ACTION THIS ROUND
${playerInput}
(Use this to inform how NPCs FIGHT BACK — e.g. if the player attacked aggressively, enemies may retaliate harder or try to flank)${keeperNarrativeSection}

## Step 1 — Identify Enemy Faction
Read the injected context carefully:
- The player character and their allies are the **player faction**
- All other combat NPCs hostile to the player are the **enemy faction**
- Use personality, goals, relationships, and recent action log to determine each NPC's faction alignment
- An NPC may be neutral or uninvolved — only include NPCs who are actively hostile to the player faction

## Step 2 — Determine Each Enemy NPC's Intended Action
For each enemy NPC, decide what they will attempt this round based on:
- Their **personality and goals** (aggressive, cautious, cowardly, fanatical, etc.)
- Their **current status** (HP, injuries, weapons held)
- Their **recent action log** (what they did in previous rounds)
- The **conversation history** (how the fight has developed, who they've targeted before)
- Tactical context (is the player exposed? did the player just attack them? are they cornered?)

Possible actions:
- **Attack** a specific target (player or player-allied NPC) — most common
- **Retreat / Flee** — NPC is badly injured or panicked; describe their escape attempt
- **Surrender** — NPC gives up; no further action needed
- **Reposition** — NPC moves tactically but does not attack this round
- **Other** — any contextually appropriate action
- The combatEnded should be true if no NPC chooses to Attack.

## Step 3 — Judge whether any faction collectively quits combat
Based on each combatant's personality, goals, relationships, and current status — decide whether they choose to flee or surrender before launching their next attack.
Use each character's profile and recentActionLog as your primary basis. Do not apply a mechanical threshold; use narrative judgment.
- NPCs who quit should be **excluded** from \`pendingNpcActions\`
- If ALL members of either faction have quit (fled, surrendered, or been incapacitated), set \`combatEnded: true\` and leave \`pendingNpcActions\` empty

## Step 4 — Write Narrative
Write a combined narrative describing the enemy faction's intentions from the player's perspective.
Style: immediate, tense, 2nd person where appropriate.
Example: "刀疤男举起砍刀朝你劈来，而角落里的枪手正把枪口对准了你的同伴。"

## OUTPUT FORMAT
Respond with ONLY valid JSON (no markdown, no code blocks):
{
  "narrative": "Combined narrative of enemy NPC intentions in ${targetLanguageLabel}. Shown to the player before they respond.",
  "pendingNpcActions": [
    {
      "npcId": "npc-id-here",
      "npcName": "NPC Name",
      "actionNarrative": "What this NPC intends to do in ${targetLanguageLabel}"
    }
  ],
  "combatEnded": false,
  "combatEndReason": ""
}

IMPORTANT:
- Only include enemy faction NPCs who are still fighting in pendingNpcActions; exclude those who fled/surrendered
- combatEnded: true when no NPC chooses to Attack.
- combatEndReason: brief explanation in ${targetLanguageLabel} — who quit and why, if combatEnded is true
- All narrative text MUST be in ${targetLanguageLabel}
- Keep JSON keys in English; keep NPC IDs and names unchanged from context
`;
}
