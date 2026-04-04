import { GameEngineRegistry } from "../registry.js";
import type { ActionDefinition } from "../types.js";

describe("registry definition management", () => {
  const makeDef = (id: string): ActionDefinition => ({
    id,
    title: id,
    description: `${id} definition`,
    content: `# ${id}`,
  });

  it("registerDefinition + getDefinition", () => {
    const registry = new GameEngineRegistry();
    registry.registerDefinition(makeDef("combat"));
    expect(registry.getDefinition("combat")).toBeDefined();
    expect(registry.getDefinition("combat")?.id).toBe("combat");
  });

  it("getAllDefinitions returns all", () => {
    const registry = new GameEngineRegistry();
    registry.registerDefinition(makeDef("combat"));
    registry.registerDefinition(makeDef("social"));
    expect(registry.getAllDefinitions()).toHaveLength(2);
  });

  it("buildDispatcherDefinitionList includes all definitions", () => {
    const registry = new GameEngineRegistry();
    registry.registerDefinition(makeDef("combat"));
    registry.registerDefinition(makeDef("social"));
    const list = registry.buildDispatcherDefinitionList();
    expect(list).toContain("combat");
    expect(list).toContain("social");
  });

  it("getDefinition returns undefined for unknown id", () => {
    const registry = new GameEngineRegistry();
    expect(registry.getDefinition("unknown")).toBeUndefined();
  });
});
