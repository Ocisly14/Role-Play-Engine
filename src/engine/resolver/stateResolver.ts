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
import {
  formatOutputSchemaPrompt,
  RESOLVER_STATIC_SYSTEM_PROMPT,
} from "./schemaBuilder.js";
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

  // Definition-specific guidance body (CoC skill rulebook text).
  const guidance = definition.guidanceBody || definition.content;

  // Definition-specific output schema section (allowed fields, duration,
  // required-on-success/failure).
  let schemaSection = "";
  if (definition.outputSchema) {
    const skillSucceeded =
      !ctx.skillCheckResult || ctx.skillCheckResult.status === "completed";
    schemaSection = formatOutputSchemaPrompt(definition.outputSchema, {
      skillSucceeded,
    });
  }

  // Per-request state context + action text.
  const requestSections: string[] = [];
  requestSections.push("# Action Node");
  requestSections.push(`Action: "${ctx.action}"`);
  requestSections.push("");
  requestSections.push(formatSkillCheckResult(ctx.skillCheckResult));

  if (ctx.executionContext) {
    requestSections.push("");
    requestSections.push(ctx.executionContext);
  }

  if (stateContext.actorSection) {
    requestSections.push("");
    requestSections.push(stateContext.actorSection);
  }

  if (stateContext.targetSections) {
    requestSections.push("");
    requestSections.push(stateContext.targetSections);
  }

  if (stateContext.sceneSection) {
    requestSections.push("");
    requestSections.push(stateContext.sceneSection);
  }

  if (stateContext.itemSection) {
    requestSections.push("");
    requestSections.push(stateContext.itemSection);
  }

  if (stateContext.worldStateSection) {
    requestSections.push("");
    requestSections.push(stateContext.worldStateSection);
  }

  if (ctx.featureNotes && ctx.featureNotes.length > 0) {
    requestSections.push("");
    requestSections.push("## Feature Activation Results");
    requestSections.push(ctx.featureNotes.join("\n"));
  }

  requestSections.push("");
  requestSections.push(
    `Write all memory text in ${language}. Respond ONLY with the JSON object, no other text.`
  );

  // Assembly order is cache-friendly: static prefix → per-definition middle
  // → per-request tail. Prompt caching benefits grow as more calls reuse the
  // same definition (e.g., many perception rolls within one session).
  return [
    RESOLVER_STATIC_SYSTEM_PROMPT,
    "---",
    "",
    "# Definition Guidance",
    "",
    guidance,
    schemaSection ? "" : null,
    schemaSection || null,
    "",
    "---",
    "",
    requestSections.join("\n"),
  ]
    .filter((s) => s !== null)
    .join("\n");
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

/**
 * Meta fields the resolver emits that are NOT state changes.
 * `elapsedMinutes` is universally required alongside `memory.event` and
 * carries the semantic duration of the action — the tick layer consumes it.
 */
const RESOLVER_META_KEYS = ["elapsedMinutes"] as const;

function getAllowedResolutionKeys(config: OutputSchemaConfig): Set<string> {
  const allowed = new Set<string>(resolveOutputSchemaTypeIds(config));
  if (config.custom) {
    for (const key of Object.keys(config.custom)) {
      allowed.add(key);
    }
  }
  for (const metaKey of RESOLVER_META_KEYS) {
    allowed.add(metaKey);
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
