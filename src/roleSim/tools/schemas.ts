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

/** Types recallMemory may filter on — everything readable, including the
 *  system-written daily summaries and the `context` memories that hold what
 *  the character knew about the town before the first tick. */
const READABLE_MEMORY_TYPES = [
  ...WRITABLE_MEMORY_TYPES,
  "summary",
  "context",
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
          'Entities the action involves. Each id MUST be copied from the "What you can point at" list in this tick\'s prompt (a stranger appears there under an alias). Use [] when no entity is involved.',
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["character", "item", "scene"] },
            id: { type: "string" },
            role: {
              type: "string",
              enum: ["target", "tool", "destination", "recipient"],
              description:
                "How you use this entity: acted upon (target), used to act (tool), moved toward (destination), given/told something (recipient).",
            },
          },
          required: ["kind", "id"],
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
        type: "string",
        description:
          'Optional: the skill you consciously bring to bear (e.g. "Locksmith"). Only when the action genuinely runs through it. Never values, difficulties or rolls.',
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
    "Keep something in long-term memory — nothing is recorded for you. Free: may be called in the same turn as act/continue.",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: [...WRITABLE_MEMORY_TYPES] },
      content: { type: "string" },
      targetId: {
        type: "string",
        description:
          'Required for type=relationship: the person this memory is about, copied from "What you can point at".',
      },
    },
    required: ["type"],
    additionalProperties: false,
  },
};

export const recallMemoryTool: ToolSpec = {
  name: "recallMemory",
  description:
    "Search your own memory. Needs a turn of its own (you must read the results), then finish with act or continue.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      types: {
        type: "array",
        items: { type: "string", enum: [...READABLE_MEMORY_TYPES] },
      },
      gameDates: {
        type: "array",
        items: {
          type: "string",
          description: 'ISO 8601 date, "YYYY-MM-DD".',
        },
      },
      limit: { type: "integer" },
    },
    required: [],
    additionalProperties: false,
  },
};

/** Order is stable: tool definitions render ahead of the system prompt, so a
 *  reordering would invalidate the cached prefix on every call. */
export const AGENT_TOOLS: ToolSpec[] = [
  actTool,
  continueTool,
  writeMemoryTool,
  recallMemoryTool,
];
