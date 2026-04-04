import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionDefinition, ActionDefinitionSkillCheck } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseSkillCheck(
  content: string
): ActionDefinitionSkillCheck | undefined {
  const skillCheckSection = content.match(
    /## Skill Check\n([\s\S]*?)(?=\n## |$)/
  );
  if (!skillCheckSection) return undefined;

  const section = skillCheckSection[1];

  const skillLine = section.match(/- skill:\s*(.+)/);
  if (!skillLine) return undefined;
  const skillText = skillLine[1].trim();
  // "(as specified by planner, if any)" or "(optional, ...)" means no fixed skills
  if (skillText.startsWith("(")) return undefined;

  const skills = skillText.split("|").map((s) => s.trim());

  const difficultyMatch = section.match(/- difficulty:\s*(\w+)/);
  const difficulty = (difficultyMatch?.[1] ?? "regular") as
    | "regular"
    | "hard"
    | "extreme";

  const typeMatch = section.match(/- type:\s*(\w+)/);
  const type = (typeMatch?.[1] ?? "single") as "single" | "opposed";

  const failMatch = section.match(/- failBehavior:\s*(\w+)/);
  const failBehavior = (failMatch?.[1] ?? "partial") as "abort" | "partial";

  let opposedDefense: string[] | undefined;
  const defenseMatch = section.match(/- opposedDefense:\s*(.+)/);
  if (defenseMatch) {
    opposedDefense = defenseMatch[1].split("|").map((s) => s.trim());
  }

  return { skills, difficulty, type, opposedDefense, failBehavior };
}

function parseTitle(content: string): string {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : "Unknown";
}

export function loadActionDefinitions(): ActionDefinition[] {
  const files = readdirSync(__dirname).filter((f) => f.endsWith(".md"));
  return files.map((file) => {
    const content = readFileSync(join(__dirname, file), "utf-8");
    const id = file.replace(/\.md$/, "");
    const title = parseTitle(content);
    return {
      id,
      title,
      description: title,
      content,
      skillCheck: parseSkillCheck(content),
    };
  });
}
