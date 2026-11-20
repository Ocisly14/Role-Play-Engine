/// <reference path="../types/express.d.ts" />
import type { NpcMemoryType } from "@prisma/client";
import type { Request, Response } from "express";
import { PlayerBoardError } from "../../../src/player/playerBoard.js";
import type { PlayerInput } from "../../../src/player/playerCommands.js";
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

function optionalText(
  input: Record<string, unknown>,
  field: string
): string | undefined {
  return input[field] === undefined ? undefined : requireText(input, field);
}

function parsePlayerInput(body: unknown): PlayerInput {
  const input = ((body as Record<string, unknown> | undefined)?.input ??
    {}) as Record<string, unknown>;
  switch (input.kind) {
    case "move":
      return { kind: "move", to: requireText(input, "to") };
    case "say": {
      const to: unknown = input.to;
      if (
        !Array.isArray(to) ||
        !to.every((id): id is string => typeof id === "string")
      ) {
        throw new BadRequest("to must be an array of person handles");
      }
      const language = optionalText(input, "language");
      return {
        kind: "say",
        to,
        words: requireText(input, "words"),
        ...(language === undefined ? {} : { language }),
      };
    }
    case "act": {
      const skillId = optionalText(input, "skillId");
      return {
        kind: "act",
        text: requireText(input, "text"),
        ...(skillId === undefined ? {} : { skillId }),
      };
    }
    case "sleep":
      return { kind: "sleep" };
    default:
      throw new BadRequest("input.kind must be move, say, act or sleep");
  }
}

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
  if (error instanceof PlayerBoardError) {
    return res.status(error.status).json({ error: message });
  }
  if (error instanceof BadRequest) {
    return res.status(400).json({ error: message });
  }
  if (
    message === "player is dead" ||
    message === "simulation has ended" ||
    message === "advice is for delegated mode" ||
    message === "commands are for manual mode" ||
    message === "no question is waiting for an answer"
  ) {
    return res.status(409).json({ error: message });
  }
  if (
    message === "empty advice" ||
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
  if (!runner.hasPlayer()) {
    res.status(404).json({ error: "Player not found" });
    return null;
  }
  return runner;
}

function mutation(
  action: string,
  run: (
    runner: SimulationRunner,
    req: Request
  ) => Promise<void | { id: string }>
) {
  return async (req: Request, res: Response) => {
    try {
      const runner = await loadRunner(req, res);
      if (!runner) return;
      const extra = await run(runner, req);
      return res.json({
        success: true,
        ...(extra ?? {}),
        player: await readPlayer(runner),
      });
    } catch (error) {
      return handleError(res, error, action);
    }
  };
}

async function readPlayer(runner: SimulationRunner) {
  const board = await runner.getPlayerBoard().catch((error) => {
    // The command or edit may already be saved. A failed board read must
    // not turn that response into a failed mutation and invite a retry.
    console.warn(
      "[playerController] could not load relationship board:",
      error
    );
    return null;
  });
  const view = runner.getPlayerView();
  return view ? { ...view, board } : null;
}

export async function getPlayer(req: Request, res: Response) {
  try {
    const runner = await loadRunner(req, res);
    if (!runner) return;
    return res.json({ success: true, player: await readPlayer(runner) });
  } catch (error) {
    return handleError(res, error, "getPlayer");
  }
}

export const sendAdvice = mutation("sendAdvice", (runner, req) =>
  runner.sendAdvice(requireText(req.body))
);

export async function submitCommand(req: Request, res: Response) {
  try {
    const runner = await loadRunner(req, res);
    if (!runner) return;
    const result = await runner.submitPlayerCommand(parsePlayerInput(req.body));
    if (!result.ok) return res.status(422).json({ error: result.reason });
    return res.json({
      success: true,
      player: await readPlayer(runner),
      unknownHandles: result.unknownHandles,
    });
  } catch (error) {
    return handleError(res, error, "submitCommand");
  }
}

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

export const editMemory = mutation("editMemory", (runner, req) =>
  runner.editPlayerMemory(parseMemoryOp(req.body))
);

export const namePerson = mutation("namePerson", (runner, req) =>
  runner.namePerson(req.params.handle, requireText(req.body, "name"))
);

export const notePerson = mutation("notePerson", (runner, req) =>
  runner.notePerson(req.params.handle, requireText(req.body, "note"))
);

export const linkPeople = mutation("linkPeople", (runner, req) =>
  runner.linkPeople(
    requireText(req.body, "a"),
    requireText(req.body, "b"),
    requireText(req.body, "label")
  )
);

export const unlinkPeople = mutation("unlinkPeople", (runner, req) =>
  runner.unlinkPeople(req.params.linkId)
);
