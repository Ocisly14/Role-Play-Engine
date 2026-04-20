---
id: anthropology
title: Anthropology
description: "Interpret the beliefs, rituals, and social structures of living or recently living human cultures through expert ethnographic analysis. Does NOT cover ancient or extinct cultures (Archaeology), passive observation (Spot Hidden), or document lookup (Research/Library Use)."

skillCheck:
  skill: Anthropology
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject: [actor]
    fields:
      actor: [id, name, conditions]
  scene:
    inject: [current]
    fields: [id, name, description, conditions, items]
  item:
    inject: [sceneItems, actorInventory]

outputSchema:
  presets: [default]
  durationGuidance:
    default: 10
    range: "3-60"
    notes: "quick cultural ID 3-5 min; ritual interpretation 15-30 min; fieldwork synthesis 45-60 min"

interpreter:
  examples:
    - "Identify which living cultural tradition this initiation rite belongs to and what it signifies"
    - "Interpret the social taboos embedded in this community's burial customs"
    - "Determine whether this folk practice has been corrupted from its original ethnographic form"
    - "Explain what violation of this kinship rule would mean to this tribe"
---

# Anthropology Resolution Guidance

## On Success
- regular success: The investigator recognizes the cultural origin of the ritual, artifact, or custom. They can identify which people or tradition it belongs to and describe the general social significance it holds within that group.
- hard success: Beyond identification, the investigator understands the deeper social and ceremonial role of the practice. They can explain how it fits into the broader belief system and what violations of it might mean to the group.
- extreme success: The investigator possesses detailed scholarly knowledge — they know variant forms, historical evolution, and any unusual deviations present in what they are observing. They may recognize that this ritual has been corrupted or adapted in a disturbing way.

## On Failure
- The cultural context remains unclear. The investigator cannot place the symbols or practices within any known tradition, leaving the meaning opaque.
- On a fumble, the investigator confidently misidentifies the cultural source, potentially causing offense or drawing a dangerously wrong conclusion about what the ritual entails.
