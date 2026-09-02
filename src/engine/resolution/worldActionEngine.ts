// src/engine/resolution/worldActionEngine.ts
//
// The unified World Action Engine session (plan Phase 7). Called once per
// triggered tick with the full EngineResolutionContext. Runs an agentic loop:
// the model may consult the deterministic damage dice (a roll must never be
// the model's) and must finish with
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
import type {
  ActionCommand,
  ResolvedCheck,
  SkillRollRecord,
} from "../actions/types.js";
import {
  buildSkillCatalogPrompt,
  renderSkillGuidance,
} from "../rules/skillReference.js";
import type { CodeToolRegistry } from "../tools/codeTool.js";
import {
  type EngineResolutionContext,
  type ResolutionError,
  type WorldActionEngineResult,
  type WorldGraph,
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

/**
 * Hard ceiling on turns in one session — repair rounds included, since they
 * run in the same loop.
 *
 * 5, down from 8. Measured over two 30-tick full-town runs: at 8 the failing
 * sessions spent every turn fanning out optional tool calls and applied
 * nothing, at ~65k of full-world context per wasted turn — four such ticks
 * were half of that run's entire token spend. Cutting to 3 removed that waste
 * but starved two ticks that needed a fourth turn, so the failure count did
 * not move: 5 either way, for opposite reasons.
 *
 * 5 is the worst honest path — one turn of tools, one submission, three
 * repairs — and costs nothing on the common path, where the median session
 * still finishes in under two turns.
 */
const MAX_ITERATIONS = 5;
/**
 * How many repair rounds a submission gets before the session gives up.
 *
 * Each round is a full-world request, so this is a real cost ceiling — but a
 * contract the Engine cannot satisfy in a few targeted fixes is a fault to
 * surface, not something to grind at.
 */
const MAX_REPAIR_ROUNDS = 3;
const CODE_TOOL_NAMES = new Set(CODE_TOOL_SPECS.map((t) => t.name));

// ── Rule documents: loaded once. Instructional prose lives in
//    src/engine/rules/*.md — editable without touching code. The build
//    ships TS only, so fall back to the repo-relative path when the
//    URL-relative read misses. ──
function loadRuleFile(name: string, fallback: string): string {
  const candidates = [
    new URL(`../rules/${name}`, import.meta.url),
    `${process.cwd()}/src/engine/rules/${name}`,
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // try next
    }
  }
  console.warn(`[WorldActionEngine] ${name} not found; using embedded summary`);
  return fallback;
}

const RULES_DOC = loadRuleFile(
  "world-action-resolution.md",
  "Resolve all actions under strict causality, state constraints, locality, engine-owned timing, conservation, roll-first assessment, concurrency consistency, minimal change, and fact/perception separation."
);
const SANITY_RULES_DOC = loadRuleFile(
  "sanity-check.md",
  "Sanity checks are involuntary and rare. Declare one under an occurrence's `sanityChecks` naming a character who perceived a concrete horror, with the failure loss and the consequence they will carry. Code rolls it; a passed check costs nothing."
);
/** The turn budget is a code constant and a prompt sentence at once. The
 *  document names it with a placeholder so the two cannot drift: a model told
 *  it has four turns when the guard fires at three would spend the difference
 *  every tick, and nobody would see it in either place alone. */
const SESSION_PROTOCOL = loadRuleFile(
  "session-protocol.md",
  "Ground the resolution with the deterministic tools where needed; finish with exactly one submit_resolution answering every worklist id."
).replaceAll("{{MAX_ITERATIONS}}", String(MAX_ITERATIONS));

const SYSTEM_PROMPT = `You are the World Action Engine of a tick-based Call of Cthulhu world
simulation. You are the sole authority on what actually happens: characters
submitted intent (ActionCommands). You decide how long each action should
take, how hard it is, and what it does to the world — for ALL new and
in-flight actions on one shared world snapshot. You do not decide how much
time passed, whether an action is finished, or whether a check was passed:
code owns the clock and the dice, and hands you their results.

${RULES_DOC}

${SANITY_RULES_DOC}

${SESSION_PROTOCOL}

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
/** The roll code made, as the Engine reads it. Named for what it is — dice —
 *  and not for what it decides: rendered as `checkOutcome`, the Engine kept
 *  echoing it back as the ending's `outcome`, the one field an ending with a
 *  check must not carry (a third of checked solo endings in a measured run).
 *  `met` stays because it is the one bit the Engine cannot safely derive
 *  itself — the success ladder and the tie-to-defender rule live in code.
 *  `fumble` goes: it is `actor.successLevel === "fumble"`, already visible.
 *  Roll ids are bookkeeping and mean nothing to the reader. */
function diceRollForPrompt(check: ResolvedCheck) {
  const strip = ({ rollId: _, ...record }: SkillRollRecord) => record;
  return {
    actor: strip(check.actor),
    requiredLevel: check.requiredLevel,
    ...(check.defenders
      ? {
          defenders: check.defenders.map((d) => ({
            characterId: d.characterId,
            record: strip(d.record),
            actorWon: d.actorWon,
          })),
        }
      : {}),
    met: check.met,
  };
}

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
 * minute goes LAST. Since the two-tier context (M3) the stable half is the
 * world SKELETON — macro locations + geography as a compact adjacency list,
 * no prose — which only changes when an edge is revealed or authored anew;
 * blocked state was moved OUT of it into the volatile Blocked Connections
 * section precisely so a felled tree does not invalidate the cached prefix.
 * The detailed place snapshots and the item list depend on which places this
 * tick's actions involve, so they live in the volatile half with the
 * characters (whom the stamina subsystem moves on most ticks anyway).
 *
 * The model reads titled JSON sections, so nothing about the resolution
 * depends on this order.
 */
/**
 * The skeleton graph in the module's own authoring shape: each node is its
 * prose description plus a `connections:` reference line — the same
 * description-and-references format as the v2 place files and the Tier-2
 * snapshots, so the Engine reads one format everywhere. Junction/road prose
 * is the authored text and already cites its `[connection.*]` ids; the reference
 * line resolves each id to its (lifted) target and travel time.
 */
export function renderWorldGraph(graph: WorldGraph): string {
  const edgesByFrom = new Map<string, WorldGraph["edges"]>();
  for (const edge of graph.edges) {
    const list = edgesByFrom.get(edge.from);
    if (list) list.push(edge);
    else edgesByFrom.set(edge.from, [edge]);
  }
  const renderEdge = (edge: WorldGraph["edges"][number]): string =>
    [
      `[${edge.connectionId}] -> ${edge.to}`,
      ...(edge.travelTimeMinutes !== undefined
        ? [`${edge.travelTimeMinutes}min`]
        : []),
      ...(edge.hidden ? ["(hidden)"] : []),
    ].join(" ");
  const nodeLines = (
    id: string,
    name: string,
    description: string | undefined
  ): string[] => {
    const prose = description?.replace(/\s*\n\s*/g, " ").trim();
    const head = `- ${id} (${name})${prose ? `: ${prose}` : ""}`;
    const edges = edgesByFrom.get(id);
    if (!edges) return [head];
    return [head, `  connections: ${edges.map(renderEdge).join("; ")}`];
  };
  const lines: string[] = [];
  for (const kind of ["scene", "road"] as const) {
    const nodes = graph.places.filter((p) => p.kind === kind);
    if (nodes.length === 0) continue;
    lines.push(kind === "scene" ? "Outdoor node scenes:" : "Roads:");
    for (const node of nodes) {
      lines.push(...nodeLines(node.id, node.name, node.description));
    }
  }
  return lines.join("\n");
}

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
    const { id, command, checkOutcome, ...rest } = action;
    return {
      actionId: id,
      ...rest,
      ...(checkOutcome ? { diceRoll: diceRollForPrompt(checkOutcome) } : {}),
      command: commandForPrompt(command),
    };
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
    `## World Graph (skeleton: macro locations + geography, each as description + connection references; interior scenes appear only under Detailed Places; the [connectionId] references are what connectionBlock/connectionHidden take)\n${renderWorldGraph(context.state.graph)}`,
  ].join("\n\n");

  const volatile = [
    section(
      "Blocked Connections (currently impassable edges, world-wide; empty means everything is passable)",
      context.state.blockedEdges
    ),
    section(
      "Detailed Places (the places involved this tick; hidden items/exits are invisible to characters until revealed)",
      context.state.places
    ),
    section(
      "Vehicles (movable interiors: boarding = a `position` change into interiorSceneId; driving = movement.vehicleId with the route; the vehicle stands at `position` until driven)",
      context.state.vehicles ?? []
    ),
    section(
      "Items (at the involved places and in the actors' hands)",
      context.state.items
    ),
    section("Characters", context.state.characters),
    section("Trigger", {
      ...context.trigger,
      resolve: {
        ...worklist,
        note: "`starting` and `ending` are the ids you must answer, in those lists, and they are the only ones. `stillRunning` is FYI: those actions keep running by themselves and take no entry. `endingNeedsOutcome` lists in-flight actions that carried no check — if one ends, you supply `outcome`. Every other ending carries a `diceRoll` on its action row: that is what code rolled, and it is INPUT — never copy it into an `outcome` field. `startingWithoutSkill` lists actors who declared no skill: those actions take no `check` at all, however obviously one seems called for — the actor chose to stake nothing, and it is settled on its own merits. `replaced` lists endings the actor themselves cut short by issuing a new command this tick (the one in `starting` with a matching `replacesActionId`): account for what was done up to this minute and stop there — never narrate how it would have finished, and never let it and its successor both happen in full.",
      },
    }),
    section("Tick", context.tick),
    section("New Commands (this tick)", newCommands),
    section("Active Actions (in flight)", activeActions),
    section("Objective Events (already effective)", context.events),
    ...(skillGuidance.length > 0
      ? [`## Declared Skill Guidance\n\n${skillGuidance.join("\n\n---\n\n")}`]
      : []),
    // The old closing — "consult tools as needed, then submit" — read as
    // "first a tool turn, then the submission". About one session in fourteen
    // took it literally: a `damageRoll("0")` that rolled nothing, and then a
    // submission written with that turn in its history, which arrived
    // malformed three times out of four. Nearly every tick has no damage to
    // roll, so the first call is the submission.
    "Resolve now. Unless a blow lands this tick, your FIRST and ONLY call is submit_resolution — every id under the trigger's `resolve.starting` and `resolve.ending` placed in that list. Call damageRoll only for damage that is actually being dealt, with a real formula; there is nothing else to look up.",
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
  // The submission under repair, and how many repair rounds it has had.
  let pending: RawTickResolution | undefined;
  let repairRounds = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const repairing = pending !== undefined;
    let toolCalls: Awaited<ReturnType<typeof generateToolCalls>>["toolCalls"];
    let assistantMessage: ModelMessage;
    try {
      const res = await generateToolCalls({
        customSystemPrompt: SYSTEM_PROMPT,
        cacheSystemPrompt: true,
        messages,
        tools,
        // Once a submission exists, the only move left is to patch it.
        toolChoice: repairing ? { name: "repair_resolution" } : "any",
        // Parallel calls only while the model still has a choice of tool.
        // Once `toolChoice` names one, a second copy of it is the only other
        // thing a parallel turn can produce — and the intake below takes a
        // submission ONLY when it arrives alone, so both copies were
        // rejected and the turn was spent for nothing. Measured live: the
        // demanded submission came back twice, both refused, and the tick
        // paid another full-world round trip (~65k tokens) to send the same
        // thing again by itself.
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
      const errors = validateRawResolution(pending, context);
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
      const errors = validateRawResolution(raw, context);
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
        const actionId =
          typeof call.args.actionId === "string"
            ? call.args.actionId
            : undefined;
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
