# Multiplayer Real-Time Input Sharing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a multiplayer player submits input, broadcast it to all players in the sceneRoom immediately, and show a sticky progress banner ("X/Y submitted — Waiting for: Alice, Bob") that disappears when all players have submitted.

**Architecture:** Backend broadcasts a new `player_input_submitted` WS event from `submitRoundInput()` after input is persisted. Frontend handles this event in `useMultiplayerWebSocket` to add character messages for other players and update a `roundStatus` state. A banner component renders between MessageList and InputArea.

**Tech Stack:** TypeScript, React, Express, WebSocket

---

### Task 1: Add `playerName` field to Message type

**Files:**
- Modify: `client/src/types/gamechat.ts:7-20`

**Step 1: Add `playerName` to Message interface**

In `client/src/types/gamechat.ts`, add an optional `playerName` field to the `Message` interface so character messages from other players can display their name:

```typescript
export interface Message {
  role: "character" | "keeper" | "banner";
  content: string;
  timestamp: string;
  turnNumber: number;
  turnId?: string;
  isStreaming?: boolean;
  imageUrl?: string;
  imageCaption?: string;
  diceRolls?: Array<string | DiceRollInfo>;
  gameDay?: number | null;
  gameTime?: string | null;
  bannerType?: "combat_start" | "combat_end";
  playerName?: string;       // Character name of the player who sent this message
  isSkip?: boolean;          // True if this was a skip action
}
```

**Step 2: Commit**

```bash
git add client/src/types/gamechat.ts
git commit -m "feat: add playerName and isSkip fields to Message type"
```

---

### Task 2: Broadcast `player_input_submitted` from backend

**Files:**
- Modify: `client/server/multiplayer/turn/service.ts:279-285`

**Step 1: Add WS broadcast after DB persist, before "all submitted" check**

In `submitRoundInput()`, after line 279 (end of the try/catch for DB persist) and before line 281 (`// 3. Check if all players have submitted`), insert the broadcast logic:

```typescript
  // 2b. Broadcast player input to all clients in this sceneRoom
  {
    const wsManager = WebSocketManager.getInstance();
    if (wsManager) {
      const clients = wsManager.getMultiplayerClients(sceneRoomId);
      if (clients && clients.size > 0) {
        // Resolve character name from in-memory state
        const playerState = manager.getState().players[userId];
        const playerName = playerState?.characterName ?? "Unknown";

        // Build list of pending player names
        const allMemberIds = sceneRoom.memberPlayerIds;
        const submittedPlayerIds = new Set(
          manager.getRoundInputsForSceneRoom(sceneRoomId).map((ri) => ri.playerId)
        );
        const pendingPlayerNames: string[] = [];
        for (const memberId of allMemberIds) {
          if (!submittedPlayerIds.has(memberId)) {
            const memberState = manager.getState().players[memberId];
            pendingPlayerNames.push(memberState?.characterName ?? "Unknown");
          }
        }

        notifySceneRoom(sceneRoomId, clients, {
          type: "player_input_submitted",
          sceneRoomId,
          playerId: userId,
          playerName,
          characterId: inputData.characterId,
          content: inputData.inputType === "skip" ? "" : (inputData.content ?? ""),
          inputType: inputData.inputType,
          submittedCount: submittedPlayerIds.size,
          totalCount: allMemberIds.length,
          pendingPlayerNames,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
```

This goes between the existing DB persist block (line 276-279) and the "Check if all players have submitted" block (line 281).

**Step 2: Verify imports**

`WebSocketManager` and `notifySceneRoom` should already be imported in `service.ts`. Confirm by checking existing import statements at the top of the file.

**Step 3: Commit**

```bash
git add client/server/multiplayer/turn/service.ts
git commit -m "feat: broadcast player_input_submitted WS event on input submission"
```

---

### Task 3: Handle `player_input_submitted` in WebSocket hook

**Files:**
- Modify: `client/src/hooks/useMultiplayerWebSocket.ts:34-58` (params interface)
- Modify: `client/src/hooks/useMultiplayerWebSocket.ts:148-507` (switch statement)

**Step 1: Add new params to the hook interface**

Add to `UseMultiplayerWebSocketParams` (after line 57):

```typescript
  currentPlayerId?: string | null;
  setRoundStatus?: React.Dispatch<React.SetStateAction<{
    submittedCount: number;
    totalCount: number;
    pendingPlayerNames: string[];
  } | null>>;
```

Add these to the hook function signature destructuring (after line 81):

```typescript
  currentPlayerId,
  setRoundStatus,
```

Add refs after line 97:

```typescript
  const setRoundStatusRef = useRef(setRoundStatus);
  setRoundStatusRef.current = setRoundStatus;
  const currentPlayerIdRef = useRef(currentPlayerId);
  currentPlayerIdRef.current = currentPlayerId;
```

**Step 2: Add the event handler in the switch statement**

Add a new case before the `case "round_processing":` block (before line 153):

```typescript
              case "player_input_submitted": {
                const eventSceneRoomId = msg.sceneRoomId as string;
                const playerId = msg.playerId as string;
                const playerName = msg.playerName as string;
                const content = msg.content as string;
                const inputType = msg.inputType as "input" | "skip";

                // Update round status banner
                if (setRoundStatusRef.current) {
                  setRoundStatusRef.current({
                    submittedCount: msg.submittedCount as number,
                    totalCount: msg.totalCount as number,
                    pendingPlayerNames: msg.pendingPlayerNames as string[],
                  });
                }

                // Don't add duplicate message for the local player (they already see their own optimistically)
                if (playerId === currentPlayerIdRef.current) break;

                // Add this player's message to chat
                const maxTurn = messagesRef.current.length > 0
                  ? Math.max(...messagesRef.current.map((m) => m.turnNumber))
                  : 0;

                if (inputType === "skip") {
                  targetSetMessages(eventSceneRoomId, (prev) => [
                    ...prev,
                    {
                      role: "character" as const,
                      content: "",
                      timestamp: msg.timestamp || new Date().toISOString(),
                      turnNumber: maxTurn + 1,
                      playerName,
                      isSkip: true,
                    },
                  ]);
                } else {
                  targetSetMessages(eventSceneRoomId, (prev) => [
                    ...prev,
                    {
                      role: "character" as const,
                      content,
                      timestamp: msg.timestamp || new Date().toISOString(),
                      turnNumber: maxTurn + 1,
                      playerName,
                    },
                  ]);
                }
                break;
              }
```

**Step 3: Clear roundStatus on `round_processing`**

In the existing `case "round_processing":` handler (line 153-155), add:

```typescript
              case "round_processing":
                setIsWaiting(true);
                if (setRoundStatusRef.current) {
                  setRoundStatusRef.current(null);
                }
                break;
```

**Step 4: Also clear roundStatus on `round_complete` and `round_error`**

In `case "round_complete":` (around line 157-158), add after `setIsWaiting(false)`:

```typescript
                if (setRoundStatusRef.current) {
                  setRoundStatusRef.current(null);
                }
```

In `case "round_error":` (around line 394-396), add after `setIsWaiting(false)`:

```typescript
                if (setRoundStatusRef.current) {
                  setRoundStatusRef.current(null);
                }
```

**Step 5: Commit**

```bash
git add client/src/hooks/useMultiplayerWebSocket.ts
git commit -m "feat: handle player_input_submitted WS event in hook"
```

---

### Task 4: Add roundStatus state and banner to MultiplayerGameChat

**Files:**
- Modify: `client/src/components/MultiplayerGameChat.tsx:52-67` (state declarations)
- Modify: `client/src/components/MultiplayerGameChat.tsx:176-217` (WS hook call)
- Modify: `client/src/components/MultiplayerGameChat.tsx:660-674` (between MessageList and InputArea)

**Step 1: Add roundStatus state**

After line 77 (the `restShowCustomInput` state), add:

```typescript
  // ── Round progress banner state ──
  const [roundStatus, setRoundStatus] = useState<{
    submittedCount: number;
    totalCount: number;
    pendingPlayerNames: string[];
  } | null>(null);
```

**Step 2: Pass new props to useMultiplayerWebSocket**

In the hook call (lines 176-217), add the two new props:

```typescript
  useMultiplayerWebSocket({
    sessionId,
    sceneRoomId,
    isGameEnded,
    characterName,
    messagesRef,
    setMessages,
    setIsWaiting,
    setIsGameEnded,
    onNarrativeComplete,
    streamingBlockedRef,
    streamingBufferRef,
    setStreamingTurnId,
    setPendingDiceRolls,
    setShowingDiceAnimation,
    setDiceAnimationCompleted,
    roomId,
    onSceneRoomSplit: handleSceneRoomSplit,
    onSceneRoomMerged: handleSceneRoomMerged,
    setMessagesForRoom,
    currentPlayerId,          // NEW
    setRoundStatus,           // NEW
    onSkillSelectionRequired: useCallback(
      // ... existing code unchanged
    ),
    onSkillSelectionUpdate: useCallback(
      // ... existing code unchanged
    ),
  });
```

**Step 3: Render the banner between MessageList and InputArea**

After the `<MessageList ... />` closing tag (line 674) and before the `{isViewingOwnRoom ? (` block (line 676), add:

```typescript
      {/* Round progress banner */}
      {roundStatus && roundStatus.submittedCount < roundStatus.totalCount && (
        <div className="mx-2 mb-1 px-4 py-2 rounded-lg bg-amber-900/40 border border-amber-700/50 backdrop-blur-sm text-center">
          <span className="text-amber-200 text-sm font-medium">
            {roundStatus.submittedCount}/{roundStatus.totalCount}{" "}
            {t("multiplayer.playersSubmitted", {
              defaultValue: "players submitted",
            })}
          </span>
          {roundStatus.pendingPlayerNames.length > 0 && (
            <span className="text-amber-400/70 text-sm ml-2">
              — {t("multiplayer.waitingFor", { defaultValue: "Waiting for:" })}{" "}
              {roundStatus.pendingPlayerNames.join(", ")}
            </span>
          )}
        </div>
      )}
```

**Step 4: Commit**

```bash
git add client/src/components/MultiplayerGameChat.tsx
git commit -m "feat: add round progress banner to multiplayer game chat"
```

---

### Task 5: Display other players' names in MessageList

**Files:**
- Modify: `client/src/components/gamechat/MessageList.tsx` (the message rendering for `role === "character"`)

**Context:** The MessageList component currently renders character messages without distinguishing between "my message" and "another player's message". We need to:
1. Show the player's character name above/before their message if `playerName` is set
2. Render skip messages with italic styling

**Step 1: Find and update the character message rendering**

In `MessageList.tsx`, locate where `role === "character"` messages are rendered. Add a name label and skip styling:

- If `message.playerName` exists, render a small label above the message bubble with the character name
- If `message.isSkip` is true, render the message as italic text: `"{playerName} skipped this round"`

The exact code depends on the current MessageList implementation. Read the file, find the character message rendering section, and add:

```tsx
{msg.playerName && (
  <div className="text-xs text-amber-400/70 mb-0.5 font-medium">
    {msg.playerName}
  </div>
)}
{msg.isSkip ? (
  <span className="text-slate-400 italic text-sm">
    {msg.playerName ?? "Player"} {t("multiplayer.skippedRound", { defaultValue: "skipped this round" })}
  </span>
) : (
  // existing content rendering
)}
```

**Step 2: Commit**

```bash
git add client/src/components/gamechat/MessageList.tsx
git commit -m "feat: display player names and skip messages in multiplayer chat"
```

---

### Task 6: Build and verify

**Step 1: Build the project**

```bash
cd /Users/sunyining/project_SentiEdge/CoC-AI-agent && pnpm build
```

Expected: Clean build, no type errors.

**Step 2: Build frontend**

```bash
cd /Users/sunyining/project_SentiEdge/CoC-AI-agent/client && pnpm build
```

Expected: Clean build, no type errors.

**Step 3: Fix any type errors**

If there are type errors, fix them and re-build.

**Step 4: Final commit**

```bash
git add -A
git commit -m "fix: resolve build errors for real-time input sharing feature"
```

---

## Summary of Changes

| File | What Changes |
|------|-------------|
| `client/src/types/gamechat.ts` | Add `playerName?: string` and `isSkip?: boolean` to `Message` |
| `client/server/multiplayer/turn/service.ts` | Broadcast `player_input_submitted` WS event after input persist |
| `client/src/hooks/useMultiplayerWebSocket.ts` | Handle `player_input_submitted` event, add `currentPlayerId` + `setRoundStatus` params |
| `client/src/components/MultiplayerGameChat.tsx` | Add `roundStatus` state, pass to WS hook, render progress banner |
| `client/src/components/gamechat/MessageList.tsx` | Show player names on character messages, render skip messages |
