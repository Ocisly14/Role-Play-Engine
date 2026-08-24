/**
 * State Change Type Registry — self-contained JSON schema units
 * representing each kind of game state change.
 *
 * Each `description` follows the same template:
 *   <one-sentence function>. Use when <trigger>. Example: <one example>.
 * Inline `<field>: <format>` notes are added when the field semantics aren't
 * self-evident from the type signature alone (only the typeDef.description
 * reaches the resolver LLM — per-field schema descriptions are stripped by
 * `formatOutputSchemaPrompt`).
 */

// ===== Interfaces =====

export interface JsonSchemaProperty {
  type: string;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  enum?: string[];
  description?: string;
}

export interface StateChangeSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties?: boolean;
}

export interface StateChangeTypeDef {
  schema: StateChangeSchema;
  description: string;
}

// ===== Registry =====

export const STATE_CHANGE_TYPES: Record<string, StateChangeTypeDef> = {
  // ── Character ───────────────────────────────────────────────────────────────

  "character.hp": {
    description:
      "Apply a hit point delta to a character (positive = heal, negative = wound). " +
      "Use when an action causes physical damage or healing (combat hit, fall, first aid). " +
      "Example: {characterId: 'Marsh', delta: -8} (Marsh takes 8 HP of damage).",
    schema: {
      type: "object",
      properties: {
        characterId: {
          type: "string",
          description:
            "Exact id of the character to modify. Copy the exact character id from the Actor/Target sections of this prompt — never invent or abbreviate one.",
        },
        delta: {
          type: "number",
          description: "HP change (positive heals, negative wounds).",
        },
      },
      required: ["characterId", "delta"],
    },
  },

  "character.san": {
    description:
      "Apply a Sanity delta to a character (positive = recover, negative = lose). " +
      "Use when an action causes mental trauma (witnessing horror, reading forbidden " +
      "lore, surviving violence) or recovery (long rest, therapy, prayer). " +
      "Example: {characterId: 'Marsh', delta: -5} (Marsh sees something " +
      "deeply unsettling); {characterId: 'Marsh', delta: 2} (a long quiet " +
      "evening of routine settles his nerves).",
    schema: {
      type: "object",
      properties: {
        characterId: {
          type: "string",
          description:
            "Exact id of the character to modify. Copy the exact character id from the Actor/Target sections of this prompt — never invent or abbreviate one.",
        },
        delta: {
          type: "number",
          description: "Sanity change (negative = loss).",
        },
      },
      required: ["characterId", "delta"],
    },
  },

  "character.fatigue": {
    description:
      "Apply a fatigue delta to a character (positive = more tired, " +
      "negative = recover via rest/sleep). Range typically 0-10. " +
      "Use after sustained physical effort (positive), or after sleeping / sitting " +
      "down for a long break (negative). " +
      "Example: {characterId: 'Marsh', delta: 2} (Marsh climbs three flights of stairs); " +
      "{characterId: 'Marsh', delta: -3} (Marsh rests in his armchair for an hour).",
    schema: {
      type: "object",
      properties: {
        characterId: {
          type: "string",
          description:
            "Exact id of the character to modify. Copy the exact character id from the Actor/Target sections of this prompt — never invent or abbreviate one.",
        },
        delta: {
          type: "number",
          description:
            "Fatigue change (positive = more tired, negative = recover).",
        },
      },
      required: ["characterId", "delta"],
    },
  },

  "character.condition": {
    description:
      "Add or remove status conditions on a character. Conditions are short " +
      "free-text descriptions ('bleeding', 'dazed', 'scared'). To remove, the " +
      "string must match an existing condition's description exactly. " +
      "Use when a character gains a transient state from an action or recovers from one. " +
      "Example: {characterId: 'Marsh', add: ['bleeding'], remove: ['alert']}.",
    schema: {
      type: "object",
      properties: {
        characterId: {
          type: "string",
          description:
            "Exact id of the character to modify. Copy the exact character id from the Actor/Target sections of this prompt — never invent or abbreviate one.",
        },
        add: {
          type: "array",
          items: { type: "string" },
          description: "Conditions to add (free text descriptions).",
        },
        remove: {
          type: "array",
          items: { type: "string" },
          description:
            "Existing condition descriptions to remove (exact match).",
        },
      },
      required: ["characterId"],
    },
  },

  "character.position": {
    description:
      "Move a character to a different scene. " +
      "Use ONLY when an action ends with the character in a NEW scene; for " +
      "multi-step routes the movement subsystem handles per-tick interpolation " +
      "— do not emit this for intermediate steps. " +
      "The optional `junction` field names a topology junction id between " +
      "scenes (e.g., 'jct_main_st_x_oak_ave'); omit it unless the route " +
      "definitively crosses that junction. " +
      "Example: {characterId: 'Marsh', sceneId: 'SCN_2'} (Marsh enters his study).",
    schema: {
      type: "object",
      properties: {
        characterId: {
          type: "string",
          description:
            "Exact id of the character to move. Copy the exact character id from the Actor/Target sections of this prompt — never invent or abbreviate one.",
        },
        sceneId: {
          type: "string",
          description: "Destination scene ID (e.g., 'SCN_2').",
        },
        junction: {
          type: "string",
          description:
            "Optional topology junction id traversed (e.g., 'jct_main_st').",
        },
      },
      required: ["characterId", "sceneId"],
    },
  },

  // ── Item ────────────────────────────────────────────────────────────────────

  "item.move": {
    description:
      "Move an item between locations. Locations are written as 'scene:<sceneId>' " +
      "or '<npcId>' (NPC inventory). " +
      "Use when an action transfers possession (pick up, drop, hand over, steal). " +
      "Example: {itemId: 'ITEM_SCN2_5', from: 'scene:SCN_2', to: 'Marsh'} " +
      "(Marsh picks the letter up off the desk).",
    schema: {
      type: "object",
      properties: {
        itemId: {
          type: "string",
          description: "ID of the item to move (e.g., 'ITEM_SCN2_5').",
        },
        from: {
          type: "string",
          description: "Source location: 'scene:<sceneId>' or '<npcId>'.",
        },
        to: {
          type: "string",
          description: "Destination location: 'scene:<sceneId>' or '<npcId>'.",
        },
      },
      required: ["itemId", "from", "to"],
    },
  },

  "item.destroy": {
    description:
      "Destroy an item, removing it from the world entirely. The engine looks " +
      "it up by id (globally unique) and removes from wherever it lives. " +
      "Use when an item is consumed, broken beyond repair, or burned away. " +
      "Example: {itemId: 'ITEM_SCN2_5'} (the letter is thrown into the fire).",
    schema: {
      type: "object",
      properties: {
        itemId: {
          type: "string",
          description: "ID of the item to destroy (e.g., 'ITEM_SCN2_5').",
        },
      },
      required: ["itemId"],
    },
  },

  "item.create": {
    description:
      "Bring a brand-new item into existence at a location. Location is " +
      "written as 'scene:<sceneId>' or '<npcId>' (NPC inventory). The engine " +
      "generates the id from the name. " +
      "Use when something genuinely new appears (the actor draws a sketch, " +
      "produces a coin, brews tea). Do NOT use this for items that were " +
      "already in the world but the actor only now noticed — those are already " +
      "tracked, no new id needed. " +
      "Example: {name: 'tea cup', location: 'scene:SCN_2'} (Marsh sets out a fresh tea cup).",
    schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Display name for the new item (e.g., 'tea cup').",
        },
        location: {
          type: "string",
          description: "Where to place: 'scene:<sceneId>' or '<npcId>'.",
        },
        properties: {
          type: "object",
          description: "Optional opaque key/value metadata.",
        },
      },
      required: ["name", "location"],
    },
  },

  "item.modify": {
    description:
      "Update an existing item's description to reflect new state. The engine " +
      "looks it up by id (globally unique) — no location field is required. " +
      "NAME stays fixed as the item's stable identity ('letter', 'lamp', " +
      "'cup'); DESCRIPTION carries the evolving state (sealed → broken seal → " +
      "unfolded; unlit → lit → snuffed; empty → full → spilled). " +
      "If the item's identity truly changes (a letter burns into ash), use " +
      "`item.destroy` + `item.create` instead. " +
      "Example: {itemId: 'ITEM_SCN2_5', description: 'cream envelope with broken " +
      "red wax seal; folded sheet visible inside'}.",
    schema: {
      type: "object",
      properties: {
        itemId: {
          type: "string",
          description:
            "ID of the item to modify; copy verbatim from perception (e.g., 'ITEM_SCN2_5').",
        },
        description: {
          type: "string",
          description: "New description reflecting the item's current state.",
        },
      },
      required: ["itemId", "description"],
    },
  },

  // ── Scene ───────────────────────────────────────────────────────────────────

  "scene.condition": {
    description:
      "Add or remove descriptive conditions on a scene. Conditions are short " +
      "free-text descriptions ('smoke fills the air', 'a draft cools the room'). " +
      "To remove, the string must match an existing condition's description exactly. " +
      "Use for AMBIENT / SCENE-LEVEL changes that affect anyone present " +
      "(weather, lighting, smoke, temperature, sound). " +
      "Do NOT use this for state changes on a tracked item (a candle was lit, " +
      "the letter was opened) — that's `item.modify`, which updates the item's " +
      "description so the renderer surfaces it inline with the item. " +
      "Example: {sceneId: 'SCN_2', add: ['smoke is beginning to seep under the door']}.",
    schema: {
      type: "object",
      properties: {
        sceneId: {
          type: "string",
          description: "ID of the scene to modify (e.g., 'SCN_2').",
        },
        add: {
          type: "array",
          items: { type: "string" },
          description: "Conditions to add (free text descriptions).",
        },
        remove: {
          type: "array",
          items: { type: "string" },
          description:
            "Existing condition descriptions to remove (exact match).",
        },
      },
      required: ["sceneId"],
    },
  },

  // ── Memory ──────────────────────────────────────────────────────────────────

  "memory.event": {
    description:
      "Record an event memory in FIRST PERSON for the actor — what THIS character " +
      "just did and what came of it. Past tense, sensory, sized to one or two " +
      "sentences. UNIVERSALLY REQUIRED on every resolution (engine relies on this " +
      "as the canonical 'what happened' record). " +
      "Example: {characterId: 'Marsh', " +
      "content: 'I broke the red wax seal and slid the letter free. Hollins's hand, dated yesterday.'}.",
    schema: {
      type: "object",
      properties: {
        characterId: {
          type: "string",
          description:
            "Exact id of the actor receiving the memory (usually the action's actor). Copy the exact character id from the Actor/Target sections of this prompt — never invent or abbreviate one.",
        },
        content: {
          type: "string",
          description: "First-person past-tense sensory record.",
        },
      },
      required: ["characterId", "content"],
    },
  },

  "memory.witness": {
    description:
      "Record a witness memory in THIRD PERSON for a NON-ACTOR character who " +
      "observed the action. The witness must be perceptually co-located (same " +
      "scene, or close enough that the action's impact reaches them). " +
      "Skip this entirely if no one else was present to see. memory.event " +
      "covers the actor's own first-person record. " +
      "Example: {characterId: 'Hollins', " +
      "content: 'Marsh broke the wax seal of the cream envelope and read the letter.'}.",
    schema: {
      type: "object",
      properties: {
        characterId: {
          type: "string",
          description:
            "Exact id of the witness (NOT the actor). Copy the exact character id from the Actor/Target sections of this prompt — never invent or abbreviate one.",
        },
        content: {
          type: "string",
          description: "Third-person past-tense description of what was seen.",
        },
      },
      required: ["characterId", "content"],
    },
  },

  // ── Relationship ─────────────────────────────────────────────────────────────

  "relationship.change": {
    description:
      "Adjust the attitude one character holds toward another. Direction is " +
      "from→to (the change is one-directional; for mutual change emit two records). " +
      "Score is clamped to -100..+100. " +
      "Use when an action shifts how A feels about B (insulted, helped, discovered " +
      "betrayal, shared confidence). " +
      "Example (ids here are illustrative — always use the real ids from " +
      "this prompt's context): {fromId: 'Marsh', toId: 'Hollins', " +
      "delta: -15, note: 'He was rude about my fieldwork.'}.",
    schema: {
      type: "object",
      properties: {
        fromId: {
          type: "string",
          description:
            "Exact id of the character whose attitude is changing. Copy the exact character id from the Actor/Target sections of this prompt — never invent or abbreviate one.",
        },
        toId: {
          type: "string",
          description:
            "Exact id of the target character. Copy the exact character id from the Actor/Target sections of this prompt — never invent or abbreviate one.",
        },
        delta: {
          type: "number",
          description:
            "Change in attitude score (-100..+100; positive = warmer, negative = colder).",
        },
        note: {
          type: "string",
          description: "Brief narrative reason for the relationship change.",
        },
      },
      required: ["fromId", "toId"],
    },
  },
};

// ===== Accessors =====

export function getStateChangeType(
  typeId: string
): StateChangeTypeDef | undefined {
  return STATE_CHANGE_TYPES[typeId];
}

export function getAllStateChangeTypeIds(): string[] {
  return Object.keys(STATE_CHANGE_TYPES);
}
