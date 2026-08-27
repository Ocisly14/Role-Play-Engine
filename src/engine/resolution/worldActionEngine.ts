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
import type {
  ModelMessage,
  ToolResultRecord,
} from "../../models/providers/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { actionIdForCommand } from "../actions/actionStore.js";
import type { ActionCommand } from "../actions/types.js";
import {
  buildSkillCatalogPrompt,
  renderSkillGuidance,
} from "../rules/skillReference.js";
import type { CodeToolRegistry } from "../tools/codeTool.js";
import {
  type EngineResolutionContext,
  type ResolutionError,
  type WorldActionEngineResult,
  formatErrorTarget,
} from "./types.js";
import {
  CODE_TOOL_SPECS,
  type RawResolutionRepair,
  type RawTickResolution,
  repairResolutionTool,
  submitResolutionTool,
} from "./worldDeltaSchema.js";
import {
  applyRepair,
  finalizeResolution,
  normalizeRawResolution,
  resolutionWorklist,
  validateRawResolution,
} from "./worldDeltaValidator.js";

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
submitted intent (ActionCommands). You decide how long each action should
take, how hard it is, and what it does to the world — for ALL new and
in-flight actions on one shared world snapshot. You do not decide how much
time passed, whether an action is finished, or whether a check was passed:
code owns the clock and the dice, and hands you their results.

${RULES_DOC}

## Session protocol

- You may call the deterministic tools (pathfinding, movementCost,
  inventoryValidation, damageRoll) to ground your resolution. Movement
  feasibility/duration MUST come from pathfinding/movementCost, not
  estimation. You never roll a skill check yourself — you name the bar and
  the opposition when the action starts, and code rolls both sides when its
  time is spent.
- Finish with exactly one \`submit_resolution\` call containing the complete
  resolution. Do not mix it with other tool calls in the same turn.
- Answer every id the trigger's \`resolve\` worklist puts under
  \`starting\` and \`ending\`, in that list. The list an action goes in IS the
  decision about what happens to it, and each list carries only the fields
  that moment allows. Ids under \`stillRunning\` need nothing from you.
- \`repair_resolution\` is listed for the whole session but is only valid
  AFTER a submission comes back rejected. Never open with it.
- Facts and reasons are objective and third-person. Perceiver lists follow
  physical/sensory reach (same location; adjacent for loud signals).
- The actor's proposedDurationTicks is advisory. You output
  resolvedDurationTicks + timingReason when the action starts, and again only
  if you revise the estimate. There is no status field and no progress field:
  saying nothing about an in-flight action leaves it running.

## Skill catalog

What each declarable skill covers — the boundary knowledge for deciding
whether to check the skill the actor declared at all. An action outside a
skill's coverage simply gets no \`check\`: the skill grants nothing and the
action is settled on its own merits. Never raise the bar instead. Declared
skills additionally get full guidance in the request context.

${buildSkillCatalogPrompt()}`;

export interface WorldActionEngineDeps {
  dgsm: DynamicGameStateManager;
  codeTools: CodeToolRegistry;
}

/**
 * One id per action, and it is the one the schema addresses.
 *
 * `actionId` is `action_<commandId>`, and the Trigger section lists exactly
 * those. Printing the raw `commandId` alongside puts a SECOND id for the same
 * action in the same prompt — and the model reasonably echoes the one printed
 * next to the action it is resolving, which then fails lookup as "unknown
 * actionId" and burns every repair round on a mismatch it cannot see. So the
 * commandId never reaches the prompt.
 */
function commandForPrompt(command: ActionCommand): Record<string, unknown> {
  const { commandId: _commandId, ...rest } = command;
  return rest;
}

/**
 * The context split at the point where its stability changes.
 *
 * Prompt caching matches a prefix from the first byte of the request, so the
 * order here is the whole game. `## Tick` is 114 characters — a tick id and a
 * timestamp — and it used to sit at offset 360 of a 116,000-character prompt.
 * Everything behind it (all 53 scenes, all 295 items: 94% of the request) was
 * byte-identical from tick to tick and got thrown away anyway, because those
 * 114 characters changed. Measured cross-tick common prefix: 0.3%.
 *
 * So the world description goes FIRST and everything about this particular
 * minute goes LAST. Characters are volatile too — the stamina subsystem moves
 * fatigue on most ticks — and at ~1.8k characters they are cheap to re-send,
 * so they lead the volatile half rather than poisoning the stable one.
 *
 * The model reads titled JSON sections, so nothing about the resolution
 * depends on this order.
 */
export function renderContextSegments(context: EngineResolutionContext): {
  stable: string;
  volatile: string;
} {
  const section = (title: string, data: unknown): string =>
    `## ${title}\n${JSON.stringify(data, null, 1)}`;

  const newCommands = context.actions.newCommands.map((command) => ({
    actionId: actionIdForCommand(command.commandId),
    ...commandForPrompt(command),
  }));
  const activeActions = context.actions.activeActions.map((action) => {
    const { id, command, ...rest } = action;
    return { actionId: id, ...rest, command: commandForPrompt(command) };
  });

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

  // The trigger section names the moment each action is in rather than leaving
  // the Engine to look up `status` in another section and infer it. That
  // inference was the single largest source of rejected submissions. Computed
  // by the same function the validator judges against, so the two cannot drift.
  const worklist = resolutionWorklist(context);

  const stable = [
    "# Tick Resolution Request",
    section("World Invariants", context.rules.worldInvariants),
    section("Scenes", context.state.scenes),
    section("Items", context.state.items),
  ].join("\n\n");

  const volatile = [
    section("Characters", context.state.characters),
    section("Trigger", {
      ...context.trigger,
      resolve: {
        ...worklist,
        note: "`starting` and `ending` are the ids you must answer, in those lists, and they are the only ones. `stillRunning` is FYI: those actions keep running by themselves and take no entry. `endingNeedsOutcome` lists in-flight actions that carried no check — if one ends, you supply `outcome`.",
      },
    }),
    section("Tick", context.tick),
    section("New Commands (this tick)", newCommands),
    section("Active Actions (in flight)", activeActions),
    section("Objective Events (already effective)", context.events),
    ...(skillGuidance.length > 0
      ? [`## Declared Skill Guidance\n\n${skillGuidance.join("\n\n---\n\n")}`]
      : []),
    "Resolve now. Consult tools as needed, then call submit_resolution once — every id under the trigger's `resolve.starting` and `resolve.ending` placed in that list.",
  ].join("\n\n");

  return { stable: `${stable}\n\n`, volatile };
}

/** The whole user prompt as one string. */
export function renderContext(context: EngineResolutionContext): string {
  const { stable, volatile } = renderContextSegments(context);
  return stable + volatile;
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
    "Send only the elements listed above, as arrays in the same shape you",
    "submitted — each item carrying the `index` quoted above (an action",
    "carries its actionId instead). Everything you do not mention stays as",
    "you submitted it: do not re-send correct parts or the whole resolution.",
  ].join("\n");
}

export async function resolveTick(
  context: EngineResolutionContext,
  deps: WorldActionEngineDeps
): Promise<WorldActionEngineResult> {
  // Two breakpoints on the opening turn, because it is reused on two
  // different timescales:
  //   - after the world description: read by the NEXT tick, whose world is
  //     usually the same one.
  //   - after the whole turn: read by every later round of THIS session. A
  //     tick that needs a repair round or a tool lookup re-sends this same
  //     116k-character turn verbatim, and used to re-pay for it in full.
  // The growing tail (assistant turns + tool results) is left uncached: it is
  // ~1.5k characters a round against a 116k prefix, and the tool-result path
  // carries no cacheControl field anyway.
  const { stable, volatile } = renderContextSegments(context);
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        { kind: "text", text: stable, cacheControl: true },
        { kind: "text", text: volatile, cacheControl: true },
      ],
    },
  ];
  // ONE tool list for the whole session. Tools render ahead of the system
  // prompt in the cached prefix, so swapping the array between rounds threw
  // away the system-prompt cache as well — `cacheSystemPrompt` was doing
  // nothing from the first repair round on. Which tool the model MUST call is
  // steered by toolChoice below, which is what was actually doing the work.
  const tools = [
    ...CODE_TOOL_SPECS,
    submitResolutionTool,
    repairResolutionTool,
  ];
  const correctiveRetryUsed = false;

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
        tools,
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
      const repairCall = toolCalls.find((c) => c.name === "repair_resolution");
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
          movementInits: finalized.movementInits,
          checkInits: finalized.checkInits,
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
        results: [{ toolCallId: repairCall.id, content: renderErrors(errors) }],
      });
      continue;
    }

    const submits = toolCalls.filter((c) => c.name === "submit_resolution");
    const codeCalls = toolCalls.filter((c) => CODE_TOOL_NAMES.has(c.name));

    // ---- first clean submission -----------------------------------------
    if (submits.length === 1 && codeCalls.length === 0) {
      const raw = normalizeRawResolution(
        submits[0].args as unknown as RawTickResolution
      );
      const invocationsSoFar = deps.codeTools.drainInvocations();
      const errors = validateRawResolution(raw, context, invocationsSoFar);
      requeueInvocations(deps.codeTools, invocationsSoFar);
      if (errors.length === 0) {
        const finalized = finalizeResolution(raw, context);
        return {
          ok: true,
          resolution: finalized.resolution,
          movementInits: finalized.movementInits,
          checkInits: finalized.checkInits,
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
      if (call.name === "repair_resolution") {
        // Present in every round's tool list so the list stays cacheable, but
        // only meaningful once a submission has been rejected.
        results.push({
          toolCallId: call.id,
          content:
            "Error: repair_resolution only applies to a submission that was " +
            "rejected. Nothing has been submitted yet — call submit_resolution.",
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
