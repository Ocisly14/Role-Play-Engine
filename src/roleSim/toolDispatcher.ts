// src/roleSim/toolDispatcher.ts
//
// Instant-tool dispatcher. Executes the agent's non-terminal tools
// (`writeMemory` — the only one) against the memory store and DGSM. Terminal
// tools (act / continue) never flow through here — the agent loop returns
// them to the controller, which is the single place engine submission
// happens.
//
// Nothing here returns a result the agent must read before deciding, so the
// agent loop lets these calls ride along in the same turn as a terminal one.

import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { NpcMemoryType } from "../memory/types.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import {
  buildPerceivableDirectory,
  descriptionIdentifier,
  isKnownTo,
} from "../state/perceivableDirectory.js";

/** Tools that consume a tick — calling one ends the agent loop. Decision 17. */
export const TERMINAL_TOOLS = new Set<string>(["act", "continue"]);

/** Per-tool call budget within a single decide() call. Decision 19. */
export const TOOL_CAPS: Record<string, number> = {
  writeMemory: 3,
};

/** Whitelist of valid tool names — used for LLM output validation. */
export const VALID_TOOLS = new Set<string>(["act", "continue", "writeMemory"]);

export interface DispatcherDeps {
  memory: NpcMemoryManager;
  dgsm: DynamicGameStateManager;
  npcId: string;
  sessionId: string;
  moduleId: string;
  gameDateTime: string;
  /** Where the character is right now — stamped onto written memories. */
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
        result: `Error: targetId "${targetId}" is not someone you can point at right now. Copy the tag shown beside them in what you perceive.`,
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

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
