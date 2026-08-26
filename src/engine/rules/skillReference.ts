// src/engine/rules/skillReference.ts
//
// Skill knowledge reference (NOT action definitions). The markdown files
// under rules/skills/ carry per-skill knowledge both sides of the action
// boundary need:
//   - the AGENT: what each skill covers / does not cover, so it declares the
//     right skillId on `act`;
//   - the ENGINE: applicability boundaries, objective duration guidance and
//     success/failure shading, so post-roll assessment is grounded.
//
// The files keep their legacy frontmatter, but ONLY knowledge fields are
// read: id, title, description, and outputSchema.durationGuidance (a
// knowledge field that historically lived inside the schema block). The
// routing machinery — skillCheck, stateDomains, output whitelists,
// interpreter examples, engine dispatch — is deliberately ignored: there are
// no per-action definitions in this architecture (plan D8), only skill
// knowledge.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export interface SkillDurationGuidance {
  default: number;
  range?: string;
  notes?: string;
}

export interface SkillReference {
  /** File id, lowercase (e.g. "locksmith"). */
  id: string;
  /** Canonical skill name to declare as `skillId` (e.g. "Locksmith"). */
  title: string;
  /** What the skill covers — and what it does NOT (boundary knowledge). */
  description: string;
  durationGuidance?: SkillDurationGuidance;
  /** Markdown body: outcome shading per success level, failure/fumble
   *  consequences. Objective rulebook knowledge, no output schemas. */
  guidanceBody: string;
}

function skillsDir(): string | undefined {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), "skills"),
    join(process.cwd(), "src", "engine", "rules", "skills"),
  ];
  return candidates.find((dir) => existsSync(dir));
}

function parseSkillFile(path: string, fallbackId: string): SkillReference | null {
  const raw = readFileSync(path, "utf-8");
  if (!raw.startsWith("---")) return null;
  const endIndex = raw.indexOf("\n---", 3);
  if (endIndex === -1) return null;
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseYaml(raw.slice(4, endIndex)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const body = raw.slice(endIndex + 4).trim();
  const id =
    typeof frontmatter.id === "string" ? frontmatter.id : fallbackId;
  const title =
    typeof frontmatter.title === "string" ? frontmatter.title : id;
  const description =
    typeof frontmatter.description === "string" ? frontmatter.description : "";
  const durationGuidance = (
    frontmatter.outputSchema as
      | { durationGuidance?: SkillDurationGuidance }
      | undefined
  )?.durationGuidance;

  return {
    id,
    title,
    description,
    ...(durationGuidance ? { durationGuidance } : {}),
    guidanceBody: body,
  };
}

let cache: SkillReference[] | null = null;

export function loadSkillReferences(): SkillReference[] {
  if (cache) return cache;
  const dir = skillsDir();
  if (!dir) {
    console.warn("[skillReference] rules/skills directory not found");
    cache = [];
    return cache;
  }
  const refs: SkillReference[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".md")) continue;
    const ref = parseSkillFile(join(dir, file), file.replace(/\.md$/, ""));
    if (ref) refs.push(ref);
  }
  cache = refs;
  return refs;
}

/** Case-insensitive lookup by canonical title or file id. */
export function getSkillReference(
  skillIdOrTitle: string
): SkillReference | undefined {
  const needle = skillIdOrTitle.trim().toLowerCase();
  return loadSkillReferences().find(
    (r) => r.title.toLowerCase() === needle || r.id.toLowerCase() === needle
  );
}

/** One line per skill — the catalog both the agent prompt and the Engine
 *  system prompt inject (stable at module load; cache-friendly). */
export function buildSkillCatalogPrompt(): string {
  return loadSkillReferences()
    .map((r) => `- ${r.title}: ${r.description}`)
    .join("\n");
}

/** Full guidance block for one declared skill, rendered for the Engine's
 *  per-resolution context (only skills actually declared this tick). */
export function renderSkillGuidance(skillIdOrTitle: string): string | null {
  const ref = getSkillReference(skillIdOrTitle);
  if (!ref) return null;
  const lines = [`### ${ref.title}`, ref.description];
  if (ref.durationGuidance) {
    const dg = ref.durationGuidance;
    lines.push(
      `Duration guidance: default ${dg.default} min${dg.range ? `, range ${dg.range}` : ""}${dg.notes ? ` (${dg.notes})` : ""}`
    );
  }
  if (ref.guidanceBody) lines.push(ref.guidanceBody);
  return lines.join("\n\n");
}
