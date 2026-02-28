# Multiplayer Pipeline Review — Issues Report

> Reviewed against: `docs/single-player-technical-reference.md`
> Date: 2026-02-27

---

## Priority Legend

| Priority | Criteria |
|----------|----------|
| **P0** | Data corruption, crash, or feature completely broken |
| **P1** | Functional bug that produces incorrect game behavior |
| **P2** | Missing feature or incomplete adaptation |
| **P3** | Minor issue, dead code, or style problem |

---

## 1. Combat System — Severely Broken

### P0-1: CombatActionB result discarded — NPC attack loop completely broken

**Location:** `multiplayerGraph.ts` combatActionB node (L775-815)

`combatAgentB.generateNpcActions()` returns a `CombatActionBResult` containing `pendingNpcActions` (the NPC attack declarations players must defend against) and `defeatedNpcs`. In the single-player graph, these are stored on `combatState.pendingNpcActions` via `dgsm.setPendingNpcActions()`.

In multiplayer, the return value is `await`-ed but never stored:

```typescript
await combatAgentB.generateNpcActions(m, sceneRoomId, combinedCombatInput, prevNarrative, language, combatAResult);
// result discarded — pendingNpcActions never stored
```

**Impact:** The entire NPC-attack → player-defense alternation loop is broken. NPCs never get to attack because their actions are never recorded. Combat is player-attack-only.

### P0-2: Combat round counter never incremented

**Location:** `multiplayerGraph.ts` — no call to `incrementCombatRound()` anywhere

In single-player (`dynamicGraph.ts:1073`), `dgsm.incrementCombatRound()` is called after a defense turn completes. In the multiplayer graph, no node ever increments `combatState.round`. It stays permanently at `1`.

**Impact:**
- LLM always sees "Combat Round: 1" — tactical reasoning (escalation, desperation, morale) is broken
- `battleKeeper` node always calls `generateEntryNarrative` (designed for round 1 only) instead of `generateCombatNarrative` (designed for round 2+)
- `generateCombatNarrative` is unreachable dead code in multiplayer

### P0-3: No player defense path in multiplayer combat

**Location:** `multiplayerGraph.ts` combatActionA node (L715-761)

Single-player distinguishes attack vs. defense via `combatState.pendingNpcActions`:
- `null` → player attack turn → `resolvePlayerAttack()`
- `PendingNpcAction[]` → player defense turn → `resolvePlayerDefense()`

Multiplayer always calls `resolvePlayerAttack()` regardless:
```typescript
const result = await combatAgentA.resolvePlayerAttack(m, sceneRoomId, combinedCombatInput, null, language);
```

**Impact:** Even if P0-1 were fixed (pendingNpcActions stored), the graph would never route to a defense path. Players can only attack, never defend.

### P1-1: Combat time advances global clock, not per-room clock

**Location:** `combatActionAgentA.ts` `applyResultForSceneRoom()` (L398)

```typescript
manager.advanceGameTime(result.timeElapsedMinutes);
// Should be: manager.advanceSceneRoomGameTime(sceneRoomId, result.timeElapsedMinutes);
```

**Impact:** During combat in one room, the global clock jumps forward, desynchronizing all other rooms.

### P1-2: `selectedSkill` always `null` in combat

**Location:** `multiplayerGraph.ts` combatActionA node (L744)

```typescript
const result = await combatAgentA.resolvePlayerAttack(m, sceneRoomId, combinedCombatInput, null, language);
//                                                                                          ^^^^
```

Players cannot specify combat skills (Firearms, Fighting, Dodge). The LLM must infer from character profile alone.

### P2-1: No per-player initiative order

Combat concatenates all player inputs into one string. CoC 7e requires DEX-based initiative ordering. The LLM produces one aggregate result without correctly handling individual attack sequences.

### P2-2: No `exitCombatAndRecord` equivalent

Single-player has explicit nodes for combat exit: recording defeated NPCs to `defeatedNpcHistory`, calling `exitCombat()`, firing `onCombatEnd` stream events. Multiplayer has none of these — combat exit is only checked in `gameEndCheck`, and even there, the actual cleanup (recording defeated NPCs, clearing `combatState`) is not performed.

### P2-3: Missing `onCombatStart`/`onCombatEnd` stream events

Single-player emits these via WebSocket for frontend combat UI (banners, music). Multiplayer's stream type definition doesn't include them.

---

## 2. Director Agent — Time & Trigger Issues

### P1-3: `updateNonPlayerScenarios` uses global time, not per-room max time

**Location:** `directorAgent.ts` `updateNonPlayerScenarios()` — uses `state.gameDay/state.timeOfDay`

```typescript
const currentGameTime = `Day ${state.gameDay}, ${state.timeOfDay}`;
```

In multiplayer, rooms have different times. The global `state.gameDay/timeOfDay` may lag behind the most advanced room. NPC timeline generation receives an incorrect "now", producing NPC actions with wrong temporal ordering.

`handleUnifiedSceneChanges` correctly computes per-room max time — `updateNonPlayerScenarios` should do the same.

### P1-4: Phase 3 background snapshots also use stale global time

Same root cause as P1-3. `generateBackgroundSnapshotsPhase3` receives `currentGameTime` from global state, propagating stale time into all background simplified snapshots.

### P1-5: `checkGlobalTriggerAndGameEnd` only checks ONE sceneRoom's evidence

**Location:** `directorAgent.ts` `checkGlobalTriggerAndGameEnd()`

The trigger check uses `collectCurrentTurnActionLogs` scoped to one sceneRoom's `temporaryInfo.actionResults`. In a multi-room game, player action logs from other rooms are not included. A victory condition satisfied by Room B's players won't be detected when Room A's trigger check runs.

### P2-4: `handleActionDrivenSceneChange` may be dead/duplicate code

The full single-player 3-phase scene change flow is retained in the multiplayer director. The multiplayer pipeline uses `processUnifiedSceneChanges` from the turn service instead. If `handleActionDrivenSceneChange` is accidentally called, it would generate expensive duplicate LLM calls and read from a sceneRoom-scoped view that can't see other rooms.

### P2-5: `checkStoryProgression` — `minutesSinceLastInput` unclear in multiplayer

`getMinutesSinceLastInput(sceneRoomId)` semantics are ambiguous: does it measure from the last round completion, or from the last individual player submission? Depending on implementation, rooms where one player submitted but others haven't may trigger/suppress progression incorrectly.

---

## 3. Action Agent — State & Feature Issues

### P1-6: `ActionResult.gameTime` is stale (pre-advance time)

**Location:** `actionAgent.ts` `buildFinalResult()`

```typescript
gameTime: dynamicState.timeOfDay || "Unknown time",
```

`dynamicState` is captured before time advancement. After `advanceSceneRoomGameTime` runs in step 8, the room's time has changed, but all `ActionResult` objects record the old time.

**Impact:** Turn records, RAG indexing, and frontend display show wrong game time for action results.

### P1-7: Heartbeat consumption called per-player, modifies global state

**Location:** `actionAgent.ts` `consumeDueHeartbeatActionsFromContext()`

This function calls `manager.setHeartbeatActions(next)` which updates the global heartbeat list. When called for player 1, it removes due heartbeats. When called for player 2, those heartbeats are already gone. The behavior is benign (second call is a no-op) but indicates unclear ownership: heartbeat consumption should happen once per room, not per player.

### P2-6: No NPC-initiated scene change handling

In single-player, NPC responses can trigger `sceneChangeRequest`. In the multiplayer action agent, NPC responses are processed but none of their output fields update the scene change request. NPC-driven location changes are silently discarded.

### P2-7: Sanity loss mechanic absent

Single-player has explicit sanity drain paths for horror reveals and mental shock checks. The multiplayer action agent has no equivalent — sanity changes only happen if the LLM explicitly includes them in `stateUpdate`.

---

## 4. Keeper Agent — Context Issues

### P1-8: `selectedSkill: null` hardcoded for all players

**Location:** `keeperAgent.ts` (L499)

```typescript
selectedSkill: null,
```

Every player's `selectedSkill` is discarded. The keeper template can never reference "You rolled your [specific skill]..." for any player. Per-player inputs contain skill info, but the template variable is a separate mechanism.

### P1-9: `actionAnalysis` reflects only the last player processed

`tempInfo.currentActionAnalysis` is cleared and overwritten per-player during the action phase. The keeper receives only the last player's action analysis. Template variables `actionTargetName` and `actionTargetIntent` reflect only one player's intent, not all players'.

### P1-10: Per-target clue gating not applied to scenario clues

`derivePerTargetClueAccess` correctly computes the best success level per target across all players. However, `filterScenarioCluesForKeeper` uses a single `allowRegularPlus` boolean — if ANY player succeeded at ANYTHING, ALL targets' clues become accessible. Player A fumbling at Target X while Player B succeeds at Target Y should NOT unlock Target X's clues.

### P2-8: `generateEpilogue` doesn't wait for all rooms to finish

If one room triggers a game end, the epilogue is generated immediately while other rooms may be mid-round. No mechanism exists to synchronize all rooms before generating the final narrative.

---

## 5. Graph Structure — Missing Nodes & Paths

### P2-9: No `skillSelectionCheck` / `skillSelectionRequired` nodes

Single-player supports pausing the graph to let the player choose a skill (LangGraph `interrupt()`). Multiplayer has no equivalent. `requiresSkillSelection` from the orchestrator is effectively ignored.

### P2-10: No `ragRecorder` node

Single-player has a `ragRecorder` node at the end of every path that fire-and-forget indexes the turn for RAG retrieval. Multiplayer does RAG recording in the turn service (`triggerMultiplayerGraphCore`) instead, which is functionally equivalent. However, epilogue turns are NOT indexed — `epilogueKeeper` edges directly to `END` and the turn service only records RAG for non-epilogue turns.

### P2-11: No `exitCombatAndRecord` node (see P2-2)

### P2-12: No dice roll streaming

Single-player streams dice rolls via `stream.onDiceRolls` in both the keeper and combat nodes. Multiplayer doesn't build or stream dice rolls in any graph node. The `diceRolls` field in `round_complete` is read from `contextualData.diceRolls`, but no graph node populates this field with properly formatted `DiceRollInfo[]` objects.

---

## 6. Turn Service — Concurrency & State Issues

### P1-11: `processUnifiedSceneChanges` can run twice per round

**Location:** `turn/service.ts` (L257)

```typescript
if (roomProcessingQueue.getPendingCount(roomId) <= 1) {
  await processUnifiedSceneChanges(roomId, latestManager, db);
}
```

The pending count is checked before the `finally` block decrements it. If two sceneRooms finish nearly simultaneously, both can satisfy `pendingCount <= 1`, causing `processUnifiedSceneChanges` to run twice. While `resolveAllMovements` is idempotent, this produces duplicate WebSocket notifications (scene images, time drift events).

### P1-12: `map_image_ready` mutates state on potentially stale manager

**Location:** `turn/service.ts` (L921-923)

```typescript
const room = manager.getSceneRoom(childRoom.sceneRoomId);
if (room?.currentScenario) {
  room.currentScenario.mapImagePath = mapResult.path;
}
```

This fire-and-forget callback mutates state on the manager reference captured at callback creation time. If the manager is replaced by a subsequent graph execution before the map generation completes, the update applies to a stale object and is silently lost.

### P1-13: Language determined by the last player to submit

**Location:** `turn/service.ts` (L238)

```typescript
const language = inputData.language ?? "zh";
```

The `language` for the entire round is set by whichever player triggers `allSubmitted` (the last one). In a mixed-language room, the graph runs in only one language, not the language each player chose.

### P2-13: No auto-checkpoint after each round

Single-player has `useAutoSave` hook that saves an auto-checkpoint after each turn. The multiplayer turn service has no auto-checkpoint logic. No `"auto"` or `"scene_transition"` checkpoint types exist.

---

## 7. Server API — Missing Features

### P2-14: No game stop/abandon endpoint

No way for a host to cleanly end an active game, clear it from `multiplayerSessionStore`, or mark the room as `"ended"`.

### P2-15: No skill suggestion endpoint

`POST /api/skills/suggest` reads from `ServerState` (single-player). No equivalent endpoint reads from `multiplayerSessionStore`. Players cannot get AI-suggested skills.

### P2-16: No player memo (Notes) CRUD

The entire memo system (GameSidebar "Notes" tab) is absent from multiplayer API. No `GET/POST/PUT/DELETE /api/multiplayer/.../memos`.

### P2-17: No RAG Q&A endpoint

`POST /api/rag/ask` is absent from multiplayer routes. The underlying `SessionRagService` already supports `sceneRoomId` filtering, but no route exposes it. The GameSidebar "Knowledge" tab is non-functional in multiplayer.

### P2-18: No turn status long-poll fallback

Multiplayer relies entirely on WebSocket for turn results. If a client reconnects after missing events, there's no HTTP endpoint to retrieve the result of a specific round/turn.

### P2-19: No language update endpoint

No `POST /api/multiplayer/rooms/:roomId/game/update-language` to change the session language mid-game.

### P3-1: `getGameState` has no membership authorization check

Any authenticated user who knows a `roomId` can retrieve the game state summary. Should verify `req.user.userId` is a room member.

### P3-2: `getTurnHistory` has no membership authorization check

Any authenticated user can read another room's conversation history.

### P3-3: `getTurnHistory` — `sceneRoomId = "all"` is dead code

The controller has logic for `sceneRoomId !== "all"`, but the route pattern `/:sceneRoomId` will never produce the literal string `"all"`.

---

## 8. Orchestrator — Minor Issues

### P2-20: Validation always passes

`MultiRoundValidation` is a stub — always returns `{ status: "passed" }`. No mechanism to reject invalid player inputs before the pipeline runs.

### P3-4: Connections loaded from Prisma on every call

Single-player gets connections from in-memory state. Multiplayer does a synchronous Prisma query per `processRound` call. On failure, `connections = []` silently — LLM loses all scene-connection context.

---

## Summary by Priority

| Priority | Count | Key Areas |
|----------|-------|-----------|
| **P0** | 3 | Combat: NPC attacks discarded, round never increments, no defense path |
| **P1** | 13 | Combat time sync, Director global-time usage, Keeper context issues, Turn service races |
| **P2** | 20 | Missing features (skill selection, memos, RAG QA, auto-checkpoints, dice streaming, etc.) |
| **P3** | 4 | Auth checks, dead code, minor issues |

### Recommended Fix Order

1. **P0 Combat fixes** — The combat system is fundamentally broken (3 P0s). Fix the NPC action loop, round counter, and defense path first.
2. **P1 Time/State fixes** — Combat `advanceGameTime` → `advanceSceneRoomGameTime`, Director `updateNonPlayerScenarios` per-room time, ActionResult stale time.
3. **P1 Keeper context** — `selectedSkill`, `actionAnalysis`, per-target clue gating.
4. **P1 Turn service** — `processUnifiedSceneChanges` double-run, language last-submitter issue.
5. **P2 Missing features** — Prioritize by user impact: dice roll display, skill selection, memos/RAG QA, auto-checkpoints.
