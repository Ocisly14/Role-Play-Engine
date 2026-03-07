/**
 * Sub-Scene Builder Templates
 * Prompt template for generating sub-scenes (rooms/floors) within a macro location
 */

export interface SubSceneParams {
  macroLocation: {
    id: string;
    name: string;
    description: string;
    subSceneCount: number;
    residents?: string[];
  };
  settingDescription: string;
  connectedStreetScenes: Array<{ id: string; name: string }>;
}

export function buildSubScenePrompt(params: SubSceneParams): string {
  const { macroLocation, settingDescription, connectedStreetScenes } = params;

  const residentsSection =
    macroLocation.residents && macroLocation.residents.length > 0
      ? `\n## Residents
The following people live at this location: ${macroLocation.residents.join(", ")}
You MUST include at least one bedroom or private living quarters for the residents.`
      : "";

  const streetConnections =
    connectedStreetScenes.length > 0
      ? connectedStreetScenes
          .map((s) => `- "${s.name}" (id: ${s.id})`)
          .join("\n")
      : "- (none specified)";

  return `You are a location designer for a tabletop RPG scenario (Call of Cthulhu).

# SUB-SCENE GENERATION

## Objective
Generate exactly ${macroLocation.subSceneCount} sub-scenes (rooms, floors, areas) for the macro location described below. These are the physical spaces that players can explore inside this location.

## Setting Context
${settingDescription}

## Macro Location
- ID: ${macroLocation.id}
- Name: ${macroLocation.name}
- Description: ${macroLocation.description}
${residentsSection}

## Connected Streets / Outdoor Scenes
These are the street-level scenes adjacent to this location. Exactly ONE sub-scene must be the entry point that connects to these outside areas.
${streetConnections}

## Requirements
1. Generate exactly ${macroLocation.subSceneCount} sub-scenes.
2. Each sub-scene must have:
   - "id": prefixed with the macro location ID (e.g., "${macroLocation.id}_lobby", "${macroLocation.id}_floor2").
   - "name": a natural, descriptive room/area name.
   - "description": an evocative 2-4 sentence description of the space, its atmosphere, and notable features.
   - "items": an array of interactable objects found here. Each item has "id", "name", and optionally "description". Include 1-4 items per sub-scene.
   - "conditions": an array of environmental conditions (lighting, smell, temperature, sound, weather). Include 1-2 per sub-scene.
   - "internalConnections": an array of other sub-scene IDs this room connects to (doors, hallways, stairs, etc.).
3. Exactly ONE sub-scene must have "isEntry": true. This is the entrance — the sub-scene players arrive at from the street. It should make sense architecturally (e.g., a lobby, front porch, main entrance).
4. All sub-scenes must be reachable from the entry sub-scene via internal connections (the graph must be connected).
5. Do NOT generate any clues — clues are placed in a separate step.
6. Do NOT include NPCs or characters in the scenes.
7. Sub-scenes should feel realistic and appropriate for the type of building/location (e.g., a bar might have a taproom, back office, cellar; a mansion might have a foyer, parlor, library, bedrooms).
8. Item IDs should be prefixed with the sub-scene ID (e.g., "${macroLocation.id}_lobby_item1").
9. Condition types must be one of: "weather", "lighting", "sound", "smell", "temperature", "other".

## Output Format
Return ONLY valid JSON in this exact structure:

\`\`\`json
{
  "subScenes": [
    {
      "id": "${macroLocation.id}_lobby",
      "name": "Main Lobby",
      "description": "A dimly lit entrance hall with worn wooden floors...",
      "isEntry": true,
      "items": [
        {
          "id": "${macroLocation.id}_lobby_item1",
          "name": "Guest Register",
          "description": "A leather-bound register lying open on the front desk."
        }
      ],
      "conditions": [
        {
          "type": "lighting",
          "description": "Dim gas lamps cast flickering shadows across the walls.",
          "mechanicalEffect": "Spot Hidden checks at this location are Hard."
        }
      ],
      "internalConnections": ["${macroLocation.id}_hallway"]
    }
  ]
}
\`\`\`
`;
}
