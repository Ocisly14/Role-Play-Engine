// src/engine/resolution/worldResolutionStagePrompts.ts
//
// Everything the World Action Engine says to the model, and nothing that
// decides anything. The Engine has two functions, each a session of its own:
// the start judgement (one phase, `starts`, run the minute a command arrives)
// and the settlement (`endings`, `characterChanges`, `itemChanges`,
// `sceneChanges`, `occurrences`, run when actions end). Every phase is its own
// request with ONLY its own submission tool, so each needs its own narrow
// system prompt and its own closing demand. The world context itself is
// phase-neutral: the same two segments are sent to every phase of a session
// (the cache layout below is the reason), and only this file's per-phase
// blocks differ.
//
// Every string rendered here is English. The world's own prose travels inside
// the context JSON and may be any language — that is data, not instruction.

import { readFileSync } from "node:fs";
import { actionIdForCommand } from "../actions/actionStore.js";
import type {
  ActionCommand,
  ResolvedCheck,
  SkillRollRecord,
} from "../actions/types.js";
import {
  CHECK_NEED_RULE,
  SURROUNDINGS_MEANING,
  TALK_DURATION_RULE,
  renderEndingModes,
} from "../rules/ruleTerms.js";
import { catalogSkillName } from "../rules/skillCatalog.js";
import {
  buildSkillCatalogPrompt,
  renderSkillGuidance,
} from "../rules/skillReference.js";
import {
  type EngineResolutionContext,
  type ResolutionError,
  type WorldGraph,
  formatErrorTarget,
} from "./types.js";
import {
  buildLookup,
  exitsFromHere,
  resolutionWorklist,
} from "./worldDeltaValidator.js";
import {
  type AcceptedResolutionDraft,
  PHASE_FIELDS,
  PHASE_TOOL_NAMES,
  type ResolutionPhase,
  sessionOfPhase,
  sessionPhasesOf,
} from "./worldResolutionStageSchemas.js";
import {
  MERGE_PHASES,
  occurrenceObligations,
  unansweredStarts,
  unmetOccurrenceObligations,
} from "./worldResolutionStageValidator.js";

// ==================== Rule documents ====================

// ── Rule documents: loaded once. Instructional prose lives in
//    src/engine/rules/*.md — editable without touching code. The build
//    ships TS only, so fall back to the repo-relative path when the
//    URL-relative read misses. ──
export function loadRuleFile(name: string, fallback: string): string {
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

/** The root contract. Present in EVERY phase — it is the only document that
 *  is, because its invariants (causality, conservation, minimal change, fact
 *  versus perception) are what every phase is judged against. The domain
 *  modules are selected per phase below. */
const ROOT_CONTRACT = loadRuleFile(
  "world-action-resolution.md",
  "Resolve all actions under strict causality, state constraints, locality, engine-owned timing, conservation, roll-first assessment, concurrency consistency, minimal change, and fact/perception separation."
);

/**
 * Which world-rule modules each phase reads.
 *
 * A phase is not shown the modules it cannot act on. The old single session
 * carried all seven at once because it answered all six domains at once; a
 * phase that can only submit item changes has no use for the perception rules,
 * and the request is re-sent on every turn, so an unread module is paid for
 * every time. The root contract above rides along with all of them.
 */
const PHASE_RULE_MODULES: Record<ResolutionPhase, readonly string[]> = {
  endings: ["world/action-adjudication.md"],
  starts: ["world/action-adjudication.md", "world/movement-and-position.md"],
  // Movement rides along with the character changes because
  // `character-changes.md` delegates to it by name: `position` is "non-travel
  // displacement only; follow movement-and-position.md". Without it in the
  // request the phase is told to follow a document it cannot read — and the
  // root contract now says an absent module is never a gap to fill by
  // guessing, so the delegation would simply dead-end.
  characterChanges: [
    "world/character-changes.md",
    "world/movement-and-position.md",
  ],
  itemChanges: ["world/item-changes.md"],
  sceneChanges: ["world/scene-changes.md"],
  occurrences: [
    "world/perception.md",
    "world/occurrences-and-dialogue.md",
    "sanity-check.md",
  ],
};

/** Only the two phases that judge an ATTEMPT need the skill boundaries: what
 *  a declared skill does and does not cover. A change or an occurrence records
 *  a settled result and never picks a skill. */
const PHASES_WITH_SKILL_CATALOG: ReadonlySet<ResolutionPhase> = new Set([
  "endings",
  "starts",
]);

/** Every module named by any phase, loaded once at module load. A module that
 *  is missing is a fault worth a warning, not a silent gap — the root's list
 *  and these lists are one contract. */
const RULE_MODULE_TEXT = new Map<string, string>(
  [...new Set(Object.values(PHASE_RULE_MODULES).flat())].map((name) => [
    name,
    loadRuleFile(name, ""),
  ])
);

/** The transport contract, shared by all six phases and deliberately naming
 *  no tool: it says "this phase's submission tool", and the phase contract
 *  below is what names it. A phase prompt that mentioned another phase's tool
 *  would be an invitation to call it.
 *
 *  The call budget is a code constant and a prompt sentence at once. The
 *  document names both numbers with placeholders so the two cannot drift: a
 *  model told it has four attempts when the guard fires at three would spend
 *  the difference every tick, and nobody would see it in either place alone. */
const PHASE_PROTOCOL = loadRuleFile(
  "session-protocol.md",
  "You are in one phase of one of the Engine's two functions — the start judgement (one phase) or the settlement (five). Call only this phase's submission tool, exactly once, with its complete array; `[]` when the domain is empty. Everything accepted in an earlier phase is a read-only fact. There is no patch tool: a rejected starts or occurrences phase sends only what the rejection lists as still owed, which code merges with the rows it kept; every other rejected phase sends the complete array again."
);

const SKILL_CATALOG_SECTION = `## Skill catalog

What each declarable skill covers — the boundary knowledge for deciding
whether to check the skill the actor declared at all. An action outside a
skill's coverage simply gets no \`check\`: the skill grants nothing and the
action is settled on its own merits. Never raise the bar instead. Declared
skills additionally get full guidance in the request context.

${buildSkillCatalogPrompt()}`;

// ==================== Phase vocabulary ====================

/** How a phase is named to the model, in the prompt's own voice. */
const PHASE_TITLES: Record<ResolutionPhase, string> = {
  endings: "ENDINGS",
  starts: "STARTS",
  characterChanges: "CHARACTER CHANGES",
  itemChanges: "ITEM CHANGES",
  sceneChanges: "SCENE CHANGES",
  occurrences: "OCCURRENCES",
};

/** Position of a phase within ITS session: the start judgement is one
 *  phase, the settlement five. */
function phaseNumber(phase: ResolutionPhase): number {
  return sessionPhasesOf(phase).indexOf(phase) + 1;
}

function phaseCount(phase: ResolutionPhase): number {
  return sessionPhasesOf(phase).length;
}

/** The session, in the prompt's own voice. */
function sessionName(phase: ResolutionPhase): string {
  return sessionOfPhase(phase) === "start"
    ? "the START JUDGEMENT"
    : "the SETTLEMENT";
}

/** "phase 2 of 5 of the SETTLEMENT — CHARACTER CHANGES": how a request
 *  names itself, everywhere it does. */
function phaseHeading(phase: ResolutionPhase): string {
  return `phase ${phaseNumber(phase)} of ${phaseCount(phase)} of ${sessionName(phase)} — ${PHASE_TITLES[phase]}`;
}

/** `submit_endings`, backticked — written once so no renderer can spell a
 *  tool name by hand. */
function toolRef(phase: ResolutionPhase): string {
  return `\`${PHASE_TOOL_NAMES[phase]}\``;
}

/** The one array that tool carries, backticked. */
function fieldRef(phase: ResolutionPhase): string {
  return `\`${PHASE_FIELDS[phase]}\``;
}

/**
 * The phase's own tool contract: the last thing in its system prompt, and the
 * only place a tool name appears there.
 *
 * Two of the six carry a rule that belongs to no markdown module because it is
 * about the tools rather than the world: damage is rolled and never written
 * (endings), and the clock and the dice are code's (starts).
 */
function phaseToolContract(phase: ResolutionPhase): string {
  // The endings phase is the only one with a code tool beside its submission,
  // so it is the only one whose first sentence can say "two tools". Saying
  // "the only tool" and then describing a second one is exactly the kind of
  // contradiction a model resolves by picking one at random.
  const tools =
    phase === "endings"
      ? `This phase takes two tools and no others: \`damageRoll\`, described below, and ${toolRef(phase)}, which ends the phase and carries exactly one array, ${fieldRef(phase)}.`
      : `The only tool this phase takes is ${toolRef(phase)}, and it carries exactly one array, ${fieldRef(phase)}.`;
  const head = `## This request: ${phaseHeading(phase)}

${tools} Call it once, with the complete array; a phase with nothing to report submits \`[]\`. Nothing else in this request is yours to answer.`;

  switch (phase) {
    case "endings":
      return `${head}

Decide each ending action's objective result or absence of a new result. There are three closed modes: ${renderEndingModes()}. An \`outcome\` for a checked attempt is consistent with the supplied verdict. Its words, if any, still get their own speech row later.

Routine observation, listening or waiting does not create a retrospective result. Events reach their perceivers through occurrences when they happen and are rendered then. At the observer's ending, use \`no_change\` if nothing new needs settling. Do not summarize the interval, repeat events already delivered, or claim "no new information" or "nobody spoke". If the command also caused an actual change (sitting down, moving an item), use \`outcome\` for only that supported change; do not append a report of other people's activity. A checked search may expose a supported clue: state the objective evidence and route it in occurrences, leaving its interpretation to the character.

The Engine describes objective world facts and determines sensory reach; the Renderer supplies the personal perspective. Another person's conduct needs its own established source and time. No pending speech, invented replies, chosen silence, private beliefs or group reactions. An observer's action never executes someone else's command.

### Damage is rolled, never written

If a blow lands this tick, call \`damageRoll\` with the real formula for the weapon, the fall or the wound — every roll for this tick in ONE turn — and write the outcome from what it returns. Never invent, estimate, round or adjust a damage number, and never call the tool with a placeholder or a zero formula. Most ticks have no damage in them; then there is nothing to call and ${toolRef(phase)} is your first and only turn.`;
    case "starts":
      return `${head}

Decide how each action that begins this tick should run — and only that. Nothing has happened yet: no result, no outcome, and no words delivered.

### Code owns the clock and the dice

You set how long an action should take and how hard it is. You do not set whether time passed, whether the action is finished, or how a roll came out. \`resolvedDurationTicks\` is whole minutes, at least 1, and belongs only to a non-travel action — travel time is derived from the route the actor stated.

### Action before speech

Judge the attempt itself. ${TALK_DURATION_RULE} Any structured utterance is delivered when the action ends. Add \`opposedBy\` only for established active resistance to a checked task. Words quoted in \`description\` do not supply an \`utterance\`. Code rolls after this phase and supplies the result at settlement.`;
    case "characterChanges":
      return `${head}

Report the persistent changes this tick's actions make to characters — health, fatigue, position, spot, appearance and conditions — and only those. A result that is merely worth describing, and leaves no state behind, is not a change: it belongs to the occurrence phase, which is not this one.`;
    case "itemChanges":
      return `${head}

Report what this tick's actions do to things — what came into being, what moved and to whom, what stopped existing, and what an item is now like — and only that. Everything here is a persistent fact about an item; a thing merely handled or looked at has not changed.`;
    case "sceneChanges":
      return `${head}

Report what this tick's actions do to places and to the passages between them — conditions, prose, blocked and concealed passages and the environment — and only that. A place's prose is also brought back into agreement here with the items that left it, ceased to exist, or now lie in plain view in it.`;
    case "occurrences":
      return `${head}

Report every objective thing that happened this tick that somebody could perceive, one flat row per fact, tied by \`actionIds\` to the actions it is the trace of. An outcome needs a \`speech:false\` row even if that action also spoke. Every ending command with an utterance additionally needs its own \`speech:true\` row: code supplies the words. These are separate obligations, not competing alternatives. Never cite a no_change ending or replay events as an observer's result. This is the last phase: everything above is decided, and the whole resolution is checked once you submit.`;
  }
}

/**
 * The one instruction that fixes the language of everything this session
 * WRITES. Without it the session had none: it composed in whatever language
 * the surrounding world data leaned toward, which held for most ticks and
 * then produced a whole settlement — every ending and every occurrence — in
 * English inside a Chinese run.
 *
 * This is the narration language, not the tongue the characters speak: a
 * command's `declaredLanguage` and a module's `commonLanguage` are in-world
 * facts and are untouched by it. English is the default, as it is for the
 * renderer and the persona agent, so a module that says nothing gets English.
 */
function languageDirective(narrationLanguage?: string): string {
  const named = narrationLanguage?.startsWith("zh") ? "Chinese" : "English";
  return `Write every string you submit in ${named}: outcomes, occurrence content, condition and appearance prose, item and place descriptions, reasons. This is the language of the telling and it does not change with what you read — the world data in this request may be in any language, and quoted speech keeps the tongue it was spoken in.`;
}

/** The whole system prompt for one phase. `budget` is templated into the
 *  protocol text; Task 4's constants own the numbers. */
export function renderPhaseSystemPrompt(
  phase: ResolutionPhase,
  budget: { maxProviderCalls: number; maxPhaseAttempts: number },
  narrationLanguage?: string
): string {
  const modules = PHASE_RULE_MODULES[phase]
    .map((name) => RULE_MODULE_TEXT.get(name) ?? "")
    .filter((doc) => doc.trim().length > 0);
  const protocol = PHASE_PROTOCOL.replaceAll(
    "{{MAX_PROVIDER_CALLS}}",
    String(budget.maxProviderCalls)
  ).replaceAll("{{MAX_PHASE_ATTEMPTS}}", String(budget.maxPhaseAttempts));

  return [
    languageDirective(narrationLanguage),
    `You are the World Action Engine of a tick-based world simulation. You are the sole authority on what actually happens: characters submitted intent (ActionCommands), and you decide how long each action should take, how hard it is, and what it does to the world — for ALL new and in-flight actions on one shared world snapshot. You do not decide how much time passed, whether an action is finished, or whether a check was passed: code owns the clock and the dice, and hands you their results.

You have two functions, each a session of its own. The START JUDGEMENT is one phase, run the minute a command arrives, before any world time has passed on it: the clock, the bar and the route of every new action. The SETTLEMENT is five phases, run when actions end: what came of them and what that did to the world. This request is ${phaseHeading(phase)}.`,
    ROOT_CONTRACT,
    ...modules,
    ...(PHASES_WITH_SKILL_CATALOG.has(phase) ? [SKILL_CATALOG_SECTION] : []),
    protocol,
    phaseToolContract(phase),
  ].join("\n\n");
}

// ==================== The world context (phase-neutral) ====================

/**
 * One id per action, and it is the one the schema addresses.
 *
 * `actionId` is `action_<commandId>`, and the Trigger section lists exactly
 * those. Printing the raw `commandId` alongside puts a SECOND id for the same
 * action in the same prompt — and the model reasonably echoes the one printed
 * next to the action it is resolving, which then fails lookup as "unknown
 * actionId" and burns every correction round on a mismatch it cannot see. So the
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
export function diceRollForPrompt(check: ResolvedCheck) {
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

export function commandForPrompt(
  command: ActionCommand
): Record<string, unknown> {
  const { commandId: _commandId, declaredSkillId, ...rest } = command;
  const skill = catalogSkillName(declaredSkillId ?? "");
  return { ...rest, ...(skill ? { declaredSkillId: skill } : {}) };
}

/**
 * The skeleton graph as topology only: each node by id and name, plus a
 * `connections:` line resolving each connection id to its (lifted) target and
 * travel time. The node prose used to ride along — 88% of the section, two
 * thirds of a Decisions request — and nothing read it: the involved places
 * carry their full text under Detailed Places.
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
      ...(edge.concealed ? ["(concealed)"] : []),
    ].join(" ");
  const nodeLines = (id: string, name: string): string[] => {
    const head = `- ${id} (${name})`;
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
      lines.push(...nodeLines(node.id, node.name));
    }
  }
  return lines.join("\n");
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
 *
 * PHASE-NEUTRAL: the same two segments go to all six phases, which is what
 * lets the cached prefix survive the whole tick and not just one request. It
 * therefore names no tool and makes no demand — `renderPhaseInstruction`
 * appends the per-phase block after the volatile half.
 */
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
    `## World Graph (skeleton: geography nodes by id and name, each with its connection references; interior scenes and every place's text appear only under Detailed Places; the [connectionId] references are what connectionBlock/connectionConcealed take)\n${renderWorldGraph(context.state.graph)}`,
  ].join("\n\n");

  const volatile = [
    section(
      "Blocked Connections (exact passages only, world-wide, for narrating consequences — a place named here is NOT itself closed, only the one edge between the two named places is; every edge not listed is open; whether a stated route can be walked is code's call, see exitsFromHere on each command)",
      context.state.blockedEdges
    ),
    section(
      "Detailed Places (the places involved this tick; each place's `setting` is the place itself and cites only its fixtures and exits; a loose item carries its `placement`; an item flagged `unnoticed` sits in a `container` and is out of plain view, and a `concealed` exit is physically obscured — characters perceive neither until they notice or find it)",
      context.state.places
    ),
    section(
      "Vehicles (movable interiors: driving = movement.vehicleId with the route, and only for a driver already standing in interiorSceneId when the drive starts — boarding is its own earlier action, a `position` change into the interior when it ends; the vehicle stands at `position` until driven)",
      context.state.vehicles ?? []
    ),
    section(
      "Items (at the involved places and in the actors' hands)",
      context.state.items
    ),
    section("Characters", context.state.characters),
    ...(context.state.surroundings
      ? [
          section(
            `Surroundings (for perception. ${SURROUNDINGS_MEANING})`,
            context.state.surroundings
          ),
        ]
      : []),
    section("Trigger", {
      ...context.trigger,
      resolve: {
        ...worklist,
        // Phase-neutral: what each list MEANS, never which call answers it.
        // The phase instruction that follows the context names the one list
        // this request is about and demands it.
        note: `\`starting\` and \`ending\` are the ids this tick asks about, and they are the only ones. \`stillRunning\` owes no ending entry. These actions stay active; a settlement may record supported intermediate effects without completing their pending steps. Every id under \`starting\` is an action that begins this minute — its time has not been spent, so it has no result yet. Every id under \`ending\` is an action whose time is up, ended in one of three modes: ${renderEndingModes()}. Ordinary observation or waiting needs no retrospective summary. \`endingWithUtterance\` lists the ending actions whose command carries an \`utterance\`: code attaches those exact words verbatim wherever they are delivered — never restate them; what is written about such a moment is what the words were NOT. \`startingWithUtterance\` lists starting actions whose command carries an \`utterance\`: those words are NOT said yet — they are delivered when the action ends (${TALK_DURATION_RULE}), when the id returns under \`endingWithUtterance\`. A \`diceRoll\` on an action row is what code rolled, and it is INPUT — judge consistently with it, never contradict it. \`startingWithoutSkill\` lists actions without a skill in the current catalog. These actions take no check. \`replaced\` lists endings the actor themselves cut short by issuing a new command this tick (the separately submitted successor with a matching \`replacesActionId\`): account for what was done up to this minute and stop there — never narrate how it would have finished, and never let it and its successor both happen in full.`,
      },
    }),
    section("Tick", context.tick),
    section(
      "New Commands (this tick — `utterance` is what the actor will have said when the action ends: it is spoken when the action ends, not on submission, and gets no occurrence yet; `proposedDurationTicks` is advisory)",
      newCommands
    ),
    section("Active Actions (in flight)", activeActions),
    section("Objective Events (already effective)", context.events),
    ...(skillGuidance.length > 0
      ? [`## Declared Skill Guidance\n\n${skillGuidance.join("\n\n---\n\n")}`]
      : []),
  ].join("\n\n");

  return { stable: `${stable}\n\n`, volatile };
}

/** The whole world context as one string. */
export function renderContext(context: EngineResolutionContext): string {
  const { stable, volatile } = renderContextSegments(context);
  return stable + volatile;
}

// ==================== The per-phase instruction ====================

const json = (value: unknown): string => JSON.stringify(value, null, 1);

/**
 * The worklist subset this phase actually answers.
 *
 * The whole worklist is already in the context's Trigger section; this repeats
 * only the part this request owes, immediately before the demand, so the ids
 * the model must cover are the last thing it reads. The two lifecycle phases
 * own a list of ids each; the four downstream phases own no worklist at all —
 * what they need is which action ids EXIST this tick, because those are the
 * only ids a `sourceActionId` or an occurrence's `actionIds` may name, and
 * after the first two phases that set is a decided fact rather than a forecast.
 */
function phaseWorklistSection(
  phase: ResolutionPhase,
  context: EngineResolutionContext,
  draft: AcceptedResolutionDraft
): string {
  if (phase === "endings") {
    const worklist = resolutionWorklist(context);
    return `## The actions ENDING this tick — your worklist\n${json({
      ending: worklist.ending,
      endingWithUtterance: worklist.endingWithUtterance,
      replaced: worklist.replaced,
    })}\n\nAnswer every id under \`ending\` exactly once, and no id that is not there.`;
  }
  if (phase === "starts") {
    const worklist = resolutionWorklist(context);
    return `## The actions STARTING this tick — your worklist\n${json({
      starting: worklist.starting,
      startingWithUtterance: worklist.startingWithUtterance,
      startingWithoutSkill: worklist.startingWithoutSkill,
    })}\n\nGive every id under \`starting\` exactly one entry, and give no entry to an id that is not there.`;
  }
  const endings = draft.endings ?? [];
  // `stillRunning` belongs here even though no phase owes it an entry: a fire
  // that keeps burning, hammering heard from a workshop mid-job, a wound that
  // keeps bleeding — the validator accepts a change or an occurrence sourced to
  // any live action, not only the two the lifecycle phases answered. Listing
  // only the ended and the started ids and calling the set exhaustive told the
  // model to drop exactly those consequences.
  const actions = {
    endedWithOutcome: endings
      .filter((d) => d.mode === "outcome")
      .map((d) => d.actionId),
    endedWithoutNewResult: endings
      .filter((d) => d.mode === "no_change")
      .map((d) => d.actionId),
    endedAsPureSpeech: endings
      .filter((d) => d.mode === "pure_speech")
      .map((d) => d.actionId),
    starting: (draft.starting ?? []).map((s) => s.actionId),
    stillRunning: resolutionWorklist(context).stillRunning,
  };
  return `## The actions of this tick\n${json(
    actions
  )}\n\nThese are the ids of this tick. The ids under \`endedWithoutNewResult\` close without changes or occurrences and MUST NOT be cited. All other listed ids are potential sources. Every id you write — a \`sourceActionId\`, an occurrence's \`actionIds\` — names one of them. \`stillRunning\` owes no ending entry and needs no mention merely to say it continues, but it may be cited when something perceptible or persistent actually came of it this minute.`;
}

/** What each starting action needs from its entry, in the terms the validator
 *  will check: whether the command carries a structured utterance, which skill
 *  it declared (a check is expected where that skill covers the attempt), and
 *  what duration the actor proposed (advisory, but the number the model must
 *  assess rather than skip). Words quoted inside `description` are not an
 *  utterance — measured: a bandaging command whose description quoted "don't
 *  move" was clocked as if it were a spoken line and lost its duration three
 *  times running. Measured too: 39 start entries with one check among them,
 *  because every utterance-bearing command was read as talk. */
function startObligationRows(
  context: EngineResolutionContext,
  actionIds: readonly string[]
) {
  const lookup = buildLookup(context);
  return actionIds.map((actionId) => {
    const command = lookup.actionById.get(actionId)?.command;
    const spoken = Boolean(command?.utterance?.trim());
    const skill = catalogSkillName(command?.declaredSkillId ?? "");
    return {
      actionId,
      actorId: command?.actorId,
      hasUtterance: spoken,
      declaredSkillId: skill ?? null,
      proposedDurationTicks: command?.proposedDurationTicks,
      timing: spoken
        ? `Judge the attempt, not the sentence. Nothing but these words: resolvedDurationTicks 1, no check. Also does something observable: assess its duration. ${CHECK_NEED_RULE} The words land when the action ends. If deliberate travel: movement.route, omit duration.`
        : "If non-travel: resolvedDurationTicks is REQUIRED, integer >= 1; assess the proposed duration. If deliberate travel: movement.route, omit duration. Quoted words in description are not an utterance.",
      ...(skill
        ? {
            check: `A skill was declared. ${CHECK_NEED_RULE} Name supported active resistance to a checked task in opposedBy.`,
          }
        : {}),
    };
  });
}

const START_ROW_RULES =
  "Choose travel only from the actor's stated intent, never to avoid providing duration. Routes contain real place ids from the world graph, never empty strings or placeholders.";

const OCCURRENCE_PAIR_RULES =
  "Each pair means at least one row whose actionIds cites that action and whose speech flag matches. An action appearing with BOTH flags needs separate fact and speech rows; one row cannot satisfy both. This is a coverage checklist, not a limit on additional supported facts. Supply real perceivers and finished content; never substitute placeholder text.";

/** Concrete obligations derived from the same worklist the validator judges.
 * No semantic action classification: only structured utterances and proposed
 * timing are known here; the model still judges whether travel was intended.
 * When the phase owes something, the `[]` permission is not offered: an empty
 * array was the cheapest legal-looking answer and the model reached for it
 * twice in one measured tick with five endings pending. */
function phaseObligations(
  phase: ResolutionPhase,
  context: EngineResolutionContext,
  draft: AcceptedResolutionDraft
): string {
  const worklist = resolutionWorklist(context);
  if (phase === "starts") {
    const rows = startObligationRows(context, worklist.starting);
    return `## Required start entries (${rows.length})\n${json(rows)}\n\n${rows.length ? "Every listed action must be in the array. An empty array is invalid." : "No starts are due; submit an empty array."} ${START_ROW_RULES}`;
  }
  if (phase === "endings") {
    return worklist.ending.length
      ? `All ${worklist.ending.length} ending ids above are mandatory. An empty array is invalid. Use no_change without an outcome for routine observation/waiting with no new result, check or utterance. A mixed command settles only its actual new effects. Do not reconstruct personal experience or claim no new information. Do not execute another active command inside this result. Keep world facts objective and route evidence through occurrences; perspective and interpretation are downstream responsibilities.`
      : "No endings are due; submit an empty array.";
  }
  if (phase === "occurrences") {
    const required = occurrenceObligations(context, draft);
    return `## Required occurrence coverage (${required.length} obligations)\n${json(required)}\n\n${OCCURRENCE_PAIR_RULES} Do not invent replies, chosen silence or group reactions to join these rows. Other people's responses require their own settled source; an absent response is not evidence of silence. An ongoing id may source a supported intermediate attempt, never its entire planned sequence or pending speech. Do not introduce position, transfer or other persistent results missing from the accepted state changes. Preserve earlier events as earlier, not new occurrences. ${required.length ? "An empty array is invalid." : "An empty array is allowed only if nothing else perceptible happened."}`;
  }
  return renderStateChangeCheck(phase);
}

/** Shared closing check for the three phases that reconcile world state. */
export function renderStateChangeCheck(
  phase: "characterChanges" | "itemChanges" | "sceneChanges"
): string {
  const guidance = {
    characterChanges:
      "Compare each accepted outcome with CURRENT character appearance, conditions and position. Repair every existing descriptive claim the outcome made false, even when HP is unchanged, no condition exists, or the visible result is temporary. If bleeding stopped, appearance must no longer say it is bleeding: use `setAppearance`, preserve unrelated details, and do not turn treatment into an unsupported cure. Do not invent a condition or healing delta to stand in for this repair. Each row names its real characterId and sourceActionId.",
    itemChanges:
      "Compare accepted outcomes with CURRENT item holder, existence, description and functional fields separately. A `move` never rewrites description: when a map is folded and taken off a table, submit the transfer AND a `set.description` replacing the claim that it is spread there, preserving material and markings. Do not append a contradiction. Repair item prose here even though the scene phase will repair place prose separately. Preserve conservation: no duplicate ownership or invented supplies. Mere handling with no changed state needs no row. Each row names its sourceActionId.",
    sceneChanges:
      "Compare accepted outcomes AND accepted character and item changes with CURRENT place prose and passages. Repair obsolete claims about placement, visible presence and physical condition, with or without an explicit reference. Correct item ownership or character position does not correct the scene description. Remove a taken map's obsolete table placement while preserving the table and other true details; do not rewrite prose that already matches. A one-use passage grant does not remove the obstacle. Each row names its real sceneId and sourceActionId.",
  };
  return `## This phase's check\n${guidance[phase]} Before submitting, check BOTH structural fields and existing prose against the supported accepted effects and code-applied state. Check source action and timing before treating an outcome clause as a change: an observer's outcome does not settle another actor's pending task. A supported intermediate effect may require a row, but never finish the rest of its ongoing command or apply an earlier effect again. An empty array is allowed only if neither requires an update; absence of a numeric or condition change is not enough. There is no one-row-per-action quota.`;
}

/** The upstream phases' accepted output, verbatim, as the read-only facts they
 *  are. Rendered in phase order so the draft reads as the tick's history in the
 *  order it was decided, and only for phases that were actually accepted: an
 *  absent phase and an accepted empty array are different states, and showing
 *  `[]` for a phase that has not run yet would be a lie the model would build
 *  on. */
function acceptedSoFarSection(
  phase: ResolutionPhase,
  draft: AcceptedResolutionDraft
): string {
  const phases = sessionPhasesOf(phase);
  const upstream = phases
    .slice(0, phases.indexOf(phase))
    .filter((p) => draft[PHASE_FIELDS[p] as keyof AcceptedResolutionDraft]);

  if (upstream.length === 0) {
    return "## Accepted so far (read-only)\n\nNothing precedes this phase: these are the first judgements of this session.";
  }
  const blocks = upstream.map((p) => {
    const field = PHASE_FIELDS[p];
    const value = draft[field as keyof AcceptedResolutionDraft];
    return `### \`${field}\` — accepted in phase ${phaseNumber(p)}\n${json(
      value
    )}`;
  });
  return [
    "## Accepted so far (read-only)",
    "",
    "These arrays have passed the implemented checks and are read-only. Read them and stay consistent with supported accepted effects; do not resubmit earlier arrays and do not try to revise them here. Acceptance is not a semantic guarantee of every sentence. Apply the root evidence and timing boundaries: never expand an unsupported clause into pending speech, another actor's behavior or a new state change. The final validator can rewind faults it detects; do not assume it detects every prose inconsistency.",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}

/** The global gate rejected the assembled resolution and rewound to here. The
 *  model is told what was wrong AND that everything after this phase was thrown
 *  away, because otherwise a phase it already answered correctly looks like it
 *  still stands and the fix gets written as if the later rows were fixed. */
function redoSection(errors: ResolutionError[]): string {
  return [
    "## Why this phase is being redone",
    "",
    "The complete resolution was checked and rejected. These faults are owned by this phase, so it is being decided again; every phase after it was discarded and will be decided again after you.",
    "",
    ...errors.map((e) => `- ${formatErrorTarget(e.target)} — ${e.message}`),
  ].join("\n");
}

/** The closing demand: what belongs in this phase's array, in one paragraph,
 *  naming ONLY this phase's tool and field. */
function phaseDemand(phase: ResolutionPhase): string {
  const call = `Call ${toolRef(phase)} now with ${fieldRef(phase)}`;
  switch (phase) {
    case "endings":
      return `${call}: exactly one decision for every ending id. one of ${renderEndingModes()}; only \`outcome\` carries an outcome. Ordinary observation/waiting ends without a recap of personal experience. Do not reconstruct the interval or execute other active commands. For mixed commands, settle only actual new changes. Roll any actual damage first with real formulas.`;
    case "starts":
      return `${call}: exactly one entry for every id listed under \`starting\` above, and no other id. A non-travel action gets \`resolvedDurationTicks\` in whole minutes, at least 1 (${TALK_DURATION_RULE}); a travel action gets \`movement\` with the route the actor stated (and \`vehicleId\` when they drive) and no duration, because code derives travel time from the route. ${CHECK_NEED_RULE} Ids under \`startingWithoutSkill\` omit \`check\` and \`opposedBy\`. No outcome and no speech: nothing has happened yet.`;
    case "characterChanges":
      return `${call}: one row for every persistent change this tick's actions actually made to a character, each naming its \`sourceActionId\` and \`characterId\`. Only state that CHANGED — a moment worth describing that leaves nothing behind is not a change and is not written here. Nothing changed is \`[]\`.`;
    case "itemChanges":
      return `${call}: one row for every persistent change this tick's actions made to a thing — created, moved, destroyed, or now in a different state — each naming its \`sourceActionId\`. Only what actually changed; an item merely handled or looked at has not changed. Nothing changed is \`[]\`.`;
    case "sceneChanges":
      return `${call}: one row for every persistent change this tick's actions made to a place or a passage, each naming its \`sourceActionId\` and \`sceneId\`. A \`passBlockedConnectionId\` on an accepted start already got that one walker through and leaves the passage shut for everybody else — so it is never paired with \`connectionBlock {blocked:false}\` for the same passage, which says the obstacle itself is gone. Nothing changed is \`[]\`.`;
    case "occurrences":
      return `${call}: one \`speech:false\` row citing every ending decided \`mode: "outcome"\` above, and one \`speech:true\` row for EVERY id under \`endingWithUtterance\`, including endings with an outcome. An action that both spoke and did something needs both rows. Never a speech row for an id that is starting this tick — its words are delivered only when it ends under \`endingWithUtterance\`. Each row states one objective fact at full detail and lists in \`perceivers\` every character the evidence actually reached, with that character's \`sight\` and \`hearing\`; write \`content\` last, after the row's ids and perceivers are settled. Complete every required coverage pair listed above. Never cite a no_change ending, and never add an interval recap for an observer.`;
  }
}

/**
 * The block appended after the volatile context: the worklist this phase
 * answers, the accepted upstream draft as read-only JSON, optionally why the
 * phase is being redone, and the closing demand.
 */
export function renderPhaseInstruction(
  phase: ResolutionPhase,
  context: EngineResolutionContext,
  draft: AcceptedResolutionDraft,
  opts?: { globalErrors?: ResolutionError[] }
): string {
  const globalErrors = opts?.globalErrors ?? [];
  return [
    `# ${phaseHeading(phase).replace(/^phase/, "Phase")}`,
    phaseWorklistSection(phase, context, draft),
    acceptedSoFarSection(phase, draft),
    ...(globalErrors.length > 0 ? [redoSection(globalErrors)] : []),
    phaseObligations(phase, context, draft),
    phaseDemand(phase),
  ].join("\n\n");
}

// ==================== Rejections ====================

/** What a rejection may hand the renderer besides the errors: the world and
 *  draft (to restate this phase's obligations), the payload that was refused,
 *  and — for a merge phase — the rows code kept out of it and the rows it
 *  did not. */
export interface RejectionRepair {
  context: EngineResolutionContext;
  draft: AcceptedResolutionDraft;
  previousPayload: unknown;
  retained?: unknown[];
  faulty?: unknown[];
}

/**
 * Addressed errors plus the contract for the corrective resubmission.
 *
 * Two contracts, by phase. A merge phase (starts, occurrences) is corrected by
 * DIFFERENCE: code has kept every row that passed on its own, says so, and
 * asks only for what is still owed — the merged array is then validated
 * whole. Every other phase is corrected by the COMPLETE array again through
 * the same tool, with the refused payload echoed so the model repairs rather
 * than reinvents. Neither is a patch tool: the tool and its one array never
 * change. What is the same in both is the last sentence — the accepted
 * earlier phases are not in play.
 */
export function renderPhaseRejection(
  phase: ResolutionPhase,
  errors: ResolutionError[],
  repair?: RejectionRepair
): string {
  const head = [
    `REJECTED. Your ${toolRef(phase)} call did not pass validation. Correct these errors:`,
    ...errors.map((e) => `- ${formatErrorTarget(e.target)} — ${e.message}`),
    "",
  ];
  const tail =
    "Nothing accepted in an earlier phase changes, and none of it is resent here.";

  if (repair && MERGE_PHASES.has(phase)) {
    const retained = repair.retained ?? [];
    const faulty = repair.faulty ?? [];
    const kept = retained.length
      ? `## Kept by code (${retained.length} rows) — do NOT resend\nThese rows passed on their own and are already part of this phase's answer. Code merges them with what you send now and validates the whole array again.\n${json(retained)}`
      : "## Kept by code (0 rows)\nNothing in your last answer passed on its own.";
    const refused = faulty.length
      ? `## Refused rows (${faulty.length}) — rewrite or drop\nThese did not pass. Fix the fields the error names, including ids, speech or perceivers when those are wrong; preserve unaffected fields. A refused optional row you leave out is dropped, but mandatory coverage is still owed.\n${json(faulty)}`
      : undefined;
    const owed =
      phase === "starts"
        ? (() => {
            const ids = unansweredStarts(retained, repair.context);
            return `## Still owed — send ONLY these (${ids.length} entries)\n${json(startObligationRows(repair.context, ids))}\n\n${START_ROW_RULES}`;
          })()
        : (() => {
            const pairs = unmetOccurrenceObligations(
              retained,
              repair.context,
              repair.draft
            );
            return `## Still owed — send ONLY these (${pairs.length} coverage pairs${faulty.length ? ", plus any refused row you rewrite" : ""})\n${json(pairs)}\n\n${OCCURRENCE_PAIR_RULES}`;
          })();
    const replaces =
      phase === "starts"
        ? "an entry with a kept row's actionId replaces that row"
        : "kept occurrences are immutable; new facts are appended, and an exact repeat of a kept row is ignored";
    return [
      ...head,
      kept,
      "",
      ...(refused ? [refused, ""] : []),
      owed,
      "",
      `Call ${toolRef(phase)} again with ${fieldRef(phase)} holding the missing required rows and any refused rows you have corrected. Every row you send must be finished — real ids, real perceivers, complete prose, never placeholder text. Code appends what you send to the kept rows (${replaces}) and judges the merged array whole; if that fails, you are shown what was kept again. ${tail}`,
    ].join("\n");
  }

  const preservation =
    phase === "endings"
      ? "Preserve every required action id and exactly one entry per id. Fix fields on the named entry; a missing field is not a reason to delete the action."
      : "Preserve every valid state change. Correct the named change; remove it only when the error identifies it as invalid or unnecessary. No per-action row quota applies.";
  return [
    ...head,
    `Send the COMPLETE ${fieldRef(phase)} array again through ${toolRef(phase)}. There is no patch: this call carries the whole array, not the parts that changed. ${preservation} Keep unaffected content verbatim, not summaries or placeholders. ${tail}`,
    ...(repair
      ? [
          `## Previous candidate to repair (NOT accepted)\n${json(repair.previousPayload)}`,
          phaseObligations(phase, repair.context, repair.draft),
        ]
      : []),
  ].join("\n");
}

/**
 * What the model is told when its own arguments did not survive the wire. The
 * alternative was worse than useless: an unreadable call reached the validator
 * as an EMPTY submission, which answered back "you did not answer any of these
 * seven actions" — seven corrections for a mistake the model had not made,
 * pointing it away from the only thing wrong (the JSON it wrote).
 */
export function renderPhaseUnreadable(
  phase: ResolutionPhase,
  rawLength: number
): string {
  return [
    `REJECTED. Your ${toolRef(phase)} arguments (${rawLength} characters) did not arrive as readable JSON — nothing of what you wrote could be applied.`,
    "",
    "Send the same call again. Keep it well-formed: no trailing commas, no raw",
    "newlines inside strings, and every bracket closed. If it was long, say the",
    "same thing more briefly rather than risking the same break.",
  ].join("\n");
}

/**
 * An argument object with no keys at all. Legal JSON, so it slips past the
 * unreadable-args check and into the validator, which answers "you did not
 * answer any of these seven actions" — the same misleading correction the
 * unreadable case used to produce, for a call that in truth carried nothing.
 * Measured: DeepSeek sends `{}` most often on the turn right after a
 * rejection, and two ticks died in five-round streaks of it.
 */
export function renderPhaseEmpty(phase: ResolutionPhase): string {
  return [
    `REJECTED. Your ${toolRef(phase)} call arrived with NO arguments — an empty object, with ${fieldRef(phase)} missing entirely.`,
    "",
    `${fieldRef(phase)} is required. Send ${toolRef(phase)} again carrying the complete array. A phase with genuinely nothing to report sends \`[]\`; it never omits the list.`,
  ].join("\n");
}

/** The same tool twice in one turn. Taking one copy would drop the other
 *  without saying so, and there is no basis for preferring either. */
export function renderPhaseDuplicate(phase: ResolutionPhase): string {
  return [
    `REJECTED. ${toolRef(phase)} was called more than once in one turn. Neither copy can be preferred over the other, so nothing was taken.`,
    "",
    `Call ${toolRef(phase)} exactly once, carrying the complete ${fieldRef(phase)} array for this phase.`,
  ].join("\n");
}

/**
 * A tool that is not this phase's submission. Either the model reached for a
 * phase it is not in — the one thing the six-phase split has to refuse
 * outright, since accepting it would let a later phase overwrite an accepted
 * one — or it invented a lookup that does not exist.
 */
export function renderPhaseWrongTool(
  phase: ResolutionPhase,
  calledName: string
): string {
  const only =
    phase === "endings"
      ? `This is ${phaseHeading(phase)}. It takes two tools and no others: \`damageRoll\`, for damage that is actually being dealt this tick, and ${toolRef(phase)}, which ends the phase.`
      : `This is ${phaseHeading(phase)}, and ${toolRef(phase)} is the only tool it takes.`;
  return [
    `Error: \`${calledName}\` was NOT accepted and did nothing.`,
    "",
    only,
    "",
    `Call ${toolRef(phase)} now, carrying the complete ${fieldRef(phase)} array.`,
  ].join("\n");
}
