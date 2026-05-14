# PromptStructurizerAgent Design

## Problem

User `creativePrompt` is injected raw into downstream World Builder templates (`{{userPrompt}}`). This is unstructured free text that may be in any language, vague, or missing key story elements. Downstream agents must guess at era, tone, genre, etc.

## Solution

Add a **Phase 0** preprocessing step in `WorldBuilderService.generateWorld()` that uses an LLM to extract and expand 5 structured story elements from the user's raw input, then passes the structured result to all downstream agents.

## Data Structure

```typescript
// Added to src/dynamicworldagent/world_builder/types.ts

interface StructuredStoryElements {
  era: string;             // e.g. "1920s Prohibition-era New England"
  worldbuilding: string;   // e.g. "Lovecraftian cosmic horror with Deep Ones..."
  genre: string[];         // e.g. ["horror", "mystery", "adventure"]
  tone: string;            // e.g. "dark, oppressive, paranoid"
  theme: string;           // e.g. "humanity's insignificance before cosmic entities"
  refinedPrompt: string;   // All elements synthesized into a precise English creative brief
}
```

- All fields always in English regardless of user input language
- `settingType` is NOT included — that stays as user manual selection (or default `small_town`)
- Missing elements are inferred by the LLM from context

## New Files

1. **`src/dynamicworldagent/world_builder/promptStructurizerAgent.ts`**
   - `structurize(creativePrompt: string): Promise<StructuredStoryElements>`
   - Uses `ModelClass.SMALL` for speed
   - Default temperature (no creativity boost needed)
   - Parses JSON response, validates required fields

2. **`src/dynamicworldagent/world_builder/promptStructurizerTemplate.ts`**
   - Single template with `{{creativePrompt}}` placeholder
   - Instructs LLM to extract 5 elements + synthesize `refinedPrompt`
   - Always English output

## Pipeline Changes

### worldBuilderService.ts

```
Before: creativePrompt → MacroSceneAgent Step1
After:  creativePrompt → PromptStructurizerAgent → StructuredStoryElements → MacroSceneAgent Step1
```

- New Phase 0 (progress 0→5) before existing Phase 1
- `storyElements` replaces `creativePrompt` in all subsequent calls
- Only applies to `generateWorld()` — `generateScene()` and `generateNpcsForModule()` unchanged

### macroSceneAgent.ts

- `generateTownStructure(settingType, creativePrompt, ...)` → `generateTownStructure(settingType, storyElements, ...)`
- `generateHistoricalMythos(macroScene, creativePrompt, ...)` → `generateHistoricalMythos(macroScene, storyElements, ...)`
- `generateTruthTimeline(macroScene, mythosEvents, creativePrompt, ...)` → `generateTruthTimeline(macroScene, mythosEvents, storyElements, ...)`
- `composeTemplate` calls change from `{ userPrompt: creativePrompt }` to `{ storyElements: JSON.stringify(storyElements, null, 2) }`

### macroSceneTemplate.ts

3 templates that use `{{userPrompt}}` change to:

```
════════════════════════════════════
🔴 SUPREME DIRECTIVE
════════════════════════════════════
STORY ELEMENTS (absolute mandate):
{{storyElements}}

This structured brief is the SINGLE HIGHEST AUTHORITY...
```

### moduleDigestAgent.ts

- `creativePrompt` parameter → `storyElements: StructuredStoryElements`
- Template injection updated accordingly

## Scope

### Changed files:
- `types.ts` — add interface
- `worldBuilderService.ts` — Phase 0 + parameter changes
- `macroSceneAgent.ts` — 3 method signatures + composeTemplate calls
- `macroSceneTemplate.ts` — 3 template `{{userPrompt}}` → `{{storyElements}}`
- `moduleDigestAgent.ts` — parameter change

### NOT changed:
- Frontend (`StoryCreator.tsx`) — no user-facing changes
- API controller (`worldBuilder.ts`) — `creativePrompt` still read from request body
- `settingType` logic — unchanged
- `generateScene()` / `generateNpcsForModule()` — unchanged
