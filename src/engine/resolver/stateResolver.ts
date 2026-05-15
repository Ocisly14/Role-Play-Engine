/**
 * StateResolver — LLM call that generates structured state changes from action context.
 *
 * The resolver reads the action definition's guidanceBody as the primary LLM rules,
 * and uses the definition's outputSchema to constrain output fields.
 */

import { ModelClass, generateText } from "../../models/index.js";
import type { StateChange } from "../core/types.js";
import { resolveOutputSchemaTypeIds } from "../outputSchema.js";
import type {
  ActionDefinition,
  OutputSchemaConfig,
  ToolResult,
} from "../types.js";
import {
  RESOLVER_STATIC_SYSTEM_PROMPT,
  formatOutputSchemaPrompt,
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

export interface ResolvedOutcome {
  stateChanges: StateChange[];
  elapsedMinutes: number;
}

/** Convert the resolver's flat dict
 *  (`{"memory.event":[...], "item.modify":[...], "elapsedMinutes":N}`) into
 *  the engine's typed `StateChange[]` discriminated union. Performs three
 *  jobs: (1) skip meta keys (`elapsedMinutes`), (2) flatten typeId→array
 *  entries into individually-tagged `{kind, ...}` records, (3) normalize
 *  resolver-batched / resolver-shaped kinds into engine-atomic forms so the
 *  Applier's `switch (c.kind)` dispatches cleanly without a second translation
 *  layer. */
function flattenToStateChanges(
  resolution: Record<string, any>
): StateChange[] {
  const out: StateChange[] = [];
  for (const [typeId, value] of Object.entries(resolution)) {
    if ((RESOLVER_META_KEYS as readonly string[]).includes(typeId)) continue;
    if (!Array.isArray(value)) continue;
    for (const obj of value) {
      if (!obj || typeof obj !== "object") continue;
      const records = normalizeResolverEntry(typeId, obj);
      out.push(...records);
    }
  }
  return out;
}

/** Normalize one resolver-shaped entry into one or more engine-atomic
 *  `StateChange` records. Returns [] for shapes the engine doesn't accept
 *  (silently dropped — the validation pass that runs before this already
 *  drops unauthorized kinds, so reaching this point with a bad shape is a
 *  resolver-LLM bug, not a contract concern).
 *
 *  Conversions:
 *  - `scene.condition {sceneId, add[], remove[]}` → multiple
 *    `scene.addCondition` + `scene.removeCondition` records.
 *  - `character.condition {characterId, add[], remove[]}` → multiple
 *    `character.addCondition` + `character.removeCondition`.
 *  - `character.position {characterId, sceneId, junction?}` → atomic with
 *    typed `CharacterPosition` payload.
 *  Pass-through (already engine-atomic): item.modify/create/move/destroy,
 *  memory.event/witness, relationship.change, character.hp/san/fatigue. */
function normalizeResolverEntry(
  typeId: string,
  obj: Record<string, any>
): StateChange[] {
  switch (typeId) {
    case "scene.condition": {
      const sceneId = String(obj.sceneId ?? "");
      if (!sceneId) return [];
      const out: StateChange[] = [];
      for (const desc of (obj.add as unknown[]) ?? []) {
        if (typeof desc !== "string" || !desc.trim()) continue;
        out.push({
          kind: "scene.addCondition",
          sceneId,
          condition: { description: desc },
        });
      }
      for (const desc of (obj.remove as unknown[]) ?? []) {
        if (typeof desc !== "string" || !desc.trim()) continue;
        // The engine's removeCondition takes a featureId predicate, but
        // resolver-emitted removals only carry a description. Use it as the
        // featureId so `appendSceneCondition({description})` writes match
        // `removeSceneConditionsByFeatureId(description)` reads.
        out.push({
          kind: "scene.removeCondition",
          sceneId,
          predicate: { featureId: desc },
        });
      }
      return out;
    }

    case "character.condition": {
      const characterId = String(obj.characterId ?? "");
      if (!characterId) return [];
      const out: StateChange[] = [];
      for (const desc of (obj.add as unknown[]) ?? []) {
        if (typeof desc !== "string" || !desc.trim()) continue;
        out.push({
          kind: "character.addCondition",
          characterId,
          condition: {
            id: `${characterId}:${desc}:${Date.now()}`,
            description: desc,
          },
        });
      }
      for (const condId of (obj.remove as unknown[]) ?? []) {
        if (typeof condId !== "string" || !condId.trim()) continue;
        out.push({
          kind: "character.removeCondition",
          characterId,
          conditionId: condId,
        });
      }
      return out;
    }

    case "character.position": {
      const characterId = String(obj.characterId ?? "");
      const sceneId = String(obj.sceneId ?? "");
      if (!characterId || !sceneId) return [];
      const junction =
        typeof obj.junction === "string" && obj.junction
          ? obj.junction
          : undefined;
      const position = junction
        ? ({ type: "junction" as const, junctionId: junction })
        : ({ type: "scene" as const, sceneId });
      return [
        {
          kind: "character.position",
          characterId,
          position,
          sourceSubsystem: "resolver",
        },
      ];
    }

    default:
      // Engine-atomic kinds (item.modify, memory.event, relationship.change,
      // character.hp/san/fatigue, etc.) pass through. The cast narrows the
      // tagged record to a member of StateChange — TypeScript can't prove
      // shape correctness from runtime data, so the union acts as the
      // contract instead.
      return [{ kind: typeId, ...obj } as StateChange];
  }
}

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
  ctx: ResolverContext
): Promise<ResolvedOutcome> {
  const prompt = buildResolverPrompt(ctx);

  let raw: Record<string, any> = {};
  try {
    const text = await generateText({
      customSystemPrompt: prompt,
      context: "",
      modelClass: ModelClass.MEDIUM,
      operation: "state-resolver",
    });
    raw = parseStateResolution(text);
  } catch (error) {
    console.warn(
      "[StateResolver] LLM call failed, returning empty resolution:",
      error instanceof Error ? error.message : error
    );
    raw = {};
  }

  if (ctx.definition.outputSchema) {
    if (!validateResolution(raw, ctx.definition.outputSchema)) {
      const allowed = getAllowedResolutionKeys(ctx.definition.outputSchema);
      for (const key of Object.keys(raw)) {
        if (!allowed.has(key)) delete raw[key];
      }
    }
  }

  const elapsedMinutes =
    typeof raw.elapsedMinutes === "number" && raw.elapsedMinutes >= 0
      ? raw.elapsedMinutes
      : 0;
  const stateChanges = flattenToStateChanges(raw);
  return { stateChanges, elapsedMinutes };
}
