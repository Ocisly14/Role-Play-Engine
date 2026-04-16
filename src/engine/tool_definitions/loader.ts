import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type {
  ActionDefinition,
  ActionDefinitionImpactHint,
  ActionDefinitionInterpreter,
  ActionDefinitionSkillCheck,
  StateDomainSpec,
} from "../types.js";
import { buildOutputSchema } from "../resolver/schemaBuilder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ==================== YAML frontmatter parsing ====================

interface YamlFrontmatter {
  id?: string;
  title?: string;
  description?: string;
  interpreter?: ActionDefinitionInterpreter;
  skillCheck?: ActionDefinitionSkillCheck;
  stateDomains?: Record<string, StateDomainSpec>;
  outputSchema?: import("../types.js").OutputSchemaConfig;
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

function loadDefinitionFile(
  filePath: string,
  fallbackId: string
): ActionDefinition {
  const raw = readFileSync(filePath, "utf-8");
  const { frontmatter, body } = splitFrontmatter(raw);
  if (frontmatter.outputSchema) {
    buildOutputSchema(frontmatter.outputSchema);
  }
  const title = frontmatter.title ?? parseTitle(body) ?? fallbackId;
  return {
    id: frontmatter.id ?? fallbackId,
    title,
    description: frontmatter.description ?? title,
    content: raw,
    guidanceBody: body,
    skillCheck: frontmatter.skillCheck,
    stateDomains: frontmatter.stateDomains,
    outputSchema: frontmatter.outputSchema,
    interpreter: frontmatter.interpreter,
    featureOverlay: frontmatter.featureOverlay,
    impactHint: frontmatter.impactHint,
  };
}

export function loadActionDefinitions(): ActionDefinition[] {
  const definitions: ActionDefinition[] = [];

  // Root-level definitions
  const rootFiles = readdirSync(__dirname).filter((f) => f.endsWith(".md"));
  for (const file of rootFiles) {
    const id = file.replace(/\.md$/, "");
    definitions.push(loadDefinitionFile(join(__dirname, file), id));
  }

  // Skill definitions from skills/ subdirectory
  const skillsDir = join(__dirname, "skills");
  if (existsSync(skillsDir)) {
    const skillFiles = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
    for (const file of skillFiles) {
      const id = file.replace(/\.md$/, "");
      definitions.push(loadDefinitionFile(join(skillsDir, file), id));
    }
  }

  return definitions;
}
