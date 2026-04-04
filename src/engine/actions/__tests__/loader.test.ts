import { loadActionDefinitions } from "../loader.js";

describe("loadActionDefinitions", () => {
  it("loads all md files from actions directory", () => {
    const defs = loadActionDefinitions();
    const ids = defs.map((d) => d.id);
    expect(ids).toContain("movement");
    expect(ids).toContain("combat");
    expect(ids).toContain("social");
    expect(ids).toContain("search");
    expect(ids).toContain("generic");
  });

  it("parses skill check metadata from combat.md", () => {
    const defs = loadActionDefinitions();
    const combat = defs.find((d) => d.id === "combat");
    expect(combat).toBeDefined();
    expect(combat?.title).toBe("Combat");
    expect(combat?.skillCheck).toBeDefined();
    expect(combat?.skillCheck?.type).toBe("opposed");
    expect(combat?.skillCheck?.skills).toContain("Fighting (Brawl)");
    expect(combat?.skillCheck?.opposedDefense).toContain("Dodge");
    expect(combat?.skillCheck?.failBehavior).toBe("abort");
  });

  it("parses single skill check from search.md", () => {
    const defs = loadActionDefinitions();
    const search = defs.find((d) => d.id === "search");
    expect(search).toBeDefined();
    expect(search?.skillCheck?.type).toBe("single");
    expect(search?.skillCheck?.failBehavior).toBe("partial");
  });

  it("generic has no fixed skills", () => {
    const defs = loadActionDefinitions();
    const generic = defs.find((d) => d.id === "generic");
    expect(generic).toBeDefined();
    expect(generic?.skillCheck).toBeUndefined();
  });

  it("content contains raw markdown", () => {
    const defs = loadActionDefinitions();
    const combat = defs.find((d) => d.id === "combat");
    expect(combat).toBeDefined();
    expect(combat?.content).toContain("## State Changes");
    expect(combat?.content).toContain("### On Success");
  });
});
