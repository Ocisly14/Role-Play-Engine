import type { Request, Response } from "express";
import type { WeatherType } from "../../../src/engine/subsystem/weather.js";
import * as mapService from "./mapService.js";
import { requireSimulationOwnership } from "./ownership.js";
import { applyGlobalWeather } from "./service.js";

const WEATHER_TYPES: ReadonlySet<WeatherType> = new Set([
  "clear",
  "rain",
  "fog",
  "storm",
  "snow",
  "extreme_heat",
  "extreme_cold",
]);

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

export async function updateConfig(req: Request, res: Response) {
  try {
    if (!(await requireSimulationOwnership(req, res))) return;
    const runner = mapService.getRunnerById(req.params.id);
    if (!runner) return res.status(404).json({ error: "Simulation not found" });

    const {
      tickIntervalMs,
      maxDays,
      syncRealTime,
      realTimeBufferMinutes,
      weather,
    } = req.body;
    let didUpdate = false;
    if (typeof tickIntervalMs === "number" && tickIntervalMs > 0) {
      runner.updateTickInterval(tickIntervalMs);
      didUpdate = true;
    }
    if (typeof maxDays === "number" && maxDays > 0) {
      runner.updateMaxDays(maxDays);
      didUpdate = true;
    }
    if (
      typeof weather === "string" &&
      WEATHER_TYPES.has(weather as WeatherType)
    ) {
      applyGlobalWeather(runner.getDgsm(), weather as WeatherType);
      didUpdate = true;
    }
    if (syncRealTime === true) {
      const result = runner.enableRealTimeSync(
        typeof realTimeBufferMinutes === "number" ? realTimeBufferMinutes : 0
      );
      await runner.saveRuntime();
      return res.json({ success: true, status: runner.getStatus(), ...result });
    }
    if (didUpdate) {
      await runner.saveRuntime();
    }
    return res.json({ success: true, status: runner.getStatus() });
  } catch (error) {
    return res
      .status(500)
      .json({ error: error instanceof Error ? error.message : "Unknown" });
  }
}
