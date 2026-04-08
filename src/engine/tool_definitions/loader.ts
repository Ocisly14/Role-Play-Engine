import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type {
  ActionDefinition,
  ActionDefinitionInterpreter,
  ActionDefinitionImpactHint,
  ActionDefinitionSkillCheck,
  StateDomainSpec,
} from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ==================== YAML frontmatter parsing ====================

interface YamlFrontmatter {
  id?: string;
  title?: string;
  description?: string;
  interpreter?: ActionDefinitionInterpreter;
  skillCheck?: ActionDefinitionSkillCheck;
  stateDomains?: Record<string, StateDomainSpec>;
  featureOverlay?: Record<string, unknown>;
  impactHint?: ActionDefinitionImpactHint;
}

function splitFrontmatter(raw: string): {
  frontmatter: YamlFrontmatter;
  body: string;
} {
  if (!raw.startsWith("---")) {
    throw new Error(
      "Definition file must have YAML frontmatter (start with ---)"
    );
  }
  const endIndex = raw.indexOf("\n---", 3);
  if (endIndex === -1) {
    throw new Error(
      "Definition file frontmatter not closed (missing closing ---)"
    );
  }
  const yamlStr = raw.slice(4, endIndex);
  const body = raw.slice(endIndex + 4).trim();
  const frontmatter = parseYaml(yamlStr) as YamlFrontmatter;
  return { frontmatter, body };
}

function parseTitle(content: string): string {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : "Unknown";
}

// ==================== Main loader ====================

export function loadActionDefinitions(): ActionDefinition[] {
  const files = readdirSync(__dirname).filter((f) => f.endsWith(".md"));
  return files.map((file) => {
    const raw = readFileSync(join(__dirname, file), "utf-8");
    const id = file.replace(/\.md$/, "");
    const { frontmatter, body } = splitFrontmatter(raw);

    const title = frontmatter.title ?? parseTitle(body) ?? id;
    return {
      id: frontmatter.id ?? id,
      title,
      description: frontmatter.description ?? title,
      content: raw,
      guidanceBody: body,
      skillCheck: frontmatter.skillCheck,
      stateDomains: frontmatter.stateDomains,
      interpreter: frontmatter.interpreter,
      featureOverlay: frontmatter.featureOverlay,
      impactHint: frontmatter.impactHint,
    };
  });
}
