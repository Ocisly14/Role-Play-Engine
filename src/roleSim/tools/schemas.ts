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

const MEMORY_TYPES = [
  "event",
  "witness",
  "information",
  "map",
  "belief",
  "plan",
  "secret",
  "summary",
  "long_term_intent",
] as const;

export const actTool: ToolSpec = {
  name: "act",
  description:
    "Take one minute-scale beat in the world. Terminates this decision and consumes a tick. See the act section of the system prompt for granularity rules and the actionText format.",
  inputSchema: {
    type: "object",
    properties: {
      actionText: {
        type: "string",
        description:
          "Two labeled sections in one string: a [narrative] block (one short in-character sentence with [N] citation markers) followed by an optional [references] block mapping each [N] to `id: <entity-id>; kind: <character|item|scene>`.",
      },
    },
    required: ["actionText"],
    additionalProperties: false,
  },
  // Every property is required here, so strict validation is expressible on
  // both providers.
  strict: true,
};

export const continueTool: ToolSpec = {
  name: "continue",
  description:
    "Keep doing what you are already doing. Terminates this decision and consumes a tick.",
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
    "Record a genuinely new thought, plan, belief or secret. Reflection, not narration — the engine logs events automatically.",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: [...MEMORY_TYPES] },
      content: { type: "string" },
      mapAdd: {
        type: "object",
        properties: {
          sceneNames: { type: "array", items: { type: "string" } },
          junctionNames: { type: "array", items: { type: "string" } },
          roadNames: { type: "array", items: { type: "string" } },
          revealHiddenConnection: { type: "string" },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ["type"],
    additionalProperties: false,
  },
};

export const recallMemoryTool: ToolSpec = {
  name: "recallMemory",
  description:
    "Search your own memory. Does not consume a tick; you must still finish with act or continue.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      types: {
        type: "array",
        items: { type: "string", enum: [...MEMORY_TYPES] },
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

export const getMapSnapshotTool: ToolSpec = {
  name: "getMapSnapshot",
  description:
    "Read your current map knowledge. Does not consume a tick; you must still finish with act or continue.",
  inputSchema: {
    type: "object",
    properties: {},
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
  getMapSnapshotTool,
];
