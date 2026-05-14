# Item Schema Extension & Asset/Item Library Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `Item` interface with type/weaponStats/consumableStats/containerStats fields, and populate `Asset/Item/` with categorized functional item templates including all ~90 weapons from seedData.ts.

**Architecture:** Extend the existing `Item` interface in `world_builder/types.ts` with optional nested stat objects. Create 7 JSON files in `Asset/Item/` organized by category. Migrate existing seedData weapon entries into `weapons.json` with proper Item format.

**Tech Stack:** TypeScript, JSON, Vitest

**Spec:** `docs/plans/2026-03-10-item-schema-asset-library-design.md`

---

## File Structure

### Modified files
| File | Change |
|---|---|
| `src/dynamicworldagent/world_builder/types.ts:96-108` | Extend `Item` interface with `type`, `weaponStats`, `consumableStats`, `containerStats` |

### New files
| File | Responsibility |
|---|---|
| `Asset/Item/weapons.json` | All weapon templates (~90 migrated from seedData + descriptions) |
| `Asset/Item/consumables.json` | Medical, ammo, chemical, food consumable templates |
| `Asset/Item/lighting.json` | Light source templates (candle, flashlight, lantern, etc.) |
| `Asset/Item/tools.json` | Functional tool templates (lockpick, rope, camera, etc.) |
| `Asset/Item/containers.json` | Storage container templates (safe, box, drawer, etc.) |
| `Asset/Item/documents.json` | Document templates (map, notebook, newspaper, etc.) |
| `Asset/Item/keys.json` | Key/access templates (key, ID card, pass, etc.) |

---

## Chunk 1: Schema Extension

### Task 1: Extend Item interface

**Files:**
- Modify: `src/dynamicworldagent/world_builder/types.ts:96-108`

- [ ] **Step 1: Add WeaponStats, ConsumableStats, ContainerStats interfaces and extend Item**

In `src/dynamicworldagent/world_builder/types.ts`, replace the existing `Item` interface (lines 96-108) with:

```typescript
export interface WeaponStats {
  skill: string;
  damage: string;
  range: string;
  attacksPerRound: number;
  ammo?: number;
  malfunction?: number;
  era?: string;
}

export interface ConsumableStats {
  uses?: number;
  effect?: string;
  duration?: number;
}

export interface ContainerStats {
  capacity?: number;
  locked?: boolean;
  lockDifficulty?: "easy" | "regular" | "hard" | "extreme";
  contents?: string[];
}

export interface Item {
  id: string;
  name: string;
  description?: string;
  type?: "weapon" | "consumable" | "tool" | "lighting" | "container" | "key" | "document" | "other";
  damaged?: boolean;
  damageDetails?: {
    damagedBy: string;
    damagedAt: string;
    reason: string;
  };
  isLightSource?: boolean;
  lightLevel?: number;
  weaponStats?: WeaponStats;
  consumableStats?: ConsumableStats;
  containerStats?: ContainerStats;
}
```

Note: `type` is optional to maintain backward compatibility with existing scene items that don't have it.

- [ ] **Step 2: Verify build passes**

Run: `pnpm build`
Expected: Success (all existing Item usage is compatible — new fields are optional)

---

## Chunk 2: Weapon Data Migration

### Task 2: Create weapons.json

**Files:**
- Create: `Asset/Item/weapons.json`

Migrate all ~90 weapons from `src/shared/agents/memory/database/seedData.ts` (lines 370-1003) into Item format.

- [ ] **Step 1: Create weapons.json with all weapons from seedData**

Field mapping from seedData array `[name, skill, damage, range, attacksPerRound, ammo, malfunction, era]`:
- `id`: Generate as `WPN_` + category prefix + normalized name (e.g., `WPN_MELEE_UNARMED`, `WPN_HANDGUN_COLT_1911`)
- `name`: From seedData[0]
- `description`: Add brief Chinese description for each weapon
- `type`: `"weapon"`
- `weaponStats.skill`: From seedData[1]
- `weaponStats.damage`: From seedData[2]
- `weaponStats.range`: From seedData[3]
- `weaponStats.attacksPerRound`: From seedData[4]
- `weaponStats.ammo`: From seedData[5] (null → omit)
- `weaponStats.malfunction`: From seedData[6] (null → omit)
- `weaponStats.era`: From seedData[7]

Categories for ID prefix:
- `MELEE_`: Brawling/Axe/Sword/Spear/Whip skill weapons with range "touch"
- `HANDGUN_`: Pistol skill firearms
- `RIFLE_`: Rifle skill weapons (bolt/semi-auto/lever)
- `SHOTGUN_`: Rifle skill shotguns (damage format contains `/`)
- `ASSAULT_`: Assault rifles (Rifle skill, attacksPerRound > 1, modern)
- `SMG_`: Submachine Gun skill weapons
- `MG_`: Machine Gun skill weapons
- `THROWN_`: Throw skill weapons
- `EXPLOSIVE_`: Demolitions/Heavy Weapon/placed range weapons

The complete file should contain all ~90 weapons from seedData organized by these categories.

- [ ] **Step 2: Validate JSON**

Run: `python3 -c "import json; data=json.load(open('Asset/Item/weapons.json')); print(f'{len(data)} weapons loaded')"`
Expected: ~90 weapons loaded, no JSON parse errors

---

## Chunk 3: Non-weapon Item Files

### Task 3: Create consumables.json

**Files:**
- Create: `Asset/Item/consumables.json`

- [ ] **Step 1: Create consumables.json**

Include functional consumable items relevant to CoC 7e investigation gameplay:

**Medical (~8 items):** First aid kit, bandages, morphine/painkillers, antidote, smelling salts, surgical kit, blood transfusion kit, herbal remedy
**Ammunition (~6 items):** Pistol ammo box, rifle ammo box, shotgun shells box, arrow quiver, crossbow bolts, flare rounds
**Chemical (~5 items):** Chloroform, acid vial, flash powder, smoke bomb, holy water
**Food/Drink (~4 items):** Field rations, water canteen, whiskey flask, coffee thermos

Each item uses the Item schema with `type: "consumable"` and `consumableStats`.

### Task 4: Create lighting.json

**Files:**
- Create: `Asset/Item/lighting.json`

- [ ] **Step 1: Create lighting.json**

Include light source items (~8 items): Candle, match box, lighter, oil lamp, flashlight, torch, lantern, flare

Each item uses `type: "lighting"`, `isLightSource: true`, `lightLevel` (1-5 scale), and optionally `consumableStats` for duration/uses.

### Task 5: Create tools.json

**Files:**
- Create: `Asset/Item/tools.json`

- [ ] **Step 1: Create tools.json**

Include functional tool items (~12 items): Lockpick set, rope (10m), crowbar, shovel, binoculars, camera, tape recorder, magnifying glass, compass, grappling hook, wire cutters, toolkit

Each item uses `type: "tool"`.

### Task 6: Create containers.json

**Files:**
- Create: `Asset/Item/containers.json`

- [ ] **Step 1: Create containers.json**

Include container items (~10 items): Small safe, large safe, wooden crate, suitcase, backpack, desk drawer, filing cabinet, lockbox, chest, envelope

Each item uses `type: "container"` and `containerStats` (capacity, locked, lockDifficulty).

### Task 7: Create documents.json

**Files:**
- Create: `Asset/Item/documents.json`

- [ ] **Step 1: Create documents.json**

Include document items (~8 items): Newspaper, notebook, map, letter, diary, passport, photograph, blueprint

Each item uses `type: "document"`.

### Task 8: Create keys.json

**Files:**
- Create: `Asset/Item/keys.json`

- [ ] **Step 1: Create keys.json**

Include key/access items (~6 items): Metal key, master key, ID card, access pass, combination note, skeleton key

Each item uses `type: "key"`.

---

## Chunk 4: Verification

### Task 9: Validate all JSON files and build

- [ ] **Step 1: Validate all JSON files parse correctly**

Run: `for f in Asset/Item/*.json; do python3 -c "import json; data=json.load(open('$f')); print(f'{f}: {len(data)} items')" ; done`
Expected: All files load without errors, item counts printed

- [ ] **Step 2: Verify build still passes**

Run: `pnpm build`
Expected: Success

- [ ] **Step 3: Commit all changes**

```bash
git add src/dynamicworldagent/world_builder/types.ts Asset/Item/
git commit -m "feat(items): extend Item schema and create Asset/Item template library"
```
