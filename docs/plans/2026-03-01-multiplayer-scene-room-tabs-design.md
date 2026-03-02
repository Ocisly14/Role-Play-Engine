# Multiplayer Scene Room Tabs — Design Document

**Date:** 2026-03-01
**Branch:** `multi`

## Goal

Add tabbed scene room viewing to the multiplayer game chat so players can watch other scene rooms in real-time while keeping the single-player layout feel.

## Architecture Decision

**Approach A — Single Chat Component + Tab Controller.** One `MultiplayerGameChat` component with a tab controller that swaps the data source. A `Map<sceneRoomId, RoomState>` holds per-room messages, scroll positions, and metadata. This avoids DOM bloat and aligns with the existing single-component pattern.

## Tab Bar (`SceneRoomTabs.tsx`)

- Horizontal tab strip between `SessionInfoBar` and `MessageList`.
- Each tab: `{scenarioName} ({playerCount})` — e.g., "Library (2)".
- Player's own room marked with a dot/star indicator.
- **Hidden when only one scene room exists** (identical to single-player).
- Your room always sorted first; others by creation time.
- On `scene_room_split` WS event: new tabs appear with highlight animation.
- On `scene_room_merged` WS event: tabs consolidate.

## Chat State (`useMultiplayerSceneRooms` hook)

```
State:
  mySceneRoomId: string
  activeTabId: string
  sceneRooms: Map<sceneRoomId, {
    scenarioName: string
    memberPlayerIds: string[]
    messages: Message[]
    scrollPosition: number
    isBattle: boolean
    roundNumber: number
  }>
```

- On mount: fetch all active scene rooms from `GET /rooms/:roomId/game/state`.
- Own room messages: loaded from turn history endpoint.
- Other rooms: fetched lazily on first tab click via `GET /rooms/:roomId/scene-rooms/:sceneRoomId/turns`.
- WS events routed to correct message array by `sceneRoomId`.
- Streaming continues in background even when tab is not active.

## Read-Only Mode

When viewing a scene room the player is NOT in:

- `MessageList` renders full chat history + live streaming.
- `InputArea` is hidden (not disabled).
- Subtle banner at bottom: "You are watching {scenarioName}".
- Dice animations still play.
- Scroll position saved per tab and restored on switch.

## Merge Behavior

When scene rooms merge:

- Tabs consolidate into one.
- Each player only sees narratives from rooms they participated in.
- Room participation chain tracked via `parentSceneRoomIds`.

## Sidebar Changes

`GameSidebar` gains a "Players Here" mini-section at the top:

- Shows compact cards for other players in the currently viewed room.
- Each card: character name + HP bar (% with color) + Sanity bar (% with color) + status icon.
- Player's own full character sheet remains unchanged below.
- Data sourced from game state endpoint, filtered by viewed room's `memberPlayerIds`.

## WebSocket Changes

- **Single WS connection per client** (no change to connection model).
- Backend `WebSocketManager` registers each multiplayer client for **all active scene rooms** in the game room (not just the player's own).
- On scene room split, backend auto-registers existing clients for new rooms.
- All WS events already include `sceneRoomId` — frontend routes them to the correct room's message array.

## Backend API Addition

**New endpoint:** `GET /rooms/:roomId/scene-rooms`

Returns lightweight list of all active (non-frozen) scene rooms:

```json
[
  {
    "sceneRoomId": "...",
    "scenarioName": "Library",
    "memberPlayerIds": ["user1", "user2"],
    "roundNumber": 3,
    "isBattle": false
  }
]
```

No other backend changes required — existing turn history and game state endpoints cover all data needs.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `client/src/components/gamechat/SceneRoomTabs.tsx` | Create | Tab bar component |
| `client/src/hooks/useMultiplayerSceneRooms.ts` | Create | Multi-room state hook |
| `client/src/components/MultiplayerGameChat.tsx` | Modify | Integrate tabs, read-only mode, multi-room messages |
| `client/src/views/MultiplayerGamePage.tsx` | Modify | Pass scene rooms data, handle split/merge lifecycle |
| `client/src/components/GameSidebar.tsx` | Modify | Add "Players Here" section |
| `client/src/hooks/useMultiplayerWebSocket.ts` | Modify | Route events by sceneRoomId to correct room |
| `client/server/websocket/WebSocketManager.ts` | Modify | Register client for all active rooms |
| `client/server/multiplayer/sceneroom/` | Create | Scene room listing endpoint |
| `client/server/multiplayer/routes.ts` | Modify | Wire new endpoint |
