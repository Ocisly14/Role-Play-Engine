/// <reference path="../types/express.d.ts" />
import type { NpcMemoryType } from "@prisma/client";
import type { Request, Response } from "express";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
import type { SimulationRunner } from "../../../src/simulation/SimulationRunner.js";
import { requireSimulationOwnership } from "./ownership.js";
import * as simulationService from "./service.js";

const MEMORY_TYPES: readonly NpcMemoryType[] = [
  "general",
  "plan",
  "secret",
  "relationship",
  "map",
  "long_term_intent",
];

class BadRequest extends Error {}

function requireText(body: unknown, field = "text"): string {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== "string") {
    throw new BadRequest(`${field} must be a string`);
  }
  return value;
}

type MemoryOp = Parameters<SimulationRunner["editPlayerMemory"]>[0];

function parseMemoryOp(body: unknown): MemoryOp {
  const b = (body ?? {}) as Record<string, unknown>;
  switch (b.op) {
    case "add": {
      if (
        typeof b.type !== "string" ||
        !MEMORY_TYPES.includes(b.type as NpcMemoryType)
      ) {
        throw new BadRequest(`type must be one of ${MEMORY_TYPES.join(", ")}`);
      }
      return {
        op: "add",
        type: b.type as NpcMemoryType,
        content: requireText(b, "content"),
      };
    }
    case "replace": {
      if (typeof b.memoryId !== "string" || b.memoryId === "") {
        throw new BadRequest("memoryId must be a non-empty string");
      }
      return {
        op: "replace",
        memoryId: b.memoryId,
        content: requireText(b, "content"),
      };
    }
    case "delete": {
      if (typeof b.memoryId !== "string" || b.memoryId === "") {
        throw new BadRequest("memoryId must be a non-empty string");
      }
      return { op: "delete", memoryId: b.memoryId };
    }
    default:
      throw new BadRequest("op must be add, replace or delete");
  }
}

function handleError(res: Response, error: unknown, action: string) {
  const message = error instanceof Error ? error.message : "Unknown error";
  if (error instanceof BadRequest) {
    return res.status(400).json({ error: message });
  }
  if (
    message === "player is dead" ||
    message === "simulation has ended" ||
    message === "the step queue belongs to manual mode" ||
    message === "no question is waiting for an answer"
  ) {
    return res.status(409).json({ error: message });
  }
  if (
    message === "empty instruction" ||
    message === "empty answer" ||
    message === "empty memory"
  ) {
    return res.status(400).json({ error: message });
  }
  if (message.startsWith("a relationship memory needs the person")) {
    return res.status(400).json({ error: message });
  }
  if (
    message === "this session has no player" ||
    /^memory ".*" not found$/.test(message)
  ) {
    return res.status(404).json({ error: message });
  }
  console.error(`[playerController] ${action} failed:`, error);
  return res.status(500).json({ error: message });
}

/** Look up the runner and require a player on it; answers 404 itself. */
async function loadRunner(
  req: Request,
  res: Response
): Promise<SimulationRunner | null> {
  if (!(await requireSimulationOwnership(req, res))) return null;
  const runner = await simulationService.getRunner(
    getPrismaClient(),
    req.params.id
  );
  if (!runner) {
    res.status(404).json({ error: "Simulation not found" });
    return null;
  }
  if (!runner.getPlayerView()) {
    res.status(404).json({ error: "Player not found" });
    return null;
  }
  return runner;
}

function mutation(
  action: string,
  run: (runner: SimulationRunner, req: Request) => Promise<void>
) {
  return async (req: Request, res: Response) => {
    try {
      const runner = await loadRunner(req, res);
      if (!runner) return;
      await run(runner, req);
      return res.json({ success: true, player: runner.getPlayerView() });
    } catch (error) {
      return handleError(res, error, action);
    }
  };
}

export async function getPlayer(req: Request, res: Response) {
  try {
    const runner = await loadRunner(req, res);
    if (!runner) return;
    return res.json({ success: true, player: runner.getPlayerView() });
  } catch (error) {
    return handleError(res, error, "getPlayer");
  }
}

export const submitInput = mutation("submitInput", (runner, req) =>
  runner.submitPlayerInput(requireText(req.body))
);

export const continuePlayer = mutation("continuePlayer", (runner) =>
  runner.continuePlayer()
);

export const answerFriend = mutation("answerFriend", (runner, req) =>
  runner.answerFriend(requireText(req.body))
);

export const setMode = mutation("setMode", (runner, req) => {
  const mode = (req.body as Record<string, unknown> | undefined)?.mode;
  if (mode !== "manual" && mode !== "delegated") {
    throw new BadRequest('mode must be "manual" or "delegated"');
  }
  return runner.setPlayerMode(mode);
});

export const replaceQueue = mutation("replaceQueue", (runner, req) => {
  const steps = (req.body as Record<string, unknown> | undefined)?.steps;
  if (!Array.isArray(steps) || steps.some((s) => typeof s !== "string")) {
    throw new BadRequest("steps must be an array of strings");
  }
  return runner.replacePlayerQueue(steps as string[]);
});

export const editMemory = mutation("editMemory", (runner, req) =>
  runner.editPlayerMemory(parseMemoryOp(req.body))
);
