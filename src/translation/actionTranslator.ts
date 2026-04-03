/**
 * Translation layer: converts PlanNode → EngineToolCall[].
 *
 * Like LLM function calling — the engine exposes tools, this layer
 * produces the calls. Currently rule-based; can evolve to LLM-based
 * for player natural language input.
 */

import type { EngineToolCall } from "../engine/types.js";
import type { PlanNode } from "../npc/planning/types.js";

/**
 * Translate a PlanNode into one or more EngineToolCalls.
 *
 * The primary call maps PlanNode.type → toolId.
 * Additional calls come from PlanNode.tools[] (e.g. item tool calls).
 */
export function translatePlanNode(node: PlanNode): EngineToolCall[] {
  const calls: EngineToolCall[] = [];

  // Base params shared by all operations
  const baseParams: Record<string, unknown> = {
    actorId: node.characterId,
    action: node.action,
    impact: node.impact,
  };
  if (node.skill) baseParams.skill = node.skill;
  if (node.difficulty) baseParams.difficulty = node.difficulty;

  // Map node type to primary tool call
  switch (node.type) {
    case "action":
      calls.push({ toolId: "action", params: { ...baseParams } });
      break;

    case "movement":
      calls.push({
        toolId: "movement",
        params: { ...baseParams, destination: node.destination },
      });
      break;

    case "character_interaction":
      calls.push({
        toolId: "character_interaction",
        params: {
          ...baseParams,
          targetCharacterIds: node.targetCharacterIds,
        },
      });
      break;

    case "object_interaction": {
      // object_interaction maps to item tool with args from tools[]
      const itemCall = node.tools?.find((t) => t.name === "item");
      if (itemCall) {
        calls.push({
          toolId: "item",
          params: { ...baseParams, ...itemCall.args },
        });
      } else {
        // Fallback: treat as generic action
        calls.push({ toolId: "action", params: { ...baseParams } });
      }
      break;
    }

    default:
      // Pass through unknown types — extensible for custom handlers
      calls.push({ toolId: node.type, params: { ...baseParams } });
      break;
  }

  // Append additional tool calls from PlanNode.tools[]
  // (skip if already consumed by object_interaction above)
  if (node.type !== "object_interaction" && node.tools?.length) {
    for (const tool of node.tools) {
      calls.push({
        toolId: tool.name,
        params: {
          actorId: node.characterId,
          action: node.action,
          ...tool.args,
        },
      });
    }
  }

  return calls;
}
