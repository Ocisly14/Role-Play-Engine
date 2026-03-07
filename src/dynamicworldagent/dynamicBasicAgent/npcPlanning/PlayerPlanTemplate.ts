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
}

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

## Node Type Reference
- **"routine"**: Self-contained action, no interaction target. Examples: eating, resting, reading something already in hand, thinking, recalling memories.
- **"movement"**: Move to a destination scene. Set location to the target scene ID. Omit actionType for normal unblocked movement; set actionType when path is blocked (if skill can overcome it) or for creative movement (climbing, jumping, swimming).
- **"character_interaction"**: Interact with a specific NPC. Requires targetCharacterId. Include characterInteractionPayload if transferring item/clue/information.
- **"object_interaction"**: Interact with a physical object in the scene. Include objectInteractionPayload (pickup/place/use/inspect/destroy).
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
Typical skills: History, Occult, Language (*), Art/Craft (*), Psychology, Law.

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

## Impact Levels
Impact determines **who in the game world perceives and is affected by** the action:
- **0 — Private / unnoticed**: Only the acting character knows. No one else perceives or reacts.
  Examples: thinking, reading alone, checking belongings, observing from afar, writing notes, resting
- **1 — Targeted / one-on-one**: Only the specific target character perceives it. A private exchange.
  Examples: whispering, passing a note, pickpocketing someone, private conversation, discreet item handoff
- **2 — Sub-scene / room-wide**: Everyone in the current room or sub-scene perceives it. Visible/audible to bystanders.
  Examples: speaking loudly, firing a gun, breaking a door, starting a fight, searching a room openly, screaming
- **3 — Building / macro-location-wide**: Everyone in the same building or macro location perceives it (all rooms/floors).
  Examples: fire alarm, shouting down a stairwell, smoke filling the building, event audible throughout
- **4 — Neighborhood**: Perceived at the current building and nearby buildings within walking distance.
  Examples: explosion heard across the block, gunshot echoing, building collapse, large fire
- **5 — Global / far-reaching**: The entire game world is affected. Consequences ripple everywhere.
  Examples: triggering a town alarm, summoning ritual, radio broadcast, earthquake

## Time Advance
Estimate realistic minutes for each action:
- Quick action (glance, pick up): 5
- Short conversation: 10-15
- Detailed investigation: 15-30
- Travel between scenes: 15-30
- Extended activity: 30-60

## Output
Return a JSON array of PlanNode objects. No extra text outside the JSON.

\`\`\`json
[
  {
    "nodeId": "unique-id",
    "gameTime": "HH:MM",
    "action": "description of what the player does",
    "location": "${params.currentScenarioId}",
    "type": "routine|movement|character_interaction|object_interaction|scene_interaction",
    "actionType": "exploration|social|combat|stealth|chase|mental|environmental|narrative (OMIT if no skill check needed)",
    "difficulty": "regular|hard|extreme (only when actionType present)",
    "impact": 0,
    "timeAdvanceMinutes": 15,
    "targetCharacterId": "npc id (only for character_interaction)",
    "characterInteractionPayload": { "transferType": "item|clue|information", "itemId": "", "clueId": "", "informationContent": "" },
    "objectInteractionPayload": { "action": "pickup|place|use|inspect|destroy", "itemId": "" },
    "sceneConnectionEffect": { "targetScenarioId": "...", "action": "block|unblock" },
    "status": "pending"
  }
]
\`\`\`

Only include optional fields (actionType, difficulty, targetCharacterId, payloads, sceneConnectionEffect) when relevant. Omit them otherwise.`;
}
