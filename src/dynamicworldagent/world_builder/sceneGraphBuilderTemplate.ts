/**
 * Scene Graph Builder Templates
 * Prompt template for transport network generation (street/road scenes connecting macro locations)
 */

export interface TransportNetworkParams {
  macroLocations: Array<{ id: string; name: string; description: string }>;
  settingDescription: string;
  storyPremise: string;
}

export function buildTransportNetworkPrompt(
  params: TransportNetworkParams
): string {
  const locationList = params.macroLocations
    .map(
      (loc) => `  - **${loc.name}** (id: "${loc.id}"): ${loc.description}`
    )
    .join("\n");

  return `You are a world-builder for a tabletop RPG scenario.

# TRANSPORT NETWORK GENERATION

## Objective
Generate the outdoor road/street/path scenes that physically connect the macro locations listed below.
These are real traversable places — streets, alleys, trails, docks, bridges, open fields — where NPCs can
encounter each other, events can happen, and investigators may be ambushed or followed.

## Setting
${params.settingDescription}

## Story Premise (for thematic guidance)
${params.storyPremise}

## Macro Locations to Connect
${locationList}

## Requirements
1. **Decide how many road/street scenes are needed.** A small town might need 2-4 outdoor scenes; a city district might need 4-8. Use your judgment based on the setting.
2. **Every macro location must be reachable** — the resulting graph (macro locations + outdoor scenes + edges) must be fully connected. There must be a path from any location to any other location.
3. **Travel times must be realistic:**
   - Walking in a small town: 2-10 minutes between adjacent locations.
   - Walking in a city: 5-15 minutes between adjacent locations.
   - Remote/wilderness paths: 10-30 minutes.
   - Choose times that feel right for the setting.
4. **Each outdoor scene is a real place** with a name and description that fits the setting (e.g., "Elm Street", "Harbor Road", "The Old Bridge", "Forest Trail to the Mill").
5. **Outdoor scene IDs** must follow the pattern "ROAD_1", "ROAD_2", etc.
6. **Transport edges are bidirectional** — if you list an edge from A to B via a road, the reverse path (B to A via the same road) is implied. You only need to list each connection once.
7. **A single outdoor scene can connect multiple locations** — a main street might connect 2-3 locations along its length. Create separate edges for each pair connected through that road.
8. Do NOT generate any clues, NPCs, items, or events — just the physical road scenes and connections.

## Output Format
Return ONLY valid JSON in this exact structure:

\`\`\`json
{
  "outdoorScenes": [
    {
      "id": "ROAD_1",
      "name": "Main Street",
      "description": "The central thoroughfare running through town, lined with gas lamps and old elm trees."
    },
    {
      "id": "ROAD_2",
      "name": "Harbor Road",
      "description": "A winding gravel path leading down to the docks, smelling of salt and fish."
    }
  ],
  "transportEdges": [
    {
      "fromLocationId": "SCN_1",
      "toLocationId": "SCN_2",
      "streetSceneId": "ROAD_1",
      "travelTimeMinutes": 5
    },
    {
      "fromLocationId": "SCN_2",
      "toLocationId": "SCN_3",
      "streetSceneId": "ROAD_2",
      "travelTimeMinutes": 8
    }
  ]
}
\`\`\`

Remember:
- fromLocationId and toLocationId must reference macro location IDs from the list above.
- streetSceneId must reference one of the outdoor scenes you generated.
- The full graph must be connected — every macro location reachable from every other.
`;
}
