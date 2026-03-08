# World Builder Pipeline Redesign

**Date:** 2026-03-07
**Branch:** tick
**Status:** Draft

## Core Philosophy

**Build a complete, normal world first. Then introduce an event. Let the event naturally change the world.**

The current pipeline designs the mystery first (truth timeline, knowledge matrix) and builds the world around it. This creates a "puzzle board" where every NPC exists because they know something.

The new pipeline inverts this:
1. Build a living, breathing world with real places and real people
2. Introduce a catalyzing event (大事件)
3. Simulate how the event changes the world over time (story timeline)
4. Update the world with the natural traces of those changes (clues, secrets, trauma)

---

## New Pipeline

```
═══════ WORLD BUILDING ═══════
Phase 0:  World Seed (叙事框架 + 物理骨架, merged from old Phase 0+1)
Phase 1:  Macro Locations (建筑/地标)
Phase 2:  Transport Network (道路)
Phase 3:  Sub-Scenes (房间/楼层)
Phase 4:  Graph Assembly (代码连线)
Phase 5:  NPC Generation (平民居民)
Phase 6:  Attributes & Skills (掷骰 + 技能分配)
═══════ 到这里，一个完整的"正常世界"已经建好 ═══════
Phase 7:  Story Generation (故事生成，基于已有世界)
  ├── 7a: Historical Backstory (历史根源)
  ├── 7b: Truth Timeline (真相事件链，用真实 NPC/场景)
  ├── 7c: Knowledge Matrix (谁知道什么 → 直接映射 npcId/sceneId/objectId)
  ├── 7d: Surface Layer (表面迷雾/误导)
  └── 7e: End State (不干预的后果)
Phase 8:  World Update (根据故事更新世界 — 场景加线索，NPC 加秘密)
Phase 9:  Module Digest + Persistence
```

### vs. Current Pipeline

```
CURRENT:                              NEW:
Phase 0: Prompt Structurizer  ──────► Phase 0: World Seed (merged 0+1)
Phase 1: Setting Seed (4 sub-steps)─┘
Phase 2: Macro Locations      ──────► Phase 1: Macro Locations
Phase 3: Transport Network    ──────► Phase 2: Transport Network
Phase 4: Sub-Scenes           ──────► Phase 3: Sub-Scenes
Phase 5: Graph Assembly        ──────► Phase 4: Graph Assembly
                                      Phase 5: NPC Generation ← NEW
                                      Phase 6: Attributes & Skills ← moved
Phase 6: Truth Timeline        ──────► Phase 7b: Truth Timeline (用真实 NPC/场景)
Phase 7: Knowledge Matrix      ──────► Phase 7c: Knowledge Matrix (直接映射 npcId/sceneId)
Phase 8: Red Herrings          ──────► Phase 7d: Surface Layer (表面迷雾)
Phase 9: NPC Generation       ──────► (absorbed into Phase 5)
Phase 10: Clue Placement       ──────► Phase 8: World Update (自然痕迹)
Phase 11: (deprecated)
Phase 12: Module Digest        ──────► Phase 9: Module Digest
```

### Key Differences

- **Knowledge Matrix** — 保留概念，但直接映射到真实 `npcId` / `sceneId` / `objectId`，不再使用抽象 holder
- **Historical Backstory** — 新增 7a，为事件提供历史深度
- **Truth Timeline** — 直接引用真实 NPC 和场景，不再 "NO NAMES"
- **Surface Layer** — 替代 Red Herrings，基于真实 NPC 视角产生误解
- **End State** — 从独立 phase 变为 7e 子步骤
- **Clue Placement** — 不再"设计放置"，而是在 World Update 中作为事件的自然痕迹

---

## Phase 0: World Seed

**Files:** Merged `promptStructurizerTemplate.ts` + `macroSceneTemplate.ts` Step 1

### Input

- `creativePrompt: string` — 用户自然语言创意输入

### Output

```json
{
  "era": "时代背景",
  "genre": ["类型标签"],
  "tone": "情感基调",
  "theme": "主题",
  "worldbuilding": "世界观（含隐藏力量、权力结构、世界历史）",
  "locationName": "地名",
  "settingType": "small_town|city|academic|isolated|single_structure|route",
  "geographicLayout": {
    "naturalFeatures": [],
    "artificialStructures": [],
    "keyLocations": []
  },
  "economicCore": "经济基础"
}
```

### Changes from Current

- **Merged** Phase 0 (prompt structurizer) and Phase 1 Step 1 (setting structure) into one LLM call
- **Removed** `refinedPrompt` — structured fields already serve as downstream context
- **Removed** `moduleName` — moved to Phase 10 (Module Digest)
- **Removed** `powerStructure` — covered by `worldbuilding`
- **Removed** `informationAsymmetry` — story layer responsibility, emerges from Phase 8

### Template Issues to Fix

- P0-1: Remove hardcoded Lovecraftian default (Rule 5)
- P0-2: Remove anti-classic bias (Rule 6)
- P0-3: Replace "Avoid the obvious. Surprise yourself." with neutral guidance
- P0-4: Diversify JSON field examples across genres
- P0-5: Neutralize worldbuilding field (don't assume supernatural)

### Template Guidance

Replace creative philosophy with:
> "Match the user's creative intent. If they want classic, deliver the best classic. If they want experimental, push boundaries. The user's prompt sets the direction — your job is to realize it at the highest possible quality."

### Model

MEDIUM (creative, needs quality)

---

## Phase 1: Macro Locations

**Files:** `scenarioBuilderTemplate.ts` (`buildMacroLocationPrompt`), `scenarioBuilderAgent.ts`

### Input

- `worldSeed` — Phase 0 output
- `moduleSize` — from `getModuleSizeConfig(storyLength)`

### Output

`ScenarioOutline[]` — array of macro locations (buildings, landmarks, areas)

### Template Issues to Fix

- P1-1: Remove road/street instruction (roads are Phase 2's job)
- P1-2: Add world seed context (SUPREME DIRECTIVE or inject worldSeed JSON)
- P1-3: Clarify ID namespace: "IDs must follow pattern SCN_N. Do NOT generate road/street locations."

---

## Phase 2: Transport Network

**Files:** `sceneGraphBuilderTemplate.ts`, `sceneGraphBuilder.ts`

### Input

- `macroLocations` — Phase 1 output
- `worldSeed` — Phase 0 output

### Output

- `outdoorScenes: DynamicScene[]` — road/street scenes
- `transportEdges: TransportEdge[]` — connections between locations
- `outdoorMacroLocation: ScenarioOutline` — container for outdoor scenes

### Template Issues to Fix

- P2-1: Enrich outdoor scenes — description must include building exteriors, allow items and conditions
- P2-2: Clarify connectivity: "Every macro location must be reachable via transport edges"
- P2-3: Strengthen ID enforcement: "CRITICAL: IDs MUST use ROAD_N pattern"
- P2-4: Add road topology patterns:

| Pattern | Use Case | Description |
|---------|----------|-------------|
| Hub-and-spoke | 小镇广场, 校园中心 | Central node radiates outward |
| Linear | 沿河小镇, 码头区 | Main road connects locations in sequence |
| Grid | 城市街区 | Intersecting streets form blocks |
| Loop | 封闭社区, 岛屿 | Road forms a circle |
| Branching | 乡村, 山区 | Main road forks into smaller paths |

---

## Phase 3: Sub-Scenes

**Files:** `subSceneBuilderTemplate.ts`, `subSceneBuilder.ts`

### Input

- `macroLocations` — Phase 1 output
- `worldSeed` — Phase 0 output
- `streetScenesByLocation` — derived from Phase 2

### Output

`Map<locationId, DynamicScene[]>` — rooms/floors within each building

### Template Issues to Fix

- P3-1: Strengthen internal connectivity (CRITICAL + BFS validation in agent)
- P3-2: Standardize `mechanicalEffect` format
- P3-3: Support multiple entry scenes with `connectsToStreets` mapping

---

## Phase 4: Graph Assembly

**Files:** `graphAssembly.ts`

Pure code — no LLM. Wires entry scenes to street scenes, BFS validates global connectivity.

### Input

- `macroLocations`, `subScenesByLocation`, `outdoorScenes`, `outdoorMacroLocation`, `transportEdges`

### Output

- `allScenes: Map<string, DynamicScene>` — complete scene graph
- `scenarios: ScenarioOutline[]` — updated with scene references

### Code Changes

- Support multi-entry wiring via `connectsToStreets` mapping

---

## Phase 5: NPC Generation

**Files:** New/refactored `npcBuilderTemplate.ts`, `npcBuilderAgent.ts`

### Input

- `worldSeed` — Phase 0 output (era, tone, economicCore, etc.)
- `scenarios` — Phase 4 output (macro locations with residents count)
- `allScenes` — Phase 4 output (rooms/spaces)
- `storyLength` — for NPC count guidance

### Output per NPC

```json
{
  "id": "npc-xxx",
  "name": "string",
  "occupation": "string",
  "age": 45,
  "gender": "string",
  "personality": "2-3 sentences",
  "appearance": "2-3 sentences",
  "residence": "macro location id",
  "workplace": "macro location id",
  "relationships": [
    { "targetNpcId": "npc-yyy", "type": "employer", "description": "..." }
  ]
}
```

### Template Guidance

- Generate NPCs that make the setting feel alive
- Each macro location with residents gets at least 1 NPC
- Mix of: owners, workers, visitors, residents
- Relationships are **mundane** only: family, friend, colleague, rival, neighbor, etc.
- **No story knowledge, no secrets, no clues** at this stage

### Relationship Type Enum

```
family, friend, ally, acquaintance, colleague, employer, employee,
mentor, student, rival, enemy, neutral, romantic, ex, dependent,
guardian, business, neighbor, suspicious, fearful
```

---

## Phase 6: Attributes & Skills

**Files:** `npcBuilderAgent.ts` (Steps 2-3), `skillAllocator.ts`

Pure code — dice rolling + skill point allocation. Runs immediately after NPC generation.

### Input

- `npcs` — Phase 5 output (basic profiles)

### Output

- `npcs` — updated in-place with stats, skills, derived values

No template changes. Logic unchanged from current Steps 2-3.

---

## ═══════ NORMAL WORLD COMPLETE ═══════

At this point, a complete, functioning world exists:
- Physical spaces (buildings, roads, rooms) with full scene graph
- NPCs with personalities, occupations, relationships, stats, skills
- Everything is "normal" — no mystery, no supernatural intrusion, no secrets yet

---

## Phase 7: Story Generation (故事生成)

**Files:** New templates + agents for each sub-step

Phase 7 has 5 sub-steps, each a separate LLM call. All sub-steps receive the complete world context (scenes, NPCs with stats/skills) and directly reference real IDs.

### Common Input (all sub-steps)

- `worldSeed` — Phase 0 output
- `scenarios` — complete macro locations
- `allScenes` — complete scene graph
- `npcs` — complete NPC list with stats/skills
- `storyLength` — determines complexity/count

---

### Phase 7a: Historical Backstory (历史根源)

**Purpose:** Why is the current crisis happening? What historical forces set the stage?

**Additional Input:** None (first sub-step)

**Output:**
```json
{
  "backstory": [
    {
      "period": "1847",
      "event": "What happened historically",
      "location": "SCN_2 or general area description",
      "consequences": ["How it still affects the present"],
      "mythosElement": "What supernatural force was involved (if any)"
    }
  ]
}
```

**Design Notes:**
- References existing locations where historical events left marks
- May reference NPC ancestors or families
- Not all modules need mythos backstory — pure mystery can have purely human history
- Provides depth for Phase 7b events to build on

---

### Phase 7b: Truth Timeline (真相事件链)

**Purpose:** The objective sequence of recent/current events — what actually happened, involving real people and places.

**Additional Input:** `backstory` — Phase 7a output

**Output:**
```json
{
  "truthEvents": [
    {
      "id": "T1",
      "time": "3 months ago",
      "event": "Dr. Harris discovered ancient remains in the hospital cellar during renovation",
      "location": "SCN_2_cellar",
      "involvedNpcs": [
        { "npcId": "npc-harris", "role": "discoverer" }
      ],
      "cause": "Hospital basement expansion exposed sealed chamber",
      "consequence": "Harris began secret research, started behaving erratically",
      "mythosInvolved": true
    },
    {
      "id": "T2",
      "time": "6 weeks ago",
      "event": "Old Tom overheard Harris making strange phone calls from the bar's back office",
      "location": "SCN_1_backoffice",
      "involvedNpcs": [
        { "npcId": "npc-old-tom", "role": "witness" },
        { "npcId": "npc-harris", "role": "actor" }
      ],
      "cause": "Harris used the bar's phone to avoid hospital records",
      "consequence": "Tom became suspicious but kept quiet",
      "mythosInvolved": false
    }
  ]
}
```

**Key Difference from Old Pipeline:**
- **Uses real NPC names and IDs** — not "NO NAMES" abstract descriptions
- **References real scene IDs** — events are grounded in specific rooms
- Each event explicitly lists involved NPCs with their roles

---

### Phase 7c: Knowledge Matrix (知识映射)

**Purpose:** Structured mapping of who knows what, where evidence exists. Directly references real NPC IDs, scene IDs, and item IDs.

**Additional Input:** `truthEvents` — Phase 7b output

**Output:**
```json
{
  "knowledgeEntries": [
    {
      "npcId": "npc-old-tom",
      "knows": ["T2"],
      "distortion": "partial_amnesia",
      "reliability": "medium",
      "willingness": "reluctant"
    },
    {
      "npcId": "npc-harris",
      "knows": ["T1", "T2", "T3", "T4"],
      "distortion": "deliberate_suppression",
      "reliability": "high",
      "willingness": "hostile"
    },
    {
      "sceneId": "SCN_2_cellar",
      "containsEvidence": ["T1", "T3"],
      "evidenceType": "physical"
    },
    {
      "objectId": "SCN_2_office_item3",
      "containsEvidence": ["T1"],
      "evidenceType": "document"
    }
  ]
}
```

**Fields:**
- `npcId` / `sceneId` / `objectId` — direct reference, no abstract holders
- `knows` — which truth events this NPC knows about
- `distortion` — none | partial_amnesia | deliberate_suppression | misinterpretation
- `reliability` — high | medium | low | encoded
- `willingness` — cooperative | reluctant | hostile | terrified (how hard to extract info)
- `containsEvidence` — which truth events left traces here
- `evidenceType` — physical | document | environment | observation

**Key Difference from Old Pipeline:**
- No abstract `holderType: ROLE/PLACE/OBJECT` — direct ID references
- Added `willingness` field — how hard it is to get info from an NPC
- Phase 8 (World Update) uses these entries to apply concrete changes

---

### Phase 7d: Surface Layer (表面迷雾)

**Purpose:** What the world looks like on the surface — the "reasonable but wrong" explanations that exist. These are natural misunderstandings, not designed puzzles.

**Additional Input:** `truthEvents` + `knowledgeEntries` — Phase 7b+7c output

**Output:**
```json
{
  "surfaceBeliefs": [
    {
      "id": "SB1",
      "belief": "Dr. Harris is having a nervous breakdown from overwork",
      "sourceType": "MEDICAL_RECORD|MEDIA_RUMOR|OFFICIAL_REPORT|WITNESS_MISIDENTIFICATION|COINCIDENCE|COVER_UP",
      "origin": "Hospital board's official statement to concerned patients",
      "spreadBy": ["npc-nurse-jenny", "npc-mayor"],
      "contradictsEvents": ["T1", "T3"],
      "whyPlausible": "Harris has been working 80-hour weeks and his behavior matches burnout"
    }
  ]
}
```

**Design Notes:**
- `spreadBy` references real NPCs who propagate this belief
- Some beliefs are deliberate cover-ups, others are genuine misunderstandings
- Provides the "noise" that makes investigation challenging

---

### Phase 7e: End State (不干预的后果)

**Purpose:** What happens if investigators don't intervene — the escalation path and catastrophic outcome.

**Additional Input:** All Phase 7a-7d outputs

**Output:**
```json
{
  "endState": {
    "summary": "1-3 paragraphs describing the catastrophic outcome",
    "catastropheNature": "Type of disaster",
    "escalationPath": [
      { "time": "Day 2", "event": "Harris completes the ritual preparation" },
      { "time": "Day 3 midnight", "event": "The entity awakens" }
    ],
    "victoryConditions": [
      "Destroy the remains before the ritual can be completed",
      "Expose Harris to the authorities with evidence of his activities"
    ],
    "pointOfNoReturn": {
      "type": "time|condition",
      "trigger": "Day 3, midnight — the alignment completes"
    }
  }
}
```

---

## Phase 8: World Update (世界更新)

**Files:** New template + agent (split into 8a + 8b)

### Purpose

Take Phase 7's story outputs and apply all changes to the actual world data. Scenes get clues, NPCs get secrets, connections get blocked.

### Common Input

- `truthEvents` — Phase 7b output
- `knowledgeEntries` — Phase 7c output
- `surfaceBeliefs` — Phase 7d output
- `allScenes` — current scene data
- `npcs` — current NPC data
- `scenarios` — macro locations

---

### Phase 8a: Scene Updates

For each scene/object referenced in `knowledgeEntries` (where `containsEvidence` is set):
- Add `clues: ScenarioClue[]` — physical traces of events
- Update `conditions: ScenarioCondition[]` — changed atmosphere
- Update `items: SceneItem[]` — new objects or missing objects
- Apply connection changes from truth timeline — block/unblock paths

Clues are **natural traces**, not designed puzzles:
- A murder leaves blood, a missing person leaves belongings behind
- A cover-up leaves cleaning supplies, forged documents
- A ritual leaves candle wax, chalk marks, strange symbols

Each clue has: `clueText`, `category` (physical/document/environment/observation), `difficulty` (automatic/regular/hard/extreme), `discoveryMethod`, `reveals` (truth event IDs).

---

### Phase 8b: NPC Updates

For each NPC referenced in `knowledgeEntries` (where `knows` is set):
- Add `secrets` — what they know and hide (derived from `knows` + `distortion`)
- Add `goals` — what they're trying to do now (based on involvement)
- Update `personality` — trauma, paranoia, guilt may have changed them
- Add `inventory` — items related to their involvement
- Set `mythosAwareness` — derived from distortion/reliability:

| distortion | reliability | → mythosAwareness |
|---|---|---|
| none | high | knowing |
| none | medium/low | partial |
| partial_amnesia | any | partial |
| deliberate_suppression | any | distorted or partial |
| misinterpretation | any | distorted |
| (not in knowledgeEntries) | — | none |

- Add `knowledge` — what they can tell investigators (perspective, possibly distorted)
- Update `relationships` — events may have changed how NPCs feel about each other
- Inject `surfaceBeliefs` — NPCs in `spreadBy` lists carry those beliefs as things they'll tell investigators

### Design Notes

- Split into 8a + 8b for focused prompts and token control
- The agent validates: every `knowledgeEntry` is reflected in the world
- NPCs not in `knowledgeEntries` remain unchanged — just normal people

---

## Phase 9: Module Digest + Persistence

**Files:** `moduleDigestTemplate.ts`, `moduleDigestAgent.ts`, `persistence.ts`

### Input

- All accumulated world data from Phases 0-8

### Output

- `moduleDigest` — module metadata (now includes `moduleName`, generated here based on complete world + story)
- File system writes: scenes, NPCs, transport edges, module digest

### Changes

- `moduleName` generated here (not in Phase 0)
- P9-1: Clarify `timeRestriction` reference point

---

## Template Issues Summary (carried forward)

All issues from the original audit still apply. Organized by new phase:

| New Phase | Issues |
|-----------|--------|
| Phase 0 (World Seed) | P0-1~P0-5: bias/creativity/examples/supernatural assumption |
| Phase 1 (Macro Locations) | P1-1~P1-3: roads, SUPREME DIRECTIVE, ID namespace |
| Phase 2 (Transport Network) | P2-1~P2-4: outdoor scenes, connectivity, ID, road topology |
| Phase 3 (Sub-Scenes) | P3-1~P3-3: connectivity, mechanicalEffect, multi-entry |
| Phase 4 (Graph Assembly) | Multi-entry wiring code change |
| Phase 5 (NPC Generation) | New template (civilian NPCs, no story) |
| Phase 6 (Attributes) | No changes (pure code) |
| Phase 7a (Historical Backstory) | New template |
| Phase 7b (Truth Timeline) | Refactored — uses real NPC/scene IDs |
| Phase 7c (Knowledge Matrix) | Refactored — direct npcId/sceneId/objectId mapping |
| Phase 7d (Surface Layer) | New template (replaces Red Herrings) |
| Phase 7e (End State) | Refactored — grounded in real world |
| Phase 8a (Scene Updates) | New template (replaces Clue Placement) |
| Phase 8b (NPC Updates) | New template |
| Phase 9 (Module Digest) | moduleName moved here; fix time reference |

---

## Files Impact

### New Files

| File | Purpose |
|------|---------|
| `storyGenerationTemplate.ts` | Phase 7 templates (7a-7e sub-steps) |
| `storyGenerationAgent.ts` | Phase 7 agent (orchestrates 5 sub-steps) |
| `worldUpdateTemplate.ts` | Phase 8 templates (8a scenes + 8b NPCs) |
| `worldUpdateAgent.ts` | Phase 8 agent |

### Modified Files

| File | Changes |
|------|---------|
| `promptStructurizerTemplate.ts` | Merge with macroScene Step 1; fix P0-1~P0-5; output WorldSeed |
| `promptStructurizerAgent.ts` | Output new unified WorldSeed type |
| `scenarioBuilderTemplate.ts` | Fix P1-1~P1-3; mark deprecated functions |
| `sceneGraphBuilderTemplate.ts` | Fix P2-1~P2-4 |
| `subSceneBuilderTemplate.ts` | Fix P3-1~P3-3 |
| `npcBuilderTemplate.ts` | Rewrite for civilian NPC generation (Phase 5) |
| `npcBuilderAgent.ts` | Phase 5 basic generation + Phase 6 attributes |
| `subSceneBuilder.ts` | Add BFS validation; multi-entry support |
| `graphAssembly.ts` | Multi-entry wiring |
| `worldBuilderService.ts` | Complete pipeline reorder |
| `moduleDigestTemplate.ts` | Add moduleName generation; fix time reference |
| `types.ts` | Add WorldSeed type; refactor KnowledgeHolder → KnowledgeEntry (direct IDs); add StoryTimeline types |

### Deprecated/Removed

| File | Reason |
|------|--------|
| `macroSceneTemplate.ts` — truth timeline, knowledge matrix, red herrings, end state, historical mythos templates | Replaced by `storyGenerationTemplate.ts` (Phase 7) |
| `macroSceneAgent.ts` — `generateStoryInWorld()`, `generate()` | Replaced by `storyGenerationAgent.ts` |
| `cluePlacementTemplate.ts` | Absorbed into `worldUpdateTemplate.ts` (Phase 8a) |
| `cluePlacementAgent.ts` | Absorbed into `worldUpdateAgent.ts` |

**Note:** `macroSceneTemplate.ts` Step 1 (setting structure) and `macroSceneAgent.ts` `generateSettingSeed()` are partially absorbed into Phase 0 (World Seed). The Story Premise sub-step may be kept or removed.

### No Changes

| File | Reason |
|------|--------|
| `persistence.ts` | Data serialization unchanged |
| `worldModuleLoader.ts` | File I/O unchanged |
| `moduleSizeConfig.ts` | Size constants unchanged |
| `storyLengthConfig.ts` | Length configs unchanged |
| `skillAllocator.ts` | Pure code, logic unchanged |

---

## Out of Scope

- Multiplayer equivalents
- Frontend changes
- Database schema changes
- Starting scene selection (deprecated)
