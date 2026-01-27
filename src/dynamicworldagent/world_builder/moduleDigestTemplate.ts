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

### End State Definition
The following defines the inevitable catastrophic outcome if investigators do not intervene:

\`\`\`json
{{endStateJson}}
\`\`\`

**Important**: The endState describes the final catastrophic outcome and its pointOfNoReturn trigger. Your global trigger should NOT be the same as the pointOfNoReturn - instead, it should be an **intermediate step** that moves the story toward the end state, but is still preventable.

## 🎯 Global Trigger

**You MUST generate an initial global trigger for the module based on the truth timeline, knowledge matrix, story structure, and the endState definition. This trigger represents the first major story event or time-sensitive development that will occur in the game.**

**Critical Guidelines:**
1. **Progressive Escalation**: The global trigger should be a step in the chain leading toward the endState, NOT the endState's pointOfNoReturn itself
2. **Event Chain Understanding**: Analyze the endState summary to understand the sequence of events that lead to catastrophe
   - Identify the early/mid-stage events in that chain
   - Your global trigger should represent one of these intermediate events
3. **Preventable but Urgent**: The trigger should be something investigators can potentially prevent or influence, creating tension and urgency
4. **Logical Progression**: The trigger should logically lead toward the endState's pointOfNoReturn, but be distinct from it
5. **Time Relationship**: The trigger's timeRestriction should be BEFORE the pointOfNoReturn time (if pointOfNoReturn is time-based)

### Trigger Structure:

1. The most important rule, the trigger you set must have great impact on the story progression.
2. **timeRestriction** : Future time point in "Day X, HH:MM" format - MUST be at least 12 hours from the game start
   - If endState's pointOfNoReturn is time-based, ensure your trigger time is BEFORE that time
   - This creates a progression: trigger → (investigator actions) → pointOfNoReturn
3. **timeReason** : Why this specific time matters in the context of moving toward the endState
4. **events**: Array of trigger event descriptions representing intermediate steps toward the endState
   - These should be early/mid-stage events in the chain leading to catastrophe
   - Examples: "Preparations begin", "Key NPCs gather", "First signs of the threat emerge", "Critical evidence becomes accessible"
   - NOT: The final catastrophic event itself (that's the pointOfNoReturn)
5. **eventReasons**: Array of reasons (one per event) explaining why each event is important and how it moves toward the endState

**Example (with endState context):**
If endState's pointOfNoReturn is "The ritual completes at midnight on Day 3", your global trigger might be:
\`\`\`json
"globalTrigger": {
  "timeRestriction": "Day 2, 18:00",
  "timeReason": "Cult members begin gathering ritual components and securing the site, marking the transition from planning to active preparation",
  "events": ["Cult members gather at the church", "Ritual components are assembled", "The site is sealed off from outsiders"],
  "eventReasons": [
    "Shows the cult's active planning phase beginning",
    "Marks the point where intervention becomes more difficult",
    "Increases urgency - investigators have limited time before the final ritual"
  ]
}
\`\`\`

**Note**: This trigger represents an intermediate step (preparation phase) that leads toward but is distinct from the final ritual completion (pointOfNoReturn).

## Output Format
Return ONLY valid JSON in this exact structure:

\`\`\`json
{
  "moduleNotes": "Player character creation guide: required skills, restrictions, party ties, arrival constraints, and tone warnings.",
  "keeperGuidance": "Brief GM guidance considering the user prompt: overall playstyle focus, tone, and facilitation notes.",
  "moduleLimitations": "Endstate triggers and hard constraints: what conditions cause endstate to fire.",
  "introduction": "Player-facing intro: how they arrive at the initial scene and why they are pulled into the story. It must naturally hand off into the initial snapshot without spoilers.",
  "globalTrigger": {
    "timeRestriction": "Day X, HH:MM (at least 12 hours from game start)",
    "timeReason": "Why this specific time point matters",
    "events": ["Event description 1", "Event description 2"],
    "eventReasons": ["Why event 1 matters", "Why event 2 matters"]
  }
}
\`\`\`
`;
}
