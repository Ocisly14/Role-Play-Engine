// src/roleSim/renderer/llmRenderer.ts
//
// Phase G renderer LLM call. Turns a PerceivedBundle into a first-person
// citation-annotated narrative per §G-decisions G2/G4/G5/G7/G8. Uses
// ModelClass.SMALL (Haiku-tier per G6). One LLM round-trip; retry budget is
// owned by `generateText`'s `maxRetries` (set to 2 = initial + 1 retry per
// G11). On failure the wrapper in index.ts returns null (D6 — no god-eye fallback).

import { ModelClass, generateText } from "../../models/index.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  descriptionIdentifier,
  isKnownTo,
} from "../../state/perceivableDirectory.js";
import { resolveLocationById } from "../../state/perceivedLocation.js";
import type { DynamicNPCProfile } from "../../state/types.js";
import type { PerceivedBundle } from "./types.js";

const RENDERER_OPERATION = "phase-g-perception-render";

const SYSTEM_PROMPT = `You are the perception renderer for a tick-based simulation.

Your only job: turn the events of one game tick into a first-person, sensory
narrative for a single viewpoint character, then list the cited entities in a
reference block with their canonical system ids.

# Output format

Emit exactly two labeled sections, in this order:

[narrative]
<one short paragraph in first-person present tense, sensory only>

[references]
[1] id: <entity-id>; kind: <character|item|scene>; <display name>: <description>
[2] id: <entity-id>; kind: <character|item|scene>; <display name>: <description>
...

The agent downstream copies "id: <X>; kind: <Y>" verbatim into its own
references block to cite this entity, so getting id + kind exactly right is
critical. The display name + description are for the agent's narrative
understanding (what does the viewpoint actually see this entity as).

# Hard rules

- Narrative is ONE paragraph (2-5 sentences). First person ("I"), present tense.
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
- Cite people, named items, and scenes by appending [N] immediately after the
  name/description in the narrative — N is a 1-based number unique per entity
  in this output. Reuse the same N if the same entity appears more than once.
- Do NOT cite scene attributes (sub-locations like "east wall", scene
  conditions like "burning", weather, generic nouns such as "door"). Render
  those inline as plain prose.
- The reference block has exactly one line per cited entity, sorted by first
  appearance.
- **id and kind in the reference line MUST match the values given to you in
  the prompt input.** The agent's citation will fail if id is invented or
  misspelled.
- **For people listed as UNKNOWN in the input, the narrative MUST refer to
  them by the description-based identifier (e.g. "the tall pale man"), NEVER
  by their canonical name** — even if the canonical name leaks into the
  prompt via event text or your own prior actions. The reference block still
  carries the canonical id, but the in-narrative display name for UNKNOWN
  people is their description, not their name.
- Do not invent new entities, items, or details that are not in the input.
- If there are no events, describe scene + own state only.
- Output the two sections only. No prose before [narrative], nothing after the
  reference list.

# Example

Input gives you:
  Person (UNKNOWN): the tall pale man (id: Hollins)
    Appearance: Tall, pale, with a long black overcoat and an ivory-handled cane.

Correct output:
  [narrative]
  The tall pale man [1] steps into the room and inclines his head.
  [references]
  [1] id: Hollins; kind: character; the tall pale man: Tall, pale, with a long black overcoat and an ivory-handled cane.

WRONG (leaks canonical name into narrative for UNKNOWN):
  [narrative]
  Professor Hollins [1] steps into the room...`;

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
  const userPrompt = buildUserPrompt(params);
  const langName = params.language?.startsWith("zh") ? "Chinese" : "English";

  const response = await generateText({
    customSystemPrompt: SYSTEM_PROMPT,
    context: `${userPrompt}\n\n# Decide\nRender the [narrative] and [references] sections now. Write content in ${langName}.`,
    modelClass: ModelClass.SMALL,
    operation: RENDERER_OPERATION,
    maxRetries: 2,
  });

  return response.trim();
}

function buildUserPrompt(params: RenderViaLLMParams): string {
  const { npcId, bundle, dgsm } = params;
  const viewpoint = dgsm.getNpcProfile(npcId);
  const viewpointName = viewpoint?.name ?? "the viewpoint character";

  const sections: string[] = [];

  sections.push('# Viewpoint character (render in first person as "I")');
  sections.push(formatViewpoint(npcId, viewpointName, viewpoint, bundle));

  sections.push("# Current scene");
  sections.push(formatScene(bundle, dgsm));

  if (bundle.charactersInScene.length > 0) {
    sections.push(
      "# People present in your scene (must be acknowledged in narrative — silent or not)"
    );
    sections.push(formatScenePresentCharacters(bundle, viewpoint));
  }

  const otherEntities = collectOtherEntities(npcId, bundle, dgsm, viewpoint);
  if (otherEntities) {
    sections.push("# Other entities involved in events");
    sections.push(otherEntities);
  }

  if (bundle.ownAction.kind !== "idle") {
    sections.push("# Own action this tick");
    sections.push(formatOwnAction(bundle));
  }

  if (bundle.perceivedActions.length > 0) {
    sections.push(
      "# Actions perceived this tick (other characters' acts whose impact reached you)"
    );
    sections.push(formatPerceivedActions(bundle));
  }

  if (bundle.events.length > 0) {
    sections.push(
      "# Events this tick (already filtered to what propagated to you)"
    );
    sections.push(formatEvents(bundle));
  } else if (bundle.perceivedActions.length === 0) {
    sections.push(
      "# Events this tick\n(none — describe scene and own state only)"
    );
  }

  return sections.join("\n\n");
}

function formatViewpoint(
  id: string,
  name: string,
  profile: DynamicNPCProfile | undefined,
  bundle: PerceivedBundle
): string {
  const lines: string[] = [];
  lines.push(`Name: ${name}  (id: ${id})`);
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
  dgsm: DynamicGameStateManager
): string {
  const lines: string[] = [];
  const { scene } = bundle;
  lines.push(`Name: ${scene.name}  (id: ${scene.id})`);
  if (scene.description) lines.push(`Description: ${scene.description}`);
  if (scene.activeConditions.length > 0) {
    lines.push("Scene conditions (render as inline prose, do NOT cite):");
    for (const c of scene.activeConditions) {
      if (c.description) lines.push(`  - ${c.description}`);
    }
  }
  if (scene.id) {
    // By id, not getScene: the place may be a road or junction, which carry
    // items of their own and are invisible to the scene lookup.
    const items = resolveLocationById(scene.id, dgsm)?.items ?? [];
    if (items.length > 0) {
      lines.push("Items visible here (cite by id):");
      for (const item of items) {
        const desc = item.description ? `: ${item.description}` : "";
        lines.push(`  - ${item.name} (id: ${item.id})${desc}`);
      }
    }
  }
  return lines.join("\n");
}

function collectOtherEntities(
  viewpointId: string,
  bundle: PerceivedBundle,
  dgsm: DynamicGameStateManager,
  viewpoint: DynamicNPCProfile | undefined
): string | null {
  // Characters already enumerated in `# People present in your scene` —
  // skip here to avoid duplicate prompt entries.
  const scenePresent = new Set(bundle.charactersInScene.map((c) => c.id));
  const characterIds = new Set<string>();
  const sceneIds = new Set<string>();

  for (const ev of bundle.events) {
    if (
      ev.characterId &&
      ev.characterId !== viewpointId &&
      !scenePresent.has(ev.characterId)
    ) {
      characterIds.add(ev.characterId);
    }
    if (ev.sceneId && ev.sceneId !== bundle.scene.id) {
      sceneIds.add(ev.sceneId);
    }
  }

  for (const a of bundle.perceivedActions) {
    if (a.characterId !== viewpointId && !scenePresent.has(a.characterId)) {
      characterIds.add(a.characterId);
    }
    if (a.sceneId && a.sceneId !== bundle.scene.id) sceneIds.add(a.sceneId);
    for (const ref of a.referencedEntities) {
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

  if (characterIds.size === 0 && sceneIds.size === 0) return null;

  const lines: string[] = [];
  for (const charId of characterIds) {
    const profile = dgsm.getNpcProfile(charId);
    if (!profile) continue;
    const known = isKnownTo(viewpoint, charId);
    const identifier = known ? profile.name : descriptionIdentifier(profile);
    const knownTag = known ? "KNOWN" : "UNKNOWN";
    lines.push(`Person (${knownTag}): ${identifier}  (id: ${charId})`);
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
    lines.push(`Adjacent scene: ${scene.name}  (id: ${scene.id})`);
    if (scene.description) lines.push(`  Description: ${scene.description}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

function formatOwnAction(bundle: PerceivedBundle): string {
  switch (bundle.ownAction.kind) {
    case "ongoing":
      return `Ongoing: "${bundle.ownAction.actionText}"`;
    case "ended":
      return `Just ${bundle.ownAction.status}: "${bundle.ownAction.actionText}"`;
    case "idle":
      return "Idle.";
  }
}

function formatEvents(bundle: PerceivedBundle): string {
  return bundle.events
    .map((e) => {
      const actor = e.characterId ? ` [actor: ${e.characterId}]` : "";
      const scene = e.sceneId ? ` [scene: ${e.sceneId}]` : "";
      return `- (type: ${e.type}, impact: ${e.impact}) ${e.description}${actor}${scene}`;
    })
    .join("\n");
}

function formatPerceivedActions(bundle: PerceivedBundle): string {
  return bundle.perceivedActions
    .map(
      (a) =>
        `- (impact: ${a.impact}) [actor: ${a.characterId}] [scene: ${a.sceneId}] ${a.actionText}`
    )
    .join("\n");
}

function formatScenePresentCharacters(
  bundle: PerceivedBundle,
  viewpoint: DynamicNPCProfile | undefined
): string {
  const lines: string[] = [];
  for (const c of bundle.charactersInScene) {
    const known = isKnownTo(viewpoint, c.id);
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
    lines.push(`Person (${knownTag}): ${identifier}  (id: ${c.id})`);
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
