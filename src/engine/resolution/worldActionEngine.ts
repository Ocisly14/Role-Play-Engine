// src/engine/resolution/worldActionEngine.ts
//
// The staged World Action Engine (plan Phase 7, six-phase output). The Engine
// has two functions, and the orchestrator calls each as a session of its own
// over its own full EngineResolutionContext:
//
//   the START JUDGEMENT — one phase, `starts` — the minute a command arrives,
//   before any world time has passed on it: the clock, the bar, the route;
//   the SETTLEMENT — `endings`, `characterChanges`, `itemChanges`,
//   `sceneChanges`, `occurrences` — when actions end: what came of them and
//   what that did to the world.
//
// Which function a context asks for is what its triggers say: a `new_action`
// trigger is a start judgement, everything else a settlement, and the two are
// never mixed in one context. Within a session the phases run in order, each
// a request of its own that offers ONLY that phase's submission tool (plus
// the deterministic damage dice in the endings phase, because a roll must
// never be the model's). A phase's
// answer is validated the moment it arrives and retained only when its own
// validator accepts it; an invalid answer gets an addressed, phase-local
// rejection. In the two phases whose rows have a key (starts, occurrences)
// code keeps the rows that passed and asks only for what is still owed,
// merging before it validates the whole array again; everywhere else the
// answer is the COMPLETE array for that phase again. There is no patch tool
// either way. After the session's phases are accepted the draft is assembled
// into the same RawTickResolution as before and judged whole by the same
// global gate; a global fault rewinds to the earliest phase of the session
// that owns it (once), and a session still invalid after that applies
// nothing.
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
import {
  type FastPathMode,
  fastPathMode,
  recordShadow,
} from "../shared/fastPath.js";
import type {
  CodeToolInvocation,
  CodeToolRegistry,
} from "../tools/codeTool.js";
import {
  type ChangePhase,
  decideEndingModes,
  decidePerceivers,
  decideUnchangedPhases,
  speechRows,
  withDecidedPerceivers,
} from "./decisionsFastPaths.js";
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
import { CODE_TOOL_SPECS, type RawOccurrence } from "./worldDeltaSchema.js";
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
  type EngineSessionKind,
  OCCURRENCES_TOOL_CODE_PERCEIVERS,
  OCCURRENCES_TOOL_CODE_PERCEIVERS_NON_STRICT,
  PHASE_FIELDS,
  PHASE_TOOLS,
  PHASE_TOOLS_NON_STRICT,
  PHASE_TOOL_NAMES,
  RESOLUTION_PHASES,
  type ResolutionPhase,
  SESSION_PHASES,
  schemaFingerprint,
} from "./worldResolutionStageSchemas.js";
import {
  MERGE_PHASES,
  acceptedPhaseValue,
  assembleRawResolution,
  mergeRows,
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
 * Hard ceiling on provider calls in one session. EVERY `generateToolCalls`
 * invocation counts — a dice turn, a structural refusal, a local correction,
 * and the reruns after a global rewind alike.
 *
 * Twelve for the five-phase settlement is about two calls a phase: the
 * common path (one) with room for one correction or one dice turn in most of
 * them, or for the whole rewound tail once. The one-phase start judgement is
 * bounded well below it by its attempts. The single session it replaces had a 5-turn ceiling,
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

/** Global rewinds one session may take. One: after a rewound tail the phases
 *  have had their say twice, and a second global failure means they cannot be
 *  made to agree — the session is rejected atomically rather than argued
 *  further. */
export const MAX_GLOBAL_REWINDS = 1;

/** The execution order, which is also the rewind order. */
export const PHASE_ORDER = RESOLUTION_PHASES;

/**
 * Which of the Engine's two functions a context asks for. A `new_action`
 * trigger is a start judgement; anything else is a settlement. The
 * orchestrator never mixes the two — they are judged on different world
 * states, a minute apart — and a context that does is refused as unusable
 * rather than half-answered.
 */
export function sessionKindOf(
  context: EngineResolutionContext
): EngineSessionKind | "mixed" {
  const reasons = new Set(context.trigger.triggers.map((t) => t.reason));
  if (!reasons.has("new_action")) return "settlement";
  return reasons.size === 1 ? "start" : "mixed";
}

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
const SYSTEM_PROMPTS = new Map<string, string>();
function systemPromptFor(
  phase: ResolutionPhase,
  narrationLanguage?: string
): string {
  // Keyed by language as well as phase: the prompt names the language it
  // writes in, so one memo per phase would hand a zh run the en text it
  // happened to render first.
  const key = `${phase}|${narrationLanguage ?? ""}`;
  let prompt = SYSTEM_PROMPTS.get(key);
  if (prompt === undefined) {
    prompt = renderPhaseSystemPrompt(phase, BUDGET, narrationLanguage);
    SYSTEM_PROMPTS.set(key, prompt);
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
  messages: ModelMessage[],
  narrationLanguage?: string
): Promise<ToolCallResult> {
  const endings = phase === "endings";
  return generateToolCalls({
    customSystemPrompt: systemPromptFor(phase, narrationLanguage),
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
  // DECISIONS_PERCEIVERS=on offers the occurrences tool without perceivers.
  const codePerceivers = phase === "occurrences" && session.perceiversByCode;
  const strictTool = codePerceivers
    ? OCCURRENCES_TOOL_CODE_PERCEIVERS
    : PHASE_TOOLS[phase];
  const looseTool = codePerceivers
    ? OCCURRENCES_TOOL_CODE_PERCEIVERS_NON_STRICT
    : PHASE_TOOLS_NON_STRICT[phase];
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
      downgraded ? looseTool : strictTool,
      messages,
      session.context.rules.narrationLanguage
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
    return await callPhaseModel(
      phase,
      looseTool,
      messages,
      session.context.rules.narrationLanguage
    );
  }
}

// ==================== Session state ====================

/** Everything one session carries across its phases. */
interface Session {
  kind: EngineSessionKind;
  /** The phases this session runs, in order. */
  phases: readonly ResolutionPhase[];
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
  /** Phases that must be asked even when the skip rule says they need not:
   *  a global rewind puts its phase and the tail behind it here, because the
   *  rewind itself says the plan that skipped them may have been wrong. */
  unskippable: Set<ResolutionPhase>;
  /** The change phases the Decisions plan says this settlement leaves
   *  untouched; asked once, after the endings are accepted. */
  unchanged?: Set<ChangePhase>;
  /** DECISIONS_PERCEIVERS=on: the occurrences phase is offered the tool with
   *  no `perceivers`, and code + Decisions fill them in after the model's
   *  submission. Turned off for the rest of the session if Decisions fails. */
  perceiversByCode: boolean;
}

// ==================== Phases accepted without a model ====================
//
// DECISIONS_PHASE_SKIP (design §6.3). In a settlement, a phase whose answer
// code or the Decisions API can give with confidence is accepted without a
// request — through the phase's own validator, like any answer. Anything
// unsure runs the phase as before. A global rewind makes the rewound phase
// and its tail `unskippable`: the rewind itself says the plan may be wrong.

/** The settlement phases that write world changes. */
const CHANGE_PHASES: ReadonlySet<ResolutionPhase> = new Set([
  "characterChanges",
  "itemChanges",
  "sceneChanges",
]);

/**
 * True when the endings are accepted and none of them carries an outcome.
 * Then nothing in this settlement can change the world: a no_change ending
 * may source no change (the stage validator refuses one), and a pure_speech
 * ending's whole result is its words, delivered by the occurrences phase.
 */
function noOutcomeEnding(draft: AcceptedResolutionDraft): boolean {
  return draft.endings?.every((d) => d.mode !== "outcome") ?? false;
}

/** Validate a payload as the phase's answer and, if it passes, accept it. */
function acceptPayload(
  session: Session,
  phase: ResolutionPhase,
  rows: unknown[],
  why: string
): boolean {
  const payload = { [PHASE_FIELDS[phase]]: rows };
  const errors = validatePhase(phase, payload, session.context, session.draft);
  if (errors.length > 0) {
    console.warn(
      `[WorldActionEngine] tick ${session.context.tick.tickId} phase ${phase}: the code answer was refused (${errors[0].message}); asking the model`
    );
    return false;
  }
  Object.assign(session.draft, {
    [draftKey(phase)]: acceptedPhaseValue(phase, payload),
  });
  console.log(
    `[WorldActionEngine] tick ${session.context.tick.tickId} phase ${phase} accepted without a model — ${why}`
  );
  return true;
}

/** sceneChanges is owed when an accepted item change took a FIXTURE out of
 *  a place whose setting still cites it — that setting must be rewritten.
 *  A loose thing carries its own placement and owes nothing. */
function sceneChangesOwed(session: Session): boolean {
  const places = session.context.state.places;
  for (const row of session.draft.itemChanges ?? []) {
    const op = (row as { operation?: { kind?: string; from?: string } })
      .operation;
    const itemId = (row as { itemId?: string }).itemId;
    if (
      !op ||
      !itemId ||
      (op.kind !== "move" && op.kind !== "destroy" && op.kind !== "place")
    ) {
      continue;
    }
    const holder =
      op.kind === "move"
        ? op.from
        : session.context.state.itemHolders?.[itemId];
    if (!holder?.startsWith("scene:")) continue;
    const place = places.find((p) => p.id === holder.slice("scene:".length));
    if (place?.setting?.includes(`[${itemId}]`)) return true;
  }
  return false;
}

async function acceptWithoutModel(
  session: Session,
  phase: ResolutionPhase,
  perceiversMode: FastPathMode
): Promise<boolean> {
  if (session.unskippable.has(phase)) return false;
  const { context, draft } = session;
  if (phase === "endings") {
    const modes = await decideEndingModes(context);
    return (
      modes !== null &&
      acceptPayload(
        session,
        phase,
        modes,
        "every ending is words alone or no new result"
      )
    );
  }
  if (CHANGE_PHASES.has(phase)) {
    if (noOutcomeEnding(draft)) {
      return acceptPayload(session, phase, [], "no ending carries an outcome");
    }
    if (phase === "sceneChanges" && sceneChangesOwed(session)) return false;
    session.unchanged ??= await decideUnchangedPhases(context, draft);
    return (
      session.unchanged.has(phase as ChangePhase) &&
      acceptPayload(session, phase, [], "no outcome changes this domain")
    );
  }
  if (phase === "occurrences" && perceiversMode === "on") {
    if (!noOutcomeEnding(draft)) return false;
    const rows = await decidePerceivers(
      context,
      speechRows(context, draft.endings ?? [])
    );
    return (
      rows !== null &&
      acceptPayload(
        session,
        phase,
        rows,
        "speech rows by code, perceivers by Decisions"
      )
    );
  }
  return false;
}

/** DECISIONS_PHASE_SKIP / DECISIONS_PERCEIVERS shadow: the LLM answered;
 *  record what the fast path would have said and whether it agreed. */
async function recordPhaseShadow(
  session: Session,
  phase: ResolutionPhase,
  skipMode: FastPathMode,
  perceiversMode: FastPathMode
): Promise<void> {
  const { context, draft } = session;
  const tick = context.tick.tickId;
  if (skipMode === "shadow") {
    if (phase === "endings") {
      const modes = await decideEndingModes(context);
      if (modes) {
        const llm = new Map(
          (draft.endings ?? []).map((d) => [d.actionId, d.mode])
        );
        recordShadow("DECISIONS_PHASE_SKIP", {
          tick,
          phase,
          predicted: modes,
          agree: modes.every((m) => llm.get(m.actionId) === m.mode),
        });
      }
    } else if (CHANGE_PHASES.has(phase)) {
      let predicted = noOutcomeEnding(draft);
      if (!predicted) {
        session.unchanged ??= await decideUnchangedPhases(context, draft);
        predicted = session.unchanged.has(phase as ChangePhase);
      }
      if (predicted) {
        const accepted = draft[draftKey(phase)];
        const rows = Array.isArray(accepted) ? accepted.length : 0;
        recordShadow("DECISIONS_PHASE_SKIP", {
          tick,
          phase,
          rows,
          agree: rows === 0,
        });
      }
    }
  }
  if (perceiversMode === "shadow" && phase === "occurrences") {
    const llmRows = draft.occurrences ?? [];
    if (llmRows.length === 0) return;
    const decided = await decidePerceivers(
      context,
      llmRows.map((r) => ({ ...r, perceivers: [] }))
    );
    if (!decided) return;
    let pairs = 0;
    let agree = 0;
    llmRows.forEach((row, i) => {
      const llm = new Map(
        row.perceivers.map((p) => [p.characterId, `${p.sight}/${p.hearing}`])
      );
      const ours = new Map(
        decided[i].perceivers.map((p) => [
          p.characterId,
          `${p.sight}/${p.hearing}`,
        ])
      );
      for (const id of new Set([...llm.keys(), ...ours.keys()])) {
        pairs += 1;
        if (llm.get(id) === ours.get(id)) agree += 1;
      }
    });
    recordShadow("DECISIONS_PERCEIVERS", { tick, pairs, agree });
  }
}

/** Segments rendered once per session: the context is phase-neutral, so
 *  every request of the session carries the same two cached blocks. */
type ContextSegments = ReturnType<typeof renderContextSegments>;

/** The draft key a phase's accepted array is stored under. `PHASE_FIELDS` is
 *  typed `Record<ResolutionPhase, string>`, so the one cast lives here. */
function draftKey(phase: ResolutionPhase): keyof AcceptedResolutionDraft {
  return PHASE_FIELDS[phase] as keyof AcceptedResolutionDraft;
}

/** Discard the phase and every phase after it, within THIS session's own
 *  phase list — not the global six — since a settlement session never ran
 *  `starts` and must not be asked to discard a phase it never had. Earlier
 *  phases stay accepted. */
function discardFrom(session: Session, phase: ResolutionPhase): void {
  for (const later of session.phases.slice(session.phases.indexOf(phase))) {
    delete session.draft[draftKey(later)];
  }
}

type PhaseOutcome =
  | { accepted: true }
  | { accepted: false; failed: WorldActionEngineResult }
  /** The model answered without perceivers and Decisions could not fill
   *  them: ask the phase again with the full tool. */
  | { accepted: false; perceiversFailed: true };

/** Appended to the occurrences instruction when code decides perceivers.
 *  After the cached blocks, so the shared prefix is unchanged. */
const PERCEIVERS_BY_CODE_NOTE = `## Perceivers are decided by code in this session

Do not write \`perceivers\` on any row — the tool does not take them. After you submit, code decides who perceives each row and how clearly, from where everyone is. Write each row's \`content\` at full objective detail, and still split rows only where different audiences receive different FACTS. A \`sanityChecks\` entry names someone you expect to perceive the row clearly; code drops it if they turn out not to.`;

// ==================== The runner ====================

export async function resolveTick(
  context: EngineResolutionContext,
  deps: WorldActionEngineDeps
): Promise<WorldActionEngineResult> {
  const tickId = context.tick.tickId;
  const kind = sessionKindOf(context);
  if (kind === "mixed") {
    return unusable(
      `${tickId}: a context that both starts and settles actions asks for two sessions at once — the orchestrator judges starts the minute they arrive and settlements a minute later, never together; nothing applied`,
      [],
      []
    );
  }
  const session: Session = {
    kind,
    phases: SESSION_PHASES[kind],
    context,
    deps,
    draft: {},
    calls: 0,
    rewinds: 0,
    invocations: [],
    noticedDowngrade: false,
    unskippable: new Set(),
    perceiversByCode: false,
  };
  const segments = renderContextSegments(context);
  const skipMode = fastPathMode("DECISIONS_PHASE_SKIP");
  const perceiversMode = fastPathMode("DECISIONS_PERCEIVERS");
  session.perceiversByCode = kind === "settlement" && perceiversMode === "on";

  let from: ResolutionPhase = session.phases[0];
  let globalErrors: ResolutionError[] | undefined;

  for (;;) {
    for (const phase of session.phases.slice(session.phases.indexOf(from))) {
      if (
        session.kind === "settlement" &&
        skipMode === "on" &&
        (await acceptWithoutModel(session, phase, perceiversMode))
      ) {
        continue;
      }
      // The global gate's verdict goes to the FIRST request of the rewound
      // phase only: it is why that phase is being decided again. The phases
      // behind it are rerun because the draft they read changed, and they are
      // told nothing — a fault that was not theirs is not theirs to fix.
      let outcome = await runPhase(
        session,
        segments,
        phase,
        phase === from ? globalErrors : undefined
      );
      if (!outcome.accepted && "perceiversFailed" in outcome) {
        console.warn(
          `[WorldActionEngine] tick ${tickId}: Decisions could not decide who perceives the occurrences; asking the model for them`
        );
        session.perceiversByCode = false;
        outcome = await runPhase(
          session,
          segments,
          phase,
          phase === from ? globalErrors : undefined
        );
      }
      if (!outcome.accepted) {
        return "failed" in outcome
          ? outcome.failed
          : unusable(
              `${tickId}: occurrences could not be given perceivers, nothing applied`,
              [],
              session.invocations
            );
      }
      if (session.kind === "settlement") {
        await recordPhaseShadow(session, phase, skipMode, perceiversMode);
      }
    }

    // Every phase of the session accepted. The assembled draft is judged
    // whole by the same gate as before — every phase-local check is a subset
    // of it, and it is the only authority that lets a resolution reach the
    // Applier.
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
    from = rewindPhaseFor(errors, context, session.kind);
    discardFrom(session, from);
    for (const later of session.phases.slice(session.phases.indexOf(from))) {
      session.unskippable.add(later);
    }
    if (from === "endings") session.unchanged = undefined;
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
        ...(phase === "occurrences" && session.perceiversByCode
          ? [{ kind: "text" as const, text: PERCEIVERS_BY_CODE_NOTE }]
          : []),
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
    // DECISIONS_PERCEIVERS=on: the rows arrive without perceivers; code and
    // Decisions fill them in before anything judges the rows.
    let rows = merged;
    if (
      phase === "occurrences" &&
      session.perceiversByCode &&
      Array.isArray(rows)
    ) {
      const filled = await withDecidedPerceivers(
        context,
        rows as RawOccurrence[]
      );
      if (!filled) return { accepted: false, perceiversFailed: true };
      rows = filled;
    }
    const payload =
      rows !== undefined ? { [PHASE_FIELDS[phase]]: rows } : call.args;
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
    if (MERGE_PHASES.has(phase) && rows !== undefined) {
      const split = retainedRows(phase, rows, context, session.draft);
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
