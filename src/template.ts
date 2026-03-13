import fs from "fs";
import path from "path";
import handlebars from "handlebars";
import { names, uniqueNamesGenerator } from "unique-names-generator";
import type { DynamicGameState } from "./dynamicworldagent/state/index.js";
import type { DynamicScene } from "./dynamicworldagent/state/types.js";
import type { ImageInput } from "./models/types.js";
import { stripModuleScope } from "./shared/agents/memory/database/moduleScope.js";

type TemplateContext = Record<string, unknown>;
const ID_LIKE_KEYS = new Set([
  "id",
  "sceneId",
  "scenarioId",
  "sceneId",
  "characterId",
  "clueId",
  "conditionId",
  "targetId",
]);

const uuidLike =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailLike = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const stripScopedIdIfNeeded = (value: string): string => {
  const sep = value.indexOf("::");
  if (sep <= 0) return value;
  const prefix = value.slice(0, sep);
  if (emailLike.test(prefix) || uuidLike.test(prefix)) {
    return stripModuleScope(value);
  }
  return value;
};

const sanitizeTemplateValue = (
  value: unknown,
  key?: string,
  seen: WeakSet<object> = new WeakSet()
): unknown => {
  if (typeof value === "string") {
    return key && ID_LIKE_KEYS.has(key) ? stripScopedIdIfNeeded(value) : value;
  }
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTemplateValue(item, key, seen));
  }

  if (value instanceof Map) {
    const sanitizedMap = new Map<unknown, unknown>();
    for (const [k, v] of value.entries()) {
      const nextKey = typeof k === "string" ? k : key;
      sanitizedMap.set(k, sanitizeTemplateValue(v, nextKey, seen));
    }
    return sanitizedMap;
  }

  if (value instanceof Set) {
    const sanitizedSet = new Set<unknown>();
    for (const item of value.values()) {
      sanitizedSet.add(sanitizeTemplateValue(item, key, seen));
    }
    return sanitizedSet;
  }

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = sanitizeTemplateValue(v, k, seen);
  }
  return out;
};

/**
 * Multiplayer scene-scoped state — carries only the active sceneRoom's scene.
 * Avoids passing the entire multiplayer state into templates (prevents cross-scene leakage).
 */
export interface MultiplayerSceneScopedState {
  /** Discriminator to distinguish from single-player state */
  multiplayerSceneScope: true;
  /** The current sceneRoom's scene */
  currentScene: DynamicScene | null;
  /** Map image path (from ScenarioOutline, provided by caller) */
  mapImagePath?: string;
  [key: string]: unknown;
}

/**
 * CoC State type for template composition
 * Can be a DynamicGameState directly, an object containing dynamicGameState,
 * or a multiplayer scene-scoped state.
 */
export type CoCState =
  | DynamicGameState
  | { dynamicGameState?: DynamicGameState; [key: string]: any }
  | MultiplayerSceneScopedState;

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

const isDynamicGameState = (state: unknown): state is DynamicGameState => {
  return Boolean(
    state &&
      typeof state === "object" &&
      "moduleName" in state &&
      "scenarioOutlines" in state &&
      "macroScene" in state
  );
};

const extractDynamicGameState = (state: CoCState): DynamicGameState | null => {
  if ("dynamicGameState" in state && state.dynamicGameState) {
    return state.dynamicGameState as DynamicGameState;
  }
  if (isDynamicGameState(state)) {
    return state;
  }
  return null;
};

/**
 * Collects scenario images (e.g., map) from the current game state.
 * mapImagePath is now on ScenarioOutline, not on the scene itself.
 */
export const collectScenarioImages = (state: CoCState): ImageInput[] => {
  let mapImagePath: string | undefined;
  if ("multiplayerSceneScope" in state && state.multiplayerSceneScope) {
    // Multiplayer: caller provides mapImagePath directly on the scoped state
    mapImagePath = state.mapImagePath as string | undefined;
  } else {
    // Simulation mode: no current scene concept, skip map image
  }
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
 * Multiplayer note:
 * - Template composition is purely a renderer; it does NOT enforce isolation.
 * - When running native multiplayer with multiple sceneRooms in parallel, callers MUST inject
 *   sceneRoom-scoped views (current scene + scene members + per-scene temporaryInfo)
 *   instead of passing the entire multiplayer state into templates, to avoid cross-scene leakage.
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
  const dynamicGameState = extractDynamicGameState(state);

  const context: TemplateContext = {
    ...state,
    dynamicGameState: dynamicGameState ?? null,
    ...extraContext,
  };
  const sanitizedContext = sanitizeTemplateValue(context) as TemplateContext;

  // Resolve template function to string
  const templateStr =
    typeof template === "function" ? template({ state }) : template;

  // Use handlebars if specified
  if (templatingEngine === "handlebars") {
    const templateFunction = handlebars.compile(templateStr);
    return templateFunction(sanitizedContext);
  }

  // Default simple replacement
  return templateStr.replace(/{{\s*([^}]+?)\s*}}/g, (_match, rawPath) => {
    const value = getValueAtPath(sanitizedContext, rawPath);
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
  const content = composeTemplate(
    template,
    state,
    extraContext,
    templatingEngine
  );
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
    const fallbackTemplate =
      typeof template === "string" ? template : "{{dynamicGameState}}";
    return composeTemplate(fallbackTemplate, state, extraContext);
  }
};
