export interface PlayerPlanParams {
  playerInput: string;
  playerName: string;
  playerProfile: string;
  currentScenarioId: string;
  currentScenarioName: string;
  currentScenarioDescription: string;
  scenarioClues: string;
  sceneConditions: string;
  connections: string;
  targetNpcProfile: string;
  targetNpcRelationship: string;
  sceneNpcs: string;
  conversationHistory: string;
  orchestratorHints: string;
  currentGameTime: string;
  gameDay: number;
  language: string;
  /** Registry-generated prompt listing all registered node types with descriptions + examples */
  handlerPrompt?: string;
  /** Registry-generated prompt with current world state from all active features */
  worldStatePrompt?: string;
  /** Registry-generated prompt: impact levels + all feature planning prompts */
  planningPrompt?: string;
  /** Registry-generated output schema prompt */
  outputSchemaPrompt?: string;
}

/**
 * Default hardcoded node type reference and action type categories.
 * Used as fallback when no registry-generated handlerPrompt is provided.
 */
const DEFAULT_NODE_TYPE_REFERENCE = `## Node Type Reference
- **"routine"**: Self-contained action, no interaction target. Examples: eating, resting, reading something already in hand, thinking, recalling memories.
- **"movement"**: Move to a destination scene. Set location to the target scene ID. Omit actionType for normal unblocked movement; set actionType when path is blocked (if skill can overcome it) or for creative movement (climbing, jumping, swimming).
- **"character_interaction"**: Interact with a specific NPC. Requires targetCharacterId. Include characterInteractionPayload if transferring item/clue/information.
- **"object_interaction"**: Interact with a physical object in the scene. Include objectInteractionPayload (pickup/place/use/inspect/destroy). For two-item interactions (e.g., use key on safe), include targetItemId. For creative non-standard uses, set actionType on the node and include itemUpdates/targetItemUpdates with expected end-state.
- **"scene_interaction"**: Search, investigate, or modify the environment/scene itself. Include sceneConnectionEffect if changing a connection (e.g., unlocking/barricading a door).

## The 8 ActionType Categories

actionType represents the **kind of skill check** required. When present, the execution engine auto-selects the best matching skill and rolls d100. When omitted, the action auto-succeeds.

### exploration
**Finding hidden things, gathering information, researching, analyzing.**
Triggered by: actively searching for concealed clues, picking locks to access hidden areas, deciphering foreign texts, appraising artifacts, forensic analysis, library research, tracking footprints.
Typical skills: Spot Hidden, Listen, Library Use, Locksmith, Navigate, Track, Science (*), Language (Other).

### social
**Influencing, persuading, deceiving, intimidating another character.**
Triggered by: convincing a reluctant NPC, lying, negotiating, bargaining, seduction, leveraging authority, reading someone's true intentions.
Typical skills: Charm, Fast Talk, Persuade, Intimidate, Psychology, Credit Rating, Disguise.

### combat
**Physical violence — attacking, defending, restraining.**
Triggered by: punching, shooting, stabbing, throwing objects at someone, grappling, setting up traps intended to harm.
Both attacker and defender roll. Damage applies to HP on hit.
Typical skills: Fighting (*), Firearms (*), Throw, Dodge.

### stealth
**Acting undetected — sneaking, hiding, pickpocketing, infiltrating.**
Triggered by: sneaking past guards, hiding in shadows, planting/stealing items without notice, forging documents, bypassing security systems.
Typical skills: Stealth, Sleight of Hand, Disguise, Locksmith.

### chase
**Pursuit or escape — running, driving, climbing under pressure.**
Triggered by: fleeing from danger, chasing a suspect, vehicle pursuit, swimming to escape.
Both pursuer and quarry roll. Higher success wins.
Typical skills: Drive Auto, Climb, Swim, Jump, Dodge, Ride, Pilot (*), Operate Heavy Machinery.

### mental
**Sanity resistance — confronting cosmic horror, resisting psychological trauma.**
Triggered by: witnessing something horrifying, reading blasphemous texts, encountering Mythos entities, resisting madness.
Rolls against SAN stat. Failure causes sanity loss.
Typical skills: Psychology, Psychoanalysis, Occult, Cthulhu Mythos.

### environmental
**Surviving harsh conditions, physical endurance, wilderness hazards, emergency medicine, and creative movement.**
Triggered by: crossing a raging river, surviving extreme cold/heat, treating wounds in the field, navigating without landmarks, handling toxic substances, climbing walls, jumping between rooftops, swimming across a lake, breaking through obstacles.
Typical skills: Survival (*), First Aid, Medicine, Navigate, Climb, Swim, Jump, Electrical Repair, Mechanical Repair.

### narrative
**Key story moments — interpreting lore, performing rituals, making dramatic speeches.**
Triggered by: decoding ancient manuscripts, performing a ritual, delivering a critical speech, creative problem-solving through art or writing.
Typical skills: History, Occult, Language (*), Art/Craft (*), Psychology, Law.`;

const DEFAULT_PLAYER_OUTPUT_SCHEMA = `## Output
Return a JSON array of PlanNode objects. No extra text. Always write in English.

Each node is a single flat JSON object combining:
1. All **Base Fields** (required on every node)
2. **Type-specific fields** for the chosen \`type\` (see below — omit if type has none)
3. **Feature overlay fields** if the action involves an active world feature (see below)

### Base Fields (every node)
\`\`\`json
{
  "nodeId": "unique-id",
  "action": "description of what the player does",
  "location": "sceneId",
  "type": "routine|movement|character_interaction|object_interaction|scene_interaction",
  "actionType": "exploration|social|combat|stealth|chase|mental|environmental|narrative (OMIT if no skill check)",
  "difficulty": "regular|hard|extreme (only when actionType present)",
  "impact": 0,
  "timeAdvanceMinutes": "minutes THIS action takes (not cumulative)",
  "status": "pending"
}
\`\`\`

### Type-Specific Additional Fields

**routine**: no additional fields

**movement**: no additional fields

**character_interaction** adds:
- \`"targetCharacterId"\`: (REQUIRED) e.g. \`"npc_dr_morgan"\`
- \`"characterInteractionPayload"\`: (optional) e.g. \`{"transferType":"item","itemId":"mysterious_letter"}\`

**object_interaction** adds:
- \`"objectInteractionPayload"\`: (optional) e.g. \`{"action":"pickup","itemId":"ancient_tome"}\` or \`{"action":"use","itemId":"room_key","targetItemId":"locked_safe"}\`. For non-standard creative uses, add \`"itemUpdates"\` and/or \`"targetItemUpdates"\` with the expected item state changes on success.

**scene_interaction** adds:
- \`"sceneConnectionEffect"\`: (optional) e.g. \`{"targetScenarioId":"basement_entrance","action":"block"}\`

### Complete Example
\`\`\`json
[
  {
    "nodeId": "ci1",
    "action": "Hand over the mysterious letter to Dr. Morgan",
    "location": "hospital_lobby",
    "type": "character_interaction",
    "actionType": "social",
    "difficulty": "regular",
    "impact": 2,
    "timeAdvanceMinutes": 10,
    "status": "pending",
    "targetCharacterId": "npc_dr_morgan",
    "characterInteractionPayload": {
      "transferType": "item",
      "itemId": "mysterious_letter"
    }
  }
]
\`\`\``;

export function buildPlayerPlanPrompt(params: PlayerPlanParams): string {
  const lang = params.language?.toLowerCase() ?? "en";
  const isZh = lang.startsWith("zh");

  const languageInstruction = isZh
    ? `Write the "action" field in Chinese. All JSON keys and enum values must remain in English.`
    : `Write the "action" field in English. All JSON keys and enum values must remain in English.`;

  return `You are the Game Master for a Call of Cthulhu tabletop RPG.

## Task
Decompose the player's natural language input into 1 or more structured PlanNode actions (JSON array).
Each node represents a discrete action the player character performs.

## Language
${languageInstruction}

## Player Input
"${params.playerInput}"

## Player Character
${params.playerProfile}

## Current Scene
- Scenario ID: ${params.currentScenarioId}
- Name: ${params.currentScenarioName}
- Description: ${params.currentScenarioDescription}

## Scene Conditions
${params.sceneConditions || "None."}

${params.worldStatePrompt || ""}

## Available Clues in This Scene
${params.scenarioClues || "No clues available."}

## Connected Scenes
${params.connections || "No connections."}

## NPCs Present in Scene
${params.sceneNpcs || "No NPCs present."}

## Target NPC (if applicable)
${params.targetNpcProfile || "N/A"}

## Relationship with Target NPC
${params.targetNpcRelationship || "N/A"}

## Orchestrator Hints
${params.orchestratorHints || "None."}

## Recent Conversation History
${params.conversationHistory || "No prior conversation."}

## Current Time
Day ${params.gameDay}, ${params.currentGameTime}

${params.handlerPrompt || DEFAULT_NODE_TYPE_REFERENCE}

## When to Assign actionType (Core Decision)

**Principle: actionType = uncertain outcome requiring a dice roll. No actionType = guaranteed success.**

### Movement-specific rules
- Moving along an unblocked connected path → **OMIT actionType**
- Moving through a BLOCKED connection → read the block reason. If a skill can overcome it (locked door → Locksmith, barricade → environmental), **SET actionType**. If impassable (collapsed building, magically sealed), do NOT attempt.
- Creative movement with no connection (jumping, climbing, swimming) → **SET actionType** (e.g. environmental, chase)

Consider these three factors together to decide:

### 1. NPC Relationship
The "Relationship with Target NPC" section provides a score from -100 (nemesis) to 100 (devoted ally) and a description. Use both the score and the description to judge the NPC's willingness to cooperate:
- Higher score → NPC is more cooperative → routine requests auto-succeed, only unreasonable or sensitive demands need a social roll
- Lower score → NPC is more resistant → even simple requests may require a social roll
- The description provides context (e.g., "suspects the player of theft") — use it to judge what the NPC would or wouldn't agree to willingly

### 2. Scene Context
Read the Scene Conditions and Scene Description to judge environmental difficulty:
- Dangerous or hazardous conditions may require environmental or exploration rolls for physical actions
- Restricted or guarded areas may require stealth or exploration rolls
- The scene context tells you whether an otherwise simple action becomes risky

### 3. Player Roleplay Quality
The quality of the player's description affects **difficulty level**, not whether actionType is assigned. An action that inherently requires a roll always gets actionType, regardless of how well the player describes it. But a detailed, clever approach earns easier difficulty, while a vague or reckless approach earns harder difficulty.

## Difficulty Rules (only when actionType is present)

Difficulty reflects **both** the inherent challenge **and** the quality of the player's approach:

- **"regular"**: Player described a detailed, clever, or well-reasoned approach; OR the task is inherently straightforward.
- **"hard"**: Player gave a vague or generic description (e.g., "I try to convince him"); OR the task is moderately challenging; OR the NPC is somewhat uncooperative.
- **"extreme"**: Player's approach is reckless, poorly planned, or contradicts common sense; OR the task is very difficult; OR the NPC is deeply hostile.

Use the relationship score, scene conditions, and player approach holistically — a clever approach against a hostile NPC might still be "hard", while a vague approach in a safe situation might only be "regular".

${params.planningPrompt || ""}

## Time Advance
\`timeAdvanceMinutes\` = how long **this single action** takes (in minutes). NOT cumulative, NOT relative to the previous node. The engine computes absolute game time from these durations automatically.

Estimate realistic minutes:
- Quick action (glance, pick up): 5
- Short conversation: 10-15
- Detailed investigation: 15-30
- Travel between scenes: 15-30
- Extended activity: 30-60

${params.outputSchemaPrompt || DEFAULT_PLAYER_OUTPUT_SCHEMA}`;
}
