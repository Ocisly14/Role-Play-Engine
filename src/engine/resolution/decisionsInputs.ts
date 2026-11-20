// src/engine/resolution/decisionsInputs.ts
//
// What each Decisions request is shown (design §6.7.3). The rule is that a
// request carries what its questions need and nothing else. They used to carry
// the LLM settlement's whole world context — about 21k tokens, two thirds of
// it the town's outdoor prose, the questions themselves 2–8% — and the answers
// read none of it.

import { actionIdForCommand } from "../actions/actionStore.js";
import {
  type ActionCommand,
  type EngineAction,
  renderGradeScale,
} from "../actions/types.js";
import { SURROUNDINGS_MEANING } from "../rules/ruleTerms.js";
import { SKILL_BASE_VALUES, catalogSkillName } from "../rules/skillCatalog.js";
import { getSkillReference } from "../rules/skillReference.js";
import type { CharacterSnapshot, EngineResolutionContext } from "./types.js";
import { resolutionWorklist } from "./worldDeltaValidator.js";
import {
  commandForPrompt,
  diceRollForPrompt,
} from "./worldResolutionStagePrompts.js";

const section = (title: string, data: unknown): string =>
  `## ${title}\n${JSON.stringify(data, null, 1)}`;

/** A person as the questions need them: who, where, in what state, doing
 *  what. No attributes, skill values or SAN. */
function person(
  c: CharacterSnapshot,
  context: EngineResolutionContext
): Record<string, unknown> {
  const doing = context.actions.activeActions.find(
    (a) => a.command.actorId === c.id
  );
  return {
    id: c.id,
    name: c.name,
    ...(c.appearance ? { appearance: c.appearance } : {}),
    alive: c.alive,
    locationId: c.locationId,
    ...(c.spot ? { spot: c.spot } : {}),
    ...(c.conditions.length > 0 ? { conditions: c.conditions } : {}),
    ...(doing ? { doing: doing.command.description } : {}),
  };
}

/**
 * The actor's value in the skill their command declares — trained value, or
 * the catalog base when untrained. Whether an attempt "will very likely
 * succeed" depends on who makes it (a nurse listening to a chest, a retired
 * keeper dressing his own wound), so the check question needs it; nothing
 * else of the character's sheet is shown.
 */
function declaredSkillValue(
  context: EngineResolutionContext,
  command: ActionCommand
): number | undefined {
  const skill = catalogSkillName(command.declaredSkillId ?? "");
  if (!skill) return undefined;
  const actor = context.state.characters.find((c) => c.id === command.actorId);
  return actor?.skills[skill] ?? SKILL_BASE_VALUES.get(skill);
}

function placesAt(context: EngineResolutionContext, ids: ReadonlySet<string>) {
  return context.state.places.filter((p) => ids.has(p.id));
}

function itemsAt(context: EngineResolutionContext, ids: ReadonlySet<string>) {
  return context.state.items.filter((item) => {
    const holder = context.state.itemHolders[item.id] ?? "";
    if (holder.startsWith("scene:")) return ids.has(holder.slice(6));
    // Carried: shown when its carrier is at one of these places.
    const carrier = context.state.characters.find((c) => c.id === holder);
    return carrier ? ids.has(carrier.locationId) : false;
  });
}

function peopleAt(
  context: EngineResolutionContext,
  ids: ReadonlySet<string>
): Record<string, unknown>[] {
  return context.state.characters
    .filter((c) => ids.has(c.locationId))
    .map((c) => person(c, context));
}

function actorPlaces(
  context: EngineResolutionContext,
  actorIds: Iterable<string>
): Set<string> {
  const out = new Set<string>();
  for (const id of actorIds) {
    const c = context.state.characters.find((x) => x.id === id);
    if (c?.locationId) out.add(c.locationId);
  }
  return out;
}

/**
 * A declared skill's guidance as a start needs it: what it covers, how long
 * it takes, and how hard each level is. The failure shading and the state
 * surface are for writing an outcome, which a start never does.
 */
function startSkillGuidance(skillId: string): string | null {
  const ref = getSkillReference(skillId);
  if (!ref) return null;
  const lines = [`### ${ref.title}`, ref.description];
  if (ref.durationGuidance) {
    const dg = ref.durationGuidance;
    lines.push(
      `Duration guidance: default ${dg.default} min${dg.range ? `, range ${dg.range}` : ""}${dg.notes ? ` (${dg.notes})` : ""}`
    );
  }
  const kept = (ref.guidanceBody ?? "")
    .split(/\n(?=## )/)
    .filter(
      (part) =>
        part.startsWith("## Applicability") ||
        part.startsWith("## Success levels")
    );
  lines.push(...kept);
  return lines.join("\n\n");
}

/** The start judgement: the new commands, where their actors stand, what is
 *  there, who is there (the opposition choices), and the declared skills. */
export function startsInput(context: EngineResolutionContext): string[] {
  const commands = context.actions.newCommands;
  const here = actorPlaces(
    context,
    commands.map((c) => c.actorId)
  );
  // A cited place is shown too: how hard getting into it is can depend on it.
  const shown = new Set(here);
  for (const c of commands) {
    for (const ref of c.objectRefs) if (ref.kind === "scene") shown.add(ref.id);
  }
  const skills = [
    ...new Set(
      commands
        .map((c): string | undefined =>
          catalogSkillName(c.declaredSkillId ?? "")
        )
        .filter((s): s is string => s !== undefined)
    ),
  ];
  const guidance = skills
    .map(startSkillGuidance)
    .filter((g): g is string => g !== null);
  return [
    [
      section(
        "New Commands (each starts this minute; `proposedDurationTicks` is the actor's own estimate, advisory; `utterance` is said when the action ends; `declaredSkillValue` is the actor's value in the declared skill, 1-100 — a d100 roll at or under it is a regular success, at or under half hard, at or under a fifth extreme)",
        commands.map((c) => {
          const value = declaredSkillValue(context, c);
          return {
            actionId: actionIdForCommand(c.commandId),
            ...commandForPrompt(c),
            ...(value !== undefined ? { declaredSkillValue: value } : {}),
          };
        })
      ),
      section(
        "Places (where the actors stand, and the places they cite)",
        placesAt(context, shown)
      ),
      section("Items there", itemsAt(context, here)),
      section("People there", peopleAt(context, here)),
      ...(guidance.length > 0
        ? [`## Declared Skills\n\n${guidance.join("\n\n---\n\n")}`]
        : []),
    ].join("\n\n"),
  ];
}

function endingActions(context: EngineResolutionContext): EngineAction[] {
  const ending = new Set(resolutionWorklist(context).ending);
  return context.actions.activeActions.filter((a) => ending.has(a.id));
}

/** Endings and the change plan: the actions whose time is up, where they
 *  happened, what and who is there, and what already took effect. */
export function settlementInput(context: EngineResolutionContext): string[] {
  const ending = endingActions(context);
  const here = actorPlaces(
    context,
    ending.map((a) => a.command.actorId)
  );
  return [
    [
      section(
        "Ending Actions (their time is up this minute; a `diceRoll` is what code rolled, and is input)",
        ending.map((a) => ({
          actionId: a.id,
          ...(a.checkOutcome
            ? { diceRoll: diceRollForPrompt(a.checkOutcome) }
            : {}),
          command: commandForPrompt(a.command),
        }))
      ),
      section("Places", placesAt(context, here)),
      section("Items there", itemsAt(context, here)),
      section("People there", peopleAt(context, here)),
      section("Objective Events (already effective)", context.events),
    ].join("\n\n"),
  ];
}

/** Perceivers: who is where and doing what, how far each is from where it
 *  happened, and the places on both sides — doors, windows and walls are in
 *  the descriptions. The rows themselves travel as the request's json. */
export function perceiversInput(context: EngineResolutionContext): string[] {
  const ending = endingActions(context);
  const here = actorPlaces(
    context,
    ending.map((a) => a.command.actorId)
  );
  return [
    [
      `## Grading (each question asks what one person gets of one row by one sense; the rows are in the json, numbered)\n${renderGradeScale()}`,
      section("Where It Happened", placesAt(context, here)),
      section(
        "People (every character; `doing` is what they are busy with)",
        context.state.characters.map((c) => person(c, context))
      ),
      section(
        `Surroundings (${SURROUNDINGS_MEANING})`,
        context.state.surroundings ?? { origins: [], places: [] }
      ),
      section(
        "Ending Actions (what the rows are the trace of)",
        ending.map((a) => ({
          actionId: a.id,
          command: commandForPrompt(a.command),
        }))
      ),
    ].join("\n\n"),
  ];
}
