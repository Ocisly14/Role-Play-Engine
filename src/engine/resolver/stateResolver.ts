/**
 * StateResolver — LLM call that generates a StateResolution from action context.
 *
 * Three exports:
 *   buildResolverPrompt  — builds the system prompt from a ResolverContext
 *   parseStateResolution — parses raw LLM output to StateResolution
 *   resolveState         — async, makes the LLM call and returns StateResolution
 */

import { ModelClass, generateText } from "../../models/index.js";
import type { StateResolution, ToolResult } from "../types.js";

// ===== ResolverContext =====

export interface ResolverContext {
  action: string;
  definitionContent: string; // relevant "On Success" or "On Failure" section from md
  skillCheckResult?: ToolResult; // from skillCheckTool (Task 3)
  actorState: any; // NPC state object
  targetStates?: any[]; // target NPC states for interactions
  sceneState: any; // scene object
  featureContext?: string; // world state from features
  language?: string;
}

// ===== Prompt builder =====

export function buildResolverPrompt(ctx: ResolverContext): string {
  const language = ctx.language ?? "en";

  // Summarise the skill check result
  let skillSection = "No skill check — auto success.";
  if (ctx.skillCheckResult) {
    const r = ctx.skillCheckResult;
    const statusLine = `Status: ${r.status}`;
    const levelLine = r.successLevel ? `Success level: ${r.successLevel}` : "";
    const detailLine = r.outcomeDescription
      ? `Outcome: ${r.outcomeDescription}`
      : "";
    skillSection = [statusLine, levelLine, detailLine]
      .filter(Boolean)
      .join("\n");
  }

  // Actor section
  const actorSection = ctx.actorState
    ? `## Actor\n${JSON.stringify(ctx.actorState, null, 2)}`
    : "## Actor\n(not provided)";

  // Targets section
  const targetsSection =
    ctx.targetStates && ctx.targetStates.length > 0
      ? `## Targets\n${JSON.stringify(ctx.targetStates, null, 2)}`
      : "";

  // Scene section
  const sceneSection = ctx.sceneState
    ? `## Scene\n${JSON.stringify(ctx.sceneState, null, 2)}`
    : "## Scene\n(not provided)";

  // Feature context
  const featureSection = ctx.featureContext
    ? `## World State\n${ctx.featureContext}`
    : "";

  return `You are a Call of Cthulhu 7th Edition game state resolver.
Given a completed action with its definition guidance and skill check result, produce a structured StateResolution describing the concrete changes to the world.

## Action
${ctx.action}

## Definition Guidance
${ctx.definitionContent}

## Skill Check Result
${skillSection}

${actorSection}

${targetsSection ? `${targetsSection}\n\n` : ""}${sceneSection}

${featureSection ? `${featureSection}\n\n` : ""}## Rules
- Follow the definition guidance (On Success / On Failure sections) for what changes should occur.
- Apply HP and SAN as deltas (negative = loss). Only apply what the definition specifies.
- Conditions: use short English labels like "bleeding", "unconscious".
- Position: provide a CharacterPosition object only when the character is physically relocated.
- Scene conditions: addConditions / removeConditions use plain string descriptions.
- Item changes: use "move", "destroy", "create", or "modify".
  - For "move": "from" and "to" are either a NPC id or "scene:<sceneId>".
  - For "create": "to" is the destination, "properties" contains the item fields.
  - For "modify": "properties" contains the fields to update.
- narrative: required. Write a 1-3 sentence description of what happened. Write in ${language}.
- Only include fields that have meaningful values. Omit fields with no change.

## Output Format
Return a single JSON object matching the StateResolution schema. No extra text.

\`\`\`json
{
  "characterChanges": [
    {
      "characterId": "npc_id",
      "hp": -3,
      "san": -1,
      "fatigue": 1,
      "addConditions": ["bleeding"],
      "removeConditions": ["frightened"],
      "position": { "type": "scene", "sceneId": "scene_id" }
    }
  ],
  "sceneChanges": [
    {
      "sceneId": "scene_id",
      "addConditions": ["door is barricaded"],
      "removeConditions": ["door is open"]
    }
  ],
  "itemChanges": [
    { "itemId": "item_id", "action": "move", "from": "npc_actor_id", "to": "scene:scene_id" }
  ],
  "memories": [
    { "characterId": "npc_id", "type": "event", "content": "first-person memory" }
  ],
  "relationships": [
    { "from": "npc_a", "to": "npc_b", "change": "hostile after attack" }
  ],
  "narrative": "description of what happened (REQUIRED, write in ${language})"
}
\`\`\``;
}

// ===== Parser =====

export function parseStateResolution(raw: string): StateResolution {
  try {
    // Extract JSON block — handle ```json fences or bare JSON
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) ??
      raw.match(/```\s*([\s\S]*?)```/) ?? [null, null];
    const jsonStr = jsonMatch[1]?.trim() ?? raw.trim();

    const parsed = JSON.parse(jsonStr);

    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Parsed value is not an object");
    }

    // narrative is required
    const narrative =
      typeof parsed.narrative === "string" && parsed.narrative.trim()
        ? parsed.narrative
        : "The action resolved without further detail.";

    return {
      characterChanges: Array.isArray(parsed.characterChanges)
        ? parsed.characterChanges
        : undefined,
      itemChanges: Array.isArray(parsed.itemChanges)
        ? parsed.itemChanges
        : undefined,
      sceneChanges: Array.isArray(parsed.sceneChanges)
        ? parsed.sceneChanges
        : undefined,
      memories: Array.isArray(parsed.memories) ? parsed.memories : undefined,
      relationships: Array.isArray(parsed.relationships)
        ? parsed.relationships
        : undefined,
      featureOverlays:
        parsed.featureOverlays !== null &&
        typeof parsed.featureOverlays === "object"
          ? parsed.featureOverlays
          : undefined,
      narrative,
    };
  } catch {
    return {
      narrative: "The action resolved without further detail.",
    };
  }
}

// ===== Async LLM call =====

export async function resolveState(
  ctx: ResolverContext,
  runtime: any
): Promise<StateResolution> {
  const prompt = buildResolverPrompt(ctx);

  try {
    const text = await generateText({
      runtime,
      customSystemPrompt: prompt,
      context: "",
      modelClass: ModelClass.SMALL,
      operation: "state-resolver",
    });

    return parseStateResolution(text);
  } catch (error) {
    console.warn(
      "[StateResolver] LLM call failed, returning minimal resolution:",
      error instanceof Error ? error.message : error
    );
    return {
      narrative: `${ctx.action} resolved.`,
    };
  }
}
