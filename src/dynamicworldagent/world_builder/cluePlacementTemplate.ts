/**
 * Clue Placement Agent Templates
 * Prompt template for distributing clues across scenes and NPCs (Phase 10)
 *
 * Clue placement is the final step of the inverted generation pipeline:
 * physical world (scenes) is built first, then story is woven in.
 * This phase takes the truth timeline, knowledge matrix, NPCs, and existing
 * scenes, and distributes clues to scenes and NPCs.
 */

export interface CluePlacementParams {
  truthTimeline: Array<{
    id: string;
    time: string;
    event: string;
    mythosInvolved: boolean;
  }>;
  knowledgeMatrix: Array<{
    id: string;
    holderType: string;
    holderName: string;
    knows: string[];
    containsEvidence?: string[];
  }>;
  scenes: Array<{
    id: string;
    name: string;
    description: string;
    parentLocationId: string;
  }>;
  npcs: Array<{
    id: string;
    name: string;
    residence?: string;
    instantiatedFrom?: string;
  }>;
  macroLocations: Array<{ id: string; name: string; description: string }>;
}

export function buildCluePlacementPrompt(params: CluePlacementParams): string {
  const {
    truthTimeline,
    knowledgeMatrix,
    scenes,
    npcs,
    macroLocations,
  } = params;

  return `You are a clue designer for a tabletop RPG scenario (Call of Cthulhu, 7th Edition).

# CLUE PLACEMENT (Phase 10)

## Objective
Distribute investigative clues across physical scenes and NPCs so that players can uncover the truth through exploration and conversation.

The physical world and NPCs already exist. Your job is to decide WHERE each piece of evidence lives and WHO knows what, then output structured clue objects.

## Inputs

### Truth Timeline (Objective Events)
These are the actual events that happened. Clues must ultimately point toward (or away from) these events.
${JSON.stringify(truthTimeline, null, 2)}

### Knowledge Matrix
Defines which abstract holders possess knowledge or contain evidence. Use this to determine:
- PLACE/OBJECT holders -> scene clues (physical evidence left at locations)
- ROLE/ORGANIZATION holders -> NPC clues (information people know)
${JSON.stringify(knowledgeMatrix, null, 2)}

### Macro Locations (Scenario Outlines)
High-level areas that group scenes together.
${JSON.stringify(macroLocations, null, 2)}

### All Scenes (Sub-Scenes within Macro Locations)
These are the specific rooms/areas players can explore. Each scene belongs to a macro location via parentLocationId.
${JSON.stringify(scenes, null, 2)}

### All NPCs
These are the characters players can interact with. Each NPC may be instantiated from a knowledge holder.
${JSON.stringify(npcs, null, 2)}

## Clue Design Rules

### Scene Clues (Physical Evidence)
Place clues in scenes that make logical sense given where truth timeline events occurred.

Each scene clue requires:
- **clueText**: A concrete, discoverable piece of evidence (NOT abstract knowledge). Examples: "bloodstains on the floorboards", "a torn page from a journal dated March 3rd", "scratch marks on the inside of the cellar door".
- **category**: One of:
  - "physical" — tangible objects, marks, residue, damage
  - "document" — written records, letters, books, newspapers, maps
  - "environment" — atmospheric or structural anomalies (strange smells, cold spots, architectural oddities)
  - "observation" — things noticed by careful examination (patterns, absences, out-of-place details)
- **difficulty**: How hard to discover:
  - "automatic" — obvious to anyone entering the scene
  - "regular" — requires a successful skill check
  - "hard" — requires a hard skill check or specific action
  - "extreme" — requires an extreme skill check or very specific approach
- **discoveryMethod**: The skill or action needed (e.g., "Spot Hidden", "Library Use", "Listen", "Examine the bookshelf", "Search the desk drawers").
- **reveals**: Array of truth event IDs (e.g., ["T1", "T3"]) that this clue points toward. A clue may point to multiple events.

### NPC Clues (Knowledge & Testimony)
Assign clues to NPCs based on the knowledge matrix — what their source knowledge holder knows.

Each NPC clue requires:
- **clueText**: What the NPC can tell investigators. This should be in their voice/perspective, possibly distorted. Examples: "I heard terrible screaming from the old house that night", "The professor was acting strange for weeks before he vanished".
- **category**: One of:
  - "knowledge" — facts the NPC knows from direct experience or study
  - "observation" — things the NPC witnessed or noticed
  - "rumor" — second-hand information, gossip, hearsay (may be inaccurate)
  - "secret" — information the NPC actively hides and will not share willingly
- **difficulty**: How hard to extract from the NPC:
  - "regular" — NPC will share if asked appropriately
  - "hard" — NPC is reluctant; requires Persuade, Intimidate, or trust-building
  - "extreme" — NPC is terrified, bound by oath, or deeply invested in hiding this
- **relatedTo**: Array of truth event IDs this clue relates to.

### Distribution Guidelines
1. **Spread clues across multiple scenes** — do NOT cluster all clues in one place. Every macro location should have at least one clue somewhere in its scenes.
2. **Use the knowledge matrix as your primary guide**:
   - PLACE holders with "containsEvidence" -> place scene clues in scenes under that macro location.
   - ROLE/ORGANIZATION holders with "knows" -> assign NPC clues to NPCs instantiated from those holders.
3. **Include redundancy** — critical truth events should be discoverable through multiple independent clues (different scenes AND different NPCs).
4. **Vary difficulty** — include a mix of automatic, regular, hard, and extreme clues. The most important revelations should have at least one easier path to discovery.
5. **Include misdirection** — add 1-3 clues that seem to point toward a plausible but INCORRECT explanation. These should be marked with reveals: [] (empty) or point to events that, in context, could be misinterpreted.
6. **Mythos clues should be harder** — clues relating to mythos-involved truth events should generally be harder difficulty and more cryptic.
7. **Each NPC should have 1-3 clues** matching their knowledge holder's "knows" list. Do NOT give an NPC clues about events their knowledge holder does not know.
8. **Scene clues: aim for 1-4 per scene** where evidence exists. Not every scene needs clues — some scenes are transitional or atmospheric.

## Output Format
Return ONLY valid JSON in this exact structure:

\`\`\`json
{
  "sceneClues": [
    {
      "sceneId": "SCN_1_lobby",
      "clues": [
        {
          "clueText": "Dark stains on the wooden floor near the back door, partially covered by a rug.",
          "category": "physical",
          "difficulty": "regular",
          "discoveryMethod": "Spot Hidden",
          "reveals": ["T2"]
        },
        {
          "clueText": "A crumpled receipt from an out-of-town pharmacy dated two weeks ago.",
          "category": "document",
          "difficulty": "hard",
          "discoveryMethod": "Search the wastebasket",
          "reveals": ["T4"]
        }
      ]
    }
  ],
  "npcClues": [
    {
      "npcId": "npc-marcus-webb",
      "clues": [
        {
          "clueText": "I heard something awful from the old tunnels that night. Sounded like chanting, but no human voice should sound like that.",
          "category": "observation",
          "difficulty": "hard",
          "relatedTo": ["T1", "T2"]
        },
        {
          "clueText": "People say it was just a gas leak, but I know what I smelled down there and it wasn't gas.",
          "category": "knowledge",
          "difficulty": "extreme",
          "relatedTo": ["T2"]
        }
      ]
    }
  ]
}
\`\`\`

IMPORTANT:
- Every scene clue MUST reference a valid sceneId from the provided scenes list.
- Every NPC clue MUST reference a valid npcId from the provided NPCs list.
- The "reveals" and "relatedTo" arrays MUST only contain truth event IDs from the provided truth timeline.
- Do NOT invent new scenes, NPCs, locations, or truth events.
- Ensure at least one clue path exists for every truth event in the timeline.

Generate the clue placement now.`;
}
