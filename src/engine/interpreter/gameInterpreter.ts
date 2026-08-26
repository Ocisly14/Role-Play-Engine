import { ModelClass, generateToolCalls } from "../../models/index.js";
import type { ToolSpec } from "../../models/providers/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
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

// Headers are matched at line start but do NOT require the rest of the line
// to be empty: models frequently emit `[narrative]I walk...` inline, and
// rejecting that wastes the whole decision.
const NARRATIVE_HEADER = /^[ \t]*\[narrative\][ \t]*\r?\n?/im;
const REFERENCES_HEADER = /^[ \t]*\[references\][ \t]*\r?\n?/im;
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
  const normalized = normalizeEscapedNewlines(actionText);
  const { narrative, refsBlock } = splitSections(normalized);
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

/**
 * Models occasionally double-escape newlines inside the tool-call JSON, so
 * the actionText arrives as one line containing literal `\n` sequences. When
 * the text has no real newline but does contain escaped ones, decode them —
 * otherwise the section headers never match and the whole decision is lost.
 */
function normalizeEscapedNewlines(text: string): string {
  if (text.includes("\n") || !text.includes("\\n")) return text;
  return text.replace(/\\r\\n|\\n/g, "\n");
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

/** A movement destination candidate surfaced to the interpreter LLM. The
 *  id must be resolvable by `resolveTargetPosition` (scenario outline id,
 *  topology scene id, junction id, or road id). */
export interface KnownLocation {
  id: string;
  name: string;
  kind: "building" | "scene" | "junction" | "road";
}

/** Collect every location the movement subsystem can path to, for the
 *  interpreter's Known Locations list. Pure over plain collections so it is
 *  trivially testable; SimulationRunner adapts from DGSM state. */
export function collectKnownLocations(input: {
  scenarioOutlines?: ReadonlyArray<{ id: string; name: string }>;
  scenes?: ReadonlyMap<string, { name?: string }>;
  junctions?: ReadonlyMap<string, { name?: string }>;
  roads?: ReadonlyMap<string, { name?: string }>;
}): KnownLocation[] {
  const out: KnownLocation[] = [];
  const seen = new Set<string>();
  const push = (
    id: string,
    name: string | undefined,
    kind: KnownLocation["kind"]
  ) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, name: name?.trim() || id, kind });
  };
  for (const o of input.scenarioOutlines ?? []) push(o.id, o.name, "building");
  for (const [id, s] of input.scenes ?? []) push(id, s.name, "scene");
  for (const [id, j] of input.junctions ?? []) push(id, j.name, "junction");
  for (const [id, r] of input.roads ?? []) push(id, r.name, "road");
  return out;
}

/** The actor's current location, rendered into the interpreter's user turn
 *  so it can tell "walking to the desk here" from "traveling elsewhere".
 *  Observed live without it: an in-room "走回办公桌" classified as movement
 *  and fuzzy-matched to a room named 办公室 in a different building — the
 *  actor was silently teleported across town. */
export interface CurrentLocation {
  id: string;
  name: string;
}

export function currentLocationOf(
  dgsm: DynamicGameStateManager,
  characterId: string
): CurrentLocation | undefined {
  const pos = dgsm.getCharacterPosition(characterId);
  if (!pos) return undefined;
  const id = dgsm.resolveLocationId(pos);
  const topology = dgsm.getTopology();
  const name =
    dgsm.getState().scenes.get(id)?.name ??
    topology.junctions.get(id)?.name ??
    topology.roads.get(id)?.name ??
    id;
  return { id, name };
}

function formatKnownLocations(locations: KnownLocation[]): string {
  const lines = locations.map((l) => `- ${l.id} — ${l.name} (${l.kind})`);
  return `## Known Locations (movement destinations)
For \`movement\` steps, \`destination\` MUST be one of the location ids below — output the id, never the display name. Pick the id whose name best matches where the narrative is heading (the narrative may use another language or an informal name for it). If no listed location plausibly matches, do NOT emit a movement step — classify that clause as \`action\` instead.

The request states the actor's CURRENT location. Movement means LEAVING it for a different listed place:
- Motion toward furniture, objects, or people at the current location ("走到桌前", "step closer") is NOT movement — fold it into the surrounding beat.
- Never output the current location's id as a destination.
- Pick a destination in a different building only when the narrative clearly says the actor is going there. Sharing a generic word with a room's name (e.g. "办公桌" vs a room called "办公室") is NOT a match — when unsure, classify the clause as \`action\`.
${lines.join("\n")}`;
}

export function buildInterpreterPrompt(
  definitions: ActionDefinition[],
  knownLocations?: KnownLocation[]
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
  const locationsSection =
    knownLocations && knownLocations.length > 0
      ? `\n${formatKnownLocations(knownLocations)}\n`
      : "";

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

${locationsSection}## Output Format
Call the \`interpret_action\` tool with the ordered steps, e.g.
  steps: [
    { definitionId: "movement", impact: 0, destination: "SCN_2", text: "I walk to the library [1]" },
    { definitionId: "locksmith", impact: 1, text: "and pick the lock on the cabinet [2]" },
    { definitionId: "perception", impact: 0, text: "then search the shelves inside" }
  ]`;
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
    return enrichInterpretedSteps(JSON.parse(jsonMatch[0]), definitions);
  } catch {
    const { engine, codeSubsystem } = enrich("generic");
    return {
      steps: [{ definitionId: "generic", impact: 0, engine, codeSubsystem }],
    };
  }
}

/**
 * Turns the model's raw `{steps:[...]}` object into InterpretedSteps, filling
 * in engine routing and clamping impact. Shared by the native tool-call path
 * and the legacy text path.
 */
export function enrichInterpretedSteps(
  parsed: { steps?: unknown },
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

/**
 * Mirrors the "Output Format" section of the prompt above. Not `strict`:
 * `destination` only applies to movement steps, and OpenAI's strict mode
 * would demand it on every step.
 */
export const INTERPRET_ACTION_TOOL: ToolSpec = {
  name: "interpret_action",
  description:
    "Return the ordered steps this action decomposes into. See the system prompt for definition selection, step granularity, impact levels and per-step text rules.",
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            definitionId: {
              type: "string",
              description: "id of one of the available definitions",
            },
            impact: {
              type: "integer",
              minimum: 0,
              maximum: 5,
              description:
                "0 private, 1 targeted, 2 same scene, 3 macro location, 4 neighborhood, 5 global",
            },
            destination: {
              type: "string",
              description:
                "Movement steps only: a location id chosen from the Known Locations list in the system prompt (the id, never the display name).",
            },
            text: {
              type: "string",
              description:
                "The fragment of the narrative belonging to this step, preserving its [N] citation markers.",
            },
          },
          required: ["definitionId", "impact"],
          additionalProperties: false,
        },
      },
    },
    required: ["steps"],
    additionalProperties: false,
  },
};

export async function interpretAction(
  action: string,
  definitions: ActionDefinition[],
  language: string,
  directory: PerceivableDirectory,
  knownLocations?: KnownLocation[],
  currentLocation?: CurrentLocation
): Promise<InterpretedResult> {
  // Strip [references] block; resolve citations once. The cleaned narrative is
  // what the LLM definition-matcher sees, and what gets stored on ActionStep.
  const { narrative, referencedEntities } = parseActionText(action, directory);

  const systemPrompt = buildInterpreterPrompt(definitions, knownLocations);
  const langInstruction =
    language === "zh"
      ? "The action is in Chinese."
      : "The action is in English.";
  // Varies per call, so it lives in the user turn — the system prompt is the
  // pipeline's largest cached prefix and must stay byte-stable.
  const locationLine = currentLocation
    ? `\nActor's current location: ${currentLocation.id} — ${currentLocation.name}\n`
    : "";

  const call = await generateToolCalls({
    customSystemPrompt: systemPrompt,
    // The system prompt here is the full action-definition list — identical
    // bytes on every interpreter call, for every NPC, for the whole session,
    // and measured at ~8.9k tokens per call. It is the single largest stable
    // prefix in the pipeline, so it carries the cache breakpoint.
    cacheSystemPrompt: true,
    messages: [
      {
        role: "user",
        content: [
          {
            kind: "text",
            text: `${langInstruction}\n${locationLine}\nAction: "${narrative}"`,
          },
        ],
      },
    ],
    tools: [INTERPRET_ACTION_TOOL],
    // One tool, forced by name: this is a fixed-schema structured output
    // expressed through the tool mechanism, not a choice the model makes.
    toolChoice: { name: INTERPRET_ACTION_TOOL.name },
    modelClass: ModelClass.MEDIUM,
    operation: "game-interpreter",
  });

  const parsed = enrichInterpretedSteps(
    call.toolCalls[0].args as { steps?: unknown },
    definitions
  );
  sanitizeMovementSteps(parsed.steps, {
    knownLocationIds: knownLocations
      ? new Set(knownLocations.map((l) => l.id))
      : undefined,
    currentLocationId: currentLocation?.id,
  });
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

/** Mechanical backstop for the prompt rules above.
 *
 *  - destination == the actor's current location → downgrade to `action`:
 *    an in-place beat, not travel — there is no failure to report.
 *  - destination missing or absent from the Known Locations list (the model
 *    echoed a display name, invented an id, or misspelled one) → the step is
 *    deliberately KEPT as movement: it fails fast at movement activation,
 *    which hands the character a "couldn't work out where that is" memory so
 *    THEY re-decide with feedback. Downgrading here would narrate a beat
 *    that hides the failure from the character. We only log for
 *    observability.
 *
 *  Checks are skipped for whichever input the caller could not provide. */
export function sanitizeMovementSteps(
  steps: InterpretedResult["steps"],
  opts: {
    knownLocationIds?: ReadonlySet<string>;
    currentLocationId?: string;
  }
): void {
  for (const step of steps) {
    if (step.codeSubsystem !== "movement") continue;
    const dest = step.overlayFields?.destination;
    // "ROAD_X@0.3" carries an explicit road position — membership is checked
    // on the base id, matching resolveTargetPosition's parsing.
    const baseId =
      typeof dest === "string" && dest.length > 0
        ? dest.split("@")[0]
        : undefined;
    if (
      opts.currentLocationId !== undefined &&
      baseId === opts.currentLocationId
    ) {
      step.definitionId = "action";
      step.engine = "llm";
      step.codeSubsystem = undefined;
      step.overlayFields = undefined;
      continue;
    }
    if (
      opts.knownLocationIds !== undefined &&
      (!baseId || !opts.knownLocationIds.has(baseId))
    ) {
      console.warn(
        `[interpreter] movement destination ${
          typeof dest === "string" ? `"${dest}"` : "(missing)"
        } is not a known location — the move will fail fast and the character will be told`
      );
    }
  }
}
