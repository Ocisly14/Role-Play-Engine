# Multiplayer Real-Time Input Sharing & Round Status Banner

**Date:** 2026-03-02
**Status:** Approved

## Problem

In multiplayer game chat, when a player submits their action, it only appears locally. Other players have no visibility into what others typed or who has submitted. There is no progress indicator showing how many players have finished the current round.

## Design

### Approach: WebSocket Broadcast on Submit

When a player submits input, the backend immediately broadcasts a `player_input_submitted` WebSocket event to all clients in the sceneRoom. The frontend displays the message in chat for all players and shows a sticky banner with round progress.

### New WebSocket Event

**Event: `player_input_submitted`**

```typescript
{
  type: "player_input_submitted",
  sceneRoomId: string,
  playerId: string,
  playerName: string,       // character name
  characterId: string,
  content: string,           // full text (or "" for skip)
  inputType: "input" | "skip",
  submittedCount: number,    // e.g. 2
  totalCount: number,        // e.g. 4
  pendingPlayerNames: string[], // ["Alice", "Bob"]
  timestamp: string
}
```

Broadcast from `submitRoundInput()` in `turn/service.ts`, after input is persisted and before the "all submitted" check.

### Frontend Message Display

- **Other players:** A new `character` role message appears in chat with the submitter's name and content.
- **Submitting player:** Already sees their own message optimistically. WS event is filtered out by matching `playerId === myPlayerId`.
- **Skip input:** Displayed as a lighter/italic system message: "PlayerName skipped this round."

### Waiting Banner

A sticky banner between the message list and input area:

- **Appears** after the first `player_input_submitted` event of a round (when `submittedCount < totalCount`)
- **Content:** `"2/4 players submitted — Waiting for: Alice, Bob"`
- **Updates live** on each subsequent `player_input_submitted` event
- **Disappears** when `round_processing` event arrives

State:
```typescript
const [roundStatus, setRoundStatus] = useState<{
  submittedCount: number;
  totalCount: number;
  pendingPlayerNames: string[];
} | null>(null);
```

### Input Area Behavior

After submitting, the input area is disabled. No edit/revise — submission is final.

### Backend Changes

Only `client/server/multiplayer/turn/service.ts`:
1. Resolve submitter's character name from `manager.getState().players[userId]`
2. Build pending player names list
3. Broadcast `player_input_submitted` via `notifySceneRoom()`

No new endpoints, no schema changes.

### Edge Cases

| Case | Handling |
|------|----------|
| Player disconnects mid-round | Banner still shows them as pending |
| Solo player in sceneRoom | Banner never shows (1/1 triggers immediately) |
| Scene split during round | Not possible — splits happen post-round |
| Skip input | Show as lighter/italic message |
| Reconnect after submitting | Turn history loaded normally; banner state rebuilt from `GET /round` |

## Files to Modify

| File | Changes |
|------|---------|
| `client/server/multiplayer/turn/service.ts` | Broadcast `player_input_submitted` after input persisted |
| `client/src/hooks/useMultiplayerWebSocket.ts` | Handle new WS event, route messages, update banner state |
| `client/src/components/MultiplayerGameChat.tsx` | Add `roundStatus` state, render banner component, filter own WS messages |
