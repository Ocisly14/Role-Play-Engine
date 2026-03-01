CRITICAL (will cause incorrect behavior)

  #: 1
  Issue: Multiplayer graph has no ragRecorder node
  Location: multiplayerGraph.ts
  Impact: Turn RAG recording is done in service layer instead, but trigger-check contextual data (triggerCheckEvidence, etc.) is never
   
    cleared after each round, leaking stale evidence into future rounds
  ────────────────────────────────────────
  #: 2
  Issue: Multiplayer graph has no skillSelectionCheck node / no interrupt
  Location: multiplayerGraph.ts
  Impact: By design (pre-check is in service), but if a player submits with selectedSkill already set, the orchestrator pre-check
  skips
     that player — yet the graph orchestrator still doesn't pass selectedSkill to action
  ────────────────────────────────────────
  #: 3
  Issue: Combat entry routing is different — single-player routes action → combatActionB on first combat turn (NPC opening attacks),
    but multiplayer routes action → character → director → keeper for normal path, with combat entry via entry → memory →
  combatActionA
  Location: multiplayerGraph.ts vs dynamicGraph.ts
  Impact: Need to verify combat initiation flow in multiplayer actually works
  ────────────────────────────────────────
  #: 4
  Issue: No exitCombatAndRecord node in multiplayer — single-player has a dedicated node that exits combat + records defeated NPCs +
    completes turn. Multiplayer inlines this in battleKeeper node
  Location: multiplayerGraph.ts
  Impact: Defeated NPC recording may differ; combat exit cleanup may be incomplete
  ────────────────────────────────────────
  #: 5
  Issue: No combatEndCheck node in multiplayer — single-player has a separate node checking HP/SAN death mid-combat. Multiplayer skips

    this, going combatActionA → combatActionB or combatActionA → battleKeeper based on combatEnded flag
  Location: multiplayerGraph.ts
  Impact: If player dies mid-combat from Agent A result, there's no defeat narrative generation before battleKeeper

  HIGH (functional gaps)

  ┌─────┬───────────────────────────────────────────┬────────────────────────────────────────┬────────────────────────────────────┐
  │  #  │                   Issue                   │                Location                │               Impact               │
  ├─────┼───────────────────────────────────────────┼────────────────────────────────────────┼────────────────────────────────────┤
  │     │ WS events scene_room_split,               │                                        │ Frontend doesn't react to room     │
  │ 6   │ scene_room_merged, scene_room_joined,     │ useMultiplayerWebSocket.ts             │ splits/merges/errors — user must   │
  │     │ round_error are broadcast but not         │                                        │ refresh                            │
  │     │ consumed by frontend hook                 │                                        │                                    │
  ├─────┼───────────────────────────────────────────┼────────────────────────────────────────┼────────────────────────────────────┤
  │     │ No per-player conversation history        │                                        │ All players see all other players' │
  │ 7   │ filtering in multiplayer memory agent     │ multiplayerAgent/memory/memoryAgent.ts │  action history in LLM context     │
  │     │                                           │                                        │ (may leak secrets/plans)           │
  ├─────┼───────────────────────────────────────────┼────────────────────────────────────────┼────────────────────────────────────┤
  │     │ Multiplayer keeper's clue access uses     │                                        │ Intentional difference but may     │
  │ 8   │ per-target ranking but single-player uses │ multiplayerAgent/keeper/keeperAgent.ts │ cause inconsistencies if templates │
  │     │  global flags — different clue revelation │                                        │  expect one format                 │
  │     │  logic                                    │                                        │                                    │
  └─────┴───────────────────────────────────────────┴────────────────────────────────────────┴────────────────────────────────────┘

  MEDIUM (edge cases / quality)

  ┌─────┬────────────────────────────────────────────────┬────────────────────────────────────────────────────┬───────────────────┐
  │  #  │                     Issue                      │                      Location                      │      Impact       │
  ├─────┼────────────────────────────────────────────────┼────────────────────────────────────────────────────┼───────────────────┤
  │     │ Trigger-check contextualData never cleared —   │                                                    │ Stale trigger     │
  │ 9   │ single-player clears triggerCheckEvidence,     │ multiplayerGraph.ts                                │ evidence          │
  │     │ triggerCheckResult, etc. in ragRecorder node.  │                                                    │ accumulates       │
  │     │ Multiplayer has no equivalent cleanup          │                                                    │ across rounds     │
  ├─────┼────────────────────────────────────────────────┼────────────────────────────────────────────────────┼───────────────────┤
  │     │                                                │                                                    │ May use wrong     │
  │ 10  │ BattleKeeper uses (state as                    │ multiplayerAgent/combat/battleKeeperAgent.ts       │ player data if    │
  │     │ any).playerCharacters with unsafe cast         │                                                    │ type doesn't      │
  │     │                                                │                                                    │ match             │
  ├─────┼────────────────────────────────────────────────┼────────────────────────────────────────────────────┼───────────────────┤
  │     │ Orchestrator LLM silent fallback — multiplayer │                                                    │ Masks real LLM    │
  │ 11  │  catches all errors and returns default        │ multiplayerAgent/orchestrator/orchestratorAgent.ts │ failures (API     │
  │     │ "exploration" action instead of failing        │                                                    │ key, network,     │
  │     │                                                │                                                    │ quota)            │
  └─────┴────────────────────────────────────────────────┴────────────────────────────────────────────────────┴───────────────────┘
