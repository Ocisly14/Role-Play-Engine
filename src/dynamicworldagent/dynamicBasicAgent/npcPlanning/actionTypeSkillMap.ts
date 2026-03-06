import type { ActionType } from "../../../shared/state/index.js";

export const ACTION_TYPE_SKILL_MAP: Record<ActionType, string[]> = {
  exploration: [
    "Spot Hidden", "Listen", "Library Use", "Research",
    "Archaeology", "History", "Occult", "Natural World", "Anthropology",
    "Science (Astronomy)", "Science (Biology)", "Science (Chemistry)",
    "Science (Cryptography)", "Science (Forensics)", "Science (Geology)",
    "Science (Mathematics)", "Science (Pharmacy)", "Science (Physics)",
    "Navigate", "Track", "Appraise", "Accounting",
    "Locksmith", "Computer Use", "Art/Craft (Photography)",
    "Language (Other)",
  ],
  social: [
    "Charm", "Fast Talk", "Persuade", "Intimidate",
    "Psychology", "Credit Rating", "Disguise",
    "Language (Own)", "Language (Other)",
    "Art/Craft (Acting)", "Law", "Accounting",
  ],
  combat: [
    "Fighting (Brawl)", "Fighting (Sword)", "Fighting (Axe)",
    "Fighting (Spear)", "Fighting (Flail)", "Fighting (Whip)",
    "Fighting (Chainsaw)", "Fighting (Garrote)",
    "Firearms (Handgun)", "Firearms (Rifle/Shotgun)", "Firearms (Submachine Gun)",
    "Firearms (Machine Gun)", "Firearms (Heavy Weapons)", "Firearms (Flamethrower)",
    "Throw", "Dodge", "First Aid",
    "Electrical Repair", "Mechanical Repair",
  ],
  stealth: [
    "Stealth", "Sleight of Hand", "Disguise",
    "Locksmith", "Spot Hidden", "Listen",
    "Electrical Repair", "Mechanical Repair",
    "Art/Craft (Forgery)", "Computer Use", "Psychology",
  ],
  chase: [
    "Drive Auto", "Pilot (Aircraft)", "Pilot (Boat)",
    "Ride", "Swim", "Climb", "Jump", "Dodge", "Throw",
    "Operate Heavy Machinery", "Mechanical Repair",
  ],
  mental: [
    "Psychology", "Psychoanalysis",
    "Occult", "Cthulhu Mythos",
    "History", "Science (Astronomy)",
    "Medicine", "Art/Craft (Fine Art)", "Language (Other)",
  ],
  environmental: [
    "Survival (Desert)", "Survival (Forest)", "Survival (Arctic)", "Survival (Sea)",
    "First Aid", "Medicine", "Navigate",
    "Natural World", "Track", "Climb", "Swim", "Jump",
    "Science (Biology)", "Science (Geology)",
    "Science (Chemistry)", "Science (Meteorology)", "Science (Pharmacy)",
    "Electrical Repair", "Mechanical Repair", "Operate Heavy Machinery",
  ],
  narrative: [
    "Language (Own)", "Language (Other)",
    "History", "Occult", "Library Use", "Research", "Anthropology",
    "Charm", "Persuade", "Fast Talk",
    "Art/Craft (Writing)", "Art/Craft (Acting)", "Art/Craft (Fine Art)",
    "Psychology", "Law", "Accounting",
    "Science (Cryptography)", "Science (Mathematics)",
  ],
};
