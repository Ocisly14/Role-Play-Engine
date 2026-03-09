# Scene Condition & Transport Network Alignment Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align `ScenarioCondition.mechanicalEffect` with tick processor's `SceneCondition` structured format, create ROAD scene files for Cassandra module, and wire the loader to populate `state.scenarioConditions` at init.

**Architecture:** Unify the two condition systems (`ScenarioCondition` stored in JSON/DB and `SceneCondition` used by tick processor) by changing `mechanicalEffect` from free-text `string?` to structured `{ skillPenalty?, blocked? }`. Load initial scene conditions into `state.scenarioConditions` at game init so the tick processor can apply them. Create outdoor ROAD scenes and wire them into the scene graph via connections.

**Tech Stack:** TypeScript, Prisma, JSON scene files

---

## Reference: Structured mechanicalEffect Format

```typescript
// Target format (from npcPlanning/types.ts SceneCondition)
mechanicalEffect?: {
  skillPenalty?: Array<{ skill: string; delta: number }>;
  blocked?: boolean;
};
```

**Skill names** (CoC 7e English, matching character skills):
`Spot Hidden`, `Listen`, `Stealth`, `Library Use`, `Disguise`, `Dodge`, `Climb`, `Navigate`, `Survival`, `Track`, `Psychology`, `First Aid`, `Locksmith`, `Mechanical Repair`, `Electrical Repair`

**Attribute-as-skill**: `STR`, `CON`, `DEX`, `INT`, `POW`

**delta conventions**: negative = harder (e.g., `-20`), positive = easier (e.g., `+20`)

**When to omit `mechanicalEffect`**: If the condition is purely atmospheric/descriptive with no impact on skill rolls or access, omit the field entirely (don't set it to `null` or `{}`).

---

## Task 1: Unify ScenarioCondition Type

**Files:**
- Modify: `src/shared/agents/models/scenarioTypes.ts:50-57`

Change `mechanicalEffect` from `string?` to structured object matching tick processor:

```typescript
export interface ScenarioCondition {
  type: "weather" | "lighting" | "sound" | "smell" | "temperature" | "other";
  description: string;
  mechanicalEffect?: {
    skillPenalty?: Array<{ skill: string; delta: number }>;
    blocked?: boolean;
  };
}
```

**Step 1:** Edit `scenarioTypes.ts` — replace the `mechanicalEffect?: string;` line.

**Step 2:** Run `pnpm build` to find all type errors caused by this change. Fix each one:

Affected files (all currently treat `mechanicalEffect` as `string`):

| File | Line | Current | Fix |
|------|------|---------|-----|
| `src/shared/agents/memory/scenarioloader/scenarioLoader.ts` | 173 | `mechanicalEffect: c.mechanicalEffect \|\| undefined` | Parse from DB Json field: `mechanicalEffect: c.mechanicalEffect ? (typeof c.mechanicalEffect === 'string' ? undefined : c.mechanicalEffect as any) : undefined` |
| `src/dynamicworldagent/world_builder/persistence.ts` | 282 | `mechanicalEffect: condition.mechanicalEffect \|\| null` | Serialize to JSON: `mechanicalEffect: condition.mechanicalEffect ? JSON.stringify(condition.mechanicalEffect) : null` — BUT if Prisma stores as Json, just pass through |
| `src/dynamicworldagent/world_builder/worldModuleLoader.ts` | 1065 | `mechanicalEffect: condition.mechanicalEffect \|\| null` | Same as persistence |
| `src/dynamicworldagent/world_builder/subSceneBuilder.ts` | 142 | `mechanicalEffect: c.mechanicalEffect` | Pass through (already correct after type change) |
| `src/dynamicworldagent/state/DynamicGameStateLoader.ts` | 613 | `mechanicalEffect: cond.mechanicalEffect \|\| undefined` | Parse from DB: `mechanicalEffect: cond.mechanicalEffect ? (cond.mechanicalEffect as any) : undefined` |
| `src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameStateLoader.ts` | 231 | Same pattern | Same fix |

**Step 3:** Commit: `"refactor: unify ScenarioCondition.mechanicalEffect to structured format"`

---

## Task 2: Update Prisma Schema

**Files:**
- Modify: `prisma/schema.prisma` (ScenarioCondition model, ~line 450)

Change `mechanicalEffect` column from `String?` to `Json?`:

```prisma
model ScenarioCondition {
  conditionId      String   @id @map("condition_id")
  sceneId          String   @map("scene_id")
  conditionType    String   @map("condition_type")
  description      String
  mechanicalEffect Json?    @map("mechanical_effect")   // was String?
  createdAt        DateTime @default(now()) @map("created_at")
  moduleId         String   @map("module_id") @db.Uuid
  // ... relations unchanged
}
```

**Step 1:** Edit `prisma/schema.prisma`.

**Step 2:** Run `npx prisma db push` to apply (NOT `migrate dev` — schema drift with existing tables).

**Step 3:** Commit: `"schema: change mechanicalEffect from String to Json"`

---

## Task 3: Wire Loader to Populate state.scenarioConditions at Init

**Files:**
- Modify: `src/dynamicworldagent/state/DynamicGameStateLoader.ts` (in `initializeCompleteDynamicGameState`, after scenes are loaded)

After the scenes map is built (~line 649), add logic to populate `scenarioConditions` from `scene.conditions`:

```typescript
// After: scenesMap is built (line 649)
// Populate state.scenarioConditions from scene.conditions for tick processor
for (const [sceneId, scene] of scenesMap.entries()) {
  if (scene.conditions && scene.conditions.length > 0) {
    const sceneConditions = scene.conditions
      .filter(c => c.mechanicalEffect != null)
      .map(c => ({
        description: c.description,
        mechanicalEffect: c.mechanicalEffect,
      }));
    if (sceneConditions.length > 0) {
      completeState.scenarioConditions[sceneId] = sceneConditions;
    }
  }
}
```

Insert this block after line 762 (after `scenes: mergedScenes` is set on `completeState`) but before NPC initialization (line 766).

**Step 1:** Add the population loop.

**Step 2:** Run `pnpm build` to verify.

**Step 3:** Commit: `"feat: populate scenarioConditions from scene.conditions at init"`

---

## Task 4: Convert All Cassandra JSON Conditions to Structured Format

**Files:**
- Modify: All 50 files in `testmods/casssandra/Cassandra_Scenarios/SCN_*.json`

### Conversion Rules

**Replace `"mechanicalEffect": ""` → omit the field entirely.**

**Convert free-text to structured format where applicable:**

| Free Text Pattern | Structured Conversion |
|---|---|
| 侦查类技能检定受到不利影响 / 侦查检定难度增加 | `{ "skillPenalty": [{ "skill": "Spot Hidden", "delta": -20 }] }` |
| 侦查类技能难度大幅增加 | `{ "skillPenalty": [{ "skill": "Spot Hidden", "delta": -40 }] }` |
| 聆听检定难度增加 | `{ "skillPenalty": [{ "skill": "Listen", "delta": -20 }] }` |
| 潜行检定 / 保持安静 | `{ "skillPenalty": [{ "skill": "Stealth", "delta": -20 }] }` |
| 伪装类技能难度降低 | `{ "skillPenalty": [{ "skill": "Disguise", "delta": 20 }] }` |
| 图书馆使用或侦查检定可加速 | `{ "skillPenalty": [{ "skill": "Library Use", "delta": 20 }, { "skill": "Spot Hidden", "delta": 20 }] }` |
| 攀爬检定 | `{ "skillPenalty": [{ "skill": "Climb", "delta": -20 }] }` |
| 闪避检定 | `{ "skillPenalty": [{ "skill": "Dodge", "delta": -20 }] }` |
| 导航或求生检定 | `{ "skillPenalty": [{ "skill": "Navigate", "delta": -20 }, { "skill": "Survival", "delta": -20 }] }` |
| 潜入行为都可能被发现 | `{ "skillPenalty": [{ "skill": "Stealth", "delta": -30 }] }` |
| 需要照明工具才能有效调查 | `{ "skillPenalty": [{ "skill": "Spot Hidden", "delta": -40 }] }` |
| 无光源时所有视觉类检定自动失败 | `{ "skillPenalty": [{ "skill": "Spot Hidden", "delta": -80 }] }` |

**Move narrative/consequence effects into `description` only (omit mechanicalEffect):**
- "撬锁行为将自动触发监控报警" → descriptive only, omit mechanicalEffect
- "调查员必须保持安静...惊动修格斯...死亡" → keep skillPenalty for Stealth, consequence stays in description
- "初次进入时需要进行理智检定" → descriptive only (SAN checks are handled by agents, not tick processor)
- "独自前来时可能无法进入" → descriptive only (conditional access handled by agents)
- "长时间停留可能导致体质检定" → descriptive only (CON checks are event-driven)
- "可通过追踪技能检查" → descriptive only (positive hint, not a penalty)
- "聆听检定成功可提前察觉危险靠近" → descriptive only (bonus, not penalty)

### Complete File-by-File Changes

**Files with conditions to convert (non-empty mechanicalEffect):**

- `SCN_1_SUB_1`: lighting → omit; other(伪装) → `{ "skillPenalty": [{ "skill": "Disguise", "delta": 20 }] }`
- `SCN_2_SUB_1`: smell → omit; sound(潜行) → `{ "skillPenalty": [{ "skill": "Stealth", "delta": -20 }] }`; other(潜行) → `{ "skillPenalty": [{ "skill": "Stealth", "delta": -20 }] }`
- `SCN_2_SUB_2`: other(潜行+死亡) → `{ "skillPenalty": [{ "skill": "Stealth", "delta": -20 }] }`; sound(理智) → omit; smell → omit
- `SCN_2_SUB_3`: lighting(无光源) → `{ "skillPenalty": [{ "skill": "Spot Hidden", "delta": -80 }] }`; temperature → omit; other(理智) → omit
- `SCN_3_SUB_1`: lighting → omit; other(NPC名+后果) → **rewrite description to remove NPC name**, omit mechanicalEffect
- `SCN_3_SUB_2`: lighting → omit; other(监控报警) → omit mechanicalEffect (consequence-based)
- `SCN_3_SUB_3`: lighting → omit; other(图书馆使用) → `{ "skillPenalty": [{ "skill": "Library Use", "delta": 20 }, { "skill": "Spot Hidden", "delta": 20 }] }`
- `SCN_6_SUB_2`: other → omit; lighting(侦查) → `{ "skillPenalty": [{ "skill": "Spot Hidden", "delta": -20 }] }`
- `SCN_6_SUB_3`: other → omit; lighting(侦查) → `{ "skillPenalty": [{ "skill": "Spot Hidden", "delta": -20 }] }`
- `SCN_7_SUB_1`: smell → omit; lighting(无照明) → `{ "skillPenalty": [{ "skill": "Spot Hidden", "delta": -40 }] }`; other(闸门阻断) → `{ "blocked": true }`
- `SCN_7_SUB_2`: smell → omit; lighting(照明) → `{ "skillPenalty": [{ "skill": "Spot Hidden", "delta": -40 }] }`; other(碎片) → omit
- `SCN_11_SUB_1`: other(条件进入) → omit; lighting → omit; smell → omit
- `SCN_15_SUB_1`: lighting → omit; smell → omit; other(监控) → `{ "skillPenalty": [{ "skill": "Stealth", "delta": -30 }] }`
- `SCN_16_SUB_1`: lighting(侦查) → `{ "skillPenalty": [{ "skill": "Spot Hidden", "delta": -10 }] }`; sound → omit; smell → omit
- `SCN_16_SUB_2`: lighting(侦查) → `{ "skillPenalty": [{ "skill": "Spot Hidden", "delta": -20 }] }`; sound → omit
- `SCN_17_SUB_2`: other(攀爬) → `{ "skillPenalty": [{ "skill": "Climb", "delta": -20 }] }`; sound → omit; temperature → omit
- `SCN_17_SUB_3`: temperature(体质) → omit; lighting(照明) → `{ "skillPenalty": [{ "skill": "Spot Hidden", "delta": -40 }] }`; other(闪避) → `{ "skillPenalty": [{ "skill": "Dodge", "delta": -20 }] }`
- `SCN_17_SUB_4`: lighting → omit; smell → omit; sound(聆听) → `{ "skillPenalty": [{ "skill": "Listen", "delta": -20 }] }`
- `SCN_19_SUB_1`: weather → omit; lighting(侦查夜间) → `{ "skillPenalty": [{ "skill": "Spot Hidden", "delta": -20 }] }`; other → omit
- `SCN_20_SUB_1`: smell → omit; sound → omit; other(敏捷) → `{ "skillPenalty": [{ "skill": "DEX", "delta": -10 }] }`
- `SCN_20_SUB_2`: lighting(照明) → `{ "skillPenalty": [{ "skill": "Spot Hidden", "delta": -40 }] }`; smell → omit; other(追踪) → omit
- `SCN_20_SUB_3`: lighting(侦查大幅) → `{ "skillPenalty": [{ "skill": "Spot Hidden", "delta": -40 }] }`; other(导航求生) → `{ "skillPenalty": [{ "skill": "Navigate", "delta": -20 }, { "skill": "Survival", "delta": -20 }] }`; smell → omit; sound(聆听) → omit
- `SCN_21_SUB_2`: weather → omit; lighting(视野) → `{ "skillPenalty": [{ "skill": "Spot Hidden", "delta": -20 }] }`; other → omit
- `SCN_21_SUB_3`: lighting → omit; smell → omit; other(监视) → `{ "skillPenalty": [{ "skill": "Stealth", "delta": -30 }] }`

**Files with ALL empty mechanicalEffect (just remove the field):**
- `SCN_1_SUB_2`, `SCN_1_SUB_3`, `SCN_1_SUB_4`, `SCN_1_SUB_5`, `SCN_1_SUB_6`
- `SCN_4_SUB_1`, `SCN_4_SUB_2`, `SCN_4_SUB_3`, `SCN_4_SUB_4`
- `SCN_5_SUB_1`, `SCN_6_SUB_1`, `SCN_8_SUB_1`
- `SCN_9_SUB_1`, `SCN_9_SUB_2`, `SCN_9_SUB_3`
- `SCN_10_SUB_1`, `SCN_12_SUB_1`
- `SCN_13_SUB_1`, `SCN_13_SUB_2`, `SCN_13_SUB_3`
- `SCN_14_SUB_1`, `SCN_14_SUB_2`, `SCN_15_SUB_2`
- `SCN_17_SUB_1`, `SCN_18_SUB_1`
- `SCN_21_SUB_1`

**Step 1:** Update all files with non-empty mechanicalEffect to structured format.

**Step 2:** Remove `"mechanicalEffect": ""` from all files that have only empty values.

**Step 3:** Commit: `"data: convert Cassandra conditions to structured mechanicalEffect format"`

---

## Task 5: Create 10 ROAD Scene Files

**Files:**
- Create: `testmods/casssandra/Cassandra_Scenarios/ROAD_1.json` through `ROAD_10.json`

Each ROAD file is a `DynamicScene` with:
- `id`: "ROAD_X"
- `name`: Chinese street name
- `description`: Atmospheric outdoor description (sensory, no NPC names)
- `parentLocationId`: "ROAD_X"
- `items`: `[]`
- `clues`: `[]`
- `conditions`: Outdoor conditions with structured mechanicalEffect where applicable
- `connections`: Entry scene IDs of locations on this road + connected ROAD IDs at intersections
- `events`: `[]`

### Connection Map (from extraction plan topology)

| ROAD | Entry Scenes | Connected ROADs (via intersections) |
|------|-------------|-------------------------------------|
| ROAD_1 | SCN_1_SUB_1, SCN_2_SUB_1 | ROAD_2, ROAD_5 (intersection A) |
| ROAD_2 | SCN_9_SUB_1, SCN_10_SUB_1, SCN_11_SUB_1 | ROAD_1 (A), ROAD_3, ROAD_4 (B) |
| ROAD_3 | SCN_16_SUB_1, SCN_17_SUB_1, SCN_18_SUB_1 | ROAD_2 (B), ROAD_5, ROAD_6 (C) |
| ROAD_4 | SCN_12_SUB_1, SCN_13_SUB_1, SCN_14_SUB_1, SCN_21_SUB_1 | ROAD_2 (B) |
| ROAD_5 | SCN_15_SUB_1 | ROAD_1 (A), ROAD_3, ROAD_6 (C), ROAD_10 (D) |
| ROAD_6 | SCN_4_SUB_1, SCN_5_SUB_1 | ROAD_3, ROAD_5 (C), ROAD_7, ROAD_8, ROAD_9 (E) |
| ROAD_7 | SCN_3_SUB_1 | ROAD_6 (E) |
| ROAD_8 | SCN_6_SUB_1, SCN_7_SUB_1 | ROAD_6 (E) |
| ROAD_9 | SCN_8_SUB_1 | ROAD_6 (E) |
| ROAD_10 | SCN_19_SUB_1, SCN_20_SUB_1 | ROAD_5 (D) |

### ROAD Conditions Template

All outdoor scenes share a base condition set:
```json
{
  "type": "weather",
  "description": "十二月末的加州小镇，天空阴沉，冷风阵阵。"
}
```

Night lighting penalty for roads with poor lighting:
```json
{
  "type": "lighting",
  "description": "路灯间距较大，夜间存在光线盲区。",
  "mechanicalEffect": { "skillPenalty": [{ "skill": "Spot Hidden", "delta": -10 }] }
}
```

**Step 1:** Create all 10 ROAD JSON files.

**Step 2:** Verify each file is valid JSON and matches DynamicScene schema.

**Step 3:** Commit: `"data: add 10 ROAD outdoor scene files for Cassandra"`

---

## Task 6: Update 21 Entry Scenes with ROAD Connections

**Files:**
- Modify: All 21 `SCN_X_SUB_1.json` files

Add the appropriate ROAD ID to each entry scene's `connections` array.

| Entry Scene | Add ROAD |
|-------------|----------|
| SCN_1_SUB_1 | ROAD_1 |
| SCN_2_SUB_1 | ROAD_1 |
| SCN_3_SUB_1 | ROAD_7 |
| SCN_4_SUB_1 | ROAD_6 |
| SCN_5_SUB_1 | ROAD_6 |
| SCN_6_SUB_1 | ROAD_8 |
| SCN_7_SUB_1 | ROAD_8 |
| SCN_8_SUB_1 | ROAD_9 |
| SCN_9_SUB_1 | ROAD_2 |
| SCN_10_SUB_1 | ROAD_2 |
| SCN_11_SUB_1 | ROAD_2 |
| SCN_12_SUB_1 | ROAD_4 |
| SCN_13_SUB_1 | ROAD_4 |
| SCN_14_SUB_1 | ROAD_4 |
| SCN_15_SUB_1 | ROAD_5 |
| SCN_16_SUB_1 | ROAD_3 |
| SCN_17_SUB_1 | ROAD_3 |
| SCN_18_SUB_1 | ROAD_3 |
| SCN_19_SUB_1 | ROAD_10 |
| SCN_20_SUB_1 | ROAD_10 |
| SCN_21_SUB_1 | ROAD_4 |

Note: Some entry scenes currently have `"connections": []` (SCN_5, SCN_8, SCN_10, SCN_11, SCN_12, SCN_18, SCN_19). After this change they will have `["ROAD_X"]`.

**Step 1:** Edit each entry scene's `connections` array to include its ROAD ID.

**Step 2:** Verify bidirectional connectivity: every ROAD's connections includes the entry scene, and every entry scene's connections includes the ROAD.

**Step 3:** Commit: `"data: connect entry scenes to ROAD scenes for Cassandra"`

---

## Task 7: Fix Content Issues in Conditions

**Files:**
- Modify: `testmods/casssandra/Cassandra_Scenarios/SCN_3_SUB_1.json`

The `other` condition currently contains NPC name "Patrizio von Samsa" and "Lux Lynch" in the description. Rewrite to describe observable environment without naming NPCs:

```json
{
  "type": "other",
  "description": "警察局表面平静，但工作人员之间存在明显的等级关系和警惕气氛。在此引起冲突可能招致意想不到的后果。"
}
```

**Step 1:** Edit the condition.

**Step 2:** Commit: `"data: remove NPC names from SCN_3_SUB_1 conditions"`

---

## Task 8: Update scenarios_outline.json subSceneCount

**Files:**
- Modify: `testmods/casssandra/scenarios_outline.json`

Some `subSceneCount` values don't match the actual number of scene files. Update to match reality:

| Scenario | Current subSceneCount | Actual File Count | Fix |
|----------|----------------------|-------------------|-----|
| SCN_1 | 6 | 6 | OK |
| SCN_4 | 4 | 4 | OK |
| SCN_6 | 3 | 3 | OK |
| SCN_9 | 3 | 3 | OK |
| SCN_13 | 3 | 3 | OK |
| SCN_14 | 2 | 2 | OK |
| SCN_15 | 2 | 2 | OK |

(Cross-check all 21 — some in extraction plan show different counts from what was generated.)

**Step 1:** Count actual scene files per SCN_X and verify `subSceneCount` matches. Fix any discrepancies.

**Step 2:** Commit: `"data: fix scenarios_outline.json subSceneCount values"`

---

## Task 9: Build Verification

**Step 1:** Run `pnpm build` — verify zero TypeScript errors.

**Step 2:** Run `pnpm check` — verify formatting/linting passes.

**Step 3:** Validate all JSON files are parseable: `node -e "const fs=require('fs');const dir='testmods/casssandra/Cassandra_Scenarios';fs.readdirSync(dir).filter(f=>f.endsWith('.json')).forEach(f=>{JSON.parse(fs.readFileSync(dir+'/'+f,'utf8'));console.log('OK:',f)})"`

**Step 4:** Commit: `"chore: verify build after scene condition alignment"`
