/**
 * Prompt Structurizer Template
 * Extracts structured story elements from user creative prompt
 */

export function getPromptStructurizerTemplate(): string {
  return `You are a story element extraction expert for tabletop RPG scenario design.

Analyze the user's creative description below and extract / expand it into 5 structured story elements. If the user omits any element, infer it from context and genre conventions.

## User Input
{{creativePrompt}}

## Output Requirements

Return a single JSON object with these fields (ALL in English, regardless of user input language):

\`\`\`json
{
  "era": "The time period / historical era the story takes place in (e.g. '1920s Prohibition-era New England', 'Victorian London 1888', 'Near-future 2045 Tokyo')",
  "worldbuilding": "How the world operates: science/magic systems, political structures, civilizations/races, religious beliefs, cosmic entities. Be specific to the story.",
  "genre": ["Primary genre(s) as an array, e.g. 'horror', 'mystery', 'adventure', 'crime', 'sci-fi', 'fantasy'"],
  "tone": "Overall style and atmosphere (e.g. 'dark, oppressive, paranoid', 'gothic and melancholic', 'tense noir')",
  "theme": "Core thematic idea the story explores (e.g. 'humanity's insignificance before cosmic entities', 'the corruption of power', 'forbidden knowledge and its price')",
  "refinedPrompt": "A comprehensive, precise creative brief in English that synthesizes ALL of the above elements plus every specific detail from the user's original input. This should be 3-6 sentences long and serve as the authoritative creative direction for all downstream generation."
}
\`\`\`

## Rules
1. PRESERVE every specific detail from the user's input (locations, character ideas, plot hooks, atmosphere cues).
2. The \`refinedPrompt\` must contain ALL user-specified details — nothing may be dropped.
3. If the user writes in a non-English language, translate and expand — do NOT transliterate.
4. For CoC (Call of Cthulhu) scenarios, default worldbuilding should include Lovecraftian cosmic horror elements unless the user explicitly requests otherwise.
5. Output ONLY the JSON object. No commentary before or after.`;
}
