# PromptStructurizerAgent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Phase 0 preprocessing step that converts raw user creative prompts into structured story elements before world generation.

**Architecture:** New `PromptStructurizerAgent` sits before `MacroSceneAgent` in the `generateWorld()` pipeline. It calls LLM (SMALL model) to extract 5 story elements + synthesize a `refinedPrompt`. The full `StructuredStoryElements` JSON replaces `{{userPrompt}}`/`{{creativePrompt}}` in all downstream templates.

**Tech Stack:** TypeScript, LangGraph models (`generateText`), `composeTemplate`

---

### Task 1: Add `StructuredStoryElements` type

**Files:**
- Modify: `src/dynamicworldagent/world_builder/types.ts`

**Step 1: Add the interface at end of types.ts (before the last `ProgressCallback` type)**

```typescript
/**
 * Structured Story Elements - Extracted from user creative prompt
 * Used as structured input for all downstream world generation agents
 */
export interface StructuredStoryElements {
  /** Time period / era, e.g. "1920s Prohibition-era New England" */
  era: string;
  /** World rules: magic/science systems, political structure, civilizations, religion */
  worldbuilding: string;
  /** Story genres, e.g. ["horror", "mystery", "adventure"] */
  genre: string[];
  /** Overall tone / atmosphere, e.g. "dark, oppressive, paranoid" */
  tone: string;
  /** Core thematic idea, e.g. "humanity's insignificance before cosmic entities" */
  theme: string;
  /** All elements synthesized into a precise English creative brief */
  refinedPrompt: string;
}
```

**Step 2: Commit**

```bash
git add src/dynamicworldagent/world_builder/types.ts
git commit -m "feat: add StructuredStoryElements type for prompt preprocessing"
```

---

### Task 2: Create `promptStructurizerTemplate.ts`

**Files:**
- Create: `src/dynamicworldagent/world_builder/promptStructurizerTemplate.ts`

**Step 1: Write the template file**

```typescript
/**
 * Prompt Structurizer Template
 * Extracts structured story elements from user creative prompt
 */

export function getPromptStructurizerTemplate(): string {
  return `You are a story element extraction expert for tabletop RPG scenario design.

Analyze the user's creative description below and extract / expand it into 5 structured story elements. If the user omits any element, infer it from context and genre conventions.

## User Input
{{creativePrompt}}

## Output Requirements

Return a single JSON object with these fields (ALL in English, regardless of user input language):

\`\`\`json
{
  "era": "The time period / historical era the story takes place in (e.g. '1920s Prohibition-era New England', 'Victorian London 1888', 'Near-future 2045 Tokyo')",
  "worldbuilding": "How the world operates: science/magic systems, political structures, civilizations/races, religious beliefs, cosmic entities. Be specific to the story.",
  "genre": ["Primary genre(s) as an array, e.g. 'horror', 'mystery', 'adventure', 'crime', 'sci-fi', 'fantasy'"],
  "tone": "Overall style and atmosphere (e.g. 'dark, oppressive, paranoid', 'gothic and melancholic', 'tense noir')",
  "theme": "Core thematic idea the story explores (e.g. 'humanity's insignificance before cosmic entities', 'the corruption of power', 'forbidden knowledge and its price')",
  "refinedPrompt": "A comprehensive, precise creative brief in English that synthesizes ALL of the above elements plus every specific detail from the user's original input. This should be 3-6 sentences long and serve as the authoritative creative direction for all downstream generation."
}
\`\`\`

## Rules
1. PRESERVE every specific detail from the user's input (locations, character ideas, plot hooks, atmosphere cues).
2. The \`refinedPrompt\` must contain ALL user-specified details — nothing may be dropped.
3. If the user writes in a non-English language, translate and expand — do NOT transliterate.
4. For tabletop horror RPG scenarios, default worldbuilding should include Lovecraftian cosmic horror elements unless the user explicitly requests otherwise.
5. Output ONLY the JSON object. No commentary before or after.`;
}
```

**Step 2: Commit**

```bash
git add src/dynamicworldagent/world_builder/promptStructurizerTemplate.ts
git commit -m "feat: add prompt structurizer template"
```

---

### Task 3: Create `promptStructurizerAgent.ts`

**Files:**
- Create: `src/dynamicworldagent/world_builder/promptStructurizerAgent.ts`

**Step 1: Write the agent file**

Follow the same pattern as `macroSceneAgent.ts` — private `runtime`, `createRuntime()`, `parseJSONResponse()`.

```typescript
/**
 * Prompt Structurizer Agent - Extracts structured story elements from raw user input
 * Phase 0 of the World Builder pipeline
 */

import {
  ModelClass,
  ModelProviderName,
  generateText,
} from "../../models/index.js";
import { composeTemplate } from "../../template.js";
import { getPromptStructurizerTemplate } from "./promptStructurizerTemplate.js";
import type { StructuredStoryElements } from "./types.js";

interface Runtime {
  modelProvider: ModelProviderName;
  getSetting: (key: string) => string | undefined;
}

const createRuntime = (): Runtime => ({
  modelProvider:
    (process.env.WORLD_BUILDER_MODEL_PROVIDER as ModelProviderName) ||
    ModelProviderName.OPENAI,
  getSetting: (key: string) => process.env[key],
});

function parseJSONResponse(response: string): any {
  const jsonText =
    response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ||
    response.match(/\{[\s\S]*\}/)?.[0];

  if (!jsonText) {
    throw new Error("Failed to extract JSON from response");
  }

  return JSON.parse(jsonText);
}

export class PromptStructurizerAgent {
  private runtime: Runtime;

  constructor() {
    this.runtime = createRuntime();
  }

  /**
   * Extract structured story elements from raw user creative prompt
   */
  async structurize(creativePrompt: string): Promise<StructuredStoryElements> {
    console.log(
      "\n📝 [Prompt Structurizer] Extracting story elements from user input..."
    );

    const template = getPromptStructurizerTemplate();
    const prompt = composeTemplate(template, {}, { creativePrompt });

    const response = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt,
      modelClass: ModelClass.SMALL,
    });

    try {
      const parsed = parseJSONResponse(response);

      // Validate required fields
      if (!parsed.era || typeof parsed.era !== "string") {
        throw new Error("Missing or invalid field: era");
      }
      if (!parsed.worldbuilding || typeof parsed.worldbuilding !== "string") {
        throw new Error("Missing or invalid field: worldbuilding");
      }
      if (!Array.isArray(parsed.genre) || parsed.genre.length === 0) {
        throw new Error("Missing or invalid field: genre (must be non-empty array)");
      }
      if (!parsed.tone || typeof parsed.tone !== "string") {
        throw new Error("Missing or invalid field: tone");
      }
      if (!parsed.theme || typeof parsed.theme !== "string") {
        throw new Error("Missing or invalid field: theme");
      }
      if (!parsed.refinedPrompt || typeof parsed.refinedPrompt !== "string") {
        throw new Error("Missing or invalid field: refinedPrompt");
      }

      const result: StructuredStoryElements = {
        era: parsed.era,
        worldbuilding: parsed.worldbuilding,
        genre: parsed.genre,
        tone: parsed.tone,
        theme: parsed.theme,
        refinedPrompt: parsed.refinedPrompt,
      };

      console.log("✅ [Prompt Structurizer] Story elements extracted:");
      console.log(`   Era: ${result.era}`);
      console.log(`   Genre: ${result.genre.join(", ")}`);
      console.log(`   Tone: ${result.tone}`);
      console.log(`   Theme: ${result.theme}`);

      return result;
    } catch (error) {
      console.error(
        "Failed to parse prompt structurizer response:",
        error
      );
      console.error("Response:", response.substring(0, 500));
      throw new Error(
        `Failed to structurize prompt: ${(error as Error).message}`
      );
    }
  }
}
```

**Step 2: Commit**

```bash
git add src/dynamicworldagent/world_builder/promptStructurizerAgent.ts
git commit -m "feat: add PromptStructurizerAgent"
```

---

### Task 4: Update `macroSceneAgent.ts` — change 3 method signatures

**Files:**
- Modify: `src/dynamicworldagent/world_builder/macroSceneAgent.ts`

**Step 1: Add import for `StructuredStoryElements`**

At line 30 (existing imports from `./types.js`), add `StructuredStoryElements` to the import.

**Step 2: Change `generateTownStructure` signature and body**

Change parameter `creativePrompt: string` → `storyElements: StructuredStoryElements`.

Change `composeTemplate` call (line 86-91):
```typescript
// Before:
const prompt = composeTemplate(template, {}, { userPrompt: creativePrompt });

// After:
const prompt = composeTemplate(template, {}, {
  storyElements: JSON.stringify(storyElements, null, 2),
});
```

**Step 3: Change `generateHistoricalMythos` signature and body**

Change parameter `creativePrompt: string` → `storyElements: StructuredStoryElements`.

Change `composeTemplate` call (line 138-145):
```typescript
// Before:
{ macroSceneJson: JSON.stringify(macroScene, null, 2), userPrompt: creativePrompt }

// After:
{ macroSceneJson: JSON.stringify(macroScene, null, 2), storyElements: JSON.stringify(storyElements, null, 2) }
```

**Step 4: Change `generateTruthTimeline` signature and body**

Change parameter `creativePrompt: string` → `storyElements: StructuredStoryElements`.

Change `composeTemplate` call (line 193-200):
```typescript
// Before:
{ macroSceneJson: ..., mythosEventsJson: ..., userPrompt: creativePrompt }

// After:
{ macroSceneJson: ..., mythosEventsJson: ..., storyElements: JSON.stringify(storyElements, null, 2) }
```

**Step 5: Update the `generate()` orchestrator method (line 409-489)**

This method also calls the 3 methods above with `creativePrompt`. Change its parameter and internal calls:

```typescript
// Before (line 412):
creativePrompt: string,

// After:
storyElements: StructuredStoryElements,
```

Update the 3 internal calls:
```typescript
// generateTownStructure call (~line 429):
// Before: settingType, creativePrompt, progressCallback
// After:  settingType, storyElements, progressCallback

// generateHistoricalMythos call (~line 437):
// Before: macroScene, creativePrompt, progressCallback
// After:  macroScene, storyElements, progressCallback

// generateTruthTimeline call (~line 443):
// Before: macroScene, mythosEvents, creativePrompt, progressCallback
// After:  macroScene, mythosEvents, storyElements, progressCallback
```

**Step 6: Commit**

```bash
git add src/dynamicworldagent/world_builder/macroSceneAgent.ts
git commit -m "feat: macroSceneAgent accepts StructuredStoryElements instead of raw creativePrompt"
```

---

### Task 5: Update `macroSceneTemplate.ts` — replace `{{userPrompt}}` with `{{storyElements}}`

**Files:**
- Modify: `src/dynamicworldagent/world_builder/macroSceneTemplate.ts`

There are 3 occurrences of `{{userPrompt}}` (lines 128, 292, 639). For each, replace the entire SUPREME DIRECTIVE block.

**Step 1: Replace Step 1 template (line 124-142)**

```
// Before:
════════════════════════════════════════════════════════
🔴 SUPREME DIRECTIVE — READ THIS BEFORE ANYTHING ELSE 🔴
════════════════════════════════════════════════════════
USER QUERY (absolute mandate):
{{userPrompt}}

This query is the SINGLE HIGHEST AUTHORITY for all content you generate.
Every location, atmosphere, theme, character, and event MUST be directly
grounded in and consistent with the user's stated intent.

Rules that CANNOT be broken:
1. If the user names a LOCATION → you MUST use that exact location. No substitutions.
2. If the user specifies a STYLE / TONE → every output element MUST reflect it.
3. If the user specifies THEMES → they MUST appear in the generated content.
4. If ANY conflict arises between the user query and genre conventions, setting
   type defaults, or example content → the user query WINS, always.
5. Do NOT import locations, organizations, or atmospheres from generic tabletop horror RPG
   templates if they contradict what the user asked for.
════════════════════════════════════════════════════════

// After:
════════════════════════════════════════════════════════
🔴 SUPREME DIRECTIVE — READ THIS BEFORE ANYTHING ELSE 🔴
════════════════════════════════════════════════════════
STORY ELEMENTS (absolute mandate):
{{storyElements}}

These structured story elements are the SINGLE HIGHEST AUTHORITY for all content you generate.
Every location, atmosphere, theme, character, and event MUST be directly
grounded in and consistent with the story elements above.

Rules that CANNOT be broken:
1. If the elements name a LOCATION → you MUST use that exact location. No substitutions.
2. The TONE field dictates the style / atmosphere → every output element MUST reflect it.
3. The THEME field MUST appear in the generated content.
4. The ERA field dictates the time period → all content must be historically consistent.
5. The GENRE field(s) dictate narrative conventions to follow.
6. If ANY conflict arises between the story elements and setting type defaults
   or example content → the story elements WIN, always.
7. Do NOT import locations, organizations, or atmospheres from generic tabletop horror RPG
   templates if they contradict the story elements.
════════════════════════════════════════════════════════
```

**Step 2: Apply the same pattern to Step 3 template (truth timeline, line 288-304)**

Replace `USER QUERY (absolute mandate):\n{{userPrompt}}` block with `STORY ELEMENTS (absolute mandate):\n{{storyElements}}` block. Adjust the rules text similarly (referencing "story elements" instead of "user query").

**Step 3: Apply the same pattern to Step 2 template (historical mythos, line 635-651)**

Same replacement pattern.

**Step 4: Commit**

```bash
git add src/dynamicworldagent/world_builder/macroSceneTemplate.ts
git commit -m "feat: macroSceneTemplate uses storyElements JSON instead of raw userPrompt"
```

---

### Task 6: Update `moduleDigestAgent.ts` and `moduleDigestTemplate.ts`

**Files:**
- Modify: `src/dynamicworldagent/world_builder/moduleDigestAgent.ts`
- Modify: `src/dynamicworldagent/world_builder/moduleDigestTemplate.ts`

**Step 1: Update `moduleDigestAgent.ts`**

Add import for `StructuredStoryElements` from `./types.js`.

Change `generate()` method signature (line 68):
```typescript
// Before:
creativePrompt: string,

// After:
storyElements: StructuredStoryElements,
```

Change `composeTemplate` call (line 105):
```typescript
// Before:
creativePrompt,

// After:
storyElements: JSON.stringify(storyElements, null, 2),
```

**Step 2: Update `moduleDigestTemplate.ts`**

Two occurrences of `{{creativePrompt}}` (lines 17 and 46).

Line 13-24 SUPREME DIRECTIVE block — same pattern as macroSceneTemplate:
```
// Before:
USER QUERY (absolute mandate):
{{creativePrompt}}

This query is the SINGLE HIGHEST AUTHORITY for tone, theme, and framing.
...

// After:
STORY ELEMENTS (absolute mandate):
{{storyElements}}

These structured story elements are the SINGLE HIGHEST AUTHORITY for tone, theme, and framing.
The module title, introduction, background, and all narrative descriptions
MUST reflect the era, tone, theme, genre, and creative direction defined above.
When writing narrative content (introduction, background, moduleNotes), always
ask: "Does this honour the story elements?" If not, revise until it does.
```

Line 46 `{{creativePrompt}}` under `### User Prompt` section:
```
// Before:
### User Prompt
{{creativePrompt}}

// After:
### Story Elements
{{storyElements}}
```

**Step 3: Commit**

```bash
git add src/dynamicworldagent/world_builder/moduleDigestAgent.ts src/dynamicworldagent/world_builder/moduleDigestTemplate.ts
git commit -m "feat: moduleDigestAgent uses storyElements instead of creativePrompt"
```

---

### Task 7: Update `worldBuilderService.ts` — wire Phase 0 into pipeline

**Files:**
- Modify: `src/dynamicworldagent/world_builder/worldBuilderService.ts`

**Step 1: Add imports**

```typescript
import { PromptStructurizerAgent } from "./promptStructurizerAgent.js";
import type { StructuredStoryElements } from "./types.js";
```

**Step 2: Add agent to constructor**

```typescript
private promptStructurizerAgent: PromptStructurizerAgent;

constructor() {
  this.promptStructurizerAgent = new PromptStructurizerAgent();
  // ... existing agents
}
```

**Step 3: Add Phase 0 in `generateWorld()` before Phase 1 (before line 113)**

```typescript
// ========== PHASE 0: PROMPT STRUCTURIZER (progress 0→5) ==========
emitProgress("prompt_structurizer", 1, "Analyzing creative prompt...");

const storyElements = await this.promptStructurizerAgent.structurize(
  creativePrompt
);

emitProgress("prompt_structurizer", 5, "Story elements extracted");
```

**Step 4: Replace `creativePrompt` with `storyElements` in all downstream calls**

Phase 1 calls in `generateWorld()`:
```typescript
// generateTownStructure (~line 115):
// Before: settingType, creativePrompt, (msg) => ..., storyLength
// After:  settingType, storyElements, (msg) => ..., storyLength

// generateHistoricalMythos (~line 128):
// Before: macroScene, creativePrompt, (msg) => ...
// After:  macroScene, storyElements, (msg) => ...

// generateTruthTimeline (~line 136):
// Before: macroScene, mythosEvents, creativePrompt, (msg) => ..., storyLength
// After:  macroScene, mythosEvents, storyElements, (msg) => ..., storyLength
```

Phase 5 moduleDigestAgent.generate() call (~line 306):
```typescript
// Before: ..., creativePrompt, endState, ...
// After:  ..., storyElements, endState, ...
```

**Step 5: Commit**

```bash
git add src/dynamicworldagent/world_builder/worldBuilderService.ts
git commit -m "feat: wire PromptStructurizerAgent as Phase 0 in generateWorld pipeline"
```

---

### Task 8: Build and verify

**Step 1: Run TypeScript build**

```bash
pnpm build
```

Expected: No type errors. All imports resolve.

**Step 2: Verify `generateScene()` and `generateNpcsForModule()` still compile**

These methods still use `creativePrompt: string` directly — they call `macroSceneAgent.generate()` which now expects `storyElements`. Since `generateScene()` calls `this.macroSceneAgent.generate(settingType, creativePrompt, ...)`, this will be a type error.

Fix: `generateScene()` calls `macroSceneAgent.generate()` which is a convenience method — it also needs updating. BUT we decided not to add Phase 0 to `generateScene()`. So `macroSceneAgent.generate()` should keep accepting `creativePrompt: string` and internally wrap it (or keep a separate overload).

**Resolution**: Keep `macroSceneAgent.generate()` accepting `creativePrompt: string` (for `generateScene()` path). Only the individual step methods (`generateTownStructure`, `generateHistoricalMythos`, `generateTruthTimeline`) accept `StructuredStoryElements`. The `generate()` convenience method wraps `creativePrompt` by passing it as-is through the old path — but since the step methods now expect `StructuredStoryElements`, we need `generate()` to accept `StructuredStoryElements | string`.

Simplest approach: **overload `generate()`** — if passed a string, construct a minimal `StructuredStoryElements` with `refinedPrompt = creativePrompt` and empty/default other fields:

```typescript
async generate(
  settingType: MacroSceneSettingType = "small_town",
  creativePromptOrElements: string | StructuredStoryElements,
  progressCallback?: ProgressCallback
) {
  const storyElements: StructuredStoryElements =
    typeof creativePromptOrElements === "string"
      ? {
          era: "",
          worldbuilding: "",
          genre: [],
          tone: "",
          theme: "",
          refinedPrompt: creativePromptOrElements,
        }
      : creativePromptOrElements;

  // ... rest unchanged, uses storyElements
}
```

**Step 3: Rebuild and verify**

```bash
pnpm build
```

Expected: Clean build, no errors.

**Step 4: Commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: handle string fallback in macroSceneAgent.generate() for generateScene path"
```
