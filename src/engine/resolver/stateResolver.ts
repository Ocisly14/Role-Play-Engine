/**
 * StateResolver — LLM call that generates a StateResolution from action context.
 *
 * The resolver reads the action definition's guidanceBody as the primary LLM rules,
 * and uses stateDomains to selectively inject state context and constrain output fields.
 */

import { ModelClass, generateText } from "../../models/index.js";
import type {
  ActionDefinition,
  StateResolution,
  ToolResult,
} from "../types.js";
import type { StateContext } from "./stateContextBuilder.js";

// ===== ResolverContext =====

export interface ResolverContext {
  action: string;
  definition: ActionDefinition;
  outcomeSection: string;
  skillCheckResult?: ToolResult;
  stateContext: StateContext;
  executionContext?: string;
  featureNotes?: string[];
  language?: string;
}

// ===== Skill check formatting =====

function formatSkillCheckResult(result?: ToolResult): string {
  if (!result) return "No skill check — auto success";

  const lines: string[] = [];
  lines.push(
    `Skill roll: ${result.successLevel ?? "unknown"} — ${result.outcomeDescription}`
  );
  if (result.rollDetail) {
    lines.push(`Detail: ${result.rollDetail}`);
  }
  if (result.perTargetResults) {
    lines.push("Opposed results per target:");
    for (const [targetId, r] of Object.entries(result.perTargetResults)) {
      const wonLabel = r.actorWon ? "Actor wins" : "Target resists";
      const damagePart = r.damage != null ? `, damage: ${r.damage}` : "";
      lines.push(`  ${targetId}: ${r.detail} — ${wonLabel}${damagePart}`);
    }
  }
  return lines.join("\n");
}

// ===== Prompt builder =====

export function buildResolverPrompt(ctx: ResolverContext): string {
  const language = ctx.language ?? "en";
  const { definition, stateContext } = ctx;

  // System prompt = definition's guidance body
  const guidance = definition.guidanceBody || definition.content;

  // Build state context sections
  const sections: string[] = [];

  sections.push(`# Action Node`);
  sections.push(`Action: "${ctx.action}"`);
  sections.push("");
  sections.push(formatSkillCheckResult(ctx.skillCheckResult));

  if (ctx.executionContext) {
    sections.push("");
    sections.push(ctx.executionContext);
  }

  if (stateContext.actorSection) {
    sections.push("");
    sections.push(stateContext.actorSection);
  }

  if (stateContext.targetSections) {
    sections.push("");
    sections.push(stateContext.targetSections);
  }

  if (stateContext.sceneSection) {
    sections.push("");
    sections.push(stateContext.sceneSection);
  }

  if (stateContext.itemSection) {
    sections.push("");
    sections.push(stateContext.itemSection);
  }

  if (stateContext.worldStateSection) {
    sections.push("");
    sections.push(stateContext.worldStateSection);
  }

  if (ctx.featureNotes && ctx.featureNotes.length > 0) {
    sections.push("");
    sections.push("## Feature Activation Results");
    sections.push(ctx.featureNotes.join("\n"));
  }

  sections.push("");
  sections.push(`Write all memory and narrative text in ${language}.`);

  const userPrompt = sections.join("\n");

  return `You are a Call of Cthulhu 7th Edition game state resolver.

${guidance}

---

${userPrompt}`;
}

// ===== Parser =====

export function parseStateResolution(raw: string): StateResolution {
  try {
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) ??
      raw.match(/```\s*([\s\S]*?)```/) ?? [null, null];
    const jsonStr =
      jsonMatch[1]?.trim() ?? raw.match(/\{[\s\S]*\}/)?.[0] ?? raw.trim();

    const parsed = JSON.parse(jsonStr);

    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Parsed value is not an object");
    }

    const narrative =
      typeof parsed.narrative === "string" && parsed.narrative.trim()
        ? parsed.narrative
        : typeof parsed.outcome === "string" && parsed.outcome.trim()
          ? parsed.outcome
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
      // Support legacy item resolver output shape
      items: Array.isArray(parsed.items) ? parsed.items : undefined,
      newItems: Array.isArray(parsed.newItems) ? parsed.newItems : undefined,
      // Support legacy interaction resolver output shape
      actorChanges: parsed.actorChanges,
      targetChanges: parsed.targetChanges,
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
      modelClass: ModelClass.MEDIUM,
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
