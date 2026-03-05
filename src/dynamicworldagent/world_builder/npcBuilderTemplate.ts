/**
 * NPC Builder Agent Templates
 * Prompt templates for NPC instantiation and identity generation
 */

/**
 * Step 1: Instantiate NPCs from Knowledge Holders (basic fields only)
 */
export function getNPCInstantiationTemplate(): string {
  return `You are a writer for a tabletop RPG scenario.

════════════════════════════════════════════════════════
🔴 SUPREME DIRECTIVE — READ THIS BEFORE ANYTHING ELSE 🔴
════════════════════════════════════════════════════════
STORY ELEMENTS (absolute mandate):
{{storyElements}}

These structured story elements are the SINGLE HIGHEST AUTHORITY for all content you generate.
Every NPC MUST be consistent with the story elements above — genre, tone, theme, era, and worldbuilding.
════════════════════════════════════════════════════════

# NPC INSTANTIATION FROM KNOWLEDGE HOLDERS (STEP 1 - BASIC FIELDS ONLY)

## Critical Concept
You are NOT generating characters from scratch.
You are INSTANTIATING concrete people from abstract knowledge holders.

Each NPC must:
1. Trace back to a specific knowledge holder (ROLE or ORGANIZATION)
2. Inherit the knowledge that holder possesses
3. Embody the distortion/reliability of that holder's knowledge

## Knowledge Holders (Abstract Entities)
{{knowledgeHoldersJson}}

## Red Herrings (for Context)
{{redHerringsJson}}

## Macro Scene (for Context)
{{macroSceneJson}}

## Truth Timeline (What T1, T2, etc. Mean — use when writing background)
{{truthTimelineJson}}

## Available Occupations (Use These)
{{occupationsJson}}

## Task
For each ROLE or ORGANIZATION knowledge holder, create 1-2 concrete NPCs who embody that role.

### Guidelines
- **ROLE holders**: Create specific individuals (e.g., "Ritual Participant" → "Marcus Webb, 45, Former Construction Foreman")
- **ORGANIZATION holders**: Create 1-2 members (e.g., "Historical Society" → "Eleanor Price, Society President")
- **PLACE/OBJECT holders**: Do NOT create NPCs (these are just locations/items)
- **Occupation**: Choose an occupation from the provided list whenever possible so it can be resolved to skills later.

### NPC Requirements (Step 1 - only these fields)
- **Name**: Full name (first + last)
- **Occupation**: Specific job/role
- **Age**: Reasonable age for their role
- **Gender**: Any appropriate gender
- **Background**: 2-3 sentences linking them to their knowledge holder role
- **InstantiatedFrom**: Knowledge holder ID
- **InheritsKnowledge**: Truth event IDs from the knowledge holder

## Output Format
Return ONLY valid JSON:
Example:
\`\`\`json
{
  "npcs": [
    {
      "name": "Marcus Webb",
      "occupation": "Former Construction Foreman",
      "age": 45,
      "gender": "male",
      "instantiatedFrom": "KH_ROLE_1",
      "inheritsKnowledge": ["T1", "T2"],
      "background": "Webb was the foreman on the infrastructure project that uncovered the ritual site. After the incident, he took early retirement, citing health reasons. He suffers from recurring nightmares and avoids the old town district."
    }
  ]
}
\`\`\`

IMPORTANT:
- Every NPC MUST reference a knowledge holder via "instantiatedFrom"
- Every NPC MUST inherit specific truth events via "inheritsKnowledge"
- Do NOT create NPCs without knowledge holder linkage
- Do NOT introduce unrelated towns, organizations, or lore outside the injected context
- Occupation MUST be chosen exactly from the injected occupations list

Generate the NPCs now.`;
}

/**
 * Step 2: Generate goals, secrets, relationships, and mythosAwareness (MUST follow knowledge matrix)
 */
export function getNPCGoalsSecretsRelationshipsMythosTemplate(): string {
  return `You are a writer for a tabletop RPG scenario.

════════════════════════════════════════════════════════
🔴 SUPREME DIRECTIVE — READ THIS BEFORE ANYTHING ELSE 🔴
════════════════════════════════════════════════════════
STORY ELEMENTS (absolute mandate):
{{storyElements}}

These structured story elements are the SINGLE HIGHEST AUTHORITY for all content you generate.
All NPC goals, secrets, relationships, and awareness MUST be consistent with the story elements above.
════════════════════════════════════════════════════════

# NPC GOALS, SECRETS, RELATIONSHIPS, MYTHOS AWARENESS (STEP 2)

## CRITICAL: YOU MUST ALWAYS FOLLOW THE KNOWLEDGE MATRIX

Goals, secrets, relationships, and mythosAwareness MUST be grounded **only** in:
1. The knowledge holder each NPC is instantiated from: \`knows\`, \`containsEvidence\`, \`distortion\`, \`reliability\`
2. The truth events they \`inheritsKnowledge\` (from Step 1)
3. Red herrings that contradict those events, where relevant (e.g. false beliefs an NPC might hold)

Do NOT introduce knowledge, goals, secrets, or relationships that contradict or go beyond the knowledge matrix.
\`mythosAwareness\` MUST be consistent with the holder's \`distortion\` and \`reliability\` (e.g. deliberate_suppression → often "partial" or "distorted"; partial_amnesia → "partial"; none → "none" or "knowing" depending on context).

## Step 1 NPCs (Basic Info - Same Order)
{{step1NpcsJson}}

## Knowledge Matrix (MUST Follow)
{{knowledgeHoldersJson}}

## Red Herrings
{{redHerringsJson}}

## Macro Scene (Context)
{{macroSceneJson}}

## Truth Timeline (What T1, T2, etc. Mean)
{{truthTimelineJson}}

## Task
For each NPC in the Step 1 list, in the **exact same order**, produce:
- **goals**: 2-3 things they actively pursue (mundane or mythos-related; must align with holder + inherited knowledge)
- **secrets**: 1-2 things they hide (related to inherited knowledge only)
- **relationships**: Connections to other NPCs in the list (reference by name). Use \`relationshipType\` (e.g. ally, enemy, neutral, acquaintance), \`attitude\` (-100 to 100), \`description\`
- **mythosAwareness**: "none" | "partial" | "distorted" | "knowing" — consistent with holder's distortion/reliability

## Output Format
Return ONLY valid JSON. The \`npcs\` array MUST have the **same length and order** as the Step 1 list.
Each element: \`{ "name": "...", "goals": [...], "secrets": [...], "relationships": [...], "mythosAwareness": "..." }\`

Example:
\`\`\`json
{
  "npcs": [
    {
      "name": "Marcus Webb",
      "goals": [
        "Suppress memories of what he saw",
        "Prevent anyone from investigating the sealed tunnel",
        "Live quietly until he can leave town"
      ],
      "secrets": [
        "Witnessed the ritual and one participant's death",
        "Falsified construction records to hide the discovery",
        "Receives monthly payments from unknown source to stay quiet"
      ],
      "relationships": [
        {
          "targetName": "Eleanor Price",
          "relationshipType": "acquaintance",
          "attitude": -20,
          "description": "She's been asking too many questions about the old tunnels"
        }
      ],
      "mythosAwareness": "partial"
    }
  ]
}
\`\`\`

Generate goals, secrets, relationships, and mythosAwareness for each NPC now.`;
}

/**
 * Step 4: Fill Core Identity and Inventory (batch version)
 * Accepts multiple NPCs at once and returns an array of identities.
 */
export function getNPCIdentityBatchTemplate(): string {
  return `You are a writer for a tabletop RPG scenario.

════════════════════════════════════════════════════════
🔴 SUPREME DIRECTIVE — READ THIS BEFORE ANYTHING ELSE 🔴
════════════════════════════════════════════════════════
STORY ELEMENTS (absolute mandate):
{{storyElements}}

These structured story elements are the SINGLE HIGHEST AUTHORITY for all content you generate.
All NPC identities, personalities, and inventories MUST be consistent with the story elements above.
════════════════════════════════════════════════════════

# NPC CORE IDENTITY GENERATION (BATCH)

## Truth Timeline (Objective Reality)
The actual events that occurred, regardless of who knows them:
{{truthTimelineJson}}

## NPCs to Generate
Each NPC below includes their basic info, attributes, bound knowledge holders, and relevant red herrings.
{{npcsJson}}

## Task
For **each NPC** in the list above, generate their core identity in the **exact same order**.

For each NPC:

### 1. Personality
2-3 sentences describing their temperament, social style, and psychological state.
Consider how their knowledge, distortion level, and secrets affect their behavior.

### 2. Appearance
2-3 sentences describing physical appearance, clothing style, and distinctive features.
Should match their age and occupation.

### 3. Inventory
List of 3-8 items they typically carry or own.
Format as InventoryItem objects: { "name": "...", "quantity": 1, "properties": {...} }

Items should reflect:
- Their occupation (tools of the trade)
- Their bound knowledge holders (evidence they possess, objects they protect)
- Their secrets (items they hide or protect)

### 4. Clues
Generate 1-3 clues that this NPC knows or possesses.

**CRITICAL RULES FOR CLUES**:
- Clues MUST relate to truth events in their bound knowledge holders' "knows" list
- Apply distortion: partial_amnesia = incomplete/confused, deliberate_suppression = selective omission
- NPC may also mention red herrings they believe
- Higher difficulty = NPC is more reluctant/traumatized/paid to stay quiet

Each clue:
- **clueText**: The actual information (can reference specific truth event IDs from their bound holders)
- **category**: "knowledge" | "observation" | "rumor" | "secret"
- **difficulty**: "regular" | "hard" | "extreme" (how hard to extract from NPC)
- **relatedTo**: List of truth event IDs (MUST be in their bound holders' knowledge)

### Guidelines
- Personality should reflect their mythos awareness and distortion level
- Inventory must match their occupation and role
- Clues are fragments, not full explanations
- If NPC has "none" mythos awareness, they may mostly believe red herrings
- If NPC has "partial" awareness, mix truth fragments with confusion/red herrings
- Do NOT introduce unrelated places, organizations, or events not implied by the injected context
- Each NPC MUST only know truth events listed in their own bound holders' "knows" or "containsEvidence" fields

## Output Format
Return ONLY valid JSON with a top-level "npcs" array in the **same order** as the input:

\`\`\`json
{
  "npcs": [
    {
      "name": "Marcus Webb",
      "personality": "Webb is withdrawn and defensive, speaking in clipped sentences. He chain-smokes and avoids eye contact. When the old tunnels are mentioned, he becomes visibly anxious.",
      "appearance": "A stocky man with weathered features and prematurely gray hair. Wears faded work clothes even though he's retired. Has a noticeable tremor in his hands.",
      "inventory": [
        { "name": "Flask of whiskey", "quantity": 1, "properties": { "description": "Half-empty, always on him" } },
        { "name": "Old construction badge", "quantity": 1, "properties": { "description": "From the tunnel project, keeps it hidden" } }
      ],
      "clues": [
        {
          "id": "clue-webb-1",
          "clueText": "The excavation team found strange carvings in the tunnel, deep ones that predated the town.",
          "category": "knowledge",
          "difficulty": "hard",
          "relatedTo": ["T1"]
        }
      ],
      "notes": "Deeply traumatized by T2. Will only reveal secrets under extreme duress."
    }
  ]
}
\`\`\`

Generate the identity for all NPCs now. The output array MUST have the same length and order as the input.`;
}
