import type { Request, Response } from "express";
import * as mapService from "./mapService.js";

export async function getTopology(req: Request, res: Response) {
  const topology = await mapService.getTopology(req.params.id);
  if (!topology)
    return res
      .status(404)
      .json({ error: "Simulation not found or no topology" });
  return res.json(topology);
}

export async function getMapLayout(req: Request, res: Response) {
  const layout = await mapService.getMapLayout(req.params.id);
  if (!layout) return res.status(404).json({ error: "Map layout not found" });
  return res.json(layout);
}

export async function getPositions(req: Request, res: Response) {
  const positions = await mapService.getPositions(req.params.id);
  if (!positions)
    return res.status(404).json({ error: "Simulation not found" });
  return res.json({ positions });
}

export async function getNpcStatuses(req: Request, res: Response) {
  const statuses = await mapService.getNpcStatuses(req.params.id);
  if (!statuses) return res.status(404).json({ error: "Simulation not found" });
  return res.json({ statuses });
}

export function updateConfig(req: Request, res: Response) {
  try {
    const runner = mapService.getRunnerById(req.params.id);
    if (!runner) return res.status(404).json({ error: "Simulation not found" });

    const { tickIntervalMs } = req.body;
    if (typeof tickIntervalMs === "number" && tickIntervalMs > 0) {
      runner.updateTickInterval(tickIntervalMs);
    }
    return res.json({ success: true, status: runner.getStatus() });
  } catch (error) {
    return res
      .status(500)
      .json({ error: error instanceof Error ? error.message : "Unknown" });
  }
}
