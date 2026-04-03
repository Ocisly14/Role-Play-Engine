import type {
  EngineNarrative,
  EngineTool,
  EngineToolCall,
  EngineToolResult,
  EngineToolSchema,
} from "../types.js";

describe("EngineTool type contracts", () => {
  it("EngineToolCall has toolId and params", () => {
    const call: EngineToolCall = {
      toolId: "move",
      params: { destination: "scene_01" },
    };
    expect(call.toolId).toBe("move");
    expect(call.params.destination).toBe("scene_01");
  });

  it("EngineToolSchema declares required and optional params", () => {
    const schema: EngineToolSchema = {
      requiredParams: [
        { name: "destination", type: "string", description: "target scene" },
      ],
      optionalParams: [
        { name: "skill", type: "string", description: "skill to use" },
      ],
      example: { destination: "scene_01" },
    };
    expect(schema.requiredParams).toHaveLength(1);
    expect(schema.optionalParams).toHaveLength(1);
  });

  it("EngineNarrative carries outcome and optional memories", () => {
    const narrative: EngineNarrative = {
      outcome: "Moved to library",
      memories: [{ characterId: "npc_a", text: "I walked to the library." }],
    };
    expect(narrative.outcome).toBe("Moved to library");
    expect(narrative.memories).toHaveLength(1);
  });

  it("EngineToolResult pairs delta with narrative", () => {
    const result: EngineToolResult<{ moveTo: string }> = {
      delta: { moveTo: "scene_01" },
      narrative: { outcome: "Moved" },
    };
    expect(result.delta.moveTo).toBe("scene_01");
    expect(result.narrative.outcome).toBe("Moved");
  });

  it("EngineTool defines id, schema, execute, and applyDelta", () => {
    const tool: EngineTool<{ moveTo: string }> = {
      id: "move",
      description: "Move to a destination",
      schema: {
        requiredParams: [
          { name: "destination", type: "string", description: "target" },
        ],
        example: { destination: "scene_01" },
      },
      execute: async () => ({
        delta: { moveTo: "scene_01" },
        narrative: { outcome: "Moved" },
      }),
      applyDelta: () => {},
    };
    expect(tool.id).toBe("move");
    expect(tool.schema.requiredParams).toHaveLength(1);
  });
});
