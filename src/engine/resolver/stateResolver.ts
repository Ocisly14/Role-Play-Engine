/**
 * StateResolver — LLM call that generates structured state changes from action context.
 *
 * The resolver reads the action definition's guidanceBody as the primary LLM rules,
 * and uses the definition's outputSchema to constrain output fields.
 */

import { ModelClass, generateToolCalls } from "../../models/index.js";
import type { ToolSpec } from "../../models/providers/types.js";
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
import type { ResolverValidRefs, StateContext } from "./stateContextBuilder.js";

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

/** Resolver prompt split into its cacheable prefix and its per-request tail. */
export interface ResolverPromptParts {
  /** Static rules + definition guidance + output schema. Stable per
   *  (definition, skillSucceeded) — carries the cache breakpoint. */
  stable: string;
  /** Action text, skill-check verdict, world state, feature notes, language
   *  instruction. Different on every call. */
  request: string;
}

export function buildResolverPrompt(ctx: ResolverContext): ResolverPromptParts {
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

  // Split at the stability boundary: everything up to and including the
  // definition's schema section is fixed for a given (definition,
  // skillSucceeded) pair and goes in the system prompt, where it carries a
  // cache breakpoint. The per-request tail (action text, dice result, world
  // state) goes in the user turn, after the breakpoint, so it never
  // invalidates the cached prefix.
  const stable = [
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
  ]
    .filter((s) => s !== null)
    .join("\n");

  return { stable, request: requestSections.join("\n") };
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
function flattenToStateChanges(resolution: Record<string, any>): StateChange[] {
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
        ? { type: "junction" as const, junctionId: junction }
        : { type: "scene" as const, sceneId };
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

// ===== Reference validation =====
//
// The resolver's ids come from an LLM. Observed live: `item.destroy` citing a
// staged scene condition's featureId as an itemId, `relationship.change` /
// `memory.witness` naming invented characters ("witness", "unknown_target"),
// and `item.move` handing an item to a holder that does not exist (DGSM
// auto-creates an inventory for ANY string, so that fabrication would
// silently stick). The Applier drops what it can at commit time, but by then
// the resolver call is long gone — so validate here, immediately after the
// LLM output, and give the model ONE corrective retry with the errors spelled
// out. Whatever is still invalid after the retry is dropped (the Applier's
// own guard remains as the last line of defense).

/** Human-readable violations in one state change; empty = clean. */
export function invalidRefsOf(
  c: StateChange,
  refs: ResolverValidRefs
): string[] {
  const errs: string[] = [];
  const chr = (id: string, field: string) => {
    if (!refs.characterIds.has(id))
      errs.push(`${field} "${id}" is not a real character`);
  };
  const itm = (id: string) => {
    if (!refs.itemIds.has(id)) errs.push(`itemId "${id}" is not a real item`);
  };
  const scn = (id: string, field: string) => {
    if (!refs.sceneIds.has(id))
      errs.push(`${field} "${id}" is not a real scene`);
  };
  switch (c.kind) {
    case "character.hp":
    case "character.san":
    case "character.fatigue":
    case "character.addCondition":
    case "character.removeCondition":
    case "memory.event":
    case "memory.witness":
      chr(c.characterId, "characterId");
      break;
    case "character.position":
      chr(c.characterId, "characterId");
      if (c.position.type === "scene") scn(c.position.sceneId, "sceneId");
      else if (
        c.position.type === "junction" &&
        !refs.junctionIds.has(c.position.junctionId)
      )
        errs.push(`junctionId "${c.position.junctionId}" is not real`);
      break;
    case "relationship.change": {
      const rel = c as unknown as { fromId: string; toId: string };
      chr(rel.fromId, "fromId");
      chr(rel.toId, "toId");
      break;
    }
    case "item.modify":
    case "item.destroy":
      itm(c.itemId);
      break;
    case "item.move":
      itm(c.itemId);
      if (c.to.startsWith("scene:")) scn(c.to.slice("scene:".length), "to");
      else chr(c.to, "to");
      break;
    case "item.create":
      scn(c.location, "location");
      break;
    case "scene.addCondition":
    case "scene.removeCondition":
      scn(c.sceneId, "sceneId");
      break;
    default:
      // Subsystem-only kinds the resolver does not emit.
      break;
  }
  return errs;
}

function buildRefErrorFeedback(
  bad: Array<{ change: StateChange; errors: string[] }>,
  refs: ResolverValidRefs,
  previousRaw: Record<string, any>
): string {
  const list = (ids: Set<string>, cap = 60): string =>
    [...ids].slice(0, cap).join(", ") || "(none)";
  return [
    "# Previous Attempt — REJECTED",
    "",
    "Your previous resolution was:",
    "```json",
    JSON.stringify(previousRaw),
    "```",
    "",
    "It referenced entities that DO NOT EXIST:",
    ...bad.map((b) => `- ${b.change.kind}: ${b.errors.join("; ")}`),
    "",
    "The world contains ONLY these entities — ids must be copied verbatim:",
    `- Characters: ${list(refs.characterIds)}`,
    `- Items: ${list(refs.itemIds)}`,
    `- Current scene: ${refs.executionSceneId}`,
    "",
    "Re-emit the COMPLETE corrected resolution: keep every valid change,",
    "and for each rejected change either re-express it with real ids or",
    "omit it entirely. NEVER invent characters, items, or scenes.",
  ].join("\n");
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

/**
 * Builds the resolver's tool schema for one definition.
 *
 * The allowed top-level keys vary per definition (that is what
 * `getAllowedResolutionKeys` computes), so the schema is built per call. The
 * value shapes are left open — the individual state-change kinds are many and
 * loosely typed, and `validateResolution` already polices them downstream.
 * The win here is the envelope: a guaranteed, well-formed JSON object with no
 * text parsing.
 *
 * Not `strict`: the resolver is explicitly told to omit keys with no changes,
 * and OpenAI's strict mode would require every declared key on every call.
 *
 * Tool definitions render ahead of the system prompt, so this varying schema
 * sits inside the cached prefix — at the same per-definition granularity the
 * system prompt already had, so cache behaviour is unchanged.
 */
function buildResolverTool(ctx: ResolverContext): ToolSpec {
  const properties: Record<string, unknown> = {
    elapsedMinutes: {
      type: "number",
      description: "In-world minutes this action consumed.",
    },
  };

  const allowed = ctx.definition.outputSchema
    ? getAllowedResolutionKeys(ctx.definition.outputSchema)
    : null;

  if (allowed) {
    for (const key of allowed) {
      if (key === "elapsedMinutes") continue;
      properties[key] = {
        type: "array",
        items: { type: "object", additionalProperties: true },
      };
    }
  }

  return {
    name: "resolve_state",
    description:
      "Emit the state changes this action produces. Use only the fields declared for this action; omit any field with no changes.",
    inputSchema: {
      type: "object",
      properties,
      required: [],
      // A definition without an outputSchema declares no key set, so anything
      // the model emits has to be accepted and filtered downstream.
      additionalProperties: allowed === null,
    },
  };
}

// ===== Async LLM call =====

export async function resolveState(
  ctx: ResolverContext
): Promise<ResolvedOutcome> {
  const { stable, request } = buildResolverPrompt(ctx);
  const tools = [buildResolverTool(ctx)];

  const callOnce = async (userText: string): Promise<Record<string, any>> => {
    try {
      const call = await generateToolCalls({
        customSystemPrompt: stable,
        cacheSystemPrompt: true,
        messages: [
          { role: "user", content: [{ kind: "text", text: userText }] },
        ],
        tools,
        toolChoice: { name: "resolve_state" },
        modelClass: ModelClass.MEDIUM,
        operation: "state-resolver",
      });
      return call.toolCalls[0].args as Record<string, any>;
    } catch (error) {
      console.warn(
        "[StateResolver] LLM call failed, returning empty resolution:",
        error instanceof Error ? error.message : error
      );
      return {};
    }
  };

  const filterAllowedKeys = (raw: Record<string, any>): Record<string, any> => {
    if (
      ctx.definition.outputSchema &&
      !validateResolution(raw, ctx.definition.outputSchema)
    ) {
      const allowed = getAllowedResolutionKeys(ctx.definition.outputSchema);
      for (const key of Object.keys(raw)) {
        if (!allowed.has(key)) delete raw[key];
      }
    }
    return raw;
  };

  let raw = filterAllowedKeys(await callOnce(request));
  let stateChanges = flattenToStateChanges(raw);

  // Reference validation + one corrective retry with the errors spelled out.
  const refs = ctx.stateContext.validRefs;
  if (refs) {
    const bad = stateChanges
      .map((change) => ({ change, errors: invalidRefsOf(change, refs) }))
      .filter((b) => b.errors.length > 0);
    if (bad.length > 0) {
      console.warn(
        `[StateResolver] ${bad.length} change(s) referenced non-existent entities; retrying once with error feedback`
      );
      raw = filterAllowedKeys(
        await callOnce(`${request}\n\n${buildRefErrorFeedback(bad, refs, raw)}`)
      );
      stateChanges = flattenToStateChanges(raw);
      // Whatever is still invalid gets dropped here (with the reason), so the
      // Applier never sees it and the commit is clean.
      stateChanges = stateChanges.filter((change) => {
        const errors = invalidRefsOf(change, refs);
        if (errors.length > 0) {
          console.warn(
            `[StateResolver] dropped ${change.kind} after retry: ${errors.join("; ")}`
          );
          return false;
        }
        return true;
      });
    }
  }

  const elapsedMinutes =
    typeof raw.elapsedMinutes === "number" && raw.elapsedMinutes >= 0
      ? raw.elapsedMinutes
      : 0;
  return { stateChanges, elapsedMinutes };
}
