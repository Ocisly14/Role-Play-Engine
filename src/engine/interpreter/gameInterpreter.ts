import { ModelClass, generateText } from "../../models/index.js";
import type { ActionDefinition, InterpretedResult } from "../types.js";

export function buildInterpreterPrompt(
  definitions: ActionDefinition[]
): string {
  const generalDefs = definitions.filter((d) => !d.skillCheck);
  const skillDefs = definitions.filter((d) => d.skillCheck);

  const opposedDefs = skillDefs.filter(
    (d) => d.skillCheck?.type === "opposed",
  );
  const singleDefs = skillDefs.filter(
    (d) => d.skillCheck?.type === "single",
  );

  const formatDef = (d: ActionDefinition): string => {
    let line = `- **${d.id}**: ${d.description}`;
    if (d.interpreter?.examples?.length) {
      line += ` (e.g. "${d.interpreter.examples[0]}")`;
    }
    if (d.impactHint) {
      line += ` [impact: default ${d.impactHint.default}`;
      if (d.impactHint.range) line += `, range ${d.impactHint.range}`;
      line += "]";
    }
    return line;
  };

  const sections: string[] = [];

  if (generalDefs.length > 0) {
    sections.push("### General Actions (no skill check)");
    sections.push(generalDefs.map(formatDef).join("\n"));
  }

  if (opposedDefs.length > 0) {
    sections.push("");
    sections.push("### Opposed Skills (social/combat — require target)");
    sections.push(opposedDefs.map(formatDef).join("\n"));
  }

  if (singleDefs.length > 0) {
    sections.push("");
    sections.push(
      "### Single Skills (perception, knowledge, physical, technical)"
    );
    sections.push(singleDefs.map(formatDef).join("\n"));
  }

  const defList = sections.join("\n");

  return `You are an action interpreter for a game simulation engine.

Given a natural language action, decompose it into an ordered sequence of steps. Each step references one of the available action definitions and has its own impact level.

## Available Definitions
${defList}

## Rules
- A simple action maps to a single step (e.g., "搜查房间" → [perception])
- A composite action maps to multiple ordered steps (e.g., "撬开柜子然后搜查里面" → [locksmith, perception])
- If the action involves going somewhere first, the first step should be "movement"
- If the action is a simple conversation without persuasion/deception, use "conversation"
- If the action involves giving/receiving items, use "item_exchange"
- If no specific skill definition matches, use "action" (general action)
- Never use "generic" if a more specific definition exists

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
    { "definitionId": "locksmith", "impact": 1 },
    { "definitionId": "perception", "impact": 0 }
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
