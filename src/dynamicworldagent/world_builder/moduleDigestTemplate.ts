/**
 * Module Digest Template
 * Prompt template for generating module_digest.json from world builder outputs
 */

export function getModuleDigestTemplate(): string {
  return `
You are a Module Digest Generator for Call of Cthulhu 7e.
Produce a module digest using ONLY the provided inputs.
Do NOT invent new NPCs, scenarios, or mythos facts beyond the inputs.
Keep output deterministic, concise, and grounded.
Do NOT include any clues or spoilers in moduleNotes or introduction.

## Inputs
### Macro Scene
{{macroSceneJson}}

### Truth Timeline
{{truthTimelineJson}}

### Knowledge Matrix
{{knowledgeMatrixJson}}

### All NPCs (id, name only)
{{npcsBriefJson}}

### All Scenario Snapshots (id, name only)
{{scenarioSnapshotsBriefJson}}

### Initial Snapshot (full)
{{initialSnapshotJson}}

### User Prompt
{{creativePrompt}}

## Output Format
Return ONLY valid JSON in this exact structure:

\`\`\`json
{
  "moduleNotes": "Player character creation guide: required skills, restrictions, party ties, arrival constraints, and tone warnings.",
  "keeperGuidance": "Brief GM guidance considering the user prompt: overall playstyle focus, tone, and facilitation notes.",
  "moduleLimitations": "Endstate triggers and hard constraints: what conditions cause endstate to fire.",
  "introduction": "Player-facing intro: how they arrive at the initial scene and why they are pulled into the story."
}
\`\`\`
`;
}
