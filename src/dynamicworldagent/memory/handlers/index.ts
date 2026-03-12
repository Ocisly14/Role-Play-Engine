import type { NpcMemoryType } from "@prisma/client";
import type { MemoryHandler } from "../types.js";
import { EventHandler } from "./EventHandler.js";
import { WitnessHandler } from "./WitnessHandler.js";
import { InformationHandler } from "./InformationHandler.js";
import { BeliefHandler } from "./BeliefHandler.js";
import { EmotionHandler } from "./EmotionHandler.js";
import { RelationshipHandler } from "./RelationshipHandler.js";
import { PlanHandler } from "./PlanHandler.js";
import { SecretHandler } from "./SecretHandler.js";
import { SummaryHandler } from "./SummaryHandler.js";

export {
  EventHandler,
  WitnessHandler,
  InformationHandler,
  BeliefHandler,
  EmotionHandler,
  RelationshipHandler,
  PlanHandler,
  SecretHandler,
  SummaryHandler,
};

const HANDLERS: Record<NpcMemoryType, MemoryHandler> = {
  event: new EventHandler(),
  witness: new WitnessHandler(),
  information: new InformationHandler(),
  belief: new BeliefHandler(),
  emotion: new EmotionHandler(),
  relationship: new RelationshipHandler(),
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
