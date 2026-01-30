/**
 * Skill Allocator - Random skill point distribution for NPCs
 * Allocates occupational and interest skill points following CoC 7e rules
 */

import type { CharacterAttributes } from "../../coc_multiagents_system/agents/models/gameTypes.js";
import fs from "fs";
import path from "path";

/** Per-skill cap for occupational skill points */
const OCCUPATIONAL_SKILL_CAP = 90;
/** Per-skill cap for interest skill points */
const INTEREST_SKILL_CAP = 80;

/**
 * Occupation data structure from Character occupation.json
 */
interface OccupationData {
  name_en: string;
  suggested_skills: string[];
  suggested_occupational_points: {
    expression: string;
    characteristics: string[];
  };
}

/**
 * Load occupation data from file
 */
function loadOccupationData(occupation: string): OccupationData | null {
  try {
    const occupationsPath = path.join(
      process.cwd(),
      "src",
      "coc_multiagents_system",
      "agents",
      "character",
      "Character occupation.json"
    );

    const occupationsFile = JSON.parse(fs.readFileSync(occupationsPath, "utf-8"));

    // Flatten all occupation groups
    const allOccupations: OccupationData[] = [];
    for (const group of occupationsFile.groups) {
      allOccupations.push(...group.occupations);
    }

    // Find matching occupation (case-insensitive)
    const match = allOccupations.find(
      (occ) => occ.name_en.toLowerCase() === occupation.toLowerCase()
    );

    return match || null;
  } catch (error) {
    console.error("Failed to load occupation data:", error);
    return null;
  }
}

/**
 * Calculate occupational points based on expression
 */
function calculateOccupationalPoints(
  expression: string,
  attributes: CharacterAttributes
): number {
  // Replace attribute names with values
  let evaluated = expression;
  for (const [attr, value] of Object.entries(attributes)) {
    evaluated = evaluated.replace(new RegExp(attr, "g"), value.toString());
  }

  // Evaluate simple expressions (EDU*4, etc.)
  try {
    // Using eval is safe here as we control the input
    // eslint-disable-next-line no-eval
    return Math.floor(eval(evaluated));
  } catch (error) {
    console.error("Failed to evaluate occupational points expression:", expression);
    return 0;
  }
}

/**
 * Randomly distribute points across a list of skills with weighted randomization
 * Core skills get higher allocation
 */
function distributePointsWeighted(
  skillList: string[],
  totalPoints: number
): Record<string, number> {
  const skills: Record<string, number> = {};

  if (skillList.length === 0) return skills;

  // Allocate 60-80% of points to first 4 skills (core skills)
  const coreSkills = skillList.slice(0, Math.min(4, skillList.length));
  const otherSkills = skillList.slice(4);

  const corePercentage = 0.6 + Math.random() * 0.2; // 60-80%
  const corePoints = Math.floor(totalPoints * corePercentage);
  const otherPoints = totalPoints - corePoints;

  // Distribute core points
  let remainingCore = corePoints;
  for (let i = 0; i < coreSkills.length; i++) {
    if (i === coreSkills.length - 1) {
      // Last skill gets remaining points
      skills[coreSkills[i]] = remainingCore;
    } else {
      // Random allocation with minimum 10 points
      const min = 10;
      const max = Math.floor(remainingCore / (coreSkills.length - i));
      const allocation = Math.max(min, Math.floor(Math.random() * max));
      skills[coreSkills[i]] = allocation;
      remainingCore -= allocation;
    }
  }

  // Distribute other points if there are other skills
  if (otherSkills.length > 0) {
    let remainingOther = otherPoints;
    for (let i = 0; i < otherSkills.length; i++) {
      if (i === otherSkills.length - 1) {
        skills[otherSkills[i]] = remainingOther;
      } else {
        const max = Math.floor(remainingOther / (otherSkills.length - i));
        const allocation = Math.floor(Math.random() * max);
        skills[otherSkills[i]] = allocation;
        remainingOther -= allocation;
      }
    }
  }

  return skills;
}

/**
 * Get random subset of skills (for interest skills)
 */
function getRandomSubset<T>(array: T[], count: number): T[] {
  const shuffled = [...array].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

/**
 * Cap each skill at maxPerSkill, then randomly redistribute overflow to other skills (same category, still under cap).
 */
function capAndRedistributeOverflow(
  skillsRaw: Record<string, number>,
  skillNames: string[],
  maxPerSkill: number
): Record<string, number> {
  const skills: Record<string, number> = {};
  let overflow = 0;
  for (const name of skillNames) {
    const points = skillsRaw[name] ?? 0;
    if (points > maxPerSkill) {
      skills[name] = maxPerSkill;
      overflow += points - maxPerSkill;
    } else {
      skills[name] = points;
    }
  }
  while (overflow > 0) {
    const underCap = skillNames.filter((name) => (skills[name] ?? 0) < maxPerSkill);
    if (underCap.length === 0) break;
    const target = underCap[Math.floor(Math.random() * underCap.length)]!;
    const add = Math.min(overflow, maxPerSkill - (skills[target] ?? 0));
    skills[target] = (skills[target] ?? 0) + add;
    overflow -= add;
  }
  return skills;
}

/**
 * Common CoC skill list
 */
const COMMON_SKILLS = [
  "Accounting", "Anthropology", "Appraise", "Archaeology", "Art/Craft",
  "Charm", "Climb", "Credit Rating", "Cthulhu Mythos", "Disguise",
  "Dodge", "Drive Auto", "Electrical Repair", "Fast Talk", "Fighting (Brawl)",
  "Firearms (Handgun)", "Firearms (Rifle/Shotgun)", "First Aid", "History",
  "Intimidate", "Jump", "Language (Other)", "Law", "Library Use", "Listen",
  "Locksmith", "Mechanical Repair", "Medicine", "Natural World", "Navigate",
  "Occult", "Operate Heavy Machinery", "Persuade", "Pilot", "Psychology",
  "Psychoanalysis", "Ride", "Science", "Sleight of Hand", "Spot Hidden",
  "Stealth", "Survival", "Swim", "Throw", "Track"
];

/**
 * Main skill allocation function
 */
export function allocateSkillPoints(
  occupation: string,
  attributes: CharacterAttributes
): Record<string, number> {
  const skills: Record<string, number> = {};

  // Load occupation data
  const occupationData = loadOccupationData(occupation);

  if (!occupationData) {
    console.warn(`Occupation "${occupation}" not found, using generic allocation`);

    // Generic allocation if occupation not found
    const occupationalPoints = attributes.EDU * 4;
    const interestPoints = attributes.INT * 2;

    const randomOccSkills = getRandomSubset(COMMON_SKILLS, 6);
    const occupationalSkillsRaw = distributePointsWeighted(randomOccSkills, occupationalPoints);
    const occupationalSkills = capAndRedistributeOverflow(
      occupationalSkillsRaw,
      randomOccSkills,
      OCCUPATIONAL_SKILL_CAP
    );

    const remainingSkills = COMMON_SKILLS.filter(s => !randomOccSkills.includes(s));
    const randomInterestSkills = getRandomSubset(remainingSkills, 3);
    const interestSkillsRaw = distributePointsWeighted(randomInterestSkills, interestPoints);
    const interestSkills = capAndRedistributeOverflow(
      interestSkillsRaw,
      randomInterestSkills,
      INTEREST_SKILL_CAP
    );

    return { ...occupationalSkills, ...interestSkills };
  }

  // Calculate skill points
  const occupationalPoints = calculateOccupationalPoints(
    occupationData.suggested_occupational_points.expression,
    attributes
  );
  const interestPoints = attributes.INT * 2;

  // Distribute occupational points to suggested skills (cap 90 per skill, overflow redistributed randomly)
  const occupationalSkillsRaw = distributePointsWeighted(
    occupationData.suggested_skills,
    occupationalPoints
  );
  const occupationalSkills = capAndRedistributeOverflow(
    occupationalSkillsRaw,
    occupationData.suggested_skills,
    OCCUPATIONAL_SKILL_CAP
  );

  // Select random interest skills (not in occupational skills)
  const interestCandidates = COMMON_SKILLS.filter(
    s => !occupationData.suggested_skills.includes(s)
  );
  const numInterestSkills = Math.min(3 + Math.floor(Math.random() * 3), interestCandidates.length); // 3-5 skills
  const selectedInterestSkills = getRandomSubset(interestCandidates, numInterestSkills);

  // Distribute interest points across selected skills (cap 80 per skill, overflow redistributed randomly)
  const interestSkillsRaw = distributePointsWeighted(selectedInterestSkills, interestPoints);
  const interestSkills = capAndRedistributeOverflow(
    interestSkillsRaw,
    selectedInterestSkills,
    INTEREST_SKILL_CAP
  );

  // Merge occupational and interest skills
  for (const [skill, points] of Object.entries(occupationalSkills)) {
    skills[skill] = points;
  }

  for (const [skill, points] of Object.entries(interestSkills)) {
    skills[skill] = (skills[skill] || 0) + points;
  }

  return skills;
}
