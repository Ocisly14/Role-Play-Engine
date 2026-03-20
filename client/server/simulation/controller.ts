/// <reference path="../types/express.d.ts" />
import * as path from "node:path";
import type { Request, Response } from "express";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
import { findMapsDirectory, findSceneDirectory } from "./mapService.js";
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
      config
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
    const prisma = getPrismaClient();
    await simulationService.startSimulation(prisma, req.params.id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(404).json({
      error: error instanceof Error ? error.message : "Not found",
    });
  }
}

export async function pauseSimulation(req: Request, res: Response) {
  try {
    const prisma = getPrismaClient();
    await simulationService.pauseSimulation(prisma, req.params.id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(404).json({
      error: error instanceof Error ? error.message : "Not found",
    });
  }
}

export async function resumeSimulation(req: Request, res: Response) {
  try {
    const prisma = getPrismaClient();
    await simulationService.resumeSimulation(prisma, req.params.id);
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
    const prisma = getPrismaClient();
    await simulationService.stepSimulation(prisma, req.params.id, ticks);
    return res.json({ success: true });
  } catch (error) {
    return res.status(404).json({
      error: error instanceof Error ? error.message : "Not found",
    });
  }
}

export async function stopSimulation(req: Request, res: Response) {
  try {
    const prisma = getPrismaClient();
    await simulationService.stopSimulation(prisma, req.params.id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(404).json({
      error: error instanceof Error ? error.message : "Not found",
    });
  }
}

export async function getStatus(req: Request, res: Response) {
  try {
    const prisma = getPrismaClient();
    const runner = await simulationService.getRunner(prisma, req.params.id);
    if (!runner) {
      return res.status(404).json({ error: `Simulation ${req.params.id} not found` });
    }
    const status = runner.getStatus();
    const moduleName = runner.getModuleName();
    const modulePath = runner.getModulePath();

    let mapsPrefix: string | null = null;
    if (modulePath) {
      // Prefer scene/ directory (image layer maps), fallback to *_Maps (tile maps)
      const sceneDir = findSceneDirectory(modulePath);
      if (sceneDir) {
        mapsPrefix = "scene";
      } else {
        const mapsDir = findMapsDirectory(modulePath);
        if (mapsDir) {
          mapsPrefix = path.basename(mapsDir);
        }
      }
    }

    return res.json({ ...status, moduleName, mapsPrefix });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const httpStatus = message.includes("not found") ? 404 : 500;
    return res.status(httpStatus).json({ error: message });
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
        day: req.query.day
          ? Number.parseInt(req.query.day as string)
          : undefined,
      }
    );
    return res.json({ events });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export async function listSimulations(_req: Request, res: Response) {
  const prisma = getPrismaClient();
  const simulations = await simulationService.listSimulations(prisma);
  return res.json({ simulations });
}

export async function getPlaybackStatus(req: Request, res: Response) {
  try {
    const prisma = getPrismaClient();
    const runner = await simulationService.getRunner(prisma, req.params.id);
    if (!runner) {
      return res.status(404).json({ error: `Simulation ${req.params.id} not found` });
    }
    return res.json(runner.getPlaybackScheduler().getBufferStatus());
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
