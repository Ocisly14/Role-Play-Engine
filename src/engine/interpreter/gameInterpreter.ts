import { ModelClass, generateText } from "../../models/index.js";
import type { ActionDefinition, InterpretedResult } from "../types.js";
import type { ReferencedEntity } from "../core/types.js";
import type { PerceivableDirectory } from "../../state/perceivableDirectory.js";

export class CitationResolutionError extends Error {
  constructor(
    public readonly citation: string,
    public readonly actionText: string
  ) {
    super(
      `Citation [${citation}] not in PerceivableDirectory. actionText: "${actionText}"`
    );
    this.name = "CitationResolutionError";
  }
}

const CITATION_REGEX = /\[([^\]]+)\]/g;

export function parseCitations(
  actionText: string,
  directory: PerceivableDirectory
): ReferencedEntity[] {
  const result: ReferencedEntity[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  CITATION_REGEX.lastIndex = 0;
  while ((match = CITATION_REGEX.exec(actionText)) !== null) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);

    const charId = directory.characters.get(name);
    if (charId !== undefined) {
      result.push({ id: charId, kind: "character" });
      continue;
    }
    const itemId = directory.items.get(name);
    if (itemId !== undefined) {
      result.push({ id: itemId, kind: "item" });
      continue;
    }
    const sceneId = directory.scenes.get(name);
    if (sceneId !== undefined) {
      result.push({ id: sceneId, kind: "scene" });
      continue;
    }

    throw new CitationResolutionError(name, actionText);
  }
  return result;
}

export function buildInterpreterPrompt(
  definitions: ActionDefinition[]
): string {
  const generalDefs = definitions.filter((d) => !d.skillCheck);
  const skillDefs = definitions.filter((d) => d.skillCheck);

  const opposedDefs = skillDefs.filter((d) => d.skillCheck?.type === "opposed");
  const singleDefs = skillDefs.filter((d) => d.skillCheck?.type === "single");

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
- If the action involves going somewhere first, the first step should be "movement". For movement steps, ALWAYS include a \`destination\` string set to the target location ID exactly as it appears in the action text (e.g. "library", "JUNC_HARBOR", "SCN_42"). Do not paraphrase — preserve the literal location identifier.
- If the action involves giving/receiving items without dialogue, use "item_exchange"
- If no specific skill definition matches, use "action" (general no-skill action) for solo/environmental actions, or "character_interaction" for casual talk / greetings / asking questions / leading someone

## Definition Selection Priority
When multiple definitions could match:
1. **Prefer specific skill definitions** (perception, listen, first_aid, brawling, persuade, etc.) over umbrella definitions (action, character_interaction, item_exchange).
2. Umbrella definitions are FALLBACKS — pick them only when no specific skill fits.
3. Physical violence (punching, grappling, tackling, attacking with a weapon) is ALWAYS a combat skill (Brawling / Axe / Sword / Whip / Firearms / Throw), never character_interaction.
4. Therapeutic giving (handing medicine with intent to treat) is Medicine / First Aid, not Item Exchange.
5. Social manipulation (persuading, charming, intimidating, deceiving) is the specific social skill (Persuade / Charm / Intimidate / Bluff), not character_interaction.
6. Long-term mental therapy (calming / treating SAN over sessions) is Psychoanalysis, not character_interaction.

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
    { "definitionId": "movement", "impact": 0, "destination": "library" },
    { "definitionId": "locksmith", "impact": 1 },
    { "definitionId": "perception", "impact": 0 }
  ]
}`;
}

export function parseInterpretedResult(
  raw: string,
  definitions?: ActionDefinition[]
): InterpretedResult {
  const defMap = new Map<string, ActionDefinition>();
  if (definitions) {
    for (const def of definitions) defMap.set(def.id, def);
  }
  const enrich = (definitionId: string) => {
    const def = defMap.get(definitionId);
    return {
      engine: (def?.engine ?? "llm") as "code" | "llm",
      codeSubsystem: def?.codeSubsystem,
    };
  };

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    const parsed = JSON.parse(jsonMatch[0]);
    if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
      const steps = parsed.steps.map(
        (s: {
          definitionId?: string;
          impact?: number;
          destination?: string;
        }) => {
          const definitionId = s.definitionId ?? "generic";
          const { engine, codeSubsystem } = enrich(definitionId);
          // Movement (and any future code-engine subsystem) carries
          // subsystem-specific inputs in overlayFields. Today the only
          // such input is `destination` for movement.
          const overlayFields =
            codeSubsystem === "movement" && typeof s.destination === "string"
              ? { destination: s.destination }
              : undefined;
          return {
            definitionId,
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
            engine,
            codeSubsystem,
            overlayFields,
          };
        }
      );
      return { steps };
    }
    throw new Error("Invalid steps");
  } catch {
    const { engine, codeSubsystem } = enrich("generic");
    return {
      steps: [{ definitionId: "generic", impact: 0, engine, codeSubsystem }],
    };
  }
}

export async function interpretAction(
  action: string,
  definitions: ActionDefinition[],
  language: string,
  directory: PerceivableDirectory
): Promise<InterpretedResult> {
  const systemPrompt = buildInterpreterPrompt(definitions);
  const langInstruction =
    language === "zh"
      ? "The action is in Chinese."
      : "The action is in English.";

  const text = await generateText({
    customSystemPrompt: systemPrompt,
    context: `${langInstruction}\n\nAction: "${action}"`,
    modelClass: ModelClass.SMALL,
    operation: "game-interpreter",
  });

  const parsed = parseInterpretedResult(text, definitions);
  // Phase H: every step shares the same citations parsed from actionText.
  const referencedEntities = parseCitations(action, directory);
  return {
    steps: parsed.steps.map((s) => ({ ...s, referencedEntities })),
  };
}
