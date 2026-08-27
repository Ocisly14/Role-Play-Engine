import type { NpcMemoryType } from "@prisma/client";
import type { MemoryHandler } from "../types.js";
import { ContextHandler } from "./ContextHandler.js";
import { GeneralHandler } from "./GeneralHandler.js";
import { LongTermIntentHandler } from "./LongTermIntentHandler.js";
import { MapHandler } from "./MapHandler.js";
import { PlanHandler } from "./PlanHandler.js";
import { RelationshipHandler } from "./RelationshipHandler.js";
import { SecretHandler } from "./SecretHandler.js";

export {
  ContextHandler,
  GeneralHandler,
  LongTermIntentHandler,
  MapHandler,
  PlanHandler,
  RelationshipHandler,
  SecretHandler,
};

const HANDLERS: Record<NpcMemoryType, MemoryHandler> = {
  general: new GeneralHandler(),
  plan: new PlanHandler(),
  secret: new SecretHandler(),
  relationship: new RelationshipHandler(),
  map: new MapHandler(),
  long_term_intent: new LongTermIntentHandler(),
  context: new ContextHandler(),
};

export function getHandler(type: NpcMemoryType): MemoryHandler {
  const handler = HANDLERS[type];
  if (!handler) {
    // Without this the caller dies on `undefined.prepare`, which names
    // nothing. Every type that reaches the store must already have been
    // folded onto the enum by `canonicalMemoryType`.
    throw new Error(
      `[memory] no handler for memory type "${type}" — fold it onto the runtime enum with canonicalMemoryType() before storing`
    );
  }
  return handler;
}

export function getAllHandlers(): Record<NpcMemoryType, MemoryHandler> {
  return HANDLERS;
}
