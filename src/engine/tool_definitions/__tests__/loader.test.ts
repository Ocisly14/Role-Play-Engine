import { loadActionDefinitions } from "../loader.js";

describe("loadActionDefinitions", () => {
  it("loads all md files from actions directory", () => {
    const defs = loadActionDefinitions();
    const ids = defs.map((d) => d.id);
    expect(ids).toContain("action");
    expect(ids).toContain("character_interaction");
    expect(ids).toContain("movement");
    expect(ids).not.toContain("item_modify");
    expect(ids).not.toContain("item_assemble");
    expect(ids).not.toContain("item_disassemble");
  });

  it("parses YAML frontmatter from character_interaction.md", () => {
    const defs = loadActionDefinitions();
    const ci = defs.find((d) => d.id === "character_interaction");
    expect(ci).toBeDefined();
    expect(ci?.title).toBe("Character Interaction");
    expect(ci?.description).toContain(
      "Any interaction with one or more target characters"
    );
    expect(ci?.skillCheck?.type).toBe("single");
    expect(ci?.skillCheck?.failBehavior).toBe("partial");
  });

  it("parses stateDomains from YAML frontmatter", () => {
    const defs = loadActionDefinitions();
    const ci = defs.find((d) => d.id === "character_interaction");
    expect(ci?.stateDomains).toBeDefined();
    expect(ci?.stateDomains?.character?.inject).toContain("actor");
    expect(ci?.stateDomains?.character?.inject).toContain("targets");
    expect(ci?.stateDomains?.character?.output).toContain("memory.event");
    expect(ci?.stateDomains?.character?.output).toContain(
      "relationship.change"
    );
  });

  it("parses interpreter examples from YAML frontmatter", () => {
    const defs = loadActionDefinitions();
    const action = defs.find((d) => d.id === "action");
    expect(action?.interpreter?.examples?.length).toBeGreaterThan(0);
  });

  it("guidanceBody contains markdown body without frontmatter", () => {
    const defs = loadActionDefinitions();
    const ci = defs.find((d) => d.id === "character_interaction");
    expect(ci?.guidanceBody).toContain(
      "# Character Interaction Resolution Guidance"
    );
    expect(ci?.guidanceBody).toContain("## On Success");
    // guidanceBody should not start with YAML frontmatter delimiter
    expect(ci?.guidanceBody?.startsWith("---")).toBe(false);
  });

  it("movement.md loads with YAML frontmatter", () => {
    const defs = loadActionDefinitions();
    const movement = defs.find((d) => d.id === "movement");
    expect(movement).toBeDefined();
    expect(movement?.title).toBe("Movement");
    expect(movement?.stateDomains?.character).toBeDefined();
  });

  it("action.md parses single skill check type", () => {
    const defs = loadActionDefinitions();
    const action = defs.find((d) => d.id === "action");
    expect(action?.skillCheck?.type).toBe("single");
    expect(action?.skillCheck?.failBehavior).toBe("partial");
  });

  it("parses outputSchema presets from YAML frontmatter", () => {
    const defs = loadActionDefinitions();
    const movement = defs.find((d) => d.id === "movement");

    expect(movement?.outputSchema?.presets).toEqual(["default"]);
    expect(movement?.outputSchema?.use).toEqual(["character.position"]);
  });

  it("parses reusable item presets from YAML frontmatter", () => {
    const defs = loadActionDefinitions();
    const action = defs.find((d) => d.id === "action");
    const locksmith = defs.find((d) => d.id === "locksmith");
    const perception = defs.find((d) => d.id === "perception");
    const artAndCraft = defs.find((d) => d.id === "art_and_craft");
    const chemistry = defs.find((d) => d.id === "chemistry");

    expect(action?.outputSchema?.presets).toEqual(["default", "item_modify"]);
    expect(locksmith?.outputSchema?.presets).toEqual([
      "default",
      "item_modify",
    ]);
    expect(locksmith?.outputSchema?.use).toBeUndefined();
    expect(perception?.outputSchema?.use).toEqual(["item.modify"]);
    expect(artAndCraft?.outputSchema?.presets).toEqual([
      "default",
      "item_modify",
    ]);
    expect(chemistry?.outputSchema?.presets).toEqual([
      "default",
      "item_modify",
    ]);
  });
});
