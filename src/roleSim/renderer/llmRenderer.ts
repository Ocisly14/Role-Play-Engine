// src/roleSim/renderer/llmRenderer.ts
//
// Phase G renderer LLM call. Turns a PerceivedBundle into a first-person
// sensory narrative per §G-decisions G2/G4/G5/G7/G8. Uses
// ModelClass.SMALL (Haiku-tier per G6). One LLM round-trip; retry budget is
// owned by `generateText`'s `maxRetries` (set to 2 = initial + 1 retry per
// G11). On failure the wrapper in index.ts returns null (D6 — no god-eye fallback).

import type { Occurrence } from "../../engine/actions/types.js";
import { ModelClass, generateText } from "../../models/index.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  buildPerceivableDirectory,
  descriptionIdentifier,
  isKnownTo,
} from "../../state/perceivableDirectory.js";
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
- **EVERY person listed under "People present in your scene" MUST be
  acknowledged in the narrative** — describe their visible presence, posture,
  or activity even if they are silent or did nothing this tick. Co-located
  characters are always sensorily present to the viewpoint and must not be
  erased. Their "Currently:" line, if any, gives you the action you should
  render as perceived behavior (rewrite as third-person sensory, e.g.
  "examines a book" → "Hollins turns the pages of a book at the desk").
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
  stranger_a steps into the room...`;

/** What the actor may cite this tick, in the shape the renderer needs:
 *  real entity id → the tag to print. Characters go through
 *  `characterHandles`, so a stranger is printed as `stranger_a` and their
 *  canonical id never reaches the narrative (nor, therefore, the actor). */
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

export interface RenderViaLLMParams {
  npcId: string;
  bundle: PerceivedBundle;
  dgsm: DynamicGameStateManager;
  /** Module language ("en" | "zh"). Drives narrative language. */
  language?: string;
}

export async function renderViaLLM(
  params: RenderViaLLMParams
): Promise<string> {
  const tags = buildCitationTags(params.npcId, params.dgsm);
  const userPrompt = buildUserPrompt(params, tags);
  const langName = params.language?.startsWith("zh") ? "Chinese" : "English";

  const response = await generateText({
    customSystemPrompt: SYSTEM_PROMPT,
    context: `${userPrompt}\n\n# Decide\nWrite the paragraph now, in ${langName}.`,
    modelClass: ModelClass.SMALL,
    operation: RENDERER_OPERATION,
    maxRetries: 2,
  });

  return stripUncitableTags(response.trim(), tags.allowed, params.npcId);
}

function buildUserPrompt(
  params: RenderViaLLMParams,
  tags: CitationTags
): string {
  const { npcId, bundle, dgsm } = params;
  const viewpoint = dgsm.getNpcProfile(npcId);
  const viewpointName = viewpoint?.name ?? "the viewpoint character";

  const sections: string[] = [];

  sections.push('# Viewpoint character (render in first person as "I")');
  sections.push(formatViewpoint(viewpointName, viewpoint, bundle));

  sections.push("# Current scene");
  sections.push(formatScene(bundle, dgsm, tags));

  if (bundle.charactersInScene.length > 0) {
    sections.push(
      "# People present in your scene (must be acknowledged in narrative — silent or not)"
    );
    sections.push(formatScenePresentCharacters(bundle, npcId, dgsm, tags));
  }

  const otherEntities = collectOtherEntities(npcId, bundle, dgsm, tags);
  if (otherEntities) {
    sections.push("# Other entities involved in events");
    sections.push(otherEntities);
  }

  if (bundle.ownAction.kind !== "idle") {
    sections.push("# Own action this tick");
    sections.push(formatOwnAction(bundle));
  }

  if (bundle.occurrences.length > 0) {
    sections.push(
      "# Occurrences this tick (objective facts + signals — YOU decide what the viewpoint perceives of each)"
    );
    sections.push(formatOccurrences(bundle, npcId, tags));
  } else {
    sections.push(
      "# Occurrences this tick\n(none — describe scene and own state only)"
    );
  }

  return sections.join("\n\n");
}

function formatViewpoint(
  name: string,
  profile: DynamicNPCProfile | undefined,
  bundle: PerceivedBundle
): string {
  const lines: string[] = [];
  lines.push(`Name: ${name}`);
  if (profile?.appearance) lines.push(`Appearance: ${profile.appearance}`);
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
    const known = isKnownTo(dgsm, viewpointId, charId);
    const identifier = known ? profile.name : descriptionIdentifier(profile);
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
    lines.push(
      `Adjacent scene: ${scene.name}${tag(scene.id, tags, "other")}`
    );
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
    // For UNKNOWN, fall back to a description-based identifier built from
    // appearance / occupation; for KNOWN, use the canonical name.
    const identifier = known
      ? c.name
      : descriptionIdentifier({
          id: c.id,
          name: c.name,
          appearance: c.appearance,
        } as DynamicNPCProfile);
    const knownTag = known ? "KNOWN" : "UNKNOWN";
    lines.push(
      `Person (${knownTag}): ${identifier}${tag(c.id, tags, "character")}`
    );
    if (c.appearance) lines.push(`  Appearance: ${c.appearance}`);
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
