/**
 * StateResolver — LLM call that generates structured state changes from action context.
 *
 * The resolver reads the action definition's guidanceBody as the primary LLM rules,
 * and uses the definition's outputSchema to constrain output fields.
 */

import { ModelClass, generateText } from "../../models/index.js";
import { resolveOutputSchemaTypeIds } from "../outputSchema.js";
import type {
  ActionDefinition,
  OutputSchemaConfig,
  ToolResult,
} from "../types.js";
import { formatOutputSchemaPrompt } from "./schemaBuilder.js";
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

  sections.push("# Action Node");
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

  if (definition.outputSchema) {
    sections.push("");
    sections.push(formatOutputSchemaPrompt(definition.outputSchema));
  }

  sections.push("");
  sections.push(
    `Write all memory text in ${language}. Respond ONLY with the JSON object, no other text.`
  );

  const userPrompt = sections.join("\n");

  return `You are a Call of Cthulhu 7th Edition game state resolver. You output structured state changes only — no narrative, no prose.

${guidance}

---

${userPrompt}`;
}

// ===== Parser =====

export function parseStateResolution(raw: string): Record<string, any> {
  try {
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) ??
      raw.match(/```\s*([\s\S]*?)```/) ?? [null, null];
    const jsonStr =
      jsonMatch[1]?.trim() ?? raw.match(/\{[\s\S]*\}/)?.[0] ?? raw.trim();
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed;
  } catch {
    return {};
  }
}

// ===== Validation =====

export function validateResolution(
  resolution: Record<string, any>,
  config: OutputSchemaConfig
): boolean {
  const allowed = getAllowedResolutionKeys(config);
  for (const key of Object.keys(resolution)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function getAllowedResolutionKeys(config: OutputSchemaConfig): Set<string> {
  const allowed = new Set<string>(resolveOutputSchemaTypeIds(config));
  if (config.custom) {
    for (const key of Object.keys(config.custom)) {
      allowed.add(key);
    }
  }
  return allowed;
}

// ===== Async LLM call =====

export async function resolveState(
  ctx: ResolverContext,
  runtime: any
): Promise<Record<string, any>> {
  const prompt = buildResolverPrompt(ctx);

  try {
    const text = await generateText({
      runtime,
      customSystemPrompt: prompt,
      context: "",
      modelClass: ModelClass.MEDIUM,
      operation: "state-resolver",
    });

    const resolution = parseStateResolution(text);

    if (ctx.definition.outputSchema) {
      if (!validateResolution(resolution, ctx.definition.outputSchema)) {
        const allowed = getAllowedResolutionKeys(ctx.definition.outputSchema);
        for (const key of Object.keys(resolution)) {
          if (!allowed.has(key)) delete resolution[key];
        }
      }
    }

    return resolution;
  } catch (error) {
    console.warn(
      "[StateResolver] LLM call failed, returning empty resolution:",
      error instanceof Error ? error.message : error
    );
    return {};
  }
}
