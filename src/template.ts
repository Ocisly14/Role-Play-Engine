import handlebars from "handlebars";
import fs from "fs";
import path from "path";
import type { GameState } from "./coc_multiagents_system/state/index.js";
import { initialGameState } from "./coc_multiagents_system/state/index.js";
import type { DynamicGameState } from "./dynamicworldagent/state/index.js";
import type { ImageInput } from "./models/types.js";
import { names, uniqueNamesGenerator } from "unique-names-generator";

type TemplateContext = Record<string, unknown>;

/**
 * CoC State type for template composition
 * Can be a GameState directly, DynamicGameState, or an object containing gameState/dynamicGameState
 */
export type CoCState = 
  | GameState 
  | DynamicGameState
  | { gameState?: GameState; dynamicGameState?: DynamicGameState; [key: string]: any };

// Template function type for dynamic templates
export type TemplateType = string | ((params: { state: CoCState }) => string);

export interface ComposedPrompt {
  content: string;
  images: ImageInput[];
}

const renderValue = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map(renderValue).join(", ");
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
};

const getValueAtPath = (context: TemplateContext, rawPath: string): unknown => {
  const segments = rawPath.trim().split(".").filter(Boolean);
  return segments.reduce<unknown>((current, key) => {
    if (current && typeof current === "object" && key in current) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, context);
};

const imageMimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const inferMimeType = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  return imageMimeTypes[ext] || "image/png";
};

const resolveMapImage = (mapImagePath?: string): ImageInput | null => {
  if (!mapImagePath) return null;

  const normalized = mapImagePath.replace(/\\/g, path.sep);
  const candidates = new Set<string>();

  if (path.isAbsolute(normalized)) {
    candidates.add(normalized);
  }

  candidates.add(path.join(process.cwd(), normalized));
  candidates.add(path.join(process.cwd(), "data", normalized));

  const modsDir = path.join(process.cwd(), "data", "Mods");
  if (fs.existsSync(modsDir)) {
    const moduleDirs = fs
      .readdirSync(modsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);

    for (const moduleDir of moduleDirs) {
      candidates.add(path.join(modsDir, moduleDir, normalized));
    }
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const data = fs.readFileSync(candidate);
        return { data, mimeType: inferMimeType(candidate) };
      }
    } catch (error) {
      console.warn(`Failed to load image at ${candidate}:`, error);
    }
  }

  return null;
};

const extractGameState = (state: CoCState): GameState | null => {
  if ("gameState" in state && state.gameState) {
    return state.gameState as GameState;
  }
  if ("phase" in state && "playerCharacter" in state && "moduleName" in state) {
    // This is DynamicGameState, return null as it's not GameState
    return null;
  }
  if ("phase" in state && "playerCharacter" in state) {
    return state as GameState;
  }
  return null;
};

/**
 * Collects scenario images (e.g., map) from the current game state.
 */
export const collectScenarioImages = (state: CoCState): ImageInput[] => {
  const gameState = extractGameState(state);
  const mapImagePath = gameState?.currentScenario?.mapImagePath;
  if (!mapImagePath) return [];

  const resolved = resolveMapImage(mapImagePath);
  if (!resolved) {
    console.warn(`Map image path provided but file not found: ${mapImagePath}`);
    return [];
  }

  return [resolved];
};

/**
 * Enhanced template composition with support for dynamic templates and handlebars.
 * Replaces `{{path.to.value}}` placeholders in a template using state-driven context.
 * This keeps prompts declarative while safely surfacing the latest state to the LLM.
 * 
 * @param template - Template string or function
 * @param state - CoC game state
 * @param extraContext - Additional context variables
 * @param templatingEngine - Optional templating engine ("handlebars")
 * @returns Composed template with placeholders filled
 */
export const composeTemplate = (
  template: TemplateType,
  state: CoCState,
  extraContext: TemplateContext = {},
  templatingEngine?: "handlebars"
): string => {
  // Handle both GameState directly and { gameState: GameState } object
  // Also handle DynamicGameState
  const gameState = 'gameState' in state && state.gameState 
    ? state.gameState 
    : (("phase" in state && "playerCharacter" in state && !("moduleName" in state)) ? state as GameState : null);
  
  const dynamicGameState = 'dynamicGameState' in state && state.dynamicGameState
    ? state.dynamicGameState
    : (("phase" in state && "playerCharacter" in state && "moduleName" in state) ? state as DynamicGameState : null);
  
  const context: TemplateContext = {
    ...state,
    gameState: gameState ?? initialGameState,
    dynamicGameState: dynamicGameState ?? null,
    ...extraContext,
  };

  // Resolve template function to string
  const templateStr = typeof template === "function" ? template({ state }) : template;

  // Use handlebars if specified
  if (templatingEngine === "handlebars") {
    const templateFunction = handlebars.compile(templateStr);
    return templateFunction(context);
  }

  // Default simple replacement
  return templateStr.replace(/{{\s*([^}]+?)\s*}}/g, (_match, rawPath) => {
    const value = getValueAtPath(context, rawPath);
    return renderValue(value);
  });
};

/**
 * Compose template and attach scenario images (if present) for vision-capable models.
 */
export const composeTemplateWithImages = (
  template: TemplateType,
  state: CoCState,
  extraContext: TemplateContext = {},
  templatingEngine?: "handlebars"
): ComposedPrompt => {
  const content = composeTemplate(template, state, extraContext, templatingEngine);
  const images = collectScenarioImages(state);
  return { content, images };
};

/**
 * Generates a string with random user names populated in a template.
 * Useful for creating examples with varied character names.
 * 
 * @param template - Template string containing {{user1}}, {{user2}}, etc. placeholders
 * @param length - Number of random user names to generate
 * @returns Template with user placeholders replaced by random names
 */
export const composeRandomUser = (template: string, length: number): string => {
  const exampleNames = Array.from({ length }, () =>
    uniqueNamesGenerator({ dictionaries: [names] })
  );
  
  let result = template;
  for (let i = 0; i < exampleNames.length; i++) {
    result = result.replaceAll(`{{user${i + 1}}}`, exampleNames[i]);
  }

  return result;
};

/**
 * Adds a header to a body of text with proper formatting.
 * 
 * @param header - Header text to prepend
 * @param body - Body text
 * @returns Formatted text with header
 */
export const addHeader = (header: string, body: string): string => {
  return body.length > 0 ? `${header ? header + "\n" : header}${body}\n` : "";
};

/**
 * Composes context for CoC game scenarios with enhanced error handling and validation.
 * 
 * @param params - Object containing state, template, and optional templating engine
 * @returns Composed context string
 */
export const composeContext = ({
  state,
  template,
  templatingEngine,
  extraContext = {},
}: {
  state: CoCState;
  template: TemplateType;
  templatingEngine?: "handlebars";
  extraContext?: TemplateContext;
}): string => {
  try {
    return composeTemplate(template, state, extraContext, templatingEngine);
  } catch (error) {
    console.error("Error composing context:", error);
    // Fallback to simple template without dynamic features
    const fallbackTemplate = typeof template === "string" ? template : "{{gameState}}";
    return composeTemplate(fallbackTemplate, state, extraContext);
  }
};
