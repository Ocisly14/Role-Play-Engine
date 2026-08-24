import { ModelClass, generateText } from "../../models/index.js";
import type { PerceivableDirectory } from "../../state/perceivableDirectory.js";
import type { ReferencedEntity } from "../core/types.js";
import type { ActionDefinition, InterpretedResult } from "../types.js";

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

export class ActionTextFormatError extends Error {
  constructor(
    message: string,
    public readonly actionText: string
  ) {
    super(`${message} actionText: "${actionText}"`);
    this.name = "ActionTextFormatError";
  }
}

type RefKind = "character" | "item" | "scene";
type ParsedRef = { id: string; kind: RefKind };

const NARRATIVE_HEADER = /^\s*\[narrative\]\s*$/im;
const REFERENCES_HEADER = /^\s*\[references\]\s*$/im;
const NUMBER_CITATION_REGEX = /\[(\d+)\]/g;
// Agent references: `[N] id: <entity-id>; kind: character|item|scene`.
// Anything past `kind:` (e.g., trailing description on renderer output) is
// ignored — agent-side only needs id + kind.
const REF_LINE_REGEX =
  /^\s*\[(\d+)\]\s+id:\s*(.+?)\s*;\s*kind:\s*(character|item|scene)\b/i;

/**
 * Parse the agent's actionText (two-block format: [narrative] + [references])
 * into a cleaned narrative + resolved ReferencedEntity[]. Lenient on missing
 * fences when there are no [N] citations.
 */
export function parseActionText(
  actionText: string,
  directory: PerceivableDirectory
): { narrative: string; referencedEntities: ReferencedEntity[] } {
  const { narrative, refsBlock } = splitSections(actionText);
  const refs = parseReferences(refsBlock, actionText);
  const used = collectCitationNumbers(narrative);

  for (const n of used) {
    if (!refs.has(n)) {
      throw new ActionTextFormatError(
        `Citation [${n}] used in narrative but missing from [references] block.`,
        actionText
      );
    }
  }

  const referencedEntities: ReferencedEntity[] = [];
  const seen = new Set<number>();
  // Iterate in narrative-appearance order for stable downstream ordering.
  for (const n of used) {
    if (seen.has(n)) continue;
    seen.add(n);
    const ref = refs.get(n)!;
    referencedEntities.push(resolveRef(n, ref, directory, actionText));
  }

  return { narrative, referencedEntities };
}

function splitSections(actionText: string): {
  narrative: string;
  refsBlock: string;
} {
  const narrIdx = actionText.search(NARRATIVE_HEADER);
  const refsIdx = actionText.search(REFERENCES_HEADER);

  // No fences at all → entire text is narrative.
  if (narrIdx < 0 && refsIdx < 0) {
    return { narrative: actionText.trim(), refsBlock: "" };
  }
  // Only [references] without [narrative] is malformed.
  if (narrIdx < 0 && refsIdx >= 0) {
    throw new ActionTextFormatError(
      "[references] header present without [narrative] header.",
      actionText
    );
  }
  // Slice narrative between [narrative] header and either [references] or EOF.
  const narrEnd =
    narrIdx >= 0 ? actionText.match(NARRATIVE_HEADER)![0].length + narrIdx : 0;
  const narrative =
    refsIdx > narrEnd
      ? actionText.slice(narrEnd, refsIdx).trim()
      : actionText.slice(narrEnd).trim();

  const refsBlock =
    refsIdx >= 0
      ? actionText
          .slice(refsIdx + actionText.match(REFERENCES_HEADER)![0].length)
          .trim()
      : "";

  return { narrative, refsBlock };
}

function parseReferences(
  refsBlock: string,
  actionText: string
): Map<number, ParsedRef> {
  const refs = new Map<number, ParsedRef>();
  if (!refsBlock) return refs;

  for (const raw of refsBlock.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(REF_LINE_REGEX);
    if (!m) {
      throw new ActionTextFormatError(
        `Malformed reference line: "${line}". Expected "[N] id: <entity-id>; kind: character|item|scene".`,
        actionText
      );
    }
    const n = Number.parseInt(m[1], 10);
    if (refs.has(n)) {
      throw new ActionTextFormatError(
        `Duplicate reference number [${n}].`,
        actionText
      );
    }
    refs.set(n, { id: m[2], kind: m[3].toLowerCase() as RefKind });
  }
  return refs;
}

function collectCitationNumbers(narrative: string): number[] {
  const result: number[] = [];
  let match: RegExpExecArray | null;
  NUMBER_CITATION_REGEX.lastIndex = 0;
  while ((match = NUMBER_CITATION_REGEX.exec(narrative)) !== null) {
    result.push(Number.parseInt(match[1], 10));
  }
  return result;
}

function resolveRef(
  n: number,
  ref: ParsedRef,
  directory: PerceivableDirectory,
  actionText: string
): ReferencedEntity {
  const scope =
    ref.kind === "character"
      ? directory.characters
      : ref.kind === "item"
        ? directory.items
        : directory.scenes;
  if (!scope.has(ref.id)) {
    throw new CitationResolutionError(
      `${ref.id} (kind=${ref.kind}, ref [${n}]) — not in perceivable scope`,
      actionText
    );
  }
  return { id: ref.id, kind: ref.kind };
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
- If the action involves giving/receiving items without dialogue, use "item_exchange"
- For routine activities that don't need a die roll, use the umbrellas: "action" (solo/environmental) or "character_interaction" (casual talk / greetings / asking questions / leading someone). See the Definition Selection Priority section below for the skill-vs-umbrella threshold.

## Step granularity — fold trivial beats
Each step you emit becomes a separate resolver call + memory entry. Reserve
steps for beats that genuinely change state. Pure body language — clearing
the throat, glancing, inclining a head, folding hands, leaning on a cane,
"keeping a composed face" — is description, NOT a step. Roll those
gestures into the \`text\` of the surrounding real beat (dialogue,
manipulation, skill use, movement) instead of giving them their own step.

A "real beat" qualifies for its own step when it:
- includes spoken words (a line of dialogue),
- moves the character through space,
- manipulates / examines / uses an item,
- exercises a skill (perception, listen, persuade, brawl, etc.),
- visibly targets another character (intimidate, accuse, hand over, attack).

Prefer fewer, more substantive steps. A two-sentence action like "我清清嗓子，
颔首问对方信封是不是他的" is ONE step (\`character_interaction\` for the
question) with the throat-clear baked into the step text — not two steps.

## Definition Selection Priority — skill defs are for DIFFICULTY, not for description
Skill definitions invoke a die roll. Use them ONLY when failure is a real possibility — when the outcome genuinely depends on whether the character is good enough. Routine activities anyone could complete go to the umbrellas (\`action\`, \`character_interaction\`, \`item_exchange\`).

- "I walk over and pick up the visible letter" → \`action\` (no roll)
- "I search the desk for hidden compartments" → \`perception\` (roll — might miss)
- "I persuade the suspicious guard against orders" → \`persuade\` (roll — might refuse)

Exceptions where a skill IS mandatory even if "easy" in flavor:
1. Physical violence → combat skill (Brawling / Axe / Firearms / etc.), never character_interaction.
2. Manipulative social pressure against resistance → the specific social skill (Persuade / Charm / Intimidate / Bluff), not character_interaction.
3. Medical treatment (handing/applying medicine with intent to treat) → Medicine / First Aid, not Item Exchange.

## Impact Levels (per step)
Each step gets its own impact value determining who perceives it:
- **0**: Private / unnoticed — thinking, reading alone, resting, observing, moving quietly
- **1**: Targeted / one-on-one — whispering, private conversation, discreet item handoff
- **2**: Room-wide — speaking loudly, firing a gun, breaking a door, searching openly
- **3**: Building-wide — fire alarm, shouting down a stairwell, smoke filling the building
- **4**: Neighborhood — explosion, gunshot echoing, building collapse
- **5**: Global — town alarm, summoning ritual, earthquake
Default to 0 unless the step clearly warrants higher. Use each definition's impact hints as guidance.

## Per-Step Text
Each step MUST include a \`text\` field with the **local fragment** of the narrative that belongs to *this step only* — not the whole action.
- Keep wording from the original where possible (you may lightly trim connectors / pronouns so each fragment reads on its own).
- Preserve all \`[N]\` citation markers from the source narrative — drop a citation only if its referent isn't relevant to this step.
- Fragments should partition the action: every meaningful clause appears in exactly one step. Don't repeat the same sentence across steps.
- If the entire action is genuinely a single beat (one step), the \`text\` is the whole narrative.

## Output Format
Respond with ONLY a JSON object:
{
  "steps": [
    { "definitionId": "movement", "impact": 0, "destination": "library", "text": "I walk to the library [1]" },
    { "definitionId": "locksmith", "impact": 1, "text": "and pick the lock on the cabinet [2]" },
    { "definitionId": "perception", "impact": 0, "text": "then search the shelves inside" }
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
          text?: string;
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
          const actionText =
            typeof s.text === "string" && s.text.trim().length > 0
              ? s.text.trim()
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
            actionText,
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
  // Strip [references] block; resolve citations once. The cleaned narrative is
  // what the LLM definition-matcher sees, and what gets stored on ActionStep.
  const { narrative, referencedEntities } = parseActionText(action, directory);

  const systemPrompt = buildInterpreterPrompt(definitions);
  const langInstruction =
    language === "zh"
      ? "The action is in Chinese."
      : "The action is in English.";

  const text = await generateText({
    customSystemPrompt: systemPrompt,
    // The system prompt here is the full action-definition list — identical
    // bytes on every interpreter call, for every NPC, for the whole session,
    // and measured at ~8.9k tokens per call. It is the single largest stable
    // prefix in the pipeline, so it carries the cache breakpoint.
    cacheSystemPrompt: true,
    context: `${langInstruction}\n\nAction: "${narrative}"`,
    modelClass: ModelClass.MEDIUM,
    operation: "game-interpreter",
  });

  const parsed = parseInterpretedResult(text, definitions);
  return {
    steps: parsed.steps.map((s) => ({
      ...s,
      // Prefer the interpreter's per-step fragment; fall back to the full
      // narrative if the LLM omitted `text` for this step.
      actionText: s.actionText ?? narrative,
      referencedEntities,
    })),
  };
}
