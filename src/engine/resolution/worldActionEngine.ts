// src/engine/resolution/worldActionEngine.ts
//
// The unified World Action Engine session (plan Phase 7). Called once per
// triggered tick with the full EngineResolutionContext. Runs an agentic loop:
// the model may consult the deterministic code tools (pathfinding, movement
// cost, inventory validation, opposed roll, damage dice) and must finish with
// one terminal `submit_resolution` call. Output is validated in code; one
// corrective retry, then whatever is still invalid is dropped and the
// affected actions are failed. No action types, no per-definition prompts —
// one rule document governs everything.

import { readFileSync } from "node:fs";
import { ModelClass, generateToolCalls } from "../../models/index.js";
import {
  buildSkillCatalogPrompt,
  renderSkillGuidance,
} from "../rules/skillReference.js";
import type {
  ModelMessage,
  ToolResultRecord,
} from "../../models/providers/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { CodeToolRegistry } from "../tools/codeTool.js";
import {
  type EngineResolutionContext,
  type ResolutionError,
  type WorldActionEngineResult,
  formatErrorTarget,
} from "./types.js";
import {
  applyRepair,
  finalizeResolution,
  validateRawResolution,
} from "./worldDeltaValidator.js";
import {
  CODE_TOOL_SPECS,
  type RawResolutionRepair,
  type RawTickResolution,
  repairResolutionTool,
  submitResolutionTool,
} from "./worldDeltaSchema.js";

const MAX_ITERATIONS = 8;
/**
 * After this many turns the session stops offering the code tools and demands
 * the terminal submission. Without it a model that keeps consulting tools —
 * or keeps re-submitting alongside them — burns every iteration and every
 * triggering action fails, at full-world context cost per turn. Observed
 * live before this guard existed.
 */
const FORCE_SUBMIT_AFTER = 4;
/**
 * How many repair rounds a submission gets before the session gives up.
 *
 * Each round is a full-world request, so this is a real cost ceiling — but a
 * contract the Engine cannot satisfy in a few targeted fixes is a fault to
 * surface, not something to grind at.
 */
const MAX_REPAIR_ROUNDS = 3;
const CODE_TOOL_NAMES = new Set(CODE_TOOL_SPECS.map((t) => t.name));

// ── Rules document: loaded once. The build ships TS only, so fall back to
//    the repo-relative path when the URL-relative read misses. ──
function loadRulesDoc(): string {
  const candidates = [
    new URL("../rules/world-action-resolution.md", import.meta.url),
    `${process.cwd()}/src/engine/rules/world-action-resolution.md`,
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // try next
    }
  }
  console.warn(
    "[WorldActionEngine] world-action-resolution.md not found; using embedded summary"
  );
  return "Resolve all actions under strict causality, state constraints, locality, engine-owned timing, conservation, roll-first assessment, concurrency consistency, minimal change, and fact/perception separation.";
}

const RULES_DOC = loadRulesDoc();

const SYSTEM_PROMPT = `You are the World Action Engine of a tick-based Call of Cthulhu world
simulation. You are the sole authority on what actually happens: characters
submitted intent (ActionCommands); you decide acceptance, real duration,
progress, conflicts and outcomes for ALL new and in-flight actions on one
shared world snapshot.

${RULES_DOC}

## Session protocol

- You may call the deterministic tools (pathfinding, movementCost,
  inventoryValidation, opposedRoll, damageRoll) to ground your resolution.
  Movement feasibility/duration MUST come from pathfinding/movementCost, not
  estimation. Opposed defense rolls MUST come from opposedRoll — the actor's
  own roll already exists on the command and is never re-rolled.
- Finish with exactly one \`submit_resolution\` call containing the complete
  resolution. Do not mix it with other tool calls in the same turn.
- Facts and reasons are objective and third-person. Perceiver lists follow
  physical/sensory reach (same location; adjacent for loud signals).
- The actor's proposedDurationTicks is advisory. You output
  resolvedDurationTicks + timingReason (first resolution) and nextWakeInTicks
  (whenever an action stays active).

## Skill catalog

What each declarable skill covers — the boundary knowledge for judging
applicability (an action outside a skill's coverage is
applicability: "rejected"). Declared skills additionally get full guidance
in the request context.

${buildSkillCatalogPrompt()}`;

export interface WorldActionEngineDeps {
  dgsm: DynamicGameStateManager;
  codeTools: CodeToolRegistry;
}

/** Render the full context as the session's user prompt. Straight JSON —
 *  verifiable, replayable, nothing filtered. */
export function renderContext(context: EngineResolutionContext): string {
  const section = (title: string, data: unknown): string =>
    `## ${title}\n${JSON.stringify(data, null, 1)}`;

  // Full guidance for exactly the skills declared this tick (deduplicated):
  // duration guidance and outcome shading ground the assessment.
  const declaredSkills = [
    ...new Set(
      [
        ...context.actions.newCommands,
        ...context.actions.activeActions.map((a) => a.command),
      ]
        .map((c) => c.declaredSkillId)
        .filter((s): s is string => s !== undefined)
    ),
  ];
  const skillGuidance = declaredSkills
    .map((skillId) => renderSkillGuidance(skillId))
    .filter((g): g is string => g !== null);

  return [
    "# Tick Resolution Request",
    section("Trigger", context.trigger),
    section("Tick", context.tick),
    section("World Invariants", context.rules.worldInvariants),
    section("Scenes", context.state.scenes),
    section("Items", context.state.items),
    section("Characters", context.state.characters),
    section("New Commands (this tick)", context.actions.newCommands),
    section("Active Actions (in flight)", context.actions.activeActions),
    section("Objective Events (already effective)", context.events),
    ...(skillGuidance.length > 0
      ? [`## Declared Skill Guidance\n\n${skillGuidance.join("\n\n---\n\n")}`]
      : []),
    "Resolve now. Consult tools as needed, then call submit_resolution once.",
  ].join("\n\n");
}

/** The session produced nothing usable. The tick applies no transition, no
 *  delta and no occurrence — actions keep the state they had. */
function unusable(
  failure: string,
  errors: ResolutionError[],
  invocations: WorldActionEngineResult["codeToolInvocations"]
): WorldActionEngineResult {
  console.warn(`[WorldActionEngine] ${failure}`);
  for (const e of errors.slice(0, 10)) {
    console.warn(`    ${formatErrorTarget(e.target)} — ${e.message}`);
  }
  return { ok: false, failure, errors, codeToolInvocations: invocations };
}

/** The errors, addressed, plus the instruction that repair is incremental. */
function renderErrors(errors: ResolutionError[]): string {
  return [
    "REJECTED. Fix ONLY these, with repair_resolution:",
    ...errors.map((e) => `- ${formatErrorTarget(e.target)} — ${e.message}`),
    "",
    "Send only the elements listed above. Everything you do not mention stays",
    "as you submitted it — do not re-send the parts that are already correct,",
    "and do not re-send the whole resolution.",
  ].join("\n");
}

export async function resolveTick(
  context: EngineResolutionContext,
  deps: WorldActionEngineDeps
): Promise<WorldActionEngineResult> {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [{ kind: "text", text: renderContext(context) }],
    },
  ];
  const tools = [...CODE_TOOL_SPECS, submitResolutionTool];
  let correctiveRetryUsed = false;

  // The submission under repair, and how many repair rounds it has had.
  let pending: RawTickResolution | undefined;
  let repairRounds = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const repairing = pending !== undefined;
    let toolCalls: Awaited<ReturnType<typeof generateToolCalls>>["toolCalls"];
    let assistantMessage: ModelMessage;
    try {
      // Once a submission exists, the only move left is to patch it.
      const mustSubmit = !repairing && i >= FORCE_SUBMIT_AFTER;
      if (mustSubmit && i === FORCE_SUBMIT_AFTER) {
        console.warn(
          `[WorldActionEngine] ${context.tick.tickId}: ${i} turns without a ` +
            "submission — withdrawing the code tools and demanding one now"
        );
      }
      const res = await generateToolCalls({
        customSystemPrompt: SYSTEM_PROMPT,
        cacheSystemPrompt: true,
        messages,
        tools: repairing
          ? [repairResolutionTool]
          : mustSubmit
            ? [submitResolutionTool]
            : tools,
        toolChoice: repairing
          ? { name: "repair_resolution" }
          : mustSubmit
            ? { name: "submit_resolution" }
            : "any",
        allowParallelCalls: !repairing,
        modelClass: ModelClass.MEDIUM,
        operation: "world-action-engine",
      });
      toolCalls = res.toolCalls;
      assistantMessage = res.assistantMessage;
    } catch (err) {
      console.warn(
        "[WorldActionEngine] LLM call failed:",
        err instanceof Error ? err.message : err
      );
      return unusable(
        `${context.tick.tickId}: model error, nothing applied`,
        [],
        deps.codeTools.drainInvocations()
      );
    }

    // ---- repair round ----------------------------------------------------
    if (repairing && pending) {
      const repairCall = toolCalls.find(
        (c) => c.name === "repair_resolution"
      );
      if (!repairCall) {
        return unusable(
          `${context.tick.tickId}: expected a repair, got none — nothing applied`,
          [],
          deps.codeTools.drainInvocations()
        );
      }
      pending = applyRepair(
        pending,
        repairCall.args as unknown as RawResolutionRepair
      );
      const invocationsSoFar = deps.codeTools.drainInvocations();
      const errors = validateRawResolution(pending, context, invocationsSoFar);
      requeueInvocations(deps.codeTools, invocationsSoFar);
      if (errors.length === 0) {
        const finalized = finalizeResolution(pending, context);
        return {
          ok: true,
          resolution: finalized.resolution,
          judgements: finalized.judgements,
          movementInits: finalized.movementInits,
          codeToolInvocations: deps.codeTools.drainInvocations(),
        };
      }
      repairRounds += 1;
      if (repairRounds >= MAX_REPAIR_ROUNDS) {
        return unusable(
          `${context.tick.tickId}: still invalid after ${repairRounds} repair round(s), nothing applied`,
          errors,
          deps.codeTools.drainInvocations()
        );
      }
      messages.push(assistantMessage);
      messages.push({
        role: "tool",
        results: [
          { toolCallId: repairCall.id, content: renderErrors(errors) },
        ],
      });
      continue;
    }

    const submits = toolCalls.filter((c) => c.name === "submit_resolution");
    const codeCalls = toolCalls.filter((c) => CODE_TOOL_NAMES.has(c.name));

    // ---- first clean submission -----------------------------------------
    if (submits.length === 1 && codeCalls.length === 0) {
      const raw = submits[0].args as unknown as RawTickResolution;
      const invocationsSoFar = deps.codeTools.drainInvocations();
      const errors = validateRawResolution(raw, context, invocationsSoFar);
      requeueInvocations(deps.codeTools, invocationsSoFar);
      if (errors.length === 0) {
        const finalized = finalizeResolution(raw, context);
        return {
          ok: true,
          resolution: finalized.resolution,
          judgements: finalized.judgements,
          movementInits: finalized.movementInits,
          codeToolInvocations: deps.codeTools.drainInvocations(),
        };
      }
      pending = raw;
      messages.push(assistantMessage);
      messages.push({
        role: "tool",
        results: [{ toolCallId: submits[0].id, content: renderErrors(errors) }],
      });
      continue;
    }

    // Otherwise: answer every call; code tools execute, a mixed-in submit is
    // rejected so the model resubmits it alone.
    messages.push(assistantMessage);
    const results: ToolResultRecord[] = [];
    for (const call of toolCalls) {
      if (call.name === "submit_resolution") {
        results.push({
          toolCallId: call.id,
          content:
            "Error: submit_resolution was NOT accepted — it must be the only tool call in its turn. Finish tool lookups first, then submit alone.",
        });
        continue;
      }
      if (!CODE_TOOL_NAMES.has(call.name)) {
        results.push({
          toolCallId: call.id,
          content: `Error: unknown tool "${call.name}".`,
        });
        continue;
      }
      try {
        const output = await deps.codeTools.run(call.name, call.args, {
          dgsm: deps.dgsm,
        });
        results.push({ toolCallId: call.id, content: JSON.stringify(output) });
      } catch (err) {
        results.push({
          toolCallId: call.id,
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    messages.push({ role: "tool", results });
  }

  return unusable(
    `${context.tick.tickId}: iteration cap reached without a valid resolution, nothing applied`,
    [],
    deps.codeTools.drainInvocations()
  );
}

/** Put drained invocation records back so a later drain still includes them
 *  (used when a corrective retry keeps the session going). */
function requeueInvocations(
  registry: CodeToolRegistry,
  invocations: WorldActionEngineResult["codeToolInvocations"]
): void {
  const target = (
    registry as unknown as {
      invocations: WorldActionEngineResult["codeToolInvocations"];
    }
  ).invocations;
  target.unshift(...invocations);
}
