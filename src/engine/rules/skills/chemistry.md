---
id: chemistry
engine: llm
title: Chemistry
description: "Analyze chemical composition, synthesize compounds, and reason about reactions, poisons, and materials through expert laboratory knowledge. Does NOT cover biological organisms (Biology), pharmaceutical treatment (Medicine), or passive observation (Perception)."

skillCheck:
  skill: Chemistry
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
  presets: [default, item_modify]
  requireOnFailure:
    - item.modify
  durationGuidance:
    default: 15
    range: "5-60"
    notes: "reagent ID 5-10 min; basic analysis 15-30 min; synthesis or titration 45-60 min"

interpreter:
  examples:
    - "Determine the molecular composition of this residue and identify whether it is a synthesized poison"
    - "Assess the purity and concentration of this alkaloid compound"
    - "Predict how these two reagents will react if combined under heat"
    - "Identify whether this accelerant was professionally manufactured or improvised"
---

# Chemistry Resolution Guidance

## State Changes
- Use `item.create` when the actor synthesizes, mixes, refines, or isolates a new chemical compound from provided materials.
- Use `item.modify` when an existing substance changes concentration, stability, toxicity, or other properties.
- Use `item.destroy` when reagents are consumed, neutralized, or spoiled during the process.
- Use `item.move` when chemicals are transferred between containers, work surfaces, or inventory.
- Use `memory.event` when the actor learns concrete facts about composition, toxicity, reactivity, purity, or likely origin.

## On Success
- regular success: The investigator identifies the substance, its composition, and its primary properties — toxicity, reactivity, flammability, or medical application. They can advise on safe handling and predict how it will behave in the current environment.
- hard success: The investigator's analysis is precise — they determine concentration, purity, and likely synthesis method. They can identify whether the substance was manufactured professionally or improvised, and what it might be intended for.
- extreme success: The investigator extracts every chemical secret the substance holds. They identify its exact formula, recognize that it matches no known compound, or determine that its synthesis requires equipment or knowledge not available to ordinary humans. The implications of its existence may be profoundly disturbing.

## On Failure
- The investigator cannot identify the substance or predict its reactions with confidence. They know it warrants caution but cannot be more specific.
- On a fumble, the investigator misidentifies a dangerous compound as benign, or triggers an unintended reaction during the analysis that creates a new hazard.
