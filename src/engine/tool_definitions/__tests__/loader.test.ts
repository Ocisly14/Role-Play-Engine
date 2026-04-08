import { loadActionDefinitions } from "../loader.js";

describe("loadActionDefinitions", () => {
  it("loads all md files from actions directory", () => {
    const defs = loadActionDefinitions();
    const ids = defs.map((d) => d.id);
    expect(ids).toContain("action");
    expect(ids).toContain("character_interaction");
    expect(ids).toContain("movement");
  });

  it("parses YAML frontmatter from character_interaction.md", () => {
    const defs = loadActionDefinitions();
    const ci = defs.find((d) => d.id === "character_interaction");
    expect(ci).toBeDefined();
    expect(ci?.title).toBe("Character Interaction");
    expect(ci?.description).toContain("Interact with one or more characters");
    expect(ci?.skillCheck?.type).toBe("opposed");
    expect(ci?.skillCheck?.failBehavior).toBe("abort");
  });

  it("parses stateDomains from YAML frontmatter", () => {
    const defs = loadActionDefinitions();
    const ci = defs.find((d) => d.id === "character_interaction");
    expect(ci?.stateDomains).toBeDefined();
    expect(ci?.stateDomains?.character?.inject).toContain("actor");
    expect(ci?.stateDomains?.character?.inject).toContain("targets");
    expect(ci?.stateDomains?.character?.output).toContain("hpDelta");
    expect(ci?.stateDomains?.character?.output).toContain("memory");
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
});
