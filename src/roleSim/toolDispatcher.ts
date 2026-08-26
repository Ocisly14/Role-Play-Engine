// src/roleSim/toolDispatcher.ts
//
// Instant-tool dispatcher. Executes the agent's non-terminal tools
// (writeMemory / recallMemory / getMapSnapshot) against the memory store and
// DGSM. Terminal tools (act / continue) never flow through here — the agent
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

/** Tools that consume a tick — calling one ends the agent loop. Decision 17. */
export const TERMINAL_TOOLS = new Set<string>(["act", "continue"]);

/** Tools that may share a turn with a terminal call: they produce no result
 *  the agent needs to read back, so batching them costs no extra round trip. */
export const FREE_WITH_TERMINAL = new Set<string>(["writeMemory"]);

/** Per-tool call budget within a single decide() call. Decision 19. */
export const TOOL_CAPS: Record<string, number> = {
  recallMemory: 10,
  writeMemory: 3,
  getMapSnapshot: 1,
};

/** Whitelist of valid tool names — used for LLM output validation. */
export const VALID_TOOLS = new Set<string>([
  "act",
  "continue",
  "writeMemory",
  "recallMemory",
  "getMapSnapshot",
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
  mapAdd?: {
    sceneNames?: string[];
    junctionNames?: string[];
    roadNames?: string[];
    revealHiddenConnection?: string;
  };
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
    case "getMapSnapshot":
      return await dispatchGetMapSnapshot(deps);
    default:
      return { result: `Unknown instant tool: ${toolName}` };
  }
}

/** The character writes its own memories; `summary` stays system-authored
 *  (end-of-day diary). */
const WRITE_MEMORY_DISALLOWED: ReadonlySet<string> = new Set(["summary"]);

async function dispatchWriteMemory(
  input: WriteMemoryInput,
  deps: DispatcherDeps
): Promise<DispatchResult> {
  if (!input || typeof input.type !== "string") {
    return { result: "Error: writeMemory requires a 'type' field." };
  }
  if (WRITE_MEMORY_DISALLOWED.has(input.type)) {
    return {
      result: `Error: "${input.type}" memories are written by the world at day's end, not by you. Allowed types: general, relationship, map, long_term_intent.`,
    };
  }

  let content = typeof input.content === "string" ? input.content : "";

  if (input.type === "map" && input.mapAdd) {
    const summary = renderMapAddSummary(input.mapAdd, deps.dgsm);
    content = content ? `${content}\n${summary}` : summary;
  }

  if (!content.trim()) {
    return {
      result:
        "Error: writeMemory requires non-empty 'content' (or 'mapAdd' for type=map).",
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
          "Error: type=relationship requires 'targetId' — the entity id of the person the memory is about.",
      };
    }
    const profile = deps.dgsm.getNpcProfile(targetId);
    if (!profile) {
      return {
        result: `Error: targetId "${targetId}" is not a person in this world. Copy the id from your perception.`,
      };
    }
    metadata = { targetId, targetName: profile.name };
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

function renderMapAddSummary(
  mapAdd: NonNullable<WriteMemoryInput["mapAdd"]>,
  dgsm: DynamicGameStateManager
): string {
  const state = dgsm.getState();
  const lines: string[] = [];

  for (const name of mapAdd.sceneNames ?? []) {
    const scene = findByName(state.scenes, name);
    lines.push(
      scene
        ? `Learned scene: ${scene.name} (${scene.id})`
        : `Noted unknown scene: ${name}`
    );
    if (!scene) {
      console.warn(
        `[toolDispatcher] writeMemory.mapAdd.sceneNames: no scene matched "${name}"`
      );
    }
  }
  for (const name of mapAdd.junctionNames ?? []) {
    const junction = findByName(state.junctions, name);
    lines.push(
      junction
        ? `Learned junction: ${junction.name} (${junction.id})`
        : `Noted unknown junction: ${name}`
    );
    if (!junction) {
      console.warn(
        `[toolDispatcher] writeMemory.mapAdd.junctionNames: no junction matched "${name}"`
      );
    }
  }
  for (const name of mapAdd.roadNames ?? []) {
    const road = findByName(state.roads, name);
    lines.push(
      road
        ? `Learned road: ${road.name} (${road.id})`
        : `Noted unknown road: ${name}`
    );
    if (!road) {
      console.warn(
        `[toolDispatcher] writeMemory.mapAdd.roadNames: no road matched "${name}"`
      );
    }
  }
  if (mapAdd.revealHiddenConnection) {
    lines.push(
      `Discovered hidden connection: ${mapAdd.revealHiddenConnection}`
    );
  }
  return lines.join("\n");
}

function findByName<T extends { id: string; name: string }>(
  map: Map<string, T>,
  name: string
): T | undefined {
  const needle = name.trim().toLowerCase();
  for (const value of map.values()) {
    if (value.name.toLowerCase() === needle) return value;
  }
  return undefined;
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

async function dispatchGetMapSnapshot(
  deps: DispatcherDeps
): Promise<DispatchResult> {
  const snapshot = await deps.memory.getMapSnapshot(deps.npcId, deps.sessionId);
  if (!snapshot) {
    return { result: "No map known yet." };
  }

  const sceneList = Object.values(snapshot.scenes)
    .map(
      (s) =>
        `- ${s.name} (${s.id})${s.detailLevel === "name_only" ? " [name only]" : ""}`
    )
    .join("\n");
  const junctionList = Object.values(snapshot.junctions)
    .map((j) => `- ${j.name} (${j.id})`)
    .join("\n");
  const roadList = Object.values(snapshot.roads)
    .map((r) => `- ${r.name} (${r.id})`)
    .join("\n");

  const sections: string[] = [];
  if (sceneList) sections.push(`Scenes:\n${sceneList}`);
  if (junctionList) sections.push(`Junctions:\n${junctionList}`);
  if (roadList) sections.push(`Roads:\n${roadList}`);
  if (snapshot.revealedHiddenConnections.length > 0) {
    sections.push(
      `Revealed hidden connections:\n${snapshot.revealedHiddenConnections
        .map((c) => `- ${c}`)
        .join("\n")}`
    );
  }
  return { result: sections.join("\n\n") || "Empty map." };
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.round(value)));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
