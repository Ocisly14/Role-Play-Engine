import { chaseRule } from "./chase.js";
import { combatRule } from "./combat.js";
import { environmentalRule } from "./environmental.js";
import { explorationRule } from "./exploration.js";
import { mentalRule } from "./mental.js";
import { narrativeRule } from "./narrative.js";
import { socialRule } from "./social.js";
import { stealthRule } from "./stealth.js";

export const actionRules = {
  exploration: explorationRule,
  social: socialRule,
  stealth: stealthRule,
  combat: combatRule,
  chase: chaseRule,
  mental: mentalRule,
  environmental: environmentalRule,
  narrative: narrativeRule,
} as const;

export {
  chaseRule,
  combatRule,
  environmentalRule,
  explorationRule,
  mentalRule,
  narrativeRule,
  socialRule,
  stealthRule,
};
