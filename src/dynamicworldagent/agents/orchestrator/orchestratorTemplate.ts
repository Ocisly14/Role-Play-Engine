/**
 * Action Analysis Agent Template - classify investigator input into action analysis only.
 */
export function getOrchestratorTemplate(): string {
  return `# Action Analysis Agent

You classify the investigator's latest input into a structured action analysis. Do NOT route to other agents; only return the analysis JSON.

## Game Context
- Character: {{characterName}}
- Location: {{scenarioLocation}}
- Available NPCs: {{npcNames}}

## Investigator's Input
"{{input}}"

{{#if previousNarrative}}
## Previous Round Narrative
"{{previousNarrative}}"
{{/if}}

## Action Types
- exploration | social | stealth | combat | chase | mental | environmental | narrative

## Output (JSON only)
{
  "actionAnalysis": {
    "character": "character name",
    "action": "what action the character wants to perform",
    "actionType": "exploration|social|stealth|combat|chase|mental|environmental|narrative",
    "target": { "name": "target name if applicable", "intent": "what the character wants to achieve" },
    "requiresDice": true
  }
}`;
}
