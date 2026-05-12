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
import type { DynamicNPCProfile } from "../../state/types.js";
import type { PerceivedBundle } from "./types.js";

const RENDERER_OPERATION = "phase-g-perception-render";

const SYSTEM_PROMPT = `You are the perception renderer for a tick-based simulation.

Your only job: turn the events of one game tick into a first-person, sensory
narrative for a single viewpoint character, then list the named entities the
narrative mentions in a reference block.

# Output format

Emit exactly two labeled sections, in this order:

[narrative]
<one short paragraph in first-person present tense, sensory only>

[references]
[1] <Name>: <description>
[2] <Name>: <description>
...

# Hard rules

- Narrative is ONE paragraph (2-5 sentences). First person ("I"), present tense.
- Render only what the viewpoint can perceive RIGHT NOW: external sights, sounds,
  smells, touches, plus your own body/mind state. Do NOT mention memory,
  relationships, prior knowledge, or future plans.
- For non-self entities, only render conditions that have an external sensory
  manifestation. Do not leak plot secrets, hidden allegiances, or any condition
  the viewpoint cannot perceive.
- Cite people, named items, and scenes by appending [N] immediately after the
  name in the narrative — N is a 1-based number unique per entity in this
  output. Reuse the same N if the same entity appears more than once.
- Do NOT cite scene attributes (sub-locations like "east wall", scene
  conditions like "burning", weather, generic nouns such as "door"). Render
  those inline as plain prose.
- The reference block has exactly one line per cited entity, sorted by first
  appearance: "[N] <Name>: <description>".
- Use the names exactly as given in the input. For people listed as UNKNOWN,
  use the description-based identifier provided (e.g. "the gaunt man") as their
  name everywhere. Do not invent canonical names for unknown people.
- Do not invent new entities, items, or details that are not in the input.
- If there are no events, describe scene + own state only.
- Output the two sections only. No prose before [narrative], nothing after the
  reference list.`;

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
  sections.push(formatViewpoint(viewpointName, viewpoint, bundle));

  sections.push("# Current scene");
  sections.push(formatScene(bundle, dgsm));

  const otherEntities = collectOtherEntities(npcId, bundle, dgsm, viewpoint);
  if (otherEntities) {
    sections.push("# Other entities involved in events");
    sections.push(otherEntities);
  }

  if (bundle.ownAction.kind !== "idle") {
    sections.push("# Own action this tick");
    sections.push(formatOwnAction(bundle));
  }

  if (bundle.events.length > 0) {
    sections.push(
      "# Events this tick (already filtered to what propagated to you)"
    );
    sections.push(formatEvents(bundle));
  } else {
    sections.push(
      "# Events this tick\n(none — describe scene and own state only)"
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
  dgsm: DynamicGameStateManager
): string {
  const lines: string[] = [];
  const { scene } = bundle;
  lines.push(`Name: ${scene.name}`);
  if (scene.description) lines.push(`Description: ${scene.description}`);
  if (scene.activeConditions.length > 0) {
    lines.push("Scene conditions (render as inline prose, do NOT cite):");
    for (const c of scene.activeConditions) {
      if (c.description) lines.push(`  - ${c.description}`);
    }
  }
  if (scene.id) {
    const fullScene = dgsm.getScene(scene.id);
    const items = fullScene?.items ?? [];
    if (items.length > 0) {
      lines.push("Items visible in scene (citable):");
      for (const item of items) {
        const desc = item.description ? `: ${item.description}` : "";
        lines.push(`  - ${item.name}${desc}`);
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
  const characterIds = new Set<string>();
  const sceneIds = new Set<string>();

  for (const ev of bundle.events) {
    if (ev.characterId && ev.characterId !== viewpointId) {
      characterIds.add(ev.characterId);
    }
    if (ev.sceneId && ev.sceneId !== bundle.scene.id) {
      sceneIds.add(ev.sceneId);
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
    lines.push(`Person (${knownTag}): ${identifier}`);
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
    lines.push(`Adjacent scene: ${scene.name}`);
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
