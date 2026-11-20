// src/roleSim/tools/schemas.ts
//
// JSON Schemas for the agent's native tool calls.
//
// The prose guidance for each tool stays in the system prompt (assembled in
// systemPrompt.ts from the `*Doc` constants) rather than moving into these
// `description` fields: it is long, it is shared framing rather than
// field-level help, and it already sits behind the measured cache breakpoint.
// What lives here is only what the model needs to fill the arguments in.
//
// Every schema sets `additionalProperties: false` and lists `required` — but
// none of these is ever sent strict: they carry `noGrammar`, for the reason
// written on that field. What they gain from the shape is a clean contract for
// the trust boundary to check, not a provider-side grammar.

import { SKILL_CATALOG } from "../../engine/rules/skillCatalog.js";
import type { ToolSpec } from "../../models/providers/types.js";
import { askFriendTool } from "./askFriend.js";
import { SLEEP_FIELD_DESCRIPTION } from "./sleepField.js";

/** Types the character may write. `summary` is system-authored (end-of-day
 *  diary) and deliberately absent. */
const WRITABLE_MEMORY_TYPES = [
  "general",
  "plan",
  "secret",
  "relationship",
  "map",
  "long_term_intent",
] as const;

export const actTool: ToolSpec = {
  name: "act",
  // See `ToolSpec.noGrammar`: constraining this one makes the model fill
  // `skillId`/`language`/`utterance` with `""` rather than leave them out.
  noGrammar: true,
  description:
    "Declare ONE atomic action with one immediate objective and an independently settleable result (intent only; the engine decides outcomes and duration). Submit only the next action, not a sequence or a plan for the engine to split. A single action may span several ticks. Terminates this decision. See the act section for granularity rules.",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description:
          "One or two in-character sentences for ONE immediate action and how you attempt it, never its outcome. Separate independently completable tasks: thanking someone, making a bed and keeping watch are separate acts chosen as each preceding action ends. Incidental posture and an accompanying remark do not require separate hand-motion acts.",
      },
      objectRefs: {
        type: "array",
        description:
          "Entities the action involves. Each id MUST be a bracketed tag from what you perceive this tick, copied exactly and without its brackets (a stranger appears as an alias like `stranger_a`). Use [] when no entity is involved.",
        items: {
          type: "object",
          properties: {
            // No `kind`: the id says whether it names a person, a thing or a
            // place, so asking for it as well only
            // offered a way to be wrong about a real id — and a mislabelled
            // real id used to be rejected as if it named nothing. The
            // boundary derives the kind.
            // No `role` either: how you use the entity is already in
            // `description`, and nothing downstream needed it said twice.
            id: { type: "string" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      proposedDurationTicks: {
        type: "integer",
        minimum: 1,
        description:
          "Ticks (1 tick = 1 in-world minute) for THIS single action, not a sequence of future tasks. Atomic does not mean one tick — a night's sleep is 480, a long journey or a stay can run to days, up to 10080 (seven days). Your estimate only; the engine sets the authoritative duration.",
      },
      skillId: {
        // Enumerated rather than free text, for two reasons found in one run
        // where 25 of 25 actions declared nothing at all: the only example the
        // model was shown ("Locksmith") is a pre-consolidation name that no
        // character sheet carries any more, and the list of real skills lived
        // only in the system prompt, far from the moment of choosing.
        type: "string",
        enum: SKILL_CATALOG.map((skill) => skill.name),
        description:
          "The skill you use for a task such as moving unseen, forcing a lock, translating a document or landing a blow. Omit for persuasion, questioning, deception, intimidation, negotiation and reading people. Provide only the skill name.",
      },
      language: {
        type: "string",
        description:
          'Required with skillId "Languages": name the tongue you are reading or speaking, exactly as it appears under "What you can do". A native tongue needs no Languages declaration.',
      },
      utterance: {
        type: "string",
        description:
          "Optional: exact words intended for delivery at the END of this same action. If they must be heard before subsequent work, submit speech as a separate short act first. Do not attach an immediate announcement to a long watch. Omit when silent; description alone delivers no words.",
      },
    },
    required: ["description", "objectRefs", "proposedDurationTicks"],
    additionalProperties: false,
  },
};

export const continueTool: ToolSpec = {
  name: "continue",
  noGrammar: true,
  description:
    "Keep your IN-FLIGHT action running (see 'Currently doing'). If you have no in-flight action, this does NOTHING — no event, no memory, others see you standing idle; declare routines with `act` instead. Terminates this decision and consumes a tick.",
  inputSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Short in-character reason for not changing course.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export const writeMemoryTool: ToolSpec = {
  name: "writeMemory",
  noGrammar: true,
  description:
    "Keep, correct or retract a long-term memory — nothing is recorded for you. Free: may be called in the same turn as act/continue, and once per memory when this minute left you several worth keeping — write them all in this turn, since the turn ends when you act.",
  inputSchema: {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: ["add", "replace", "delete"],
        description:
          "add (default) keeps something new. replace corrects a memory you already hold. delete retracts one. replace and delete need `ref`.",
      },
      type: {
        type: "string",
        enum: [...WRITABLE_MEMORY_TYPES],
        description: "Required for op=add. Ignored for replace and delete.",
      },
      content: {
        type: "string",
        description:
          "Required for op=add and op=replace. For replace this is the whole corrected memory, not a diff.",
      },
      ref: {
        type: "string",
        description:
          "Required for op=replace and op=delete: the tag shown at the start of that line in what you remember, e.g. M3f9a2c.",
      },
      targetId: {
        type: "string",
        description:
          "Required for type=relationship: the person this memory is about, by the tag beside them in what you perceive.",
      },
      knownAs: {
        type: "string",
        description:
          "With type=relationship: what you now CALL this person, once you have actually been told — a name you heard them give, or that someone used in front of you. Until you set it they stay a description to you, however strong your opinion. Never guess it, and never put down a name nobody said.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

/** Order is stable: tool definitions render ahead of the system prompt, so a
 *  reordering would invalidate the cached prefix on every call. */
export const AGENT_TOOLS: ToolSpec[] = [actTool, continueTool, writeMemoryTool];

const replyField = {
  type: "string",
  maxLength: 320,
  description:
    "Optional exact words you say NOW in reply to the player you just heard. One brief spoken reply only. Omit for silence. Keep future speech and physical actions in their ordinary fields.",
};

export const MANUAL_DIALOGUE_TOOLS: ToolSpec[] = AGENT_TOOLS.map((tool) => {
  if (tool.name !== "act" && tool.name !== "continue") return tool;
  const copy = structuredClone(tool);
  (copy.inputSchema.properties as Record<string, unknown>).replyNow =
    replyField;
  return copy;
});

/** The player character's `act`: the same tool, still named "act", plus one
 *  optional `sleep` flag. A deep copy, so `actTool` — and with it every NPC
 *  request — stays byte-identical. */
export const playerActTool: ToolSpec = (() => {
  const copy = structuredClone(actTool);
  const schema = copy.inputSchema as { properties: Record<string, unknown> };
  schema.properties.sleep = {
    type: "boolean",
    description: SLEEP_FIELD_DESCRIPTION,
  };
  return copy;
})();

/** A player character the player has handed over: the NPC tool set, the
 *  player's `act`, and the line to their absent friend. Order is stable for
 *  the same cache reason as AGENT_TOOLS. */
export const PLAYER_DELEGATED_TOOLS: ToolSpec[] = [
  playerActTool,
  continueTool,
  writeMemoryTool,
  askFriendTool,
];
