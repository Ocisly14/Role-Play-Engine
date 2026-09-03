// src/engine/resolution/worldActionEngine.ts
//
// The unified World Action Engine session (plan Phase 7). Called once per
// triggered tick with the full EngineResolutionContext. Runs an agentic loop:
// the model may consult the deterministic damage dice (a roll must never be
// the model's) and must finish with
// one terminal `submit_resolution` call. Output is validated in code and gets
// up to three incremental repair rounds; if it remains invalid, the whole tick
// is rejected without partial application. No action types or per-action
// prompts — one ordered set of world-rule modules governs everything.

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
  refusedWithdrawals,
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

/** The root contract, followed by its rule modules in the order the root
 *  names them. The root says "load these documents in this order"; this is
 *  the code that does. A module that is missing is a fault worth a warning,
 *  not a silent gap — the root's list and this list are one contract. */
const RULE_MODULES = [
  "world/action-adjudication.md",
  "world/movement-and-position.md",
  "world/character-changes.md",
  "world/item-changes.md",
  "world/scene-changes.md",
  "world/perception.md",
  "world/occurrences-and-dialogue.md",
] as const;
const RULES_DOC = [
  loadRuleFile(
    "world-action-resolution.md",
    "Resolve all actions under strict causality, state constraints, locality, engine-owned timing, conservation, roll-first assessment, concurrency consistency, minimal change, and fact/perception separation."
  ),
  ...RULE_MODULES.map((name) => loadRuleFile(name, "")),
]
  .filter((doc) => doc.trim().length > 0)
  .join("\n\n");
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
 * The ways out of the place the actor is standing in, each marked open or
 * closed — code's answer, put beside the command that might need it.
 *
 * Passability is never the model's call: the movement runtime walks the
 * stated route and interrupts it with a `blocked:` reason the moment a closed
 * edge is actually reached. But with the Blocked Connections table in front
 * of it and nothing saying what the table was FOR, the model cross-referenced
 * routes against it by place name — read "lodge_drive ↔ porch is closed" as
 * "the porch is closed", and ended a walk from the greatroom to the porch as
 * weather-blocked when that door was open. Listing the actor's own exits with
 * their state removes the lookup, and with it the misreading.
 */
export function exitsFromHere(
  context: Pick<EngineResolutionContext, "state">,
  actorId: string
): Array<{ to: string; open: boolean; reason?: string }> | undefined {
  const here = context.state.characters.find(
    (c) => c.id === actorId
  )?.locationId;
  if (!here) return undefined;
  const place = context.state.places.find((p) => p.id === here);
  if (!place) return undefined;
  const blocked = new Map<string, string>();
  for (const e of context.state.blockedEdges) {
    blocked.set(`${e.from}|${e.to}`, e.reason);
    blocked.set(`${e.to}|${e.from}`, e.reason);
  }
  return place.connections
    .filter((c) => !c.hidden)
    .map((c) => {
      const reason = c.blockedReason ?? blocked.get(`${here}|${c.targetId}`);
      return reason
        ? { to: c.targetId, open: false, reason }
        : { to: c.targetId, open: true };
    });
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

  const newCommands = context.actions.newCommands.map((command) => {
    const exits = exitsFromHere(context, command.actorId);
    return {
      actionId: actionIdForCommand(command.commandId),
      ...commandForPrompt(command),
      ...(exits ? { exitsFromHere: exits } : {}),
    };
  });
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
      "Blocked Connections (exact passages only, world-wide, for narrating consequences — a place named here is NOT itself closed, only the one edge between the two named places is; every edge not listed is open; whether a stated route can be walked is code's call, see exitsFromHere on each command)",
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
        note: "`starting` and `ending` are the ids you must answer, and they are the only ones. `stillRunning` is FYI: those actions keep running by themselves and take no entry. Every id under `starting` gets a `starting` entry. Every id under `ending` is answered ONE of two ways: (a) an `ending` entry with an `outcome` paragraph, cited by at least one occurrence — for anything that was done; or (b) no ending entry, just one occurrence with speech true citing it — for an action that was nothing but words said. `endingWithUtterance` lists the ending actions whose command carries an `utterance`: for these, code attaches the words to your speech row verbatim — never restate them, write in `content` what the words were NOT. If such an action also did something with its hands, that is a second row with speech false, and then it takes an ending entry too. A `diceRoll` on an action row is what code rolled, and it is INPUT — write the outcome consistent with it, never contradict it. `startingWithoutSkill` lists actors who declared no skill: those actions take no `check` at all, however obviously one seems called for — the actor chose to stake nothing, and it is settled on its own merits. `replaced` lists endings the actor themselves cut short by issuing a new command this tick (the one in `starting` with a matching `replacesActionId`): account for what was done up to this minute and stop there — never narrate how it would have finished, and never let it and its successor both happen in full.",
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
    "Resolve now. Unless a blow lands this tick, your FIRST and ONLY call is submit_resolution. Give every `resolve.starting` id a starting entry. Answer every `resolve.ending` id either with an ending entry plus a speech-false occurrence, or, for pure talk, with a speech-true occurrence and no ending entry. Call damageRoll only for damage that is actually being dealt, with a real formula; there is nothing else to look up.",
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

/**
 * What the model is told when its own arguments did not survive the wire. The
 * alternative was worse than useless: an unreadable call reached the validator
 * as an EMPTY submission, which answered back "you did not answer any of these
 * seven actions" — seven corrections for a mistake the model had not made,
 * pointing it away from the only thing wrong (the JSON it wrote).
 */
function renderUnreadable(toolName: string, rawLength: number): string {
  return [
    `REJECTED. Your \`${toolName}\` arguments (${rawLength} characters) did not arrive as readable JSON — nothing of what you wrote could be applied.`,
    "",
    "Send the same call again. Keep it well-formed: no trailing commas, no raw",
    "newlines inside strings, and every bracket closed. If it was long, say the",
    "same thing more briefly rather than risking the same break.",
  ].join("\n");
}

/**
 * An argument object with no keys at all. Legal JSON, so it slipped past the
 * unreadable-args check and into the validator, which answered "you did not
 * answer any of these seven actions" — the same misleading correction the
 * unreadable case used to produce, for a call that in truth carried nothing.
 * Measured: DeepSeek sends `{}` most often on the turn right after a
 * rejection, and two ticks died in five-round streaks of it.
 */
function renderEmpty(toolName: string): string {
  return [
    `REJECTED. Your \`${toolName}\` call arrived with NO arguments — an empty object, every field missing.`,
    "",
    toolName === "repair_resolution"
      ? "A repair that changes nothing cannot fix anything. Send the elements the last rejection named."
      : "Send the full resolution: every starting id in `starting`; every ending id answered by an ending plus a speech-false occurrence, or by a speech-true occurrence alone when it was pure talk.",
  ].join("\n");
}

/** True when the provider handed back readable JSON that holds nothing. */
function hasNoArgs(call: { args: Record<string, unknown> }): boolean {
  return Object.keys(call.args).length === 0;
}

/** The errors, addressed, plus the instruction that repair is incremental. */
function renderErrors(errors: ResolutionError[], notes: string[] = []): string {
  // Withdrawal is offered only where it is the right move — an element that
  // should not have been sent at all. Advertised under every rejection, it
  // reads as a general escape hatch, and the model reached for it to fix a
  // DUPLICATED triggering action: the copy went away, the answer went with
  // it, and three rounds later the tick was dropped for an action nobody had
  // answered. An error about an action the trigger requires is never one that
  // `remove` fixes.
  const withdrawable = errors.some(
    (e) =>
      e.target.kind !== "action" || e.message.startsWith("unknown actionId")
  );
  return [
    "REJECTED. Fix ONLY these, with repair_resolution:",
    ...errors.map((e) => `- ${formatErrorTarget(e.target)} — ${e.message}`),
    ...notes.map((n) => `- ${n}`),
    "",
    "Send only the elements listed above, as arrays in the same shape you submitted.",
    "An action carries its actionId; an occurrence row carries its",
    "actionIds and REPLACES every row of yours that cites any of them, so",
    "re-send the whole corrected row; a delta carries the `index` quoted",
    "above. Everything you do not mention stays as you submitted it: do not re-send correct parts or the whole resolution.",
    "An action sent once",
    "replaces every copy of that actionId, so a duplicate is fixed by sending",
    "it once in the list it belongs in.",
    ...(withdrawable
      ? [
          "To take an element back rather than fix it, send `remove: true` with",
          "its address and nothing else.",
        ]
      : []),
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
  // Every action the trigger demands an answer for. Held here because a repair
  // round has to know which withdrawals it must refuse.
  const worklist = resolutionWorklist(context);
  const requiredActionIds = new Set([...worklist.starting, ...worklist.ending]);
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
      // A repair round demands `repair_resolution` through toolChoice, and
      // gets it from a provider that honours toolChoice. DeepSeek does not
      // always: measured, it answered two repair rounds with a full
      // `submit_resolution` — carrying, both times, exactly the corrections
      // that had been asked for. Dropping the tick over the envelope threw
      // away a right answer. A whole submission IS a repair, of the widest
      // kind: it replaces everything.
      const repairCall =
        toolCalls.find((c) => c.name === "repair_resolution") ??
        toolCalls.find((c) => c.name === "submit_resolution");
      if (!repairCall) {
        return unusable(
          `${context.tick.tickId}: expected a repair, got none — nothing applied`,
          [],
          deps.codeTools.drainInvocations()
        );
      }
      if (repairCall.unreadableArgs || hasNoArgs(repairCall)) {
        messages.push(assistantMessage);
        messages.push({
          role: "tool",
          results: [
            {
              toolCallId: repairCall.id,
              content: repairCall.unreadableArgs
                ? renderUnreadable(
                    repairCall.name,
                    repairCall.unreadableArgs.rawLength
                  )
                : renderEmpty(repairCall.name),
            },
          ],
        });
        continue;
      }
      const repairArgs = repairCall.args as unknown as RawResolutionRepair;
      const refused =
        repairCall.name === "submit_resolution"
          ? []
          : refusedWithdrawals(repairArgs, requiredActionIds);
      pending =
        repairCall.name === "submit_resolution"
          ? normalizeRawResolution(
              repairCall.args as unknown as RawTickResolution
            )
          : applyRepair(pending, repairArgs, requiredActionIds);
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
        results: [
          {
            toolCallId: repairCall.id,
            content: renderErrors(
              errors,
              refused.map(
                (id) =>
                  `action:${id} — your withdrawal was refused: the trigger requires an answer for this action. Send it once, in the list it belongs in.`
              )
            ),
          },
        ],
      });
      continue;
    }

    const submits = toolCalls.filter((c) => c.name === "submit_resolution");
    const codeCalls = toolCalls.filter((c) => CODE_TOOL_NAMES.has(c.name));

    // ---- first clean submission -----------------------------------------
    if (submits.length === 1 && codeCalls.length === 0) {
      if (submits[0].unreadableArgs || hasNoArgs(submits[0])) {
        messages.push(assistantMessage);
        messages.push({
          role: "tool",
          results: [
            {
              toolCallId: submits[0].id,
              content: submits[0].unreadableArgs
                ? renderUnreadable(
                    submits[0].name,
                    submits[0].unreadableArgs.rawLength
                  )
                : renderEmpty(submits[0].name),
            },
          ],
        });
        continue;
      }
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
