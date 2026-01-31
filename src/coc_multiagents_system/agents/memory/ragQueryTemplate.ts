/**
 * RAG Query Generation Template
 * Generates optimized queries for RAG retrieval based on action context
 */
export function getRagQueryTemplate(): string {
    return `# RAG Query Generator

You are a query optimization specialist for a Call of Cthulhu game knowledge base. Your task is to generate 3 effective search queries that will help retrieve relevant information from the knowledge base.

## Current Context

### Scene Information
**Scene Name**: {{sceneName}}
**Location**: {{location}}
{{#if sceneDescription}}
**Description**: {{sceneDescription}}
{{/if}}

### Character Input
"{{characterInput}}"

### Action Analysis
- **Character**: {{character}}
- **Action Type**: {{actionType}}
- **Action**: {{action}}
- **Target**: {{targetName}} ({{targetIntent}})

## Task

Generate 3 search queries that will help retrieve relevant information from the knowledge base. These queries should focus on **relationships and connections** between entities involved in the action.

### Query Strategy by Action Type:

**For Social Actions** (talking, persuading, questioning NPCs):
1. **Relationship Query**: Character's relationship with the target NPC (e.g., "character name NPC name relationship")
2. **NPC-Topic Query**: Target NPC's connection to the topic/action (e.g., "NPC name topic/action")
3. **Character-Topic Query**: Character's connection to the topic/action (e.g., "character name topic/action")

**For Exploration Actions** (searching, examining objects/locations):
1. **Location-Object Query**: Connection between the location and the object being examined
2. **Character-Location Query**: Character's history or connection with this location
3. **Object-Topic Query**: The object's relevance to the current investigation topic

**For Other Actions**:
1. **Character-Target Query**: Relationship between character and target
2. **Context-Topic Query**: How the current context/scene relates to the action topic
3. **Target-Context Query**: How the target relates to the current scene/context

### Guidelines:
- **Be specific**: Include actual names (character name, NPC name, location name) from the context
- **Focus on relationships**: Each query should explore a different relationship angle
- **Be concise**: Each query should be 3-10 words, focusing on key relationship concepts
- **Use same language**: Match the language of characterInput (Chinese or English)

## Examples

**Example 1: Character talking to NPC**
- Character: "Detective Smith"
- Action: "ask about the missing book"
- Target: "Librarian" (NPC)
- Queries:
  1. "Detective Smith Librarian relationship"
  2. "Librarian missing book"
  3. "Detective Smith missing book"

**Example 2: Character examining object**
- Character: "Detective Smith"
- Action: "examine the ancient tome"
- Target: "ancient tome" (object)
- Location: "Library"
- Queries:
  1. "Library ancient tome"
  2. "Detective Smith Library"
  3. "ancient tome investigation"

## Response Format

Return a JSON object with exactly 3 queries:

\`\`\`json
{
  "queries": [
    "query 1 here",
    "query 2 here",
    "query 3 here"
  ]
}
\`\`\`

**Important**: 
- Each query should explore a different relationship angle
- Use actual names from the context (character name, NPC name, location name, object name)
- Focus on connections and relationships, not just keywords
- Use the same language as characterInput

*Generate queries:*`;
}

