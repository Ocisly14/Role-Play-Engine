/// <reference path="../types/express.d.ts" />
import type { Request, Response } from "express";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
import * as simulationService from "./service.js";

export async function createSimulation(req: Request, res: Response) {
  try {
    const { moduleName, language, config } = req.body;
    if (!moduleName) {
      return res.status(400).json({ error: "moduleName is required" });
    }
    const prisma = getPrismaClient();
    const userId = req.user?.userId ?? "";
    const result = await simulationService.createSimulation(
      prisma,
      moduleName,
      userId,
      language ?? "en",
      config,
    );
    return res.status(201).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.includes("not found") ? 404 : 500;
    return res.status(status).json({ error: message });
  }
}

export async function startSimulation(req: Request, res: Response) {
  try {
    await simulationService.startSimulation(req.params.id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(404).json({
      error: error instanceof Error ? error.message : "Not found",
    });
  }
}

export function pauseSimulation(req: Request, res: Response) {
  try {
    simulationService.pauseSimulation(req.params.id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(404).json({
      error: error instanceof Error ? error.message : "Not found",
    });
  }
}

export async function resumeSimulation(req: Request, res: Response) {
  try {
    await simulationService.resumeSimulation(req.params.id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(404).json({
      error: error instanceof Error ? error.message : "Not found",
    });
  }
}

export async function stepSimulation(req: Request, res: Response) {
  try {
    const ticks = req.body?.ticks ?? 1;
    await simulationService.stepSimulation(req.params.id, ticks);
    return res.json({ success: true });
  } catch (error) {
    return res.status(404).json({
      error: error instanceof Error ? error.message : "Not found",
    });
  }
}

export function stopSimulation(req: Request, res: Response) {
  try {
    simulationService.stopSimulation(req.params.id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(404).json({
      error: error instanceof Error ? error.message : "Not found",
    });
  }
}

export function getStatus(req: Request, res: Response) {
  try {
    const runner = simulationService.getRunner(req.params.id);
    if (!runner) {
      return res.status(404).json({ error: "Simulation not found" });
    }
    return res.json(runner.getStatus());
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export async function getEvents(req: Request, res: Response) {
  try {
    const prisma = getPrismaClient();
    const events = await simulationService.getSimulationEvents(
      prisma,
      req.params.id,
      {
        type: req.query.type as string | undefined,
        npcId: req.query.npcId as string | undefined,
        day: req.query.day ? parseInt(req.query.day as string) : undefined,
      },
    );
    return res.json({ events });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export function listSimulations(_req: Request, res: Response) {
  const simulations = simulationService.listSimulations();
  return res.json({ simulations });
}
