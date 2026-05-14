/**
 * State Change Type Registry — self-contained JSON schema units
 * representing each kind of game state change.
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
      "Apply a hit point delta to a character (positive = heal, negative = wound).",
    schema: {
      type: "object",
      properties: {
        characterId: {
          type: "string",
          description: "ID of the character to modify.",
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
    description: "Apply a sanity delta to a character.",
    schema: {
      type: "object",
      properties: {
        characterId: {
          type: "string",
          description: "ID of the character to modify.",
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
    description: "Apply a fatigue delta to a character.",
    schema: {
      type: "object",
      properties: {
        characterId: {
          type: "string",
          description: "ID of the character to modify.",
        },
        delta: {
          type: "number",
          description: "Fatigue change (positive = more tired).",
        },
      },
      required: ["characterId", "delta"],
    },
  },

  "character.condition": {
    description: "Add or remove status conditions on a character.",
    schema: {
      type: "object",
      properties: {
        characterId: {
          type: "string",
          description: "ID of the character to modify.",
        },
        add: {
          type: "array",
          items: { type: "string" },
          description: "Conditions to add.",
        },
        remove: {
          type: "array",
          items: { type: "string" },
          description: "Conditions to remove.",
        },
      },
      required: ["characterId"],
    },
  },

  "character.position": {
    description: "Move a character to a specific scene and optional junction.",
    schema: {
      type: "object",
      properties: {
        characterId: {
          type: "string",
          description: "ID of the character to move.",
        },
        sceneId: { type: "string", description: "Destination scene ID." },
        junction: {
          type: "string",
          description: "Specific junction within the scene (optional).",
        },
      },
      required: ["characterId", "sceneId"],
    },
  },

  // ── Item ────────────────────────────────────────────────────────────────────

  "item.move": {
    description: "Move an item from one location to another.",
    schema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "ID of the item to move." },
        from: {
          type: "string",
          description: "Source location (NPC ID or 'scene:<sceneId>').",
        },
        to: {
          type: "string",
          description: "Destination location (NPC ID or 'scene:<sceneId>').",
        },
      },
      required: ["itemId", "from", "to"],
    },
  },

  "item.destroy": {
    description: "Destroy an item, removing it from the world.",
    schema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "ID of the item to destroy." },
        from: { type: "string", description: "Current location of the item." },
      },
      required: ["itemId"],
    },
  },

  "item.create": {
    description: "Create a new item and place it in a location.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name for the new item." },
        location: {
          type: "string",
          description: "Where to place the item (NPC ID or 'scene:<sceneId>').",
        },
        properties: {
          type: "object",
          description: "Additional item properties.",
        },
      },
      required: ["name", "location"],
    },
  },

  "item.modify": {
    description: "Modify properties of an existing item.",
    schema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "ID of the item to modify." },
        properties: {
          type: "object",
          description: "Properties to update on the item.",
        },
      },
      required: ["itemId", "properties"],
    },
  },

  // ── Scene ───────────────────────────────────────────────────────────────────

  "scene.condition": {
    description: "Add or remove conditions on a scene.",
    schema: {
      type: "object",
      properties: {
        sceneId: { type: "string", description: "ID of the scene to modify." },
        add: {
          type: "array",
          items: { type: "string" },
          description: "Conditions to add to the scene.",
        },
        remove: {
          type: "array",
          items: { type: "string" },
          description: "Conditions to remove from the scene.",
        },
      },
      required: ["sceneId"],
    },
  },

  // ── Memory ──────────────────────────────────────────────────────────────────

  "memory.event": {
    description: "Record an event memory for a character.",
    schema: {
      type: "object",
      properties: {
        characterId: {
          type: "string",
          description: "ID of the character receiving the memory.",
        },
        content: {
          type: "string",
          description: "Content of the event memory.",
        },
      },
      required: ["characterId", "content"],
    },
  },

  "memory.witness": {
    description:
      "Record a witness memory for a character (something they observed).",
    schema: {
      type: "object",
      properties: {
        characterId: {
          type: "string",
          description: "ID of the character receiving the memory.",
        },
        content: {
          type: "string",
          description: "Content of what was witnessed.",
        },
      },
      required: ["characterId", "content"],
    },
  },

  // ── Relationship ─────────────────────────────────────────────────────────────

  "relationship.change": {
    description: "Adjust the relationship value between two characters.",
    schema: {
      type: "object",
      properties: {
        fromId: {
          type: "string",
          description: "ID of the character whose relationship is changing.",
        },
        toId: { type: "string", description: "ID of the target character." },
        delta: {
          type: "number",
          description:
            "Relationship value change (positive = warmer, negative = colder).",
        },
        note: {
          type: "string",
          description: "Narrative reason for the relationship change.",
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
