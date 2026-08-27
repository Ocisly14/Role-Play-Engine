// src/roleSim/toolDispatcher.ts
//
// Instant-tool dispatcher. Executes the agent's non-terminal tools
// (writeMemory / recallMemory) against the memory store and DGSM. Terminal tools (act / continue) never flow through here — the agent
// loop returns them to the controller, which is the single place engine
// submission happens.
//
// `writeMemory` is special: it returns nothing the agent must read before
// deciding, so the agent loop lets it ride along in the same turn as a
// terminal call (see FREE_WITH_TERMINAL in llmAgent).

import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { NpcMemoryType } from "../memory/types.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import { coerceIsoDate, formatForPrompt } from "../state/gameClock.js";
import {
  buildPerceivableDirectory,
  descriptionIdentifier,
  isKnownTo,
} from "../state/perceivableDirectory.js";

/** Tools that consume a tick — calling one ends the agent loop. Decision 17. */
export const TERMINAL_TOOLS = new Set<string>(["act", "continue"]);

/** Tools that may share a turn with a terminal call: they produce no result
 *  the agent needs to read back, so batching them costs no extra round trip. */
export const FREE_WITH_TERMINAL = new Set<string>(["writeMemory"]);

/** Per-tool call budget within a single decide() call. Decision 19. */
export const TOOL_CAPS: Record<string, number> = {
  recallMemory: 10,
  writeMemory: 3,
};

/** Whitelist of valid tool names — used for LLM output validation. */
export const VALID_TOOLS = new Set<string>([
  "act",
  "continue",
  "writeMemory",
  "recallMemory",
]);

export interface DispatcherDeps {
  memory: NpcMemoryManager;
  dgsm: DynamicGameStateManager;
  npcId: string;
  sessionId: string;
  moduleId: string;
  gameDateTime: string;
  /** Where the character is right now — stamped onto written memories so
   *  recall can answer "what happened at the library". */
  location?: string;
}

export interface DispatchResult {
  /** Result string fed back to the LLM as the tool result content. */
  result: string;
}

interface WriteMemoryInput {
  type: NpcMemoryType;
  content?: string;
  /** Required for type=relationship — who the memory is about. */
  targetId?: string;
}

interface RecallMemoryInput {
  query?: string;
  types?: NpcMemoryType[];
  gameDates?: string[];
  limit?: number;
}

export async function dispatchInstantTool(
  toolName: string,
  input: unknown,
  caps: Record<string, number>,
  deps: DispatcherDeps
): Promise<DispatchResult> {
  if (caps[toolName] !== undefined && caps[toolName] <= 0) {
    return {
      result: `Error: tool "${toolName}" has been used the maximum allowed times in this decision. Try a different tool or commit with act/continue.`,
    };
  }
  if (caps[toolName] !== undefined) caps[toolName] -= 1;

  switch (toolName) {
    case "writeMemory":
      return await dispatchWriteMemory(input as WriteMemoryInput, deps);
    case "recallMemory":
      return await dispatchRecallMemory(input as RecallMemoryInput, deps);
    default:
      return { result: `Unknown instant tool: ${toolName}` };
  }
}

/** The character writes its own memories. `summary` (end-of-day diary) and
 *  `context` (the geography they started the session knowing) stay
 *  system-authored. */
const WRITE_MEMORY_DISALLOWED: ReadonlySet<string> = new Set([
  "summary",
  "context",
]);

async function dispatchWriteMemory(
  input: WriteMemoryInput,
  deps: DispatcherDeps
): Promise<DispatchResult> {
  if (!input || typeof input.type !== "string") {
    return { result: "Error: writeMemory requires a 'type' field." };
  }
  if (WRITE_MEMORY_DISALLOWED.has(input.type)) {
    return {
      result: `Error: "${input.type}" memories are not yours to write. Allowed types: general, plan, secret, relationship, map, long_term_intent.`,
    };
  }

  const content = typeof input.content === "string" ? input.content : "";

  if (!content.trim()) {
    return {
      result: "Error: writeMemory requires non-empty 'content'.",
    };
  }

  // A relationship memory without a subject cannot be retrieved as "what do
  // I know about X" — reject rather than silently degrade it to general.
  let metadata: Record<string, unknown> | undefined;
  if (input.type === "relationship") {
    const targetId = input.targetId?.trim();
    if (!targetId) {
      return {
        result:
          "Error: type=relationship requires 'targetId' — the handle of the person the memory is about.",
      };
    }
    // What the agent wrote is what it may cite — an alias for a stranger, a
    // real id for someone it knows. Resolve through the same directory the
    // `act` boundary uses, so exactly the same names work in both tools.
    const realId = buildPerceivableDirectory(
      deps.npcId,
      deps.dgsm
    ).characterHandles.get(targetId);
    const profile = realId ? deps.dgsm.getNpcProfile(realId) : undefined;
    if (!realId || !profile) {
      return {
        result: `Error: targetId "${targetId}" is not someone you can point at right now. Copy a name from "What you can point at".`,
      };
    }
    // Store the REAL id. It never reaches the character — the handler renders
    // `targetName`, and nothing puts `targetId` in a prompt — so there is no
    // leak, and the key stays joinable instead of drifting with a per-tick
    // alias. `targetName` is how THEY refer to this person, "the tall pale
    // man" until the day they learn better.
    metadata = {
      targetId: realId,
      targetName: isKnownTo(deps.dgsm, deps.npcId, realId)
        ? profile.name
        : descriptionIdentifier(profile),
    };
  }

  await deps.memory.add({
    npcId: deps.npcId,
    sessionId: deps.sessionId,
    moduleId: deps.moduleId,
    type: input.type,
    content,
    gameDateTime: deps.gameDateTime,
    ...(deps.location ? { location: deps.location } : {}),
    ...(metadata ? { metadata } : {}),
  });

  return {
    result: `Remembered (${input.type}): "${truncate(content, 80)}"`,
  };
}

async function dispatchRecallMemory(
  input: RecallMemoryInput,
  deps: DispatcherDeps
): Promise<DispatchResult> {
  const limit = clampLimit(input.limit, 5, 20);
  let gameDates: string[] | undefined;
  if (input.gameDates !== undefined) {
    if (!Array.isArray(input.gameDates)) {
      return {
        result: `Error: gameDates must be an array of ISO 8601 dates (e.g. ["1923-10-15"])`,
      };
    }
    const coerced: string[] = [];
    for (const raw of input.gameDates) {
      const c = typeof raw === "string" ? coerceIsoDate(raw) : null;
      if (!c) {
        return {
          result: `Error: gameDates entries must be ISO 8601 date "YYYY-MM-DD" (got: ${JSON.stringify(raw)})`,
        };
      }
      if (c !== raw.trim()) {
        console.debug(
          `[toolDispatcher] coerced recallMemory.gameDates entry "${raw}" -> "${c}"`
        );
      }
      coerced.push(c);
    }
    gameDates = coerced.length > 0 ? coerced : undefined;
  }
  const memories = await deps.memory.query({
    npcId: deps.npcId,
    sessionId: deps.sessionId,
    query: input.query ?? "",
    filters: {
      types: input.types,
      ...(gameDates !== undefined ? { gameDate: gameDates } : {}),
    },
    limit,
  });

  if (memories.length === 0) {
    return { result: "No memories matched." };
  }

  const lines = memories.map(
    (m) =>
      `- [${formatForPrompt(m.gameDateTime)}] (${m.type}) ${truncate(m.content, 200)}`
  );
  return {
    result: `Found ${memories.length} memory(ies):\n${lines.join("\n")}`,
  };
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.round(value)));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
