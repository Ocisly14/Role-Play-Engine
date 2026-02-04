/**
 * Module background and briefing types
 * Used for importing adventure/module overview documents
 */

/** Parsed module information extracted from documents */
export interface ParsedModuleData {
  title: string;
  background?: string;
  storyOutline?: string;
  moduleNotes?: string;
  keeperGuidance?: string;
  moduleLimitations?: string;
  initialGameTime?: string; // Initial game time in format "HH:MM" or "Day X HH:MM"
  initialScenarioNPCs?: string[]; // List of NPC names that are present with the player at the initial scenario
  tags?: string[];
  // Player-facing story introduction (from JSON or generated during document parsing)
  introduction?: string;
}

/** Stored module background record */
export interface ModuleBackground {
  id: string;
  title: string;
  background?: string;
  storyOutline?: string;
  moduleNotes?: string;
  keeperGuidance?: string;
  moduleLimitations?: string;
  initialGameTime?: string; // Initial game time in format "HH:MM" or "Day X HH:MM"
  initialScenarioNPCs?: string[]; // List of NPC names that are present with the player at the initial scenario
  tags: string[];
  // Player-facing story introduction (from JSON's introduction field or generated from documents)
  introduction?: string;
}
