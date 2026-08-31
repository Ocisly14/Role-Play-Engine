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
// Every schema sets `additionalProperties: false` and lists `required`, which
// is what `strict: true` demands on both providers.

import { SKILL_CATALOG } from "../../engine/rules/skillCatalog.js";
import type { ToolSpec } from "../../models/providers/types.js";

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
  description:
    "Declare the ONE thing you now set out to do in the world (intent only — the engine decides outcomes and real duration). Terminates this decision and consumes a tick. See the act section of the system prompt for granularity rules.",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description:
          "One or two in-character sentences describing what you attempt and how — never its outcome.",
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
            id: { type: "string" },
            role: {
              type: "string",
              enum: ["target", "tool", "destination", "recipient"],
              description:
                "How you use this entity: acted upon (target), used to act (tool), moved toward (destination), given/told something (recipient).",
            },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      proposedDurationTicks: {
        type: "integer",
        minimum: 1,
        description:
          "How many ticks (1 tick = 1 in-world minute) you expect or are willing to invest. Your estimate only — the engine sets the authoritative duration.",
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
          "The skill you consciously bring to bear. Declare it whenever your training is what you are relying on — talking someone round, moving unseen, forcing a lock, reading a document, landing a blow — and declare it even when you are poor at it: missing a check costs the minutes and that approach, nothing more. Omitting it is a real choice and not a default: an action with no declared skill is settled on its own merits and your training counts for nothing. Never values, difficulties or rolls — only which skill.",
      },
      language: {
        type: "string",
        description:
          'Required with skillId "Languages", and meaningless without it: name the tongue you are reading or speaking, exactly as it appears under "What you can do". A language you grew up with needs no skillId at all — you simply speak it.',
      },
      utterance: {
        type: "string",
        description:
          "Optional: the exact words you speak, verbatim. Omit when silent.",
      },
    },
    required: ["description", "objectRefs", "proposedDurationTicks"],
    additionalProperties: false,
  },
};

export const continueTool: ToolSpec = {
  name: "continue",
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
  description:
    "Keep, correct or retract a long-term memory — nothing is recorded for you. Free: may be called in the same turn as act/continue.",
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
