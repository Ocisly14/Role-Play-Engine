// src/engine/resolution/worldActionEngine.ts
//
// The staged World Action Engine (plan Phase 7, six-phase output). Called once
// per triggered tick with the full EngineResolutionContext. One tick is
// resolved in six ordered phases — endings, starts, characterChanges,
// itemChanges, sceneChanges, occurrences — each a request of its own that
// offers ONLY that phase's submission tool (plus the deterministic damage dice
// in the endings phase, because a roll must never be the model's). A phase's
// answer is validated the moment it arrives and retained only when its own
// validator accepts it; an invalid answer gets an addressed, phase-local
// rejection. In the two phases whose rows have a key (starts, occurrences)
// code keeps the rows that passed and asks only for what is still owed,
// merging before it validates the whole array again; everywhere else the
// answer is the COMPLETE array for that phase again. There is no patch tool
// either way. After six accepted phases the draft is assembled into the
// same RawTickResolution as before and judged whole by the same global gate;
// a global fault rewinds to the earliest phase that owns it (once), and a tick
// still invalid after that applies nothing.
//
// The one thing a request may change about itself is the `strict` flag, and
// only when the provider refuses to compile that phase's grammar: see
// `callPhaseModelWithFallback` and `strictSchemaFallback.ts`.
//
// This module changes NO world state. It never touches DGSM, the movement
// runtime, action state or persistence: its only side effect is
// `deps.codeTools.run` for the dice (recorded and returned as
// `codeToolInvocations`), and its only output is the returned value, which the
// orchestrator applies atomically or not at all.

import {
  ModelClass,
  type ToolCallResult,
  generateToolCalls,
} from "../../models/index.js";
import type {
  ModelMessage,
  ToolCallRecord,
  ToolResultRecord,
  ToolSpec,
} from "../../models/providers/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type {
  CodeToolInvocation,
  CodeToolRegistry,
} from "../tools/codeTool.js";
import {
  engineModelIdentity,
  isStrictDowngraded,
  isStrictSchemaRejection,
  rememberStrictDowngrade,
} from "./strictSchemaFallback.js";
import {
  type EngineResolutionContext,
  type ResolutionError,
  type WorldActionEngineResult,
  formatErrorTarget,
} from "./types.js";
import { CODE_TOOL_SPECS } from "./worldDeltaSchema.js";
import {
  exitsFromHere,
  finalizeResolution,
  validateRawResolution,
} from "./worldDeltaValidator.js";
import {
  renderContext,
  renderContextSegments,
  renderPhaseDuplicate,
  renderPhaseEmpty,
  renderPhaseInstruction,
  renderPhaseRejection,
  renderPhaseSystemPrompt,
  renderPhaseUnreadable,
  renderPhaseWrongTool,
  renderWorldGraph,
} from "./worldResolutionStagePrompts.js";
import {
  type AcceptedResolutionDraft,
  PHASE_FIELDS,
  PHASE_TOOLS,
  PHASE_TOOLS_NON_STRICT,
  PHASE_TOOL_NAMES,
  RESOLUTION_PHASES,
  type ResolutionPhase,
  schemaFingerprint,
} from "./worldResolutionStageSchemas.js";
import {
  MERGE_PHASES,
  acceptedPhaseValue,
  assembleRawResolution,
  mergeRows,
  phaseIndex,
  phaseRows,
  retainedRows,
  rewindPhaseFor,
  validatePhase,
} from "./worldResolutionStageValidator.js";

// `exitsFromHere` lives with the validator now, which checks a
// `passBlockedConnectionId` against the same list the prompt shows; the three
// renderers live with the phase prompts, which is the only place that still
// builds an instruction around them. All four are re-exported here because the
// engine module is where callers and tests have always reached for them.
export {
  exitsFromHere,
  renderContext,
  renderContextSegments,
  renderWorldGraph,
};

// ==================== Budget ====================

/**
 * Hard ceiling on provider calls in one tick's resolution. EVERY
 * `generateToolCalls` invocation counts — a dice turn, a structural refusal, a
 * local correction, and the reruns after a global rewind alike.
 *
 * Twelve for six phases is two calls a phase: the common path (one) with room
 * for one correction or one dice turn in most of them, or for the whole
 * rewound tail once. The single session it replaces had a 5-turn ceiling,
 * measured over two 30-tick full-town runs: a session that spends every turn
 * fanning out tool calls and applies nothing costs the whole world context
 * per turn, so the ceiling exists to bound waste, not to be reached.
 *
 * The number is also a prompt sentence: `renderPhaseSystemPrompt` templates
 * it into the protocol document so the guard and the promise cannot drift.
 */
export const MAX_PROVIDER_CALLS = 12;

/**
 * Complete submission attempts one phase gets before the tick is given up.
 *
 * Every turn that carries the phase's tool counts, readable or not — so a
 * model looping on `{}` burns its three and stops. Each attempt re-sends the
 * world, so this is a real cost ceiling; but a phase that cannot get one array
 * right in three tries is a fault to surface, not something to grind at.
 */
export const MAX_PHASE_ATTEMPTS = 3;

/** Global rewinds one tick may take. One: after a rewound tail the phases have
 *  had their say twice, and a second global failure means they cannot be made
 *  to agree — the tick is rejected atomically rather than argued further. */
export const MAX_GLOBAL_REWINDS = 1;

/** The execution order, which is also the rewind order. */
export const PHASE_ORDER = RESOLUTION_PHASES;

const BUDGET = {
  maxProviderCalls: MAX_PROVIDER_CALLS,
  maxPhaseAttempts: MAX_PHASE_ATTEMPTS,
};

const CODE_TOOL_NAMES = new Set(CODE_TOOL_SPECS.map((t) => t.name));

export interface WorldActionEngineDeps {
  dgsm: DynamicGameStateManager;
  codeTools: CodeToolRegistry;
}

// ==================== Results ====================

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

/**
 * The phase's submission arrived in the same turn as other calls.
 *
 * The one refusal the prompts module has no renderer for, because it is about
 * the turn rather than the array: a submission is a turn of its own. In the
 * endings phase the other calls are usually the dice, and an outcome written
 * in the same turn as the roll it depends on was written before the roll came
 * back — so the rolls are executed and answered (the model has the numbers
 * now) and the submission is refused with that reason. Anywhere else the
 * companions are tools this phase does not carry, answered as such.
 */
function renderSubmittedBesideOthers(
  phase: ResolutionPhase,
  others: readonly string[],
  rolled: boolean
): string {
  const tool = `\`${PHASE_TOOL_NAMES[phase]}\``;
  const field = `\`${PHASE_FIELDS[phase]}\``;
  const beside = others.map((name) => `\`${name}\``).join(", ");
  return [
    `Not applied: ${tool} arrived in the same turn as ${beside}. A submission is a turn of its own — this phase's tool once, and nothing else.`,
    "",
    rolled
      ? `An outcome written in the same turn as the roll it depends on was written before the roll came back. The roll results are in this turn's other results: read them, then call ${tool} alone, with the complete ${field} array.`
      : `Call ${tool} again, alone, with the complete ${field} array.`,
  ].join("\n");
}

/** True when the provider handed back readable JSON that holds nothing. An
 *  empty object and an unreadable one are different events (see
 *  `ToolCallRecord.unreadableArgs`) and get different answers. */
function hasNoArgs(call: ToolCallRecord): boolean {
  return Object.keys(call.args).length === 0;
}

// ==================== The provider seam ====================

/** One system prompt per phase, rendered once. The text is a pure function of
 *  the phase and the budget constants, and keeping the string byte-identical
 *  across calls is what lets the provider cache it. */
const SYSTEM_PROMPTS = new Map<ResolutionPhase, string>();
function systemPromptFor(phase: ResolutionPhase): string {
  let prompt = SYSTEM_PROMPTS.get(phase);
  if (prompt === undefined) {
    prompt = renderPhaseSystemPrompt(phase, BUDGET);
    SYSTEM_PROMPTS.set(phase, prompt);
  }
  return prompt;
}

/**
 * ONE provider call for one phase — the single seam every request of the
 * runner goes through, and the one place the request envelope is decided.
 *
 * `submissionTool` is passed in rather than looked up so a caller can offer a
 * different copy of the same tool: `callPhaseModelWithFallback` wraps this
 * function and, on a classified grammar-compilation refusal, calls it again
 * with `PHASE_TOOLS_NON_STRICT[phase]` and the same messages. Nothing about
 * the envelope changes with the copy — the two copies share a name, so the
 * forced `toolChoice` and every downstream filter are the same either way.
 *
 * The envelope: the phase's own system prompt (cached); the phase tool alone,
 * plus the dice in the endings phase; `toolChoice` naming the phase tool
 * wherever it is the only tool — the structured-output case — and `"any"` in
 * endings, where the dice must remain callable. Parallel calls are allowed
 * only in endings, so every roll for the tick arrives in one turn instead of
 * one full-world round trip each; elsewhere a turn is one submission, and a
 * provider that ignores the flag is trimmed to its first call by the policy.
 */
export async function callPhaseModel(
  phase: ResolutionPhase,
  submissionTool: ToolSpec,
  messages: ModelMessage[]
): Promise<ToolCallResult> {
  const endings = phase === "endings";
  return generateToolCalls({
    customSystemPrompt: systemPromptFor(phase),
    cacheSystemPrompt: true,
    messages,
    tools: endings ? [submissionTool, ...CODE_TOOL_SPECS] : [submissionTool],
    toolChoice: endings ? "any" : { name: submissionTool.name },
    allowParallelCalls: endings,
    modelClass: ModelClass.MEDIUM,
    operation: `world-action-engine:${phase}`,
  });
}

/**
 * The phase's call, with the ONE fallback the plan allows (D8): a provider
 * that refuses to compile the strict tool's grammar is answered by asking the
 * same question again with the same schema, unstrict.
 *
 * That refusal is the only error worth answering differently. It arrives
 * before a single token is generated, it is a property of the schema rather
 * than of the moment, and it will arrive again for every tick of this process
 * — so it is warned about once, remembered by fingerprint (vendor + model +
 * tool + schema), and skipped over from then on. Every other failure — a rate
 * limit, an outage, a timeout, an unusable answer — is left exactly where the
 * runner already puts it: rethrown, and the tick applies nothing. Downgrading
 * on one of those would trade the grammar away for a blip.
 *
 * What is given up is structure enforcement and nothing else. The answer goes
 * through the same `validatePhase` gate either way; a payload the model
 * serialized into a JSON string is read back by the validator's own
 * normalization, and a payload that is genuinely wrong is rejected as any
 * other wrong payload is.
 *
 * Both the failed strict call and its retry count against the shared ceiling —
 * every invocation does — so a rejection that arrives on the last call of the
 * budget is not retried at all.
 */
async function callPhaseModelWithFallback(
  session: Session,
  phase: ResolutionPhase,
  messages: ModelMessage[]
): Promise<ToolCallResult> {
  const { provider, model } = engineModelIdentity();
  const strictTool = PHASE_TOOLS[phase];
  const fingerprint = schemaFingerprint(provider, model, strictTool);
  const downgraded = isStrictDowngraded(fingerprint);

  // One line a tick, not one a phase: after the first refusal every later
  // tick would otherwise repeat the same sentence six times over.
  if (downgraded && !session.noticedDowngrade) {
    session.noticedDowngrade = true;
    console.log(
      `[WorldActionEngine] tick ${session.context.tick.tickId}: offering ${strictTool.name} without strict — ${provider}/${model} refused to compile it earlier in this process`
    );
  }

  session.calls += 1;
  try {
    return await callPhaseModel(
      phase,
      downgraded ? PHASE_TOOLS_NON_STRICT[phase] : strictTool,
      messages
    );
  } catch (err) {
    // Already unstrict, or an error that says nothing about the schema: not
    // ours to answer. The runner's model-error path takes it from here.
    if (downgraded || !isStrictSchemaRejection(err)) throw err;

    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[WorldActionEngine] strict schema for ${strictTool.name} rejected by ${provider}/${model} (${fingerprint.slice(0, 8)}): ${reason} — retrying this phase once without strict; downgrade cached for this process`
    );
    rememberStrictDowngrade(fingerprint, {
      toolName: strictTool.name,
      reason,
    });

    if (session.calls >= MAX_PROVIDER_CALLS) {
      // The retry is a provider call like any other and there is none left.
      // The downgrade still stands: the next tick opens unstrict and pays
      // nothing for what was learned here.
      throw err;
    }
    session.calls += 1;
    return await callPhaseModel(phase, PHASE_TOOLS_NON_STRICT[phase], messages);
  }
}

// ==================== Session state ====================

/** Everything one tick's resolution carries across its phases. */
interface Session {
  context: EngineResolutionContext;
  deps: WorldActionEngineDeps;
  /** Accepted output, phase by phase. A key is absent until its phase's
   *  validator accepted it, and a rewind deletes it again. */
  draft: AcceptedResolutionDraft;
  /** Every `generateToolCalls` invocation so far, against the ceiling. */
  calls: number;
  rewinds: number;
  /** Dice records, drained out of the registry after every turn that rolled
   *  and kept here for the whole tick — a later phase's correction, or the
   *  tick's failure, must not lose the roll that was made. */
  invocations: CodeToolInvocation[];
  /** Whether this tick has already said out loud that it is offering a
   *  downgraded tool. The refusal is warned about once, in the process that
   *  met it; every later tick says so once and quietly. */
  noticedDowngrade: boolean;
}

/** Segments rendered once per tick: the context is phase-neutral, so all six
 *  requests carry the same two cached blocks. */
type ContextSegments = ReturnType<typeof renderContextSegments>;

/** The draft key a phase's accepted array is stored under. `PHASE_FIELDS` is
 *  typed `Record<ResolutionPhase, string>`, so the one cast lives here. */
function draftKey(phase: ResolutionPhase): keyof AcceptedResolutionDraft {
  return PHASE_FIELDS[phase] as keyof AcceptedResolutionDraft;
}

/** Discard the phase and every phase after it; earlier phases stay accepted. */
function discardFrom(
  draft: AcceptedResolutionDraft,
  phase: ResolutionPhase
): void {
  for (const later of RESOLUTION_PHASES.slice(phaseIndex(phase))) {
    delete draft[draftKey(later)];
  }
}

type PhaseOutcome =
  | { accepted: true }
  | { accepted: false; failed: WorldActionEngineResult };

// ==================== The runner ====================

export async function resolveTick(
  context: EngineResolutionContext,
  deps: WorldActionEngineDeps
): Promise<WorldActionEngineResult> {
  const session: Session = {
    context,
    deps,
    draft: {},
    calls: 0,
    rewinds: 0,
    invocations: [],
    noticedDowngrade: false,
  };
  const segments = renderContextSegments(context);
  const tickId = context.tick.tickId;

  let from: ResolutionPhase = RESOLUTION_PHASES[0];
  let globalErrors: ResolutionError[] | undefined;

  for (;;) {
    for (const phase of RESOLUTION_PHASES.slice(phaseIndex(from))) {
      // The global gate's verdict goes to the FIRST request of the rewound
      // phase only: it is why that phase is being decided again. The phases
      // behind it are rerun because the draft they read changed, and they are
      // told nothing — a fault that was not theirs is not theirs to fix.
      const outcome = await runPhase(
        session,
        segments,
        phase,
        phase === from ? globalErrors : undefined
      );
      if (!outcome.accepted) return outcome.failed;
    }

    // Six accepted phases. The assembled draft is judged whole by the same
    // gate as before — every phase-local check is a subset of it, and it is
    // the only authority that lets a resolution reach the Applier.
    const raw = assembleRawResolution(session.draft);
    const errors = validateRawResolution(raw, context);
    if (errors.length === 0) {
      const finalized = finalizeResolution(raw, context);
      return {
        ok: true,
        resolution: finalized.resolution,
        movementInits: finalized.movementInits,
        checkInits: finalized.checkInits,
        codeToolInvocations: session.invocations,
      };
    }
    if (session.rewinds >= MAX_GLOBAL_REWINDS) {
      return unusable(
        `${tickId}: still invalid after ${session.rewinds} global rewind(s), nothing applied`,
        errors,
        session.invocations
      );
    }
    session.rewinds += 1;
    from = rewindPhaseFor(errors, context);
    discardFrom(session.draft, from);
    globalErrors = errors;
    console.warn(
      `[WorldActionEngine] tick ${tickId}: assembled draft rejected by the global gate (${errors.length} error(s)); rewinding to phase ${from}, ${session.calls}/${MAX_PROVIDER_CALLS} calls spent`
    );
  }
}

/**
 * One phase, start to acceptance or to the tick's failure.
 *
 * Fresh messages: the phase is its own conversation, opened with the two
 * cached context blocks and this phase's instruction. Within the phase, dice
 * turns and corrections continue that conversation; the accepted upstream
 * draft travels inside the instruction as read-only JSON, never as history.
 */
async function runPhase(
  session: Session,
  segments: ContextSegments,
  phase: ResolutionPhase,
  globalErrors: ResolutionError[] | undefined
): Promise<PhaseOutcome> {
  const { context } = session;
  const tickId = context.tick.tickId;
  // Which copy of the phase's tool a request offers is the fallback's
  // business; the NAME is the same either way, and the name is all the runner
  // needs to tell this phase's submission from anything else in a turn.
  const toolName = PHASE_TOOL_NAMES[phase];
  const fail = (failed: WorldActionEngineResult): PhaseOutcome => ({
    accepted: false,
    failed,
  });

  // Two breakpoints on the opening turn, because it is reused on two
  // different timescales: after the world description, read by the NEXT tick,
  // whose world is usually the same one; and after the volatile half, read by
  // every later request of THIS tick — five more phases and every correction
  // re-send the same context verbatim. The instruction that follows is what
  // differs per phase, and the growing tail (assistant turns + tool results)
  // is left uncached.
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        { kind: "text", text: segments.stable, cacheControl: true },
        { kind: "text", text: segments.volatile, cacheControl: true },
        {
          kind: "text",
          text: renderPhaseInstruction(
            phase,
            context,
            session.draft,
            globalErrors ? { globalErrors } : undefined
          ),
        },
      ],
    },
  ];
  let attempts = 0;
  // Rows of a refused submission that passed on their own, in a merge phase.
  // The next submission is merged over them before it is judged; an empty
  // list means the next submission stands alone (first attempt, or a phase
  // that is corrected by the complete array).
  let retained: unknown[] = [];

  for (;;) {
    if (session.calls >= MAX_PROVIDER_CALLS) {
      return fail(
        unusable(
          `${tickId}: call budget of ${MAX_PROVIDER_CALLS} exhausted in phase ${phase} after ${attempts} submission attempt(s), nothing applied`,
          [],
          session.invocations
        )
      );
    }
    let turn: ToolCallResult;
    try {
      turn = await callPhaseModelWithFallback(session, phase, messages);
    } catch (err) {
      console.warn(
        `[WorldActionEngine] LLM call failed in phase ${phase}:`,
        err instanceof Error ? err.message : err
      );
      return fail(
        unusable(
          `${tickId}: model error in phase ${phase} after ${attempts} submission attempt(s), nothing applied`,
          [],
          session.invocations
        )
      );
    }
    const { toolCalls, assistantMessage } = turn;
    const phaseCalls = toolCalls.filter((c) => c.name === toolName);
    const others = toolCalls.filter((c) => c.name !== toolName);

    // ---- (a) a dice turn: endings only, no submission in it ---------------
    // Every call is answered — the rolls executed, anything else refused —
    // and the phase continues. Not a submission attempt: the model has not
    // yet said anything about the tick. The call budget bounds this.
    if (
      phaseCalls.length === 0 &&
      phase === "endings" &&
      toolCalls.some((c) => CODE_TOOL_NAMES.has(c.name))
    ) {
      messages.push(assistantMessage);
      messages.push({
        role: "tool",
        results: await answerNonPhaseCalls(session, phase, toolCalls),
      });
      continue;
    }

    // ---- (c) no submission and no dice: a wrong tool, or nothing ----------
    // Counts as an attempt: the model was asked for this phase's array and
    // answered with something else. A provider that returns no call at all
    // is already a thrown error at the policy layer, so the empty case is a
    // nudge for completeness rather than a path that runs.
    if (phaseCalls.length === 0) {
      attempts += 1;
      if (toolCalls.length === 0) {
        messages.push({
          role: "user",
          content: [
            { kind: "text", text: renderPhaseWrongTool(phase, "(no call)") },
          ],
        });
      } else {
        messages.push(assistantMessage);
        messages.push({
          role: "tool",
          results: await answerNonPhaseCalls(session, phase, toolCalls),
        });
      }
      if (attempts >= MAX_PHASE_ATTEMPTS) {
        return fail(
          unusable(
            `${tickId}: phase ${phase} still invalid after ${attempts} attempts, nothing applied`,
            [],
            session.invocations
          )
        );
      }
      continue;
    }

    // ---- (b) a turn carrying the submission -------------------------------
    attempts += 1;
    const call = phaseCalls[0];
    // Structural refusals, judged before the validator sees anything. Each
    // is its own event with its own answer: a duplicate cannot be merged
    // without silently dropping a copy; a mixed turn cannot be taken without
    // leaving its companions unanswered (an unanswered tool_use is a 400 on
    // the next request); unreadable arguments reaching the validator as an
    // EMPTY submission used to answer back "you did not answer any of these
    // seven actions" — seven corrections for a mistake the model had not made;
    // and `{}` is legal JSON that would produce the same misleading
    // correction for a call that in truth carried nothing (measured: DeepSeek
    // sends it most often on the turn right after a rejection, and two ticks
    // died in five-round streaks of it).
    const rolled =
      phase === "endings" && others.some((c) => CODE_TOOL_NAMES.has(c.name));
    const structural =
      phaseCalls.length > 1
        ? renderPhaseDuplicate(phase)
        : others.length > 0
          ? renderSubmittedBesideOthers(
              phase,
              others.map((c) => c.name),
              rolled
            )
          : call.unreadableArgs
            ? renderPhaseUnreadable(phase, call.unreadableArgs.rawLength)
            : hasNoArgs(call)
              ? renderPhaseEmpty(phase)
              : undefined;
    if (structural !== undefined) {
      const companions = await answerNonPhaseCalls(session, phase, others);
      const byId = new Map(companions.map((r) => [r.toolCallId, r]));
      messages.push(assistantMessage);
      messages.push({
        role: "tool",
        results: toolCalls.map(
          (c) => byId.get(c.id) ?? { toolCallId: c.id, content: structural }
        ),
      });
      if (attempts >= MAX_PHASE_ATTEMPTS) {
        return fail(
          unusable(
            `${tickId}: phase ${phase} still invalid after ${attempts} attempts, nothing applied`,
            [],
            session.invocations
          )
        );
      }
      continue;
    }

    // The readable submission. The arguments are the model's and untrusted;
    // the phase validator judges them against the world and the accepted
    // draft, and only an empty verdict lets them into the draft. In a merge
    // phase the rows code kept from the refused attempt come first, and the
    // submission is read as the answer to what was still owed.
    const submitted = phaseRows(phase, call.args);
    const merged =
      submitted !== undefined && retained.length > 0
        ? mergeRows(phase, retained, submitted, context, session.draft)
        : submitted;
    const payload =
      merged !== undefined ? { [PHASE_FIELDS[phase]]: merged } : call.args;
    const errors = validatePhase(phase, payload, context, session.draft);
    if (errors.length === 0) {
      Object.assign(session.draft, {
        [draftKey(phase)]: acceptedPhaseValue(phase, payload),
      });
      console.log(
        `[WorldActionEngine] tick ${tickId} phase ${phase} accepted after ${attempts} attempt(s), ${session.calls}/${MAX_PROVIDER_CALLS} calls${retained.length ? ` (${retained.length} row(s) kept from the refused attempt, ${submitted?.length ?? 0} sent)` : ""}`
      );
      return { accepted: true };
    }
    let repair: Parameters<typeof renderPhaseRejection>[2] = {
      context,
      draft: session.draft,
      previousPayload: call.args,
      ...(MERGE_PHASES.has(phase) ? { retained } : {}),
    };
    if (MERGE_PHASES.has(phase) && merged !== undefined) {
      const split = retainedRows(phase, merged, context, session.draft);
      retained = split.retained;
      repair = { ...repair, retained, faulty: split.faulty };
    }
    messages.push(assistantMessage);
    messages.push({
      role: "tool",
      results: [
        {
          toolCallId: call.id,
          content: renderPhaseRejection(phase, errors, repair),
        },
      ],
    });
    if (attempts >= MAX_PHASE_ATTEMPTS) {
      return fail(
        unusable(
          `${tickId}: phase ${phase} still invalid after ${attempts} attempts, nothing applied`,
          errors,
          session.invocations
        )
      );
    }
  }
}

/**
 * Answer every call that is not this phase's submission. A code tool is
 * executed only in the phase that offers it (endings); anywhere else, and for
 * any name that is not a tool at all, the answer is the phase's refusal. The
 * dice records are drained into the session straight away, so no later turn
 * or phase can lose them.
 */
async function answerNonPhaseCalls(
  session: Session,
  phase: ResolutionPhase,
  calls: readonly ToolCallRecord[]
): Promise<ToolResultRecord[]> {
  const { deps } = session;
  const results: ToolResultRecord[] = [];
  for (const call of calls) {
    if (phase !== "endings" || !CODE_TOOL_NAMES.has(call.name)) {
      results.push({
        toolCallId: call.id,
        content: renderPhaseWrongTool(phase, call.name),
      });
      continue;
    }
    try {
      const actionId =
        typeof call.args.actionId === "string" ? call.args.actionId : undefined;
      const output = await deps.codeTools.run(call.name, call.args, {
        dgsm: deps.dgsm,
        ...(actionId !== undefined ? { actionId } : {}),
      });
      results.push({ toolCallId: call.id, content: JSON.stringify(output) });
    } catch (err) {
      results.push({
        toolCallId: call.id,
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  session.invocations.push(...deps.codeTools.drainInvocations());
  return results;
}
