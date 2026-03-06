export interface HorrorSource {
  id: string;
  description: string;
  sanLossMin: number;
  sanLossMax: number;
}

export const BASELINE_HORROR_SOURCES: HorrorSource[] = [
  { id: "corpse_fresh",     description: "Seeing a fresh human corpse",                     sanLossMin: 0, sanLossMax: 1 },
  { id: "corpse_mutilated", description: "Seeing a mutilated or dismembered corpse",        sanLossMin: 1, sanLossMax: 5 },
  { id: "undead",           description: "Encountering an undead creature zombie ghoul",     sanLossMin: 0, sanLossMax: 7 },
  { id: "deep_one",         description: "Seeing a Deep One or fish-hybrid creature",        sanLossMin: 0, sanLossMax: 7 },
  { id: "shoggoth",         description: "Encountering a Shoggoth",                         sanLossMin: 7, sanLossMax: 16 },
  { id: "great_old_one",    description: "Seeing a Great Old One or cosmic deity",           sanLossMin: 10, sanLossMax: 20 },
  { id: "mythos_tome",      description: "Reading a Mythos tome cover to cover",             sanLossMin: 7, sanLossMax: 8 },
  { id: "alien_geometry",   description: "Witnessing non-Euclidean geometry or alien space", sanLossMin: 1, sanLossMax: 11 },
  { id: "possession",       description: "Watching someone become possessed",               sanLossMin: 0, sanLossMax: 7 },
  { id: "ritual_sacrifice", description: "Witnessing a ritual sacrifice or murder",         sanLossMin: 0, sanLossMax: 7 },
  { id: "insane_person",    description: "Encountering a violently insane person",           sanLossMin: 0, sanLossMax: 4 },
  { id: "dark_young",       description: "Encountering a Dark Young of Shub-Niggurath",     sanLossMin: 4, sanLossMax: 11 },
  { id: "mi_go",            description: "Seeing a Mi-Go Fungi from Yuggoth",               sanLossMin: 0, sanLossMax: 7 },
  { id: "byakhee",          description: "Seeing a Byakhee",                               sanLossMin: 0, sanLossMax: 7 },
  { id: "nightgaunt",       description: "Seeing a Nightgaunt",                            sanLossMin: 0, sanLossMax: 5 },
  { id: "haunting",         description: "Witnessing a poltergeist or haunting event",     sanLossMin: 0, sanLossMax: 5 },
  { id: "dream_horror",     description: "Experiencing a Mythos nightmare or dream vision", sanLossMin: 0, sanLossMax: 4 },
];
