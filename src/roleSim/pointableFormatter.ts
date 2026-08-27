// src/roleSim/pointableFormatter.ts
//
// The actor's address book for this minute: everything they may name in
// `objectRefs` or `writeMemory.targetId`, and nothing else.
//
// It is generated from the same `PerceivableDirectory` the trust boundary
// validates against, so the list and the rule enforcing it cannot drift. The
// renderer used to carry this job — it wrote the ids into a reference block
// under its narrative — which meant a SMALL model was hand-copying data the
// code already held, and an `unknown_ref` rejection was one typo away.
//
// People appear under an opaque handle, never their real id: the id would
// hand the actor the canonical name of someone they may only know by sight.
// Items and places appear under their real ids — those name a thing the actor
// is already looking at, so there is no identity to withhold.

import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import {
  buildPerceivableDirectory,
  descriptionIdentifier,
  isKnownTo,
} from "../state/perceivableDirectory.js";
import { resolveLocationById } from "../state/perceivedLocation.js";

export function formatPointables(
  npcId: string,
  dgsm: DynamicGameStateManager
): string | null {
  const viewpoint = dgsm.getNpcProfile(npcId);
  if (!viewpoint) return null;

  const directory = buildPerceivableDirectory(npcId, dgsm);
  const position = dgsm.getCharacterPosition(npcId);
  const hereId = position ? dgsm.resolveLocationId(position) : "";

  // The directory already assigned aliases in real-id order, so this block is
  // byte-stable across the ticks of an unchanged cast — it then rides inside
  // the tick-frozen `situation` segment without disturbing its prefix.
  const people: string[] = [];
  for (const [handle, targetId] of directory.characterHandles) {
    const profile = dgsm.getNpcProfile(targetId);
    if (!profile) continue;
    // Someone they know is named; a stranger is described. The description is
    // the whole point of the line — the alias beside it means nothing on its
    // own, and this is what tells the actor which stranger it stands for.
    const display = isKnownTo(dgsm, npcId, targetId)
      ? profile.name
      : descriptionIdentifier(profile);
    people.push(`- ${handle} — ${display}`);
  }

  const itemNames = new Map<string, string>();
  for (const item of resolveLocationById(hereId, dgsm)?.items ?? []) {
    itemNames.set(item.id, item.name);
  }
  for (const item of dgsm.getNpcInventory(npcId)) {
    itemNames.set(item.id, item.name);
  }
  const items = [...directory.items]
    .sort()
    .map((id) => `- ${id} — ${itemNames.get(id) ?? id}`);

  const places = [...directory.scenes].sort().map((id) => {
    const name = resolveLocationById(id, dgsm)?.name ?? id;
    return `- ${id} — ${name}${id === hereId ? " (where you are)" : ""}`;
  });

  if (people.length === 0 && items.length === 0 && places.length === 0) {
    return null;
  }

  const lines = [
    "Only these can go in `objectRefs`, or in `writeMemory`'s `targetId`.",
    "Copy an id exactly. Anything else is refused.",
  ];
  if (people.length > 0) lines.push("", "People:", ...people);
  if (items.length > 0) lines.push("", "Items:", ...items);
  if (places.length > 0) lines.push("", "Places:", ...places);
  return lines.join("\n");
}
