import { ModelClass, generateText } from "../../models/index.js";
import type { ActionDefinition, InterpretedResult } from "../types.js";

export function buildInterpreterPrompt(
  definitions: ActionDefinition[]
): string {
  const defList = definitions
    .map((d) => {
      let line = `- **${d.id}**: ${d.description}`;
      if (d.impactHint) {
        line += ` [impact: default ${d.impactHint.default}`;
        if (d.impactHint.range) line += `, range ${d.impactHint.range}`;
        if (d.impactHint.examples) line += `, e.g. ${d.impactHint.examples}`;
        line += "]";
      }
      return line;
    })
    .join("\n");

  return `You are an action interpreter for a game simulation engine.

Given a natural language action, decompose it into an ordered sequence of steps. Each step references one of the available action definitions and has its own impact level.

## Available Definitions
${defList}

## Rules
- A simple action maps to a single step (e.g., "search the room" → [action])
- A composite action maps to multiple ordered steps (e.g., "go to the harbor and ask the captain" → [movement, character_interaction])
- If the action involves going somewhere first, the first step should be "movement"
- If no definition matches, use "generic"

## Impact Levels (per step)
Each step gets its own impact value determining who perceives it:
- **0**: Private / unnoticed — thinking, reading alone, resting, observing, moving quietly
- **1**: Targeted / one-on-one — whispering, private conversation, discreet item handoff
- **2**: Room-wide — speaking loudly, firing a gun, breaking a door, searching openly
- **3**: Building-wide — fire alarm, shouting down a stairwell, smoke filling the building
- **4**: Neighborhood — explosion, gunshot echoing, building collapse
- **5**: Global — town alarm, summoning ritual, earthquake
Default to 0 unless the step clearly warrants higher. Use each definition's impact hints as guidance.

## Output Format
Respond with ONLY a JSON object:
{
  "steps": [
    { "definitionId": "movement", "impact": 0 },
    { "definitionId": "character_interaction", "impact": 1 }
  ]
}`;
}

export function parseInterpretedResult(raw: string): InterpretedResult {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    const parsed = JSON.parse(jsonMatch[0]);
    if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
      const steps = parsed.steps.map(
        (s: { definitionId?: string; impact?: number }) => ({
          definitionId: s.definitionId ?? "generic",
          impact:
            typeof s.impact === "number"
              ? (Math.max(0, Math.min(5, Math.round(s.impact))) as
                  | 0
                  | 1
                  | 2
                  | 3
                  | 4
                  | 5)
              : (0 as const),
        })
      );
      return { steps };
    }
    throw new Error("Invalid steps");
  } catch {
    return { steps: [{ definitionId: "generic", impact: 0 }] };
  }
}

export async function interpretAction(
  action: string,
  definitions: ActionDefinition[],
  runtime: any,
  language: string
): Promise<InterpretedResult> {
  const systemPrompt = buildInterpreterPrompt(definitions);
  const langInstruction =
    language === "zh"
      ? "The action is in Chinese."
      : "The action is in English.";

  const text = await generateText({
    runtime,
    customSystemPrompt: systemPrompt,
    context: `${langInstruction}\n\nAction: "${action}"`,
    modelClass: ModelClass.SMALL,
    operation: "game-interpreter",
  });

  return parseInterpretedResult(text);
}
