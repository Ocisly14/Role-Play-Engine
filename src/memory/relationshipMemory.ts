// src/memory/relationshipMemory.ts
//
// 人际常识 — the people a character already knows, before the first tick.
//
// The module-data seeder for relationships: like authored map memories turn geography into
// memories of the town, this one turns module relationships into memories of
// people. Same rules — assembled from module data with no LLM, so the
// bootstrap stays free, deterministic and replayable.
//
// The module authors a relationship as a DOSSIER: third person, about the
// character rather than by them ("Her closest companion and protector, whom
// she deeply trusts"). Dropped into the memory block unchanged it reads as
// somebody else's notes, sitting among sentences the character wrote in their
// own voice. So it is re-framed from the holder's side, and `relationshipType`
// and `attitude` — which the raw prose does not carry at all — become part of
// what they hold rather than numbers nobody sees.
//
// After the first tick these are ordinary `relationship` memories: each
// character revises their own with `writeMemory`, and the two sides of a
// friendship drift apart exactly as they should.

import { t } from "../i18n/t.js";
import type { NPCRelationship } from "../state/types.js";

export interface RelationshipMemoryEntry {
  targetId: string;
  targetName: string;
  content: string;
}

/** Attitude is authored -100..100. Nobody thinks of a friend as a 90, so the
 *  number becomes the sentence a person would actually say to themselves. */
function warmth(attitude: number | undefined, language: string): string | null {
  if (typeof attitude !== "number") return null;
  if (attitude >= 75) return t("relationship_warmth_devoted", language);
  if (attitude >= 30) return t("relationship_warmth_warm", language);
  if (attitude > -30) return t("relationship_warmth_even", language);
  if (attitude > -75) return t("relationship_warmth_cool", language);
  return t("relationship_warmth_hostile", language);
}

/** The authored stance as a phrase, or null when it has no translation.
 *
 *  `t` falls back locale → en → THE KEY ITSELF, which is the right default for
 *  a missing UI string and exactly wrong here: whatever comes back is written
 *  verbatim into a memory the character then reads as their own thought. A
 *  module carrying a stance outside `RELATIONSHIP_TYPES` put the literal text
 *  `relationship_stance_partner` into six characters' heads. Warmth still
 *  carries the attitude, so dropping the clause degrades; printing the key
 *  does not. */
function stance(relationshipType: string, language: string): string | null {
  const key = `relationship_stance_${relationshipType}`;
  const phrase = t(key, language);
  if (phrase !== key) return phrase;
  console.warn(
    `[relationshipMemory] no translation for "${key}" — stance omitted from the seed memory`
  );
  return null;
}

export function buildRelationshipMemory(
  relationship: NPCRelationship,
  language = "en"
): RelationshipMemoryEntry | null {
  if (!relationship.targetId) return null;

  const name = relationship.targetName?.trim() || relationship.targetId;
  const stanceParts = [
    stance(relationship.relationshipType, language),
    warmth(relationship.attitude, language),
  ].filter((part): part is string => Boolean(part));
  if (stanceParts.length === 0) return null;

  // The holder's own voice when the module supplies it. Otherwise the authored
  // dossier, verbatim — third person and slightly wrong in a memory block, but
  // it is the only part carrying anything specific and losing it is worse.
  const account =
    relationship.firstPerson?.trim() ||
    [relationship.description?.trim(), relationship.history?.trim()]
      .filter(Boolean)
      .join(" ");

  const content = account
    ? t("relationship_seed", language, {
        name,
        stance: stanceParts.join("，"),
        account,
      })
    : t("relationship_seed_bare", language, {
        name,
        stance: stanceParts.join("，"),
      });

  return { targetId: relationship.targetId, targetName: name, content };
}
