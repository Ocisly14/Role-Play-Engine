// src/roleSim/toolDispatcher.ts
//
// Phase F instant-tool dispatcher. Executes the agent's non-terminal tools
// (writeMemory / recallMemory / getMapSnapshot) against the memory store and
// DGSM. Terminal tools (act / continue) never flow through here — the agent
// loop returns them to the controller, which is the single place engine
// submission/cancellation happens.

import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { NpcMemoryType } from "../memory/types.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";

/** Tools that consume a tick — calling one ends the agent loop. Decision 17. */
export const TERMINAL_TOOLS = new Set<string>(["act", "continue"]);

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
  gameDay: number;
  gameTime: string;
}

export interface DispatchResult {
  /** Result string fed back to the LLM as the tool result content. */
  result: string;
}

interface WriteMemoryInput {
  type: NpcMemoryType;
  content?: string;
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
  gameDay?: number;
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

async function dispatchWriteMemory(
  input: WriteMemoryInput,
  deps: DispatcherDeps
): Promise<DispatchResult> {
  if (!input || typeof input.type !== "string") {
    return { result: "Error: writeMemory requires a 'type' field." };
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

  await deps.memory.add({
    npcId: deps.npcId,
    sessionId: deps.sessionId,
    moduleId: deps.moduleId,
    type: input.type,
    content,
    gameDay: deps.gameDay,
    gameTime: deps.gameTime,
  });

  return {
    result: `Wrote ${input.type} memory: "${truncate(content, 80)}"`,
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
  const memories = await deps.memory.query({
    npcId: deps.npcId,
    sessionId: deps.sessionId,
    query: input.query ?? "",
    filters: {
      types: input.types,
      gameDay: input.gameDay,
    },
    limit,
  });

  if (memories.length === 0) {
    return { result: "No memories matched." };
  }

  const lines = memories.map(
    (m) =>
      `- [Day ${m.gameDay} ${m.gameTime}] (${m.type}) ${truncate(m.content, 200)}`
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
