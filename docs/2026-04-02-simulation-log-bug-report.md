# Simulation Log Bug Report

**Date**: 2026-04-02
**Source**: `data/log/` — Day 1 (19:00) ~ Day 2 (~08:40) full simulation run, 29 NPCs
**Status**: Initial triage complete

---

## CRITICAL — Engine / System Bugs

### 1. Massive Node Duplication in Plan Arrays

**Severity**: CRITICAL
**Affected**: ALL NPCs
**Location**: `tickProcessor.ts` / revision pipeline → `NpcDailyPlan.nodes` persistence

Each time a replan/revision cycle occurs, all existing nodes (including already completed/failed ones) are re-appended to the `nodes` array instead of being updated in place.

| NPC | Total Nodes | Unique | Duplication Rate | Worst Offender |
|-----|-------------|--------|------------------|----------------|
| Martin Gin | 497 | 70 | **85.9%** | `m1` movement duplicated **166 times** |
| Lux Lynch | 91 | 35 | **62%** | `m1` duplicated ~20 times |
| Patrizio | severe | — | — | `m1` duplicated 8+ times, `ci1` 5 times |
| Harrison | severe | — | — | `ci1` duplicated 7 times |
| Tallinn | severe | — | — | `a2` duplicated 7+ times |
| Solomon | moderate | — | — | `si2` 3 times, `m1` 3 times |
| Angela | moderate | — | — | `m1` 7+ times |
| Ben Cleo | moderate | — | — | `ci1` 3 times, `m1` 3 times |

**Root Cause**: Node write logic uses append instead of upsert-by-nodeId.

**Fix**: When persisting nodes to `NpcDailyPlan`, merge by `nodeId` — update existing entries rather than pushing duplicates.

---

### 2. Pathfinding Failure — Infinite Retry Loop

**Severity**: CRITICAL
**Affected**: Martin Gin, Lux Lynch, Ben Cleo, Haran Greenwood, Angela

When an NPC's movement fails due to `[拓扑中无可用路径]` (no available topology path), the planning agent immediately generates the same movement node again. This creates an infinite loop of identical failures with no backoff or circuit breaker.

| NPC | Destination | Failures | Duration |
|-----|-------------|----------|----------|
| Martin Gin | SCN_6_SUB_1 (2nd floor cabin) | **45 consecutive** (0% success) | Entire 2-day simulation |
| Lux Lynch | JUNC_8 (police station exterior) | 11 unique attempts | ~4 hours |
| Haran Greenwood | JUNC_7 (train station) | 4+ attempts | Spans Day 1 and Day 2 |
| Ben Cleo | JUNC_7 (train station) | 3+ attempts | — |

Notable: Haran chained the door to JUNC_7 shut himself at 19:50, then his own subsequent movement nodes to JUNC_7 keep failing — and Day 2's first node still tries the same destination.

**Root Cause**: No failure counter or destination blacklist in the planning pipeline.

**Fix**: Track consecutive movement failures per destination. After N failures (e.g., 2-3), mark the destination as temporarily unreachable and inject this into the planning context so the LLM generates an alternative plan.

---

### 3. Encounter → "Target Not Present" Contradiction

**Severity**: CRITICAL
**Affected**: Harrison, Patrizio, Angela, Solomon

The engine generates `__encounter__` witness records saying "I encountered X here at this location", but the immediately following `character_interaction` node targeting X fails with `[target X not present]`. The NPC sees a character but cannot interact with them.

| NPC | Location | Occurrences |
|-----|----------|-------------|
| Harrison Lockheed | ROAD_2 | **15+ consecutive** target-not-present after encounters |
| Patrizio | SCN_16_SUB_1 / ROAD_3 | Multiple encounters then interaction failures |
| Angela | ROAD_2 | Repeated across Day 1 evening |
| Solomon | ROAD_2 | Repeated across Day 1 evening |

**Root Cause**: The `encounter` detection and the `character_interaction` handler use different co-location criteria. On ROAD-type locations, NPCs may have different `position` values (e.g., 0.1 vs 0.5) — encounter triggers at a broader range than the strict co-location check in `arePositionsCoLocated()`.

**Fix**: Unify the co-location logic between encounter detection and interaction validation, or widen the interaction co-location threshold for road segments.

---

### 4. Replan Death Spiral (Encounter-Interrupt Feedback Loop)

**Severity**: CRITICAL
**Affected**: Angela, Solomon, Harrison, Patrizio, Tallinn

When multiple NPCs are in the same area, the following loop occurs:
1. NPC starts an action
2. Another NPC passes by → encounter event triggers
3. Impact gate fires → `shouldInterruptCurrentNode: true`
4. Current action is interrupted (`revise_replan`)
5. New plan generated → NPC starts a new action
6. Another NPC passes by → back to step 2

No action ever completes. NPCs are trapped for hours.

| NPC | Duration | Location |
|-----|----------|----------|
| Tallinn | **~7 hours** (01:52-08:34) | Paladriel Hotel |
| Patrizio | ~2.5 hours (00:57-03:35) | Reindeer Bar |
| Angela | ~2 hours (19:55-21:57) | ROAD_2 |
| Solomon | ~2 hours (19:42-21:33) | ROAD_2 |
| Harrison | ~1.5 hours (20:01-21:27) | ROAD_2 |

**Root Cause**: The impact gate's `shouldInterruptCurrentNode` is too sensitive to encounter events. Seeing someone walk by does not warrant interrupting the current action.

**Fix**: Add dampening rules to the impact gate:
- Casual encounters (co-presence) should not trigger `shouldInterruptCurrentNode` unless the encountered character is directly relevant to the current action
- Add a cooldown period — if the same NPC was encountered within the last N minutes, suppress the interrupt
- Consider making `shouldInterruptCurrentNode` default to `false` for encounter-only events

---

### 5. Character ID Inconsistency — Ghost Entities

**Severity**: CRITICAL
**Affected**: System-wide (evidenced by `npc_*` phantom files)

The LLM-generated `targetCharacterIds` sometimes use `"npc_haran_greenwood"` format and sometimes `"Haran Greenwood"` display name format. When the ID doesn't match the actual NPC roster:
- Co-location check fails (the phantom ID has no position)
- The real target NPC never receives the interaction
- A phantom memory file is created under the wrong ID

**Evidence** — phantom files in `data/log/`:
- `npc_haran_greenwood.json` (497B) vs `Haran_Greenwood.json` (29KB)
- `npc_bruno_galilei.json` (2KB) vs `Bruno_Galilei.json` (46KB)
- `npc_lux_lynch.json` (1.2KB) vs `Lux_Lynch.json` (128KB)
- `npc_vito.json` (3.3KB) vs `Vito.json` (44KB)
- `Simon.json` (3KB phantom) vs `Simon_Laplace__Simon_.json` (188KB)
- `simon_laplace.json` (461B phantom)
- Plus 10+ other `npc_*` phantom files

In `Ben_Cleo.json`, the same plan uses both `"npc_haran_greenwood"` and `"Haran Greenwood"` as target IDs in adjacent nodes.

**Root Cause**: Plan node parsing does not normalize or validate character IDs against the NPC roster.

**Fix**: After LLM generates plan nodes, validate all `targetCharacterIds` and `characterId` fields against the known NPC roster. Fuzzy-match or alias-map `npc_xxx` prefixed IDs to their canonical forms.

---

### 6. In-Progress Nodes Never Resolved at Day Boundary

**Severity**: HIGH
**Affected**: ALL NPCs with activity near midnight
**Status**: Fix designed, not yet implemented

When the game day transitions (23:59 → 00:00), any node with `status: "in_progress"` on the old day is abandoned. The new day's plan query uses `{ sessionId, gameDay: newDay }` and never fetches the old day's orphaned nodes.

**Evidence**: Bruno (`ci_bruno_vito_01`), Lux (3x `ci1`), Angela (`m` to JUNC_11), Johnny (`ci1`, `ci2`), Tallinn (`a2`), Harrison (`m1`, `ci_harrison_0216_01`), Patrizio (`m1`, `ci1`).

**Fix**: In `onNewDay()`, query previous day's plan for `in_progress` nodes and mark them as `interrupted` with reason `day_transition`.

---

## HIGH — Data / Logic Bugs

### 7. Non-Standard itemId Values

**Severity**: HIGH
**Affected**: ALL active NPCs

The LLM generates `objectInteractionPayload.itemId` as free-text Chinese strings instead of the standard `ITEM_SCN[X]_[N]` format. This causes item-not-found errors when the engine tries to look up the item.

| Chinese itemId | Standard Format | NPC | Consequence |
|---------------|-----------------|-----|-------------|
| `"街头挎包"` | ? | Angela | — |
| `"street_crossbody_bag"` | ? | Angela | **item not found error** |
| `"毒品样品"` | ? | Angela | — |
| `"《黄衣之王》"` | ? | Solomon | — |
| `"神秘学书籍"` | ? | Solomon | — |
| `"花哨的衣服"` | ? | Tallinn | — |
| `"赌场联系簿"` | ? | Tallinn | — |
| `"猎枪"` | ? | Johnny, Patrizio | — |
| `"非法枪支库存"` | ? | Harrison | — |
| `"案件证据包"` | ? | Bruno | — |

The English snake_case `"street_crossbody_bag"` is particularly problematic — it matches neither the Chinese name nor the `ITEM_*` pattern, causing an actual runtime failure.

**Root Cause**: The planning LLM does not always reference canonical item IDs from the scene/inventory data.

**Fix**: After LLM generates a plan node, validate `objectInteractionPayload.itemId` against known scene items and NPC inventory. If no match, attempt fuzzy matching by item name.

---

### 8. Relationship Score Anomalies

**Severity**: HIGH

#### 8a. Cross-Day Score Jumps (No Corresponding Events)

| NPC | Relationship | Day 1 End | Day 2 Start | Unexplained Delta |
|-----|-------------|-----------|-------------|-------------------|
| Lux → Bruno | | 21 | -4 | **-25** |
| Lux → Vito | | 11 | 6 | **-5** |

#### 8b. Score Increase on Failed Interactions

Harrison → Angela: relationship increases by `+2 → 7` after a **failed** Persuade roll (rolled 76 vs 40). Failed social interactions should not improve relationships.

#### 8c. Disproportionate Drops

- Johnny → Nancy: `-5` for simply asking "Where is Helen?" — disproportionate
- Patrizio → Shandra: `-10` on first interaction — excessively steep

---

### 9. Abnormal Skill Values (STR 1, Locksmith 1)

**Severity**: HIGH
**Affected**: Martin Gin, Patrizio von Samsa

| NPC | Skill | Value | Normal Range | Consequence |
|-----|-------|-------|-------------|-------------|
| Martin Gin | STR | 1 | 15-90 | All 6 STR rolls auto-fail |
| Patrizio | STR | 1 | 15-90 | Physical actions impossible |
| Patrizio | Locksmith | 1 | 1-99 | Cannot pick any lock |

In CoC 7e, regular difficulty requires rolling at or under the skill value on d100. With STR 1, only rolling exactly 1 succeeds (1% chance). This is almost certainly a module data error.

---

### 10. Key/Item Possession State Chaos (Patrizio Bar Scene)

**Severity**: HIGH
**Affected**: Patrizio, Kovind, Lutz, Johnny — SCN_16_SUB_1 (Reindeer Bar), Day 2

The storage cabinet key changes hands in a physically contradictory sequence:
1. 01:06 — Patrizio orders Lutz to give him the key. Lutz complies.
2. 01:38 — Lutz locks cabinet, puts key in **his** pocket (contradicts #1).
3. 01:40 — Kovind snatches key from Lutz.
4. 01:43 — Patrizio snatches key back from Kovind.
5. 01:44 — Kovind takes gun out with "his stored key" (but Patrizio just took it).
6. 02:02 — Patrizio gives key to Kovind under duress.
7. 02:04 — Patrizio commands and they give key back to him.
8. 02:04 — Witness: Kovind uses key to take gun out (contradicts #7).
9. 03:18 — Patrizio gives key to Johnny.
10. 03:23 — Patrizio steals key back from Johnny.
11. 03:29 — Patrizio steals key back from Johnny **again**.

**Root Cause**: Multiple NPCs interact with the same item in rapid succession. Each NPC's state resolver runs independently without awareness of concurrent item transfers. The item ownership tracking does not enforce single-owner consistency across overlapping ticks.

---

## MEDIUM — Behavioral / Narrative Issues

### 11. Repetitive Behavior Loops

**Severity**: MEDIUM
**Affected**: Multiple NPCs

When the planning agent has no viable alternative actions (e.g., movement blocked, no new characters to interact with), it generates nearly identical actions in a loop.

| NPC | Repetitive Action | Count | Duration |
|-----|-------------------|-------|----------|
| Martin Gin | Check stairway safety | **41 times** | ~8 hours |
| Solomon | Observe intersection from window | 10+ times | ~5.5 hours |
| Lux Lynch | Review CCTV footage | 10 times | ~2 hours |
| Tallinn | Wait for Cold Spider (same loop) | 15+ times | ~7 hours |
| Johnny | Ask Lutz about storage card | 8+ times | ~3 hours (relationship: +10 → -7) |

**Root Cause**: The planning LLM prompt includes "What Happened Today So Far" but does not explicitly penalize repeating identical actions. The LLM also has no concept of futility.

**Fix**: Inject a recent action summary into the planning prompt with an explicit instruction: "Do not repeat the same action if it has already been completed or attempted multiple times with the same result."

---

### 12. Day 2 Plans Start at Midnight

**Severity**: MEDIUM
**Affected**: ALL NPCs

All Day 2 plans are generated at 00:00 and begin executing immediately, even though plan content describes daytime activities ("白天到五金店", "午餐", "傍晚返回教堂"). NPCs perform daytime activities at 2-3 AM.

**Root Cause**: `onNewDay()` triggers at the day boundary (midnight) and immediately generates a new schedule, which the tick processor starts executing right away.

**Fix**: Consider NPC's current state when generating new day plans. If it's midnight, the first plan entry should be rest/sleep unless the NPC has an urgent reason to be awake.

---

### 13. Time Overlap Between Concurrent Nodes

**Severity**: MEDIUM
**Affected**: Lux Lynch, Martin Gin, Harrison, Patrizio, Angela

Multiple nodes have overlapping time ranges, meaning the NPC is doing two things simultaneously.

Examples from Lux Lynch Day 1:
- `19:59-20:02` overlaps with `20:00-20:03`
- `23:26-23:34` overlaps with `23:27-23:32` overlaps with `23:28-23:30` (three nodes at once)

Examples from Martin Gin Day 2:
- `08:02-08:12`, `08:08-08:25`, `08:09-08:32`, `08:15-08:20`, `08:16-08:34` (massive overlap cluster)

**Root Cause**: New nodes are generated and started before the previous node's endTime is reached, likely during interrupt/replan cycles.

---

### 14. Actions After Going to Sleep

**Severity**: MEDIUM
**Affected**: Solomon

Solomon completes "闭目冥想十分钟...然后就寝" (meditate and go to sleep) at 23:36, but then performs 30 minutes of additional activities:
- 23:37: Check wax seal on curtain
- 23:40: Check wax seal again
- 23:44: Move book under sofa
- 23:55: Observe street from behind curtain
- 23:59: Still observing

**Root Cause**: No "sleeping" state that prevents further action generation.

---

### 15. Patrizio Reveals Core Secrets to Hostile NPC

**Severity**: MEDIUM (Narrative quality)
**Affected**: Patrizio

At 03:18, Patrizio tells Johnny: "嵌墙保险箱里只剩下加塔诺托亚的诅咒画像与梦王会的仪式手稿" — voluntarily revealing the existence and location of his most critical occult artifacts to a hostile character. This fundamentally contradicts his character profile as the most secretive NPC in the scenario.

**Root Cause**: The character interaction state resolver does not weight secret-level knowledge against character personality when generating dialogue. The `difficulty: "extreme"` gate on secrets may have been bypassed.

---

## LOW — Minor Issues

### 16. Movement Failure Messages in English (Not i18n)

**Affected**: Lux Lynch, Martin Gin

Hardcoded engine message: `"I tried to move to JUNC_8 but the path was blocked."` appears in English while all other content is Chinese. This string is not passed through the i18n system.

**Location**: `interactionStateResolver.ts:675` (the `applyCharacterDelta` movement-blocked fallback memory)

---

### 17. Chinese Name Transliteration Inconsistency

**Affected**: Lux Lynch, Kovind, Constantine

The same character is referred to by different Chinese transliterations in LLM-generated text:

| English Name | Variants |
|-------------|----------|
| Lux Lynch | 卢克斯 / 勒克斯 / 鲁克斯 |
| Kovind | 科文德 / 柯文德 |
| Constantine | 康斯坦丁 / Constantine (mixed) |

---

### 18. Gender Pronoun Inconsistency

**Affected**: Lux Lynch

Lux is referred to as 她 (she) in one witness memory (Day 1, 19:15) but as 他 (he) in all other contexts.

---

### 19. Intent Language Mismatch

**Affected**: Solomon

Solomon's `intents` field is in English while all memories, plans, and actions are in Chinese:
> "Prioritize immediate concealment and defensive measures: avoid any contact with Simon..."

---

### 20. Failed Scene Interactions with Empty Outcomes

**Affected**: Martin Gin, Day 2

Two `scene_interaction` nodes have `status: "failed"` with completely empty `outcome` fields:
- `si_day2_0627_1` (06:27-06:37): outcome is `""`
- `si_d2_0723` (07:23-07:33): outcome is `""`

---

### 21. NodeId Contains Colons

**Affected**: Martin Gin

Two nodeIds contain colons which could cause parsing issues:
- `m1_day1_23:40`
- `m1_05:51`

---

### 22. Memory Gaps for Failed Movements

**Affected**: Lux Lynch

Between 19:57 and 20:38 on Day 1, 6+ failed movement attempts were not recorded as event memories, creating a 41-minute gap in the character's experiential record.

---

## Summary — Fix Priority

| Priority | Bug # | Description | Impact |
|----------|-------|-------------|--------|
| **P0** | 1 | Node duplication in plan arrays | Data integrity, bloated storage |
| **P0** | 2 | Pathfinding infinite retry loop | NPC stuck for entire simulation |
| **P0** | 5 | Character ID inconsistency → ghost entities | Broken interactions, phantom data |
| **P1** | 4 | Replan death spiral (encounter-interrupt loop) | NPCs stuck for hours |
| **P1** | 3 | Encounter → target not present contradiction | Failed interactions, wasted time |
| **P1** | 6 | In-progress nodes unresolved at day boundary | Orphaned state |
| **P1** | 7 | Non-standard itemId values | Item lookup failures |
| **P2** | 10 | Key/item possession state chaos | Narrative incoherence |
| **P2** | 11 | Repetitive behavior loops | Poor narrative quality |
| **P2** | 8 | Relationship score anomalies | Incorrect social dynamics |
| **P2** | 9 | STR 1 / Locksmith 1 values | Module data error |
| **P2** | 12 | Day 2 plans start at midnight | Unrealistic behavior |
| **P3** | 13-22 | Minor issues (i18n, names, pronouns, etc.) | Polish |
