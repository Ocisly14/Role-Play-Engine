// src/roleSim/renderer/llmRenderer.ts
//
// Phase G renderer LLM call. Turns a PerceivedBundle into a first-person
// sensory narrative per §G-decisions G2/G4/G5/G7/G8.
//
// ModelClass.MEDIUM: one round-trip, plus one corrective pass when the
// paragraph comes back carrying a tag the actor could not cite. Transport
// retries are `generateText`'s `maxRetries` (2 = initial + 1, per G11). On
// failure the wrapper in index.ts returns null (D6 — no god-eye fallback).

import type { Occurrence } from "../../engine/actions/types.js";
import { ModelClass, generateText } from "../../models/index.js";
import type { PromptSegment } from "../../models/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  buildPerceivableDirectory,
  descriptionIdentifier,
  isKnownTo,
  knownAs,
} from "../../state/perceivableDirectory.js";
import { formatForPrompt } from "../../state/gameClock.js";
import { resolveLocationById } from "../../state/perceivedLocation.js";
import type { DynamicNPCProfile } from "../../state/types.js";
import type { PerceivedBundle } from "./types.js";

const RENDERER_OPERATION = "phase-g-perception-render";

const SYSTEM_PROMPT = `You are the perception renderer for a tick-based simulation.

Your only job: turn the events of one game tick into a first-person, sensory
narrative for a single viewpoint character.

# Output format

One short paragraph. Nothing else — no heading, no label, no list, no
commentary before or after it.

# Citation tags

Entities in your input carry a tag in square brackets — \`[stranger_a]\`,
\`[ITEM_7]\`, \`[SCN_LIBRARY]\`. Write the tag into the narrative, right
after the words that name the thing:

  The tall pale man [stranger_a] sets a brass key [ITEM_7] on the counter.

This is the ONLY way the character can point at anything: they act by citing
a tag they read in your paragraph. An entity you leave untagged is an entity
they cannot touch, address or walk toward this minute.

- Copy a tag EXACTLY as given. Never invent one, never guess at an id you
  were not given, never reuse a tag for a different thing.
- A tag belongs to the ONE entity it was issued for, and to nothing else. A
  door, a shelf, a window, a stairway — a part or fixture of the room is not
  the room, so it never wears the room's tag. Nor does a lamp wear the tag of
  the street it stands on, or a wheel the tag of the cart.
- An entity with no tag in your input is written with no tag.
- A tag is not a name and never replaces the prose: write
  "the tall pale man [stranger_a]", never "stranger_a walks in".
- Tag the things the character could plausibly act on this minute — the
  people present, the items within reach.

# Hard rules

- Narrative is ONE paragraph (2-5 sentences). First person ("I"), present tense.
- The "Occurrences" input lists OBJECTIVE facts of this tick with sensory
  signals (visual/sound/smell/touch/direct). YOU decide what of each the
  viewpoint actually perceives, from the signals, the viewpoint's location
  and their senses: a sound-only signal from elsewhere renders as a heard
  impression ("a sharp crack from the street"), never as if seen; a visual
  signal in the same place renders as sight. When uncertain, stay vague.
- Never add facts: no entities, actions, outcomes or causes that are not in
  the occurrence facts or scene input. Facts you leave out are simply not
  perceived — that is allowed; inventing is not.
- Render only what the viewpoint can perceive RIGHT NOW: external sights, sounds,
  smells, touches, plus your own body/mind state. Do NOT mention memory,
  relationships, prior knowledge, or future plans.
- **When "Own action this tick" is present, the narrative MUST render it.**
  It is the one thing the viewpoint cannot fail to notice — their own hands.
  \`Ongoing:\` renders as what they are doing at this moment of it ("my knife
  is half through the twine"), using the elapsed/expected minutes to place
  them early or late in it. \`Just completed/failed/interrupted/cancelled:\`
  renders BOTH the moment it ended and what came of it: the \`Result:\` line is
  the objective outcome, rewrite it as what they experience ("the lock gives",
  "the wire will not budge"), never as a status word or a verdict. Never drop
  an ended action's result — this paragraph is the only place the outcome
  reaches them.
- **EVERY person listed under "People present in your scene" MUST be
  acknowledged in the narrative** — describe their visible presence, posture,
  or activity even if they are silent or did nothing this tick. Co-located
  characters are always sensorily present to the viewpoint and must not be
  erased. Their "Currently:" line, if any, gives you the action you should
  render as perceived behavior (rewrite as third-person sensory, e.g.
  "examines a book" → "Hollins turns the pages of a book at the desk").
- A \`Where you are in this place\` / \`Where they are in this place\` line is a
  position INSIDE the current place, given to you by the world. Render it as
  what it looks like from where the viewpoint stands ("I have not moved out of
  the corner armchair", "he is still bent over the workbench"), never as a
  restated label, and never contradict it — do not put someone at the window
  who is at the workbench. It carries no bracket and never gets one.
- For non-self entities, only render conditions that have an external sensory
  manifestation. Do not leak plot secrets, hidden allegiances, or any condition
  the viewpoint cannot perceive.
- **For people listed as UNKNOWN in the input, the narrative MUST refer to
  them by the description-based identifier (e.g. "the tall pale man"), NEVER
  by their canonical name** — even if the canonical name leaks into the
  prompt via event text or your own prior actions.
- Do not invent new entities, items, or details that are not in the input.
- If there are no events, describe scene + own state only.

# Example

Input gives you:
  Person (UNKNOWN): the tall pale man  [stranger_a]
    Appearance: Tall, pale, with a long black overcoat and an ivory-handled cane.

Correct output:
  The tall pale man [stranger_a] steps into the room and inclines his head,
  the ivory head of his cane catching the lamplight.

WRONG (leaks the canonical name of someone the viewpoint has never met):
  Professor Hollins steps into the room...

WRONG (leaks a machine id that is not the given tag):
  The tall pale man (Hollins) steps into the room...

WRONG (tag swallowed the prose):
  stranger_a steps into the room...

WRONG (prose swallowed by the tag — the bracket holds an id and NOTHING else,
no description, no punctuation, no words of your own, in any language):
  我猛拽那位老工人[ITEM_SCN21_3旁的同伴]的手臂...
  The old man [stranger_a, the one by the door] catches my arm...

WRONG (the room's own tag hung on a fixture inside the room — the door is not
the nave, and the actor who copies this points at the wrong thing):
  探头凑近那道被钉死的暗门 [SCN_17_SUB_1]...
  I lean toward the boarded-up door [SCN_17_SUB_1]...

Right: name the thing in your prose, then the bare id in a bracket after it.
Nothing to cite? Then write it with no bracket — an entity the actor can see
but not act on is a normal thing, and inventing a tag for it is not.`;

/** What the actor can see right now, in the shape the renderer needs: real
 *  entity id → the tag to print. Characters go through `characterHandles`, so
 *  a stranger is printed under the stable alias they wear for THIS viewer and
 *  their canonical id never reaches the narrative (nor, therefore, the actor).
 *
 *  Note this is about what can be TAGGED, which is narrower than what can be
 *  cited: a tag is only printed for something in front of the actor, but a tag
 *  they read a while ago still resolves, because every id space is stable. */
interface CitationTags {
  characters: Map<string, string>;
  places: Set<string>;
  items: Set<string>;
  /** Every tag the narrative may legally carry. */
  allowed: Set<string>;
}

function buildCitationTags(
  npcId: string,
  dgsm: DynamicGameStateManager
): CitationTags {
  const directory = buildPerceivableDirectory(npcId, dgsm);
  const characters = new Map<string, string>();
  for (const [handle, realId] of directory.characterHandles) {
    characters.set(realId, handle);
  }
  return {
    characters,
    places: directory.scenes,
    items: directory.items,
    allowed: new Set<string>([
      ...directory.characterHandles.keys(),
      ...directory.items,
      ...directory.scenes,
    ]),
  };
}

/** `  [tag]` when the entity is citable, nothing when it is not — an
 *  untagged entity is one the actor can perceive but not act on. */
function tag(id: string, tags: CitationTags, kind: "character" | "other") {
  const value =
    kind === "character"
      ? tags.characters.get(id)
      : tags.items.has(id) || tags.places.has(id)
        ? id
        : undefined;
  return value ? `  [${value}]` : "";
}

const TAG_PATTERN = /\s*\[([^\]\n]{1,64})\]/g;

/** Drop any bracketed tag the actor could not legally cite. The renderer is a
 *  SMALL model copying ids by hand: an invented or mistyped tag would sail
 *  through here and die at the trust boundary a turn later, as a rejection
 *  the character cannot act on. Stripping it costs them the citation and
 *  leaves the prose intact, which is the same as never having been told. */
export function stripUncitableTags(
  narrative: string,
  allowed: ReadonlySet<string>,
  npcId: string
): string {
  return narrative
    .replace(TAG_PATTERN, (_match, raw: string) => {
      const candidate = raw.trim();
      if (allowed.has(candidate)) return ` [${candidate}]`;
      console.warn(
        `[renderer] ${npcId}: dropped uncitable tag "${candidate}" from the narrative`
      );
      return "";
    })
    .trim();
}

/** Bracketed things the actor could not legally cite. Stripping one costs the
 *  character an entity they can see but cannot act on, so it is worth one more
 *  call before settling for that. */
export function uncitableTags(
  narrative: string,
  allowed: ReadonlySet<string>
): string[] {
  const bad: string[] = [];
  for (const match of narrative.matchAll(TAG_PATTERN)) {
    const candidate = match[1].trim();
    if (!allowed.has(candidate)) bad.push(candidate);
  }
  return [...new Set(bad)];
}

export interface RenderViaLLMParams {
  npcId: string;
  bundle: PerceivedBundle;
  dgsm: DynamicGameStateManager;
  /** Module language ("en" | "zh"). Drives narrative language. */
  language?: string;
  /** Every paragraph already rendered for this character, oldest first and
   *  EXCLUDING this tick. Append-only on purpose — see buildUserPromptSegments. */
  recentPerceptions?: ReadonlyArray<{
    gameDateTime: string;
    location: string;
    narrative: string;
  }>;
}

export async function renderViaLLM(
  params: RenderViaLLMParams
): Promise<string> {
  const tags = buildCitationTags(params.npcId, params.dgsm);
  const segments = buildUserPromptSegments(params, tags);
  const langName = params.language?.startsWith("zh") ? "Chinese" : "English";

  const decide = `\n\n# Decide\nWrite the paragraph now, in ${langName}.`;
  const ask = (extra = "") =>
    generateText({
      customSystemPrompt: SYSTEM_PROMPT,
      // Assembled once at module import and byte-identical for every NPC on
      // every tick. Under SMALL this breakpoint did nothing — Haiku will not
      // cache a prefix below 2048 tokens and this one is about 1,550 — so the
      // most frequent call site in the system was the only one paying full
      // price for its own instructions. MEDIUM's floor is 1024.
      cacheSystemPrompt: true,
      // Segmented so the breakpoint can sit at the end of the history. `extra`
      // is retry feedback and `decide` the instruction — both belong after
      // everything cacheable.
      contextSegments: [
        ...segments,
        { text: `${extra}${decide}`, cache: false },
      ],
      context: segments.map((seg) => seg.text).join("\n\n") + extra + decide,
      // MEDIUM, not SMALL. The small model kept citing the right KIND of
      // thing with the wrong id — street lamps tagged with the scene's id,
      // a train whistle tagged as a place — which is well-formed and passes
      // every check we can write, then points the actor at the wrong entity.
      // Judging which id names which thing is not something a cheaper model
      // was getting right.
      modelClass: ModelClass.MEDIUM,
      operation: RENDERER_OPERATION,
      maxRetries: 2,
    });

  let narrative = (await ask()).trim();
  const bad = uncitableTags(narrative, tags.allowed);

  // One corrective pass before falling back to stripping. A stripped tag is
  // not a broken tick — the prose survives — but it silently costs the
  // character an entity they can see and now cannot act on, and the mistake
  // is one a small model corrects readily once it is shown the exact string
  // it invented. Observed: `[ITEM_SCN21_3旁的同伴]`, an id with a phrase of
  // narrative welded onto it, which no amount of re-reading the rules would
  // have caught but naming it plainly does.
  if (bad.length > 0) {
    console.warn(
      `[renderer] ${params.npcId}: uncitable ${bad.map((t) => `"${t}"`).join(", ")} — asking again`
    );
    narrative = (
      await ask(
        [
          "\n\n# Your last attempt was rejected",
          "You wrote " +
            bad.map((t) => `[${t}]`).join(", ") +
            " — not a citable id. A bracket holds an id and NOTHING else: no",
          "description, no punctuation, no words of your own, in any language.",
          "Name the thing in your prose and put the bare id in the bracket after",
          "it, copied exactly from the address book above — or, if none of them",
          "is the thing you mean, write it with no bracket at all.",
          "Rewrite the whole paragraph.",
        ].join("\n")
      )
    ).trim();
  }

  return stripUncitableTags(narrative, tags.allowed, params.npcId);
}

/** Three tiers, ordered so the cacheable prefix grows and never rewrites:
 *
 *   frozen   identity — byte-identical every tick this character renders
 *   growing  everything they have already been told they perceived, APPENDED
 *   volatile this minute
 *
 * The history is deliberately append-only rather than a sliding window. A
 * window of the last N moves its own first byte every tick, which invalidates
 * itself AND everything after it; an append-only list keeps the prefix of
 * length N byte-identical to what it was last tick, so the breakpoint at its
 * end is read rather than rewritten.
 */
/** `--- 12-01 19:05 · 教堂主殿 ---`, the same stamp the character's own prompt
 *  uses, so a paragraph reads the same in both places. */
function stamp(
  gameDateTime: string,
  sceneId: string | undefined,
  dgsm: DynamicGameStateManager
): string {
  const place = sceneId
    ? (resolveLocationById(sceneId, dgsm)?.name ?? sceneId)
    : undefined;
  return `--- ${formatForPrompt(gameDateTime)}${place ? ` · ${place}` : ""} ---`;
}

function buildUserPromptSegments(
  params: RenderViaLLMParams,
  tags: CitationTags
): PromptSegment[] {
  const { npcId, bundle, dgsm } = params;
  const viewpoint = dgsm.getNpcProfile(npcId);
  const viewpointName = viewpoint?.name ?? "the viewpoint character";

  const frozen: string[] = [];
  const growing: string[] = [];
  const volatileParts: string[] = [];

  frozen.push('# Viewpoint character (render in first person as "I")');
  frozen.push(formatIdentity(viewpointName, viewpoint));

  // What this character has already been told they perceived. Without it the
  // renderer reintroduces the room from scratch every minute — the oak doors,
  // the candle smoke, the ticking — because it cannot know it said all that
  // two ticks ago.
  const history = params.recentPerceptions ?? [];
  if (history.length > 0) {
    const block = history
      .map((p) => `${stamp(p.gameDateTime, p.location, dgsm)}\n${p.narrative}`)
      .join("\n\n");
    growing.push(
      `# What you have already described\n${block}\n\nThe standing furniture of this place has been said. Write what CHANGED, what is new, and what you are doing now — do not re-introduce what is unchanged.`
    );
  }

  const selfNow = formatSelfNow(bundle);
  if (selfNow) {
    volatileParts.push("# How you are right now");
    volatileParts.push(selfNow);
  }

  volatileParts.push("# Current scene");
  volatileParts.push(formatScene(bundle, dgsm, tags));

  if (bundle.charactersInScene.length > 0) {
    volatileParts.push(
      "# People present in your scene (must be acknowledged in narrative — silent or not)"
    );
    volatileParts.push(formatScenePresentCharacters(bundle, npcId, dgsm, tags));
  }

  const otherEntities = collectOtherEntities(npcId, bundle, dgsm, tags);
  if (otherEntities) {
    volatileParts.push("# Other entities involved in events");
    volatileParts.push(otherEntities);
  }

  if (bundle.ownAction.kind !== "idle") {
    volatileParts.push("# Own action this tick (must be rendered)");
    volatileParts.push(formatOwnAction(bundle));
  }

  if (bundle.occurrences.length > 0) {
    volatileParts.push(
      "# Occurrences this tick (objective facts + signals — YOU decide what the viewpoint perceives of each)"
    );
    volatileParts.push(formatOccurrences(bundle, npcId, tags));
  } else {
    volatileParts.push(
      "# Occurrences this tick\n(none — describe scene and own state only)"
    );
  }

  const segments: PromptSegment[] = [];
  // No breakpoint on `frozen` alone: identity is ~2 lines, far under any
  // provider's minimum cacheable prefix, and the system prompt already carries
  // one. The breakpoint goes at the end of the history, where the prefix is
  // both stable and worth caching.
  segments.push({ text: frozen.join("\n\n"), cache: growing.length === 0 });
  if (growing.length > 0) {
    segments.push({ text: growing.join("\n\n"), cache: true });
  }
  segments.push({ text: volatileParts.join("\n\n"), cache: false });
  return segments;
}

/** Name and appearance — the same bytes on every tick this character renders,
 *  which is what lets a cache breakpoint sit behind it. Anything that moves
 *  belongs in `formatSelfNow`; mixing the two here made the whole prefix
 *  change every minute and the breakpoint never read. */
function formatIdentity(
  name: string,
  profile: DynamicNPCProfile | undefined
): string {
  const lines: string[] = [`Name: ${name}`];
  if (profile?.appearance) lines.push(`Appearance: ${profile.appearance}`);
  return lines.join("\n");
}

/** Where the character is standing and what their body is telling them —
 *  both change tick to tick, so this sits after the breakpoint. */
function formatSelfNow(bundle: PerceivedBundle): string {
  const lines: string[] = [];
  if (bundle.ownSpot) {
    lines.push(`Where you are in this place: ${bundle.ownSpot}`);
  }
  if (bundle.ownConditions.length > 0) {
    lines.push("Own conditions (proprioceptive — fully visible to self):");
    for (const c of bundle.ownConditions) {
      lines.push(`  - ${c.description}`);
    }
  }
  return lines.join("\n");
}

function formatScene(
  bundle: PerceivedBundle,
  dgsm: DynamicGameStateManager,
  tags: CitationTags
): string {
  const lines: string[] = [];
  const { scene } = bundle;
  lines.push(`Name: ${scene.name}${tag(scene.id, tags, "other")}`);
  if (scene.description) lines.push(`Description: ${scene.description}`);
  if (scene.activeConditions.length > 0) {
    lines.push("Scene conditions (render as inline prose):");
    for (const c of scene.activeConditions) {
      if (c.description) lines.push(`  - ${c.description}`);
    }
  }
  if (scene.id) {
    // By id, not getScene: the place may be a road or junction, which carry
    // items of their own and are invisible to the scene lookup.
    const items = resolveLocationById(scene.id, dgsm)?.items ?? [];
    if (items.length > 0) {
      lines.push("Items visible here:");
      for (const item of items) {
        const desc = item.description ? `: ${item.description}` : "";
        lines.push(`  - ${item.name}${tag(item.id, tags, "other")}${desc}`);
      }
    }
  }
  return lines.join("\n");
}

function collectOtherEntities(
  viewpointId: string,
  bundle: PerceivedBundle,
  dgsm: DynamicGameStateManager,
  tags: CitationTags
): string | null {
  // Characters already enumerated in `# People present in your scene` —
  // skip here to avoid duplicate prompt entries.
  const scenePresent = new Set(bundle.charactersInScene.map((c) => c.id));
  const characterIds = new Set<string>();
  const sceneIds = new Set<string>();

  for (const occ of bundle.occurrences) {
    if (occ.locationId && occ.locationId !== bundle.scene.id) {
      sceneIds.add(occ.locationId);
    }
    for (const p of occ.participants) {
      if (p.characterId !== viewpointId && !scenePresent.has(p.characterId)) {
        characterIds.add(p.characterId);
      }
    }
    for (const fact of occ.facts) {
      for (const ref of fact.entityRefs) {
        if (
          ref.kind === "character" &&
          ref.id !== viewpointId &&
          !scenePresent.has(ref.id)
        ) {
          characterIds.add(ref.id);
        }
        if (ref.kind === "scene" && ref.id !== bundle.scene.id) {
          sceneIds.add(ref.id);
        }
      }
    }
  }

  if (characterIds.size === 0 && sceneIds.size === 0) return null;

  const lines: string[] = [];
  for (const charId of characterIds) {
    const profile = dgsm.getNpcProfile(charId);
    if (!profile) continue;
    // The name THIS viewer knows them by, which is not necessarily the name
    // on their papers — "Nan" to one person, "the florist" to another.
    const identifier =
      knownAs(dgsm, viewpointId, charId) ?? descriptionIdentifier(profile);
    const known = isKnownTo(dgsm, viewpointId, charId);
    const knownTag = known ? "KNOWN" : "UNKNOWN";
    lines.push(
      `Person (${knownTag}): ${identifier}${tag(charId, tags, "character")}`
    );
    if (profile.appearance) lines.push(`  Appearance: ${profile.appearance}`);
    const conds = profile.status?.conditions ?? [];
    if (conds.length > 0) {
      lines.push("  Active conditions (render only externally perceivable):");
      for (const c of conds) {
        if (c.description) lines.push(`    - ${c.description}`);
      }
    }
  }

  for (const sceneId of sceneIds) {
    const scene = dgsm.getScene(sceneId);
    if (!scene) continue;
    lines.push(`Adjacent scene: ${scene.name}${tag(scene.id, tags, "other")}`);
    if (scene.description) lines.push(`  Description: ${scene.description}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

function formatOwnAction(bundle: PerceivedBundle): string {
  const own = bundle.ownAction;
  switch (own.kind) {
    case "ongoing": {
      const bits = [`Ongoing: "${own.description}"`];
      if (own.startedAt) bits.push(`started at ${own.startedAt}`);
      bits.push(`~${own.progressMinutes} min in`);
      if (own.resolvedDurationTicks !== undefined) {
        bits.push(`expected ~${own.resolvedDurationTicks} min total`);
      }
      return bits.join("; ");
    }
    case "ended": {
      const lines = [`Just ${own.status}: "${own.description}"`];
      if (own.outcome) {
        const reason = own.outcome.reason ? ` — ${own.outcome.reason}` : "";
        lines.push(
          `Result (objective; render as what the viewpoint experiences): ${own.outcome.outcome}${reason}`
        );
      }
      return lines.join("\n");
    }
    case "idle":
      return "Idle.";
  }
}

function formatOccurrences(
  bundle: PerceivedBundle,
  viewpointId: string,
  tags: CitationTags
): string {
  return bundle.occurrences
    .map((occ) => formatOccurrence(occ, bundle, viewpointId, tags))
    .join("\n");
}

function formatOccurrence(
  occ: Occurrence,
  bundle: PerceivedBundle,
  viewpointId: string,
  tags: CitationTags
): string {
  const lines: string[] = [];
  const where =
    occ.locationId === bundle.scene.id
      ? "here"
      : occ.locationId
        ? `at ${occ.locationId} (not your location)`
        : "location unspecified";
  // By tag, never by real id: a participant the viewpoint does not know must
  // reach the narrative as `stranger_a`, not as the name behind it.
  const involved = occ.participants
    .map((p) => {
      if (p.characterId === viewpointId) return `you (${p.role})`;
      const handle = tags.characters.get(p.characterId);
      return `${handle ?? "someone"} (${p.role})`;
    })
    .join(", ");
  lines.push(
    `- Occurrence ${where}${involved ? `; involved: ${involved}` : ""}`
  );
  const selfInvolved = occ.participants.some(
    (p) => p.characterId === viewpointId
  );
  if (selfInvolved) {
    lines.push("  (the viewpoint is directly involved)");
  }
  for (const fact of occ.facts) {
    lines.push(`  fact (${fact.type}): ${fact.content}`);
  }
  for (const signal of occ.signals) {
    const bits = [`signal: ${signal.channel}`];
    if (signal.originLocationId) bits.push(`from ${signal.originLocationId}`);
    if (signal.intensity !== undefined)
      bits.push(`intensity ${signal.intensity}`);
    lines.push(`  ${bits.join(", ")}`);
  }
  return lines.join("\n");
}

function formatScenePresentCharacters(
  bundle: PerceivedBundle,
  viewpointId: string,
  dgsm: DynamicGameStateManager,
  tags: CitationTags
): string {
  const lines: string[] = [];
  for (const c of bundle.charactersInScene) {
    const known = isKnownTo(dgsm, viewpointId, c.id);
    // Whatever this viewer calls them; a description built from appearance or
    // occupation until they have been told a name.
    const identifier =
      knownAs(dgsm, viewpointId, c.id) ??
      descriptionIdentifier({
        id: c.id,
        name: c.name,
        appearance: c.appearance,
      } as DynamicNPCProfile);
    const knownTag = known ? "KNOWN" : "UNKNOWN";
    lines.push(
      `Person (${knownTag}): ${identifier}${tag(c.id, tags, "character")}`
    );
    if (c.appearance) lines.push(`  Appearance: ${c.appearance}`);
    if (c.spot) lines.push(`  Where they are in this place: ${c.spot}`);
    if (c.currentActionText) {
      lines.push(`  Currently: ${c.currentActionText}`);
    } else {
      lines.push("  Currently: idle (between actions).");
    }
    if (c.conditions.length > 0) {
      lines.push("  Conditions (render only externally perceivable):");
      for (const cond of c.conditions) {
        if (cond.description) lines.push(`    - ${cond.description}`);
      }
    }
  }
  return lines.join("\n");
}
