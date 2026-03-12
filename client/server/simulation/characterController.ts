/// <reference path="../types/express.d.ts" />
import type { Request, Response } from "express";
import { buildInjectedProfile } from "../../../src/dynamicworldagent/simulation/characterInjection.js";
import * as simulationService from "./service.js";

export async function injectCharacter(req: Request, res: Response) {
  try {
    const runner = simulationService.getRunner(req.params.id);
    if (!runner) return res.status(404).json({ error: "Simulation not found" });

    const {
      name,
      attributes,
      skills,
      backstory,
      residence,
      personality,
      occupation,
      age,
      gender,
      intent,
    } = req.body;
    if (!name || !attributes || !skills || !backstory || !residence)
      return res.status(400).json({
        error:
          "Missing required fields: name, attributes, skills, backstory, residence",
      });
    if (!intent)
      return res
        .status(400)
        .json({ error: "Missing required field: intent" });

    const profile = buildInjectedProfile({
      name,
      attributes,
      skills,
      backstory,
      residence,
      personality,
      occupation,
      age,
      gender,
    });
    await runner.injectCharacter(profile, intent);
    return res.status(201).json({ characterId: profile.id, profile });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.includes("Invalid residence")
      ? 400
      : message.includes("only inject") || message.includes("Cannot inject")
        ? 409
        : 500;
    return res.status(status).json({ error: message });
  }
}

export function listInjectedCharacters(req: Request, res: Response) {
  try {
    const runner = simulationService.getRunner(req.params.id);
    if (!runner) return res.status(404).json({ error: "Simulation not found" });
    return res.json({ characters: runner.getInjectedCharacters() });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export async function updateIntent(req: Request, res: Response) {
  try {
    const runner = simulationService.getRunner(req.params.id);
    if (!runner) return res.status(404).json({ error: "Simulation not found" });
    const { intent } = req.body;
    if (!intent)
      return res
        .status(400)
        .json({ error: "Missing required field: intent" });
    await runner.updateIntent(req.params.charId, intent);
    return res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.includes("not found")
      ? 404
      : message.includes("only update") || message.includes("Cannot update")
        ? 409
        : 500;
    return res.status(status).json({ error: message });
  }
}

export async function removeCharacter(req: Request, res: Response) {
  try {
    const runner = simulationService.getRunner(req.params.id);
    if (!runner) return res.status(404).json({ error: "Simulation not found" });
    await runner.removeCharacter(req.params.charId);
    return res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.includes("not found")
      ? 404
      : message.includes("only remove") || message.includes("Cannot remove")
        ? 409
        : 500;
    return res.status(status).json({ error: message });
  }
}
