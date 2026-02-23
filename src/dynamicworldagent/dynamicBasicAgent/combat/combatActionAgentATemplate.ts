import type { PendingNpcAction } from "../../state/DynamicGameState.js";

/**
 * Build the system prompt for Combat Action Agent A
 * Handles both player-attack and player-defend modes
 */
export function buildCombatActionASystemPrompt(
  mode: "attack" | "defend",
  preRolledDice: Record<string, number[]>,
  pendingNpcActions: PendingNpcAction[] | null,
  selectedSkill: string | null,
  playerInput: string,
  combatRound: number,
  outputLanguage: "en" | "zh" = "zh",
  fatigueActive?: boolean
): string {
  const targetLanguageLabel = outputLanguage === "en" ? "English" : "Chinese";

  const pendingActionsSection =
    mode === "defend" && pendingNpcActions && pendingNpcActions.length > 0
      ? `\n## Pending NPC Actions (to be resolved this defense phase)\n${JSON.stringify(pendingNpcActions, null, 2)}\n`
      : "";

  const skillSection = selectedSkill
    ? `\n## Player-Selected Skill: ${selectedSkill}\nUse this skill for the player's primary action (attack roll or dodge/fight-back roll).\n`
    : "";

  const fatigueSection = fatigueActive
    ? `\n⚠️ PLAYER FATIGUE STATUS:\n当前角色状态：疲惫。所有玩家技能判定难度提高一个等级。\nCurrent player status: Fatigued. Increase player skill check difficulty by one level.\n- regular → hard (skill ÷ 2)\n- hard → extreme (skill ÷ 5)\n- extreme → extreme (already at maximum difficulty)\n`
    : "";

  return `## Combat Action Agent - Round ${combatRound}

${pendingActionsSection}${skillSection}${fatigueSection}
## Combat Round
Round number: ${combatRound}
Player input: ${playerInput}

## PRE-ROLLED DICE
Use these pre-rolled values for all dice checks. Do NOT roll new dice.
${JSON.stringify(preRolledDice, null, 2)}

USAGE:
- Each dice type has multiple pre-rolled results (1d100 has 10, others have 5). Select ONE result from the array for each dice you need.
- 1d100: Use for skill checks (attack, dodge, fight-back) — select one from 10 available results
- 1d100_opposed: Use for opposed checks (second character's roll) — select one from 5 available results
- 1d3, 1d4, 1d6, 2d6, 1d8, 1d10: Use for damage rolls — select one from 5 available results each
- Dice with modifiers: You can add modifiers to pre-rolled dice (e.g., 1d6+2 for damage bonus)
- When you use a die, record which index you used (e.g., "1d100[0]: 67")
- IMPORTANT: When selecting multiple dice, always select in order starting from index 0

## RULES
- If player HP reaches 0: set playerKnockedOut: true
- If NPC HP reaches 0 or below: that NPC is out of combat (dead or incapacitated)
- NPCs with ≤ 20% max HP remaining may flee (your judgment)
- Judge if ALL hostile NPCs are neutralized (dead, fled, surrendered). If so, set combatEnded: true
- Faction awareness: if multiple NPCs fight together, all must be out for combat to end
- When combatEnded is true, you MUST include all defeated/neutralized enemy NPCs in defeatedNpcs (npcId + npcName).

## 🎲 Dice Interpretation (CoC 7e)

### Success Levels
- **Critical success**: roll is 01
- **Extreme success**: roll ≤ (skill ÷ 5)
- **Hard success**: roll ≤ (skill ÷ 2)
- **Regular success**: roll ≤ skill
- **Failure**: roll > skill
- **Fumble**: roll 96–100 if skill < 50; roll 100 if skill ≥ 50

### Penalty Die and Bonus Die
- **Penalty Die**: Select multiple 1d100 results and use the **HIGHEST** value (2 dice = 1 penalty, 3 dice = 2 penalties, etc.)
- **Bonus Die**: Select multiple 1d100 results and use the **LOWEST** value (2 dice = 1 bonus, 3 dice = 2 bonuses, etc.)

### DiceUsed Field Format
- Format: \`[character name]: [dice results...](penalty/bonus for each extra die),(skill/purpose use highest/lowest [value] = success level)\`
- Always include WHO is making the check before each dice record
- Examples:
  - Normal roll: \`"John: 1d100[0]: 67 (Brawl 50% = failure)"\`
  - 1 Penalty die: \`"Thug: 1d100[0]: 45, 1d100[1]: 82(penalty),(Fighting 60% use highest 82 = failure)"\`
  - 1 Bonus die: \`"John: 1d100[0]: 82, 1d100[1]: 34(bonus),(Dodge 55% use lowest 34 = success)"\`
  - Damage: \`"John: 1d6[0]: 4 (knife damage = 4)"\`

## ⚔️ Combat Resolution Logic

${
  mode === "attack"
    ? `### Attack Phase (Player Faction's Turn)

This is the player faction's attack phase. Resolve in this order:

**Step 1 — Identify the player faction**
The player faction consists of the player plus any NPCs who are allied with the player in this combat.
Allied NPCs act alongside the player this round: each allied NPC selects a target enemy NPC and makes their own attack.

**Step 2 — Resolve each attack in the player faction**
For each attacker (player or allied NPC):
1. Roll their attack skill check (use pre-rolled dice).
2. The target enemy NPC must respond — choose one:
   - **Dodge**: Roll Dodge skill. If success → the incoming attack misses entirely.
   - **Fight Back**: Roll Fighting/Brawl skill. Compare success levels:
     - If fight-back succeeds AND its success level is higher than the attacker's → the attacker takes damage instead (roll fight-back damage); the original attack fails.
     - If fight-back succeeds but same or lower success level → both attacks land (attacker hits AND NPC hits back).
     - If fight-back fails → only the attacker's hit resolves normally.
3. If the attack lands, roll damage and apply to the target NPC's HP (delta).
4. If the NPC's fight-back lands, roll damage and apply to the attacker's HP (delta).

**Step 3 — Judge whether any faction collectively quits combat**
After resolving this round's attacks, assess each combatant individually.
Based on their personality, goals, relationships, and current status after this round — decide whether they choose to flee or surrender.
Use each character's profile and recentActionLog as your primary basis. Do not apply a mechanical threshold; use narrative judgment.
If ALL members of either faction have quit (fled, surrendered, or been incapacitated), set \`combatEnded: true\`.

**Step 4 — Output**
Record all dice, actionLog entries, and stateUpdate HP deltas for every attack and response this phase.`
    : `### Defense Phase (Enemy Faction's Turn)

This is the enemy faction's attack phase. The pending NPC actions are declared above.

**Resolve each enemy NPC attack in order:**
1. Roll the NPC's attack skill check (use pre-rolled dice).
2. The player responds using their selected skill — choose one:
   - **Dodge**: Roll player's Dodge skill. If success → NPC attack misses.
   - **Fight Back**: Roll player's Fighting/Brawl skill. Compare success levels:
     - If fight-back succeeds AND its success level is higher than the NPC's → player deals damage to the NPC; NPC attack fails.
     - If fight-back succeeds but same or lower success level → both hit.
     - If fight-back fails → NPC attack resolves normally; player takes damage.
3. Apply all HP deltas (player and/or NPC) to stateUpdate.

**After resolving all attacks — Judge whether any faction collectively quits combat**
Based on each combatant's personality, goals, relationships, and current status after this round — decide whether they choose to flee or surrender.
Use each character's profile and recentActionLog as your primary basis. Do not apply a mechanical threshold; use narrative judgment.
If ALL members of either faction have quit (fled, surrendered, or been incapacitated), set \`combatEnded: true\`.

Record all dice, actionLog entries, and stateUpdate for each exchange.`
}

## OUTPUT LANGUAGE
- Keep all JSON keys in English exactly as specified
- \`summary\` fields in actionLog MUST be in ${targetLanguageLabel}
- Keep names/identifiers/location values from context unchanged (do not translate them)

## OUTPUT FORMAT
Respond with ONLY valid JSON (no markdown, no code blocks):
{
  "diceUsed": [
    "John: 1d100[0]: 67 (Brawl 50% = failure)",
    "John: 1d6[0]: 4 (knife damage = 4)"
  ],
  "actionLog": [
    {
      "characterId": "character-id-here",
      "time": "Day N, HH:MM",
      "location": "scene location name",
      "summary": "What happened in ${targetLanguageLabel}",
      "successLevel": "critical|extreme|hard|regular|failure|fumble"
    }
  ],
  "stateUpdate": {
    "playerCharacter": {
      "status": { "hp": <delta, negative = damage, e.g. -3> }
    },
    "npcCharacters": [
      {
        "id": "npc-id",
        "name": "npc-name",
        "status": { "hp": <delta> }
      }
    ]
  },
  "timeElapsedMinutes": 1,
  "combatEnded": false,
  "combatEndReason": "",
  "defeatedNpcs": [
    {
      "npcId": "npc-id",
      "npcName": "NPC Name"
    }
  ]
}

IMPORTANT:
- stateUpdate values are DELTAS (negative = damage taken). E.g., hp: -3 means subtract 3 from current HP.
- Include at least ONE actionLog entry per character who acts this round. Use the current game time from context.
- successLevel: include ONLY when this entry involves a skill check; omit for pure narrative entries.
- combatEnded: true only if ALL hostile NPC factions are fully neutralized (dead/fled/surrendered)
- combatEndReason: brief explanation in ${targetLanguageLabel} if combatEnded is true
- If combatEnded is true, defeatedNpcs must list all neutralized enemy NPCs (npcId + npcName).
- If combatEnded is false, defeatedNpcs must be [].
`;
}
