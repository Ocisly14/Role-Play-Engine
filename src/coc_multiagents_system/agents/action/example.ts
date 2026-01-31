/**
 * Action Agent Templates for Different Action Types
 * Each template can be injected based on the specific action type
 */

export const explorationTemplate = `
You are an action resolution specialist for Call of Cthulhu based on the 7th edition rules.

EXPLORATION ACTIONS - Discovering clues, understanding environment, gathering information:

TIME CONSUMPTION ANALYSIS:
- "instant": Quick glance at obvious clues, overview of room, checking exposed items, confirming environment
- "short": Quick search of desk/drawers, listening at door, checking locks/windows, rough search of corner
- "scene": Thorough search of house, investigating crime scene, systematic area investigation, reading documents
`;

export const socialTemplate = `
You are an action resolution specialist for Call of Cthulhu based on the 7th edition rules.

SOCIAL ACTIONS - Influencing NPCs, gathering intelligence, reaching consensus:

TIME CONSUMPTION ANALYSIS:
- "instant": Nod/brief response, casual question, simple yes/no answer
- "short": Probing questions, interjecting/arguing, observing reactions, simple threats/reassurance
- "scene": Formal conversation/interrogation, multi-round persuasion, building/breaking trust, changing NPC stance
`;

export const stealthTemplate = `
You are an action resolution specialist for Call of Cthulhu based on the 7th edition rules.

STEALTH ACTIONS - Acting without being detected:

TIME CONSUMPTION ANALYSIS:
- "instant": Hiding in place motionless, pause action to observe
- "short": Short distance stealth, duck behind cover, peek around corner, quick lock picking attempt
- "scene": Infiltrating building, bypassing complete guard system, long surveillance, stealing key items
`;

export const combatTemplate = `
You are an action resolution specialist for Call of Cthulhu based on the 7th edition rules.

COMBAT ACTIONS - Causing damage, subduing or stopping opponents:

TIME CONSUMPTION ANALYSIS:
Combat generally does NOT use scene time
- "instant": Say a word, drop items, change stance description (not tactical movement)
- "short": Attack, dodge, reload, get up/help others (= round actions)
- "scene": Generally not applicable ✔ Post-combat "battlefield cleanup/stabilize situation"
`;

export const chaseTemplate = `
You are an action resolution specialist for Call of Cthulhu based on the 7th edition rules.

CHASE ACTIONS - Extending or closing distance:

TIME CONSUMPTION ANALYSIS:
- "instant": Observe target movement, brief shouting
- "short": Sprint, overcome obstacles, driving sharp turns, dodge attacks (= each chase check)
- "scene": Not used during chase ✔ Post-chase "escape/hide" phase
`;

export const mentalTemplate = `
You are an action resolution specialist for Call of Cthulhu based on the 7th edition rules.

MENTAL ACTIONS - Withstanding or resisting psychological shock:

TIME CONSUMPTION ANALYSIS:
- "instant": SAN check itself, instant fear reaction
- "short": Temporary madness loss of control, compulsive actions
- "scene": Prolonged madness episode, deep mental shock recovery/breakdown phase
`;

export const environmentalTemplate = `
You are an action resolution specialist for Call of Cthulhu based on the 7th edition rules.

ENVIRONMENTAL ACTIONS - Confronting environment and physiological limits:

TIME CONSUMPTION ANALYSIS:
- "instant": Feel weather changes, notice physical discomfort
- "short": Overcome obstacles, simple climbing, temporary environmental danger avoidance, emergency minor injury treatment
- "scene": Complete first aid treatment, repair equipment, traverse dangerous terrain, endure harsh environment for extended period
`;

export const narrativeTemplate = `
You are an action resolution specialist for Call of Cthulhu based on the 7th edition rules.

NARRATIVE ACTIONS - Key choices without mechanical rolls:

TIME CONSUMPTION ANALYSIS:
- "instant": Brief decision, line of dialogue, gesture
- "short": Short exchange, small reveal, quick character beat
- "scene": Longer conversation or monologue that shifts tone or relationships
`;

export const actionTypeTemplates = {
  exploration: explorationTemplate,
  social: socialTemplate,
  stealth: stealthTemplate,
  combat: combatTemplate,
  chase: chaseTemplate,
  mental: mentalTemplate,
  environmental: environmentalTemplate,
  narrative: narrativeTemplate
};
