import type { NpcMemoryType } from "@prisma/client";
import type { MemoryHandler } from "../types.js";
import { BeliefHandler } from "./BeliefHandler.js";
import { EventHandler } from "./EventHandler.js";
import { InformationHandler } from "./InformationHandler.js";
import { PlanHandler } from "./PlanHandler.js";
import { SecretHandler } from "./SecretHandler.js";
import { SummaryHandler } from "./SummaryHandler.js";
import { WitnessHandler } from "./WitnessHandler.js";

export {
  EventHandler,
  WitnessHandler,
  InformationHandler,
  BeliefHandler,
  PlanHandler,
  SecretHandler,
  SummaryHandler,
};

const HANDLERS: Record<NpcMemoryType, MemoryHandler> = {
  event: new EventHandler(),
  witness: new WitnessHandler(),
  information: new InformationHandler(),
  belief: new BeliefHandler(),
  plan: new PlanHandler(),
  secret: new SecretHandler(),
  summary: new SummaryHandler(),
};

export function getHandler(type: NpcMemoryType): MemoryHandler {
  return HANDLERS[type];
}

export function getAllHandlers(): Record<NpcMemoryType, MemoryHandler> {
  return HANDLERS;
}
