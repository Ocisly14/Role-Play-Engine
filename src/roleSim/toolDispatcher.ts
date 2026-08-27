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
  aliasFor,
  descriptionIdentifier,
  knownAs,
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
  /** Exactly the memories that were rendered into this decision's prompt.
   *  `ref` resolves against THIS list and nothing else — the same rule the
   *  `act` boundary applies to objectRefs: a character may only point at what
   *  they were shown. */
  memories: ReadonlyArray<{
    id: string;
    handle: string;
    type: string;
    content: string;
  }>;
}

export interface DispatchResult {
  /** Result string fed back to the LLM as the tool result content. */
  result: string;
}

interface WriteMemoryInput {
  op?: "add" | "replace" | "delete";
  type?: NpcMemoryType;
  content?: string;
  /** Required for op=replace / op=delete — the tag of the memory to act on. */
  ref?: string;
  /** Required for type=relationship — who the memory is about. */
  targetId?: string;
  /** With type=relationship — what the character now calls them. */
  knownAs?: string;
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

/** The character writes its own memories. `context` — the geography they
 *  started the session knowing — is the one thing written for them, so it is
 *  the one thing they may not rewrite. */
const WRITE_MEMORY_DISALLOWED: ReadonlySet<string> = new Set(["context"]);

async function dispatchWriteMemory(
  input: WriteMemoryInput,
  deps: DispatcherDeps
): Promise<DispatchResult> {
  if (!input) {
    return { result: "Error: writeMemory requires arguments." };
  }
  const op = input.op ?? "add";
  if (op === "replace" || op === "delete") {
    return await dispatchReviseMemory(op, input, deps);
  }
  if (typeof input.type !== "string") {
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
    // An alias for a stranger, or a real id for someone they know. Resolved
    // against every character in the world, not only those in the room: a
    // character's sharpest read on someone is usually formed just after that
    // person walks out, and the alias means the same person either way.
    const realId = deps.dgsm
      .getState()
      .npcCharacters.map((npc) => npc.id)
      .find((id) => id === targetId || aliasFor(deps.npcId, id) === targetId);
    const profile = realId ? deps.dgsm.getNpcProfile(realId) : undefined;
    if (!realId || !profile) {
      return {
        result: `Error: targetId "${targetId}" is nobody in this world. Copy the tag shown beside them in what you perceive.`,
      };
    }
    // Store the REAL id. It never reaches the character — the handler renders
    // `targetName`, and nothing puts `targetId` in a prompt — so there is no
    // leak, and the key stays joinable. `targetName` is how THEY refer to this person, "the tall pale
    // man" until the day they learn better.
    metadata = {
      targetId: realId,
      targetName:
        knownAs(deps.dgsm, deps.npcId, realId) ??
        descriptionIdentifier(profile),
    };

    // The relationship graph is the same fact as this memory, indexed for
    // lookup — so the character writes both, and nothing writes either on
    // their behalf. The Engine used to keep the graph, deciding for a
    // character what they now thought of someone; that operation is gone.
    //
    // One direction only. That the shopkeeper has taken a view of the customer
    // says nothing about what he makes of her.
    deps.dgsm.updateRelationship(
      deps.npcId,
      realId,
      0,
      content.trim(),
      input.knownAs?.trim() || undefined
    );
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

/**
 * Correct or retract a memory the character already holds.
 *
 * Two gates, in this order:
 *  1. `ref` must name a memory that was IN THIS DECISION'S PROMPT. Resolving
 *     against the rendered list — not against the store — is the same rule
 *     `act` applies to objectRefs: a character can only point at what they
 *     were shown. It also makes a truncated-tag collision resolvable, since
 *     both sides derive tags from the same list.
 *  2. The row must still belong to this character in this session. That is
 *     enforced inside the query, so even a leaked id changes nothing.
 *
 * The geography they started with and the diary written for them are not
 * theirs to rewrite — same list as for writing.
 */
async function dispatchReviseMemory(
  op: "replace" | "delete",
  input: WriteMemoryInput,
  deps: DispatcherDeps
): Promise<DispatchResult> {
  const ref = input.ref?.trim();
  if (!ref) {
    return {
      result: `Error: op="${op}" requires 'ref' — the tag at the start of that line in what you remember, e.g. M3f9a2c.`,
    };
  }

  // The handle is stored on the row, so resolving is a lookup and not a
  // recomputation — which is what used to make this disagree with the prompt.
  const target = deps.memories.find((m) => m.handle === ref);
  if (!target) {
    return {
      result: `Error: "${ref}" is not a memory of yours. Copy the tag exactly as it appears at the start of the line in what you remember.`,
    };
  }
  if (WRITE_MEMORY_DISALLOWED.has(target.type)) {
    return {
      result: `Error: "${target.type}" memories are not yours to change — that is what you already knew coming in. Write a new memory of your own instead.`,
    };
  }

  if (op === "delete") {
    const done = await deps.memory.retractOwn({
      memoryId: target.id,
      sessionId: deps.sessionId,
      npcId: deps.npcId,
    });
    return {
      result: done
        ? `Forgotten: "${truncate(target.content, 80)}"`
        : `Error: "${ref}" is no longer in your memory.`,
    };
  }

  const content = typeof input.content === "string" ? input.content : "";
  if (!content.trim()) {
    return {
      result:
        "Error: op=\"replace\" requires 'content' — the whole corrected memory, not just what changed.",
    };
  }

  const done = await deps.memory.reviseOwn({
    memoryId: target.id,
    sessionId: deps.sessionId,
    npcId: deps.npcId,
    content,
    metadata: { revisedAt: deps.gameDateTime },
  });
  return {
    result: done
      ? `Corrected (${target.type}): "${truncate(content, 80)}"`
      : `Error: "${ref}" is no longer in your memory.`,
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
