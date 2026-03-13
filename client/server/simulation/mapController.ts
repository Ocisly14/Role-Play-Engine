import type { Request, Response } from "express";
import * as mapService from "./mapService.js";

export function getTopology(req: Request, res: Response) {
  const topology = mapService.getTopology(req.params.id);
  if (!topology)
    return res
      .status(404)
      .json({ error: "Simulation not found or no topology" });
  return res.json(topology);
}

export function getMapLayout(req: Request, res: Response) {
  const layout = mapService.getMapLayout(req.params.id);
  if (!layout) return res.status(404).json({ error: "Map layout not found" });
  return res.json(layout);
}

export function getPositions(req: Request, res: Response) {
  const positions = mapService.getPositions(req.params.id);
  if (!positions)
    return res.status(404).json({ error: "Simulation not found" });
  return res.json({ positions });
}

export function getNpcStatuses(req: Request, res: Response) {
  const statuses = mapService.getNpcStatuses(req.params.id);
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
