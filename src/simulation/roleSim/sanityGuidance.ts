// src/simulation/roleSim/sanityGuidance.ts
//
// Role-sim resource for the LLM resolver. The resolver uses this guidance to
// decide, in-context, whether a SAN drop should also trigger a bout of madness
// — and if so, to construct an appropriate CharacterCondition (with expiresAt
// for temporary/indefinite, without expiresAt for persistent phobia/mania).
//
// No mechanical state machine: bout duration & onset are encoded as
// CharacterCondition.expiresAt and auto-swept by TickOrchestrator (D8). The
// LLM resolver picks bout type, description, restriction-level globalSkillPenalty,
// and emits the corresponding `character.addCondition` StateChange in its
// PlannedOutcome alongside the `character.san` delta.

export type BoutOfMadnessType =
  | "amnesia"
  | "psychosomatic_disability"
  | "violence"
  | "paranoia"
  | "significant_person"
  | "faint"
  | "flee"
  | "hysterics"
  | "phobia"
  | "mania";

export type ActionRestriction =
  | "none"
  | "incapacitated"
  | "flee_only"
  | "attack_only"
  | "impaired";

export interface BoutOfMadnessEntry {
  roll: number;
  boutType: BoutOfMadnessType;
  label: string;
  description: string;
  actionRestriction: ActionRestriction;
  persistent?: boolean;
}

// Ported verbatim from src/engine/features/sanityFeature.ts
// (BOUT_OF_MADNESS_TABLE + BOUT_DESCRIPTIONS combined).
export const BOUT_OF_MADNESS_TABLE: readonly BoutOfMadnessEntry[] = [
  {
    roll: 1,
    boutType: "amnesia",
    label: "Amnesia",
    description: "Mind goes blank — cannot recall recent events or surroundings",
    actionRestriction: "impaired",
  },
  {
    roll: 2,
    boutType: "psychosomatic_disability",
    label: "Psychosomatic Disability",
    description:
      "Body betrays the mind — a limb goes numb, vision blurs, or voice fails",
    actionRestriction: "impaired",
  },
  {
    roll: 3,
    boutType: "violence",
    label: "Violence",
    description:
      "Rational thought shatters — lashing out at anyone nearby in blind rage",
    actionRestriction: "attack_only",
  },
  {
    roll: 4,
    boutType: "paranoia",
    label: "Paranoia",
    description:
      "Trust collapses — everyone is a threat, every shadow hides a conspirator",
    actionRestriction: "impaired",
  },
  {
    roll: 5,
    boutType: "significant_person",
    label: "Significant Person Fixation",
    description: "Reality warps — sees a significant person where there is none",
    actionRestriction: "impaired",
  },
  {
    roll: 6,
    boutType: "faint",
    label: "Faint",
    description:
      "Consciousness flickers out — collapses to the ground, unresponsive",
    actionRestriction: "incapacitated",
  },
  {
    roll: 7,
    boutType: "flee",
    label: "Flee in Panic",
    description:
      "Primal terror takes over — desperate to escape, stumbling and screaming",
    actionRestriction: "flee_only",
  },
  {
    roll: 8,
    boutType: "hysterics",
    label: "Physical Hysterics",
    description:
      "Body convulses with uncontrollable laughter, screaming, or sobbing",
    actionRestriction: "incapacitated",
  },
  {
    roll: 9,
    boutType: "phobia",
    label: "Phobia",
    description: "A deep irrational fear takes root",
    actionRestriction: "impaired",
    persistent: true,
  },
  {
    roll: 10,
    boutType: "mania",
    label: "Mania",
    description: "An obsessive compulsion seizes the mind",
    actionRestriction: "impaired",
    persistent: true,
  },
];

const BOUT_REFERENCE_LINES = BOUT_OF_MADNESS_TABLE.map(
  (b) =>
    `- **${b.label}** (restriction: ${b.actionRestriction}${b.persistent ? ", persistent" : ""}): ${b.description}`,
).join("\n");

export const SANITY_GUIDANCE_PROMPT = `## Sanity effects (guidance for the LLM resolver)

When resolving an action that causes a SAN drop, consider whether it should also trigger a bout of madness. If so, emit a \`character.addCondition\` StateChange ALONGSIDE the \`character.san\` delta in your PlannedOutcome.

### Triggers
- **Temporary insanity** — a single SAN loss of 5+ may trigger a bout. Use \`expiresAt\` 1–10 hours from current game time.
- **Indefinite insanity** — cumulative SAN loss exceeding (current SAN / 5) within the last hour may trigger an indefinite bout. Use \`expiresAt\` 1–10 days from current game time, optionally describing onset delay in the condition text.
- **Persistent phobia/mania** — emit a CharacterCondition WITHOUT \`expiresAt\`. It never auto-removes.

### Bout-of-madness reference (CoC 7e table)

${BOUT_REFERENCE_LINES}

Pick a bout type that fits the situation; tailor the condition's \`description\` to the specific narrative — don't copy the table text verbatim.

### Mechanical effects

Use \`mechanicalEffect.globalSkillPenalty\` on the condition to express action restriction:
- \`incapacitated\` → \`-100\` (effectively can't act)
- \`impaired\` → \`-15\`
- \`flee_only\` / \`attack_only\` → no global penalty; the condition's \`description\` text alone drives the NPC planner's behavioral interpretation
- \`none\` → no global penalty (used for non-restrictive bouts like persistent fascination)

### Examples

For an investigator who saw a tentacled horror and lost 8 SAN:
\`\`\`json
{
  "kind": "character.addCondition",
  "characterId": "investigator-1",
  "condition": {
    "id": "bout:flee:1234",
    "featureId": "sanity",
    "description": "Flees in panic from the room, screaming about tentacles in the walls",
    "mechanicalEffect": { "globalSkillPenalty": 0 },
    "expiresAt": { "day": 5, "tickTime": "14:00" }
  }
}
\`\`\`

For an investigator developing a persistent phobia of fire after a traumatic burn:
\`\`\`json
{
  "kind": "character.addCondition",
  "characterId": "investigator-1",
  "condition": {
    "id": "phobia:fire:1234",
    "featureId": "sanity",
    "description": "Phobia: fire — extreme distress and avoidance when near open flames",
    "mechanicalEffect": { "skillPenalty": { "Spot Hidden": -10 } }
  }
}
\`\`\`

Note the absence of \`expiresAt\` for the phobia — TickOrchestrator's expiry sweep will not touch it.
`;

/**
 * Surface per-character sanity context to the LLM resolver.
 *
 * MVP returns empty — the resolver works off general guidance + immediate
 * action context only. Future work: surface recent SAN history, current SAN
 * value, persistent conditions, etc. for the LLM resolver.
 */
export function buildSanityContextForResolver(
  _dgsm: unknown,
  _characterId: string,
): string {
  return "";
}
