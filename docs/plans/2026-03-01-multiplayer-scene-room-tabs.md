# Multiplayer Scene Room Tabs — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add tabbed scene room viewing to the multiplayer game chat so players can watch other scene rooms in real-time while keeping the single-player layout feel.

**Architecture:** Single `MultiplayerGameChat` component with a tab controller (Approach A). A new `useMultiplayerSceneRooms` hook manages a `Map<sceneRoomId, RoomState>` of per-room messages, scroll positions, and metadata. A `SceneRoomTabs` component renders a horizontal tab strip above the message list. The backend `WebSocketManager` registers each client for all active scene rooms, and events are routed by `sceneRoomId` on the frontend.

**Tech Stack:** React, TypeScript, Express, WebSocket (ws), Prisma

**Design doc:** `docs/plans/2026-03-01-multiplayer-scene-room-tabs-design.md`

---

### Task 1: Backend — Scene Room Listing Endpoint

**Files:**
- Create: `client/server/multiplayer/sceneroom/controller.ts`
- Create: `client/server/multiplayer/sceneroom/routes.ts`
- Modify: `client/server/multiplayer/routes.ts`

**Context:** We need a lightweight `GET /rooms/:roomId/scene-rooms` endpoint that returns all active (non-frozen) scene rooms with metadata. The `MultiplayerDynamicGameStateLoader` session store already holds the full game state in memory. The existing game state endpoint (`GET /rooms/:roomId/game/state`) returns scene rooms but includes heavy data — this new endpoint returns just what the tab bar needs.

**Step 1: Create the controller**

Create `client/server/multiplayer/sceneroom/controller.ts`:

```typescript
import type { Request, Response } from "express";
import { MultiplayerDynamicGameStateLoader } from "../../../../src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameStateLoader.js";

export async function listActiveSceneRooms(req: Request, res: Response) {
  try {
    const { roomId } = req.params;
    const manager = MultiplayerDynamicGameStateLoader.getSessionManager(roomId);
    if (!manager) {
      return res.status(404).json({ success: false, error: "Game not found or not started" });
    }

    const state = manager.getState();
    const activeRooms = Object.values(state.sceneRooms)
      .filter((room) => !room.isFrozen)
      .map((room) => ({
        sceneRoomId: room.sceneRoomId,
        scenarioName: room.scenarioName,
        memberPlayerIds: room.memberPlayerIds,
        roundNumber: room.roundNumber,
        isBattle: room.isBattle,
        gameDay: room.gameDay,
        timeOfDay: room.timeOfDay,
      }));

    return res.json({ success: true, sceneRooms: activeRooms });
  } catch (error) {
    console.error("Error listing scene rooms:", error);
    return res.status(500).json({ success: false, error: "Failed to list scene rooms" });
  }
}
```

**Step 2: Create the routes file**

Create `client/server/multiplayer/sceneroom/routes.ts`:

```typescript
import { Router } from "express";
import { listActiveSceneRooms } from "./controller.js";

const router = Router({ mergeParams: true });

router.get("/", listActiveSceneRooms);

export default router;
```

**Step 3: Wire into multiplayer routes**

Modify `client/server/multiplayer/routes.ts`. Add import near line 9 (with other route imports):

```typescript
import sceneRoomRoutes from "./sceneroom/routes.js";
```

Add route mount after the existing scene room input routes (around line 35, after the skill-selection route):

```typescript
router.use("/rooms/:roomId/scene-rooms-list", authMiddleware, sceneRoomRoutes);
```

Note: Use `/scene-rooms-list` to avoid conflict with existing `/scene-rooms/:sceneRoomId/...` routes.

**Step 4: Build and verify**

Run: `pnpm build`
Expected: No type errors. The new endpoint compiles cleanly.

**Step 5: Commit**

```bash
git add client/server/multiplayer/sceneroom/
git add client/server/multiplayer/routes.ts
git commit -m "feat: add GET /scene-rooms-list endpoint for multiplayer tab bar"
```

---

### Task 2: Backend — WebSocketManager Multi-Room Registration

**Files:**
- Modify: `client/server/websocket/WebSocketManager.ts`

**Context:** Currently, `WebSocketManager` registers a multiplayer client for a single `sceneRoomId` extracted from the WS URL params. We need to register the client for **all active scene rooms** in the game room so the frontend receives events from every room. The connection URL still includes the player's own `sceneRoomId`, but on connect we also register for all other active rooms.

**Step 1: Add method to register client for all rooms**

In `client/server/websocket/WebSocketManager.ts`, add a new method after `registerMultiplayerClient` (around line 260):

```typescript
public registerMultiplayerClientForAllRooms(
  roomId: string,
  userId: string,
  client: WSClient
): void {
  // Import dynamically to avoid circular deps
  const { MultiplayerDynamicGameStateLoader } = require("../../../../src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameStateLoader.js");
  const manager = MultiplayerDynamicGameStateLoader.getSessionManager(roomId);
  if (!manager) return;

  const state = manager.getState();
  for (const room of Object.values(state.sceneRooms)) {
    if (!room.isFrozen) {
      this.registerMultiplayerClient(room.sceneRoomId, userId, client);
    }
  }
}
```

**Step 2: Update connection handler to use multi-room registration**

In the connection handler (around line 70), find where `registerMultiplayerClient` is called with the single `sceneRoomId`. After that call, also register for all rooms. Find the section that looks like:

```typescript
this.registerMultiplayerClient(sceneRoomId, userId, client);
```

Add after it:

```typescript
// Also register for all other active scene rooms so client gets cross-room events
if (roomId) {
  this.registerMultiplayerClientForAllRooms(roomId, userId, client);
}
```

We need `roomId` from the URL params. Check the connection handler — if `roomId` is not already extracted from query params, add it:

```typescript
const roomId = url.searchParams.get("roomId");
```

**Step 3: Add method to register a client for a newly created scene room**

This is called when a scene room splits — all connected clients need to be registered for the new room. Add after the method from Step 1:

```typescript
public registerAllClientsForNewSceneRoom(
  existingSceneRoomId: string,
  newSceneRoomId: string
): void {
  const existingClients = this.multiplayerClients.get(existingSceneRoomId);
  if (!existingClients) return;

  for (const [userId, client] of existingClients) {
    this.registerMultiplayerClient(newSceneRoomId, userId, client);
  }
}
```

**Step 4: Build and verify**

Run: `pnpm build`
Expected: No type errors.

**Step 5: Commit**

```bash
git add client/server/websocket/WebSocketManager.ts
git commit -m "feat: register WS clients for all active scene rooms"
```

---

### Task 3: Frontend — Scene Room Types

**Files:**
- Modify: `client/src/types/gamechat.ts`

**Context:** Define the types needed for multi-room state management before building the hook and components.

**Step 1: Add scene room types**

Add at the end of `client/src/types/gamechat.ts` (after the existing exports, around line 83):

```typescript
export interface SceneRoomInfo {
  sceneRoomId: string;
  scenarioName: string | null;
  memberPlayerIds: string[];
  roundNumber: number;
  isBattle: boolean;
  gameDay?: number;
  timeOfDay?: string;
}

export interface SceneRoomState {
  info: SceneRoomInfo;
  messages: Message[];
  scrollPosition: number;
  isLoaded: boolean; // false until turn history is fetched
}
```

**Step 2: Build and verify**

Run: `cd client && npx tsc --noEmit`
Expected: No type errors.

**Step 3: Commit**

```bash
git add client/src/types/gamechat.ts
git commit -m "feat: add SceneRoomInfo and SceneRoomState types"
```

---

### Task 4: Frontend — useMultiplayerSceneRooms Hook

**Files:**
- Create: `client/src/hooks/useMultiplayerSceneRooms.ts`

**Context:** This hook manages the multi-room state: which rooms exist, which tab is active, per-room messages, and scroll positions. It fetches the room list on mount, lazily loads turn history when a tab is first clicked, and exposes handlers for WS events (`scene_room_split`, `scene_room_merged`).

**Step 1: Create the hook**

Create `client/src/hooks/useMultiplayerSceneRooms.ts`:

```typescript
import { useCallback, useEffect, useRef, useState } from "react";
import type { Message, SceneRoomInfo, SceneRoomState } from "../types/gamechat";
import { authFetch } from "../utils/authFetch";

interface UseMultiplayerSceneRoomsParams {
  roomId: string;
  mySceneRoomId: string;
  initialMessages?: Message[];
}

interface UseMultiplayerSceneRoomsReturn {
  activeTabId: string;
  setActiveTabId: (id: string) => void;
  sceneRooms: Map<string, SceneRoomState>;
  isViewingOwnRoom: boolean;
  activeRoomMessages: Message[];
  setActiveRoomMessages: (updater: Message[] | ((prev: Message[]) => Message[])) => void;
  handleSceneRoomSplit: (newRooms: SceneRoomInfo[]) => void;
  handleSceneRoomMerged: (survivingRoomId: string, removedRoomId: string) => void;
  updateSceneRoomInfo: (roomId: string, info: Partial<SceneRoomInfo>) => void;
  saveScrollPosition: (position: number) => void;
  getScrollPosition: () => number;
  sortedSceneRooms: SceneRoomInfo[];
}

export function useMultiplayerSceneRooms({
  roomId,
  mySceneRoomId,
  initialMessages = [],
}: UseMultiplayerSceneRoomsParams): UseMultiplayerSceneRoomsReturn {
  const [sceneRooms, setSceneRooms] = useState<Map<string, SceneRoomState>>(
    () => {
      const map = new Map<string, SceneRoomState>();
      // Initialize with my room
      map.set(mySceneRoomId, {
        info: {
          sceneRoomId: mySceneRoomId,
          scenarioName: null,
          memberPlayerIds: [],
          roundNumber: 0,
          isBattle: false,
        },
        messages: initialMessages,
        scrollPosition: 0,
        isLoaded: true,
      });
      return map;
    }
  );
  const [activeTabId, setActiveTabIdRaw] = useState(mySceneRoomId);
  const sceneRoomsRef = useRef(sceneRooms);
  sceneRoomsRef.current = sceneRooms;

  const isViewingOwnRoom = activeTabId === mySceneRoomId;

  // Fetch all active scene rooms on mount
  useEffect(() => {
    const fetchSceneRooms = async () => {
      try {
        const res = await authFetch(
          `/api/multiplayer/rooms/${roomId}/scene-rooms-list`
        );
        const data = await res.json();
        if (data.success && data.sceneRooms) {
          setSceneRooms((prev) => {
            const next = new Map(prev);
            for (const room of data.sceneRooms as SceneRoomInfo[]) {
              if (!next.has(room.sceneRoomId)) {
                next.set(room.sceneRoomId, {
                  info: room,
                  messages: [],
                  scrollPosition: 0,
                  isLoaded: false,
                });
              } else {
                // Update info but keep messages
                const existing = next.get(room.sceneRoomId)!;
                next.set(room.sceneRoomId, { ...existing, info: room });
              }
            }
            return next;
          });
        }
      } catch (err) {
        console.error("Failed to fetch scene rooms:", err);
      }
    };
    fetchSceneRooms();
  }, [roomId, mySceneRoomId]);

  // Lazy load turn history when switching to a tab for the first time
  const setActiveTabId = useCallback(
    async (tabId: string) => {
      setActiveTabIdRaw(tabId);
      const room = sceneRoomsRef.current.get(tabId);
      if (room && !room.isLoaded && tabId !== mySceneRoomId) {
        try {
          const res = await authFetch(
            `/api/multiplayer/rooms/${roomId}/scene-rooms/${tabId}/turns`
          );
          const data = await res.json();
          if (data.success && data.messages) {
            setSceneRooms((prev) => {
              const next = new Map(prev);
              const existing = next.get(tabId);
              if (existing) {
                next.set(tabId, {
                  ...existing,
                  messages: data.messages,
                  isLoaded: true,
                });
              }
              return next;
            });
          }
        } catch (err) {
          console.error("Failed to fetch turn history for room:", tabId, err);
        }
      }
    },
    [roomId, mySceneRoomId]
  );

  // Get messages for active tab
  const activeRoomMessages =
    sceneRooms.get(activeTabId)?.messages ?? [];

  // Set messages for active tab (used by WS handler)
  const setActiveRoomMessages = useCallback(
    (updater: Message[] | ((prev: Message[]) => Message[])) => {
      setSceneRooms((prev) => {
        const next = new Map(prev);
        const room = next.get(activeTabId);
        if (!room) return prev;
        const newMessages =
          typeof updater === "function" ? updater(room.messages) : updater;
        next.set(activeTabId, { ...room, messages: newMessages });
        return next;
      });
    },
    [activeTabId]
  );

  // Update messages for a specific room (used for routing WS events by sceneRoomId)
  // This is exposed indirectly — the WS hook will call setMessagesForRoom instead

  // Handle scene room split
  const handleSceneRoomSplit = useCallback(
    (newRooms: SceneRoomInfo[]) => {
      setSceneRooms((prev) => {
        const next = new Map(prev);
        for (const room of newRooms) {
          if (!next.has(room.sceneRoomId)) {
            next.set(room.sceneRoomId, {
              info: room,
              messages: [],
              scrollPosition: 0,
              isLoaded: false,
            });
          }
        }
        return next;
      });
    },
    []
  );

  // Handle scene room merge
  const handleSceneRoomMerged = useCallback(
    (survivingRoomId: string, removedRoomId: string) => {
      setSceneRooms((prev) => {
        const next = new Map(prev);
        next.delete(removedRoomId);
        // If we were viewing the removed room, switch to surviving
        if (activeTabId === removedRoomId) {
          setActiveTabIdRaw(survivingRoomId);
        }
        return next;
      });
    },
    [activeTabId]
  );

  // Update scene room info
  const updateSceneRoomInfo = useCallback(
    (srId: string, info: Partial<SceneRoomInfo>) => {
      setSceneRooms((prev) => {
        const next = new Map(prev);
        const room = next.get(srId);
        if (room) {
          next.set(srId, {
            ...room,
            info: { ...room.info, ...info },
          });
        }
        return next;
      });
    },
    []
  );

  // Scroll position management
  const saveScrollPosition = useCallback(
    (position: number) => {
      setSceneRooms((prev) => {
        const next = new Map(prev);
        const room = next.get(activeTabId);
        if (room) {
          next.set(activeTabId, { ...room, scrollPosition: position });
        }
        return next;
      });
    },
    [activeTabId]
  );

  const getScrollPosition = useCallback(() => {
    return sceneRooms.get(activeTabId)?.scrollPosition ?? 0;
  }, [sceneRooms, activeTabId]);

  // Sorted rooms: own room first, then by sceneRoomId
  const sortedSceneRooms = Array.from(sceneRooms.values())
    .map((r) => r.info)
    .sort((a, b) => {
      if (a.sceneRoomId === mySceneRoomId) return -1;
      if (b.sceneRoomId === mySceneRoomId) return 1;
      return a.sceneRoomId.localeCompare(b.sceneRoomId);
    });

  return {
    activeTabId,
    setActiveTabId,
    sceneRooms,
    isViewingOwnRoom,
    activeRoomMessages,
    setActiveRoomMessages,
    handleSceneRoomSplit,
    handleSceneRoomMerged,
    updateSceneRoomInfo,
    saveScrollPosition,
    getScrollPosition,
    sortedSceneRooms,
  };
}
```

**Step 2: Build and verify**

Run: `cd client && npx tsc --noEmit`
Expected: No type errors.

**Step 3: Commit**

```bash
git add client/src/hooks/useMultiplayerSceneRooms.ts
git commit -m "feat: add useMultiplayerSceneRooms hook for multi-room state"
```

---

### Task 5: Frontend — SceneRoomTabs Component

**Files:**
- Create: `client/src/components/gamechat/SceneRoomTabs.tsx`

**Context:** Horizontal tab bar rendered between `SessionInfoBar` and `MessageList`. Hidden when only one scene room exists. Shows scene name + player count. Player's own room has a dot indicator.

**Step 1: Create the component**

Create `client/src/components/gamechat/SceneRoomTabs.tsx`:

```typescript
import type React from "react";
import { useTranslation } from "react-i18next";
import type { SceneRoomInfo } from "../../types/gamechat";

interface SceneRoomTabsProps {
  sceneRooms: SceneRoomInfo[];
  activeTabId: string;
  mySceneRoomId: string;
  onTabChange: (sceneRoomId: string) => void;
}

export const SceneRoomTabs: React.FC<SceneRoomTabsProps> = ({
  sceneRooms,
  activeTabId,
  mySceneRoomId,
  onTabChange,
}) => {
  const { t } = useTranslation();

  // Hide when only one room
  if (sceneRooms.length <= 1) {
    return null;
  }

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 bg-black/30 backdrop-blur-sm border-b border-amber-900/30 overflow-x-auto scrollbar-hide">
      {sceneRooms.map((room) => {
        const isActive = room.sceneRoomId === activeTabId;
        const isMine = room.sceneRoomId === mySceneRoomId;
        const playerCount = room.memberPlayerIds.length;
        const displayName = room.scenarioName || t("multiplayer.unknownScene", "Unknown");

        return (
          <button
            key={room.sceneRoomId}
            type="button"
            onClick={() => onTabChange(room.sceneRoomId)}
            className={`
              flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium
              whitespace-nowrap transition-all duration-200 min-w-0
              ${
                isActive
                  ? "bg-amber-900/60 text-amber-100 border border-amber-600/50 shadow-sm"
                  : "bg-black/20 text-amber-300/70 border border-transparent hover:bg-amber-900/30 hover:text-amber-200"
              }
            `}
          >
            {isMine && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0"
                title={t("multiplayer.yourRoom", "Your room")}
              />
            )}
            <span className="truncate max-w-[120px]">{displayName}</span>
            <span
              className={`text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                isActive
                  ? "bg-amber-700/50 text-amber-200"
                  : "bg-black/30 text-amber-400/60"
              }`}
            >
              {playerCount}
            </span>
          </button>
        );
      })}
    </div>
  );
};
```

**Step 2: Build and verify**

Run: `cd client && npx tsc --noEmit`
Expected: No type errors.

**Step 3: Commit**

```bash
git add client/src/components/gamechat/SceneRoomTabs.tsx
git commit -m "feat: add SceneRoomTabs component for multiplayer tab bar"
```

---

### Task 6: Frontend — Integrate Tabs into MultiplayerGameChat

**Files:**
- Modify: `client/src/components/MultiplayerGameChat.tsx`

**Context:** This is the biggest change. We integrate `useMultiplayerSceneRooms`, render `SceneRoomTabs` between `SessionInfoBar` and `MessageList`, hide `InputArea` when viewing another room, and show a "watching" banner. The existing message state (`messages`, `setMessages`) is replaced by the hook's per-room state for the active tab.

**Step 1: Add imports**

At the top of `MultiplayerGameChat.tsx`, add these imports (around line 13-25):

```typescript
import { useMultiplayerSceneRooms } from "../hooks/useMultiplayerSceneRooms";
import type { SceneRoomInfo } from "../types/gamechat";
import { SceneRoomTabs } from "./gamechat/SceneRoomTabs";
```

**Step 2: Initialize useMultiplayerSceneRooms**

After the existing state declarations (around line 86), add:

```typescript
const {
  activeTabId,
  setActiveTabId,
  sceneRooms: sceneRoomStates,
  isViewingOwnRoom,
  sortedSceneRooms,
  handleSceneRoomSplit,
  handleSceneRoomMerged,
  saveScrollPosition,
  getScrollPosition,
} = useMultiplayerSceneRooms({
  roomId,
  mySceneRoomId: sceneRoomId,
  initialMessages: messages,
});
```

**Step 3: Add tab change handler with scroll position save/restore**

Add a handler function:

```typescript
const messageListRef = useRef<HTMLDivElement>(null);

const handleTabChange = useCallback(
  (tabId: string) => {
    // Save current scroll position
    if (messageListRef.current) {
      saveScrollPosition(messageListRef.current.scrollTop);
    }
    setActiveTabId(tabId);
  },
  [saveScrollPosition, setActiveTabId]
);
```

**Step 4: Handle scene_room_split and scene_room_merged WS events**

In the `useMultiplayerWebSocket` message handler section, find where `scene_room_split` and `scene_room_merged` events are handled (around line 389). Currently they just trigger a sidebar refresh. Add calls to the scene room handlers:

For `scene_room_split`:
```typescript
case "scene_room_split": {
  const newRooms = msg.childRooms || msg.newSceneRooms || [];
  handleSceneRoomSplit(newRooms as SceneRoomInfo[]);
  onNarrativeComplete?.();
  break;
}
```

For `scene_room_merged`:
```typescript
case "scene_room_merged": {
  handleSceneRoomMerged(msg.survivingRoomId, msg.removedRoomId);
  onNarrativeComplete?.();
  break;
}
```

**Step 5: Render SceneRoomTabs and conditional InputArea**

In the JSX return (around line 615-667), add `SceneRoomTabs` after `SessionInfoBar` and conditionally render `InputArea`:

```tsx
<SessionInfoBar ... />

<SceneRoomTabs
  sceneRooms={sortedSceneRooms}
  activeTabId={activeTabId}
  mySceneRoomId={sceneRoomId}
  onTabChange={handleTabChange}
/>

<MessageList ... />

{isViewingOwnRoom ? (
  <InputArea ... />
) : (
  <div className="px-4 py-2.5 bg-black/40 backdrop-blur-sm border-t border-amber-900/30 text-center">
    <span className="text-amber-400/60 text-sm italic">
      {t("multiplayer.watchingRoom", {
        scene: sceneRoomStates.get(activeTabId)?.info.scenarioName || "...",
        defaultValue: `Watching {{scene}}`,
      })}
    </span>
  </div>
)}
```

**Step 6: Build and verify**

Run: `pnpm build`
Expected: No type errors. Full project builds.

**Step 7: Manual test**

Run: `pnpm chat:dev`
1. Start a multiplayer game with 2+ players
2. Verify single room shows no tab bar
3. Trigger a scene split (have a player move to a different location)
4. Verify tab bar appears with 2 tabs
5. Click the other room's tab — input area hidden, "Watching" banner shows
6. Click back to your room — input area returns

**Step 8: Commit**

```bash
git add client/src/components/MultiplayerGameChat.tsx
git commit -m "feat: integrate scene room tabs into multiplayer chat"
```

---

### Task 7: Frontend — WebSocket Multi-Room Event Routing

**Files:**
- Modify: `client/src/hooks/useMultiplayerWebSocket.ts`

**Context:** Currently, all WS events (keeper_stream_start/delta/end, round_complete, etc.) update a single `messages` state. With multi-room support, events include a `sceneRoomId` field. We need to route events to the correct room's message array. The key change: provide a `setMessagesForRoom(sceneRoomId, updater)` callback that the hook uses instead of the direct `setMessages`.

**Step 1: Add a new parameter to UseMultiplayerWebSocketParams**

In `client/src/hooks/useMultiplayerWebSocket.ts`, add to the params interface (around line 35):

```typescript
setMessagesForRoom?: (sceneRoomId: string, updater: Message[] | ((prev: Message[]) => Message[])) => void;
```

**Step 2: Use setMessagesForRoom when available**

Inside the message handler, for events that include a `sceneRoomId` field (`round_complete`, `keeper_stream_start`, `keeper_stream_delta`, `keeper_stream_end`, `keeper_dice_rolls`, `combat_start`, `combat_end`, `round_error`), check if the event's `sceneRoomId` differs from the component's own `sceneRoomId`. If `setMessagesForRoom` is provided and the event's `sceneRoomId` is present, use it:

```typescript
// Helper at top of message handler:
const targetSetMessages = (eventSceneRoomId: string | undefined, updater: Message[] | ((prev: Message[]) => Message[])) => {
  if (setMessagesForRoom && eventSceneRoomId) {
    setMessagesForRoom(eventSceneRoomId, updater);
  } else {
    setMessages(updater);
  }
};
```

Then replace `setMessages(...)` calls in the relevant event handlers with `targetSetMessages(msg.sceneRoomId, ...)`.

**Note:** This is an incremental, backwards-compatible change. If `setMessagesForRoom` is not provided, behavior is identical to current code.

**Step 3: Build and verify**

Run: `pnpm build`
Expected: No type errors.

**Step 4: Commit**

```bash
git add client/src/hooks/useMultiplayerWebSocket.ts
git commit -m "feat: route WS events by sceneRoomId for multi-room support"
```

---

### Task 8: Frontend — Update MultiplayerGamePage to Pass Scene Rooms Data

**Files:**
- Modify: `client/src/views/MultiplayerGamePage.tsx`

**Context:** `MultiplayerGamePage` initializes the game and passes `sceneRoomId` to `MultiplayerGameChat`. The page already fetches `sceneRooms[]` from the game state endpoint (line 83-92). No major changes needed — the `useMultiplayerSceneRooms` hook inside `MultiplayerGameChat` handles its own data fetching. But we need to pass `roomId` to the WS connection URL so the backend can register for all rooms.

**Step 1: Pass roomId to WS URL**

In `MultiplayerGamePage.tsx`, verify that `roomId` is being passed to `MultiplayerGameChat` (it already is, as a prop). Check that the WS connection in `useMultiplayerWebSocket` includes `roomId` in the URL query params.

In `useMultiplayerWebSocket.ts`, find the WebSocket URL construction (around line 85-119). Add `roomId` to the URL params. This requires adding `roomId` to `UseMultiplayerWebSocketParams`:

```typescript
roomId?: string; // Added to params interface
```

And in the URL construction:

```typescript
const wsUrl = `${wsProtocol}//${wsHost}/ws?sessionId=${sessionId}&sceneRoomId=${sceneRoomId}&token=${token}&roomId=${roomId || ""}`;
```

Then in `MultiplayerGameChat.tsx`, pass `roomId` to `useMultiplayerWebSocket`:

```typescript
useMultiplayerWebSocket({
  ...existingParams,
  roomId, // Add this
});
```

**Step 2: Update WebSocketManager to extract roomId**

In `client/server/websocket/WebSocketManager.ts`, in the connection handler, extract `roomId` from URL params:

```typescript
const roomId = url.searchParams.get("roomId");
```

Then after registering for the single sceneRoomId, also register for all rooms:

```typescript
if (sceneRoomId && userId) {
  this.registerMultiplayerClient(sceneRoomId, userId, client);
  // Register for all active rooms in the game
  if (roomId) {
    this.registerMultiplayerClientForAllRooms(roomId, userId, client);
  }
}
```

**Step 3: Build and verify**

Run: `pnpm build`
Expected: No type errors.

**Step 4: Commit**

```bash
git add client/src/views/MultiplayerGamePage.tsx
git add client/src/hooks/useMultiplayerWebSocket.ts
git add client/server/websocket/WebSocketManager.ts
git commit -m "feat: pass roomId through WS for multi-room registration"
```

---

### Task 9: Frontend — GameSidebar "Players Here" Section

**Files:**
- Modify: `client/src/components/GameSidebar.tsx`

**Context:** Add a compact "Players Here" section at the top of the sidebar showing other players in the currently viewed scene room. Each player card shows character name + HP bar + Sanity bar. The sidebar already receives `apiBaseUrl` for multiplayer, so we can fetch player data from the game state endpoint.

**Step 1: Add props for player data**

In `GameSidebar.tsx`, extend the `GameSidebarProps` interface (around line 13):

```typescript
interface GameSidebarProps {
  sessionId: string;
  apiBaseUrl?: string;
  refreshTrigger?: number;
  isMobile?: boolean;
  isOpen?: boolean;
  onClose?: () => void;
  // New: multiplayer player info
  roomPlayers?: Array<{
    characterName: string;
    hp: number;
    maxHp: number;
    san: number;
    maxSan: number;
    isCurrentUser: boolean;
  }>;
}
```

**Step 2: Add the "Players Here" section**

Inside the component's return JSX, before the existing tab content (around line 560, before the Status/Notes/Knowledge/Map tabs), add:

```tsx
{roomPlayers && roomPlayers.length > 1 && (
  <div className="px-3 py-2 border-b border-amber-900/30">
    <h3 className="text-xs font-semibold text-amber-400/70 uppercase tracking-wider mb-1.5">
      {t("sidebar.playersHere", "Players Here")}
    </h3>
    <div className="space-y-1.5">
      {roomPlayers
        .filter((p) => !p.isCurrentUser)
        .map((player) => (
          <div
            key={player.characterName}
            className="flex items-center gap-2 px-2 py-1 rounded bg-black/20"
          >
            <span className="text-xs text-amber-200 truncate flex-1 min-w-0">
              {player.characterName}
            </span>
            <div className="flex gap-1.5 flex-shrink-0">
              {/* HP bar */}
              <div className="flex items-center gap-0.5" title={`HP: ${player.hp}/${player.maxHp}`}>
                <span className="text-[10px] text-red-400">HP</span>
                <div className="w-10 h-1.5 bg-black/40 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${Math.max(0, Math.min(100, (player.hp / player.maxHp) * 100))}%`,
                      backgroundColor:
                        player.hp / player.maxHp > 0.5
                          ? "#22c55e"
                          : player.hp / player.maxHp > 0.25
                            ? "#eab308"
                            : "#ef4444",
                    }}
                  />
                </div>
              </div>
              {/* SAN bar */}
              <div className="flex items-center gap-0.5" title={`SAN: ${player.san}/${player.maxSan}`}>
                <span className="text-[10px] text-blue-400">SAN</span>
                <div className="w-10 h-1.5 bg-black/40 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all duration-300"
                    style={{
                      width: `${Math.max(0, Math.min(100, (player.san / player.maxSan) * 100))}%`,
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        ))}
    </div>
  </div>
)}
```

**Step 3: Provide roomPlayers data from MultiplayerGamePage**

In `MultiplayerGamePage.tsx`, add state + fetch for player data and pass it to `GameSidebar`:

```typescript
const [roomPlayers, setRoomPlayers] = useState<GameSidebarProps["roomPlayers"]>([]);
```

Fetch player data from the game state endpoint (inside the existing initialization or via a separate effect triggered by `sidebarRefreshTrigger`):

```typescript
useEffect(() => {
  if (!roomId || !sceneRoomId) return;
  const fetchPlayers = async () => {
    try {
      const res = await authFetch(`/api/multiplayer/rooms/${roomId}/game/state`);
      const data = await res.json();
      if (data.success) {
        const currentUserId = JSON.parse(localStorage.getItem("user") || "{}").id;
        const myRoom = data.sceneRooms?.find((r: any) =>
          r.memberPlayerIds?.includes(currentUserId)
        );
        if (myRoom && data.players) {
          const players = myRoom.memberPlayerIds
            .map((pid: string) => {
              const p = data.players[pid];
              if (!p) return null;
              return {
                characterName: p.characterName || "Unknown",
                hp: p.profile?.hitPoints?.current ?? p.profile?.hitPoints ?? 0,
                maxHp: p.profile?.hitPoints?.max ?? p.profile?.hitPoints ?? 1,
                san: p.profile?.sanity?.current ?? p.profile?.sanity ?? 0,
                maxSan: p.profile?.sanity?.max ?? p.profile?.sanity ?? 1,
                isCurrentUser: pid === currentUserId,
              };
            })
            .filter(Boolean);
          setRoomPlayers(players);
        }
      }
    } catch (err) {
      console.error("Failed to fetch room players:", err);
    }
  };
  fetchPlayers();
}, [roomId, sceneRoomId, sidebarRefreshTrigger]);
```

Then pass to `GameSidebar`:

```tsx
<GameSidebar
  sessionId={sessionId}
  apiBaseUrl={`/api/multiplayer/rooms/${roomId}`}
  refreshTrigger={sidebarRefreshTrigger}
  roomPlayers={roomPlayers}
  ...
/>
```

**Step 4: Build and verify**

Run: `pnpm build`
Expected: No type errors.

**Step 5: Manual test**

Run: `pnpm chat:dev`
1. Start multiplayer game with 2+ players in same room
2. Verify "Players Here" section shows other players with HP/SAN bars
3. Verify your own character is NOT shown in the section (only others)
4. Verify bars update after a round completes

**Step 6: Commit**

```bash
git add client/src/components/GameSidebar.tsx
git add client/src/views/MultiplayerGamePage.tsx
git commit -m "feat: add Players Here section to multiplayer sidebar"
```

---

### Task 10: Integration Test — Full Multi-Room Flow

**Files:** None (manual testing)

**Context:** End-to-end verification of the complete multi-room tab system.

**Step 1: Full build**

Run: `pnpm build`
Expected: Clean build, no errors.

**Step 2: Start the application**

Run: `pnpm chat:dev`

**Step 3: Test scenario**

1. **Setup:** Create a multiplayer room with 2-3 players. All join and start the game.
2. **Single room:** Verify no tab bar visible. All players see the same chat. Sidebar shows "Players Here" for others.
3. **Scene split:** Have one player move to a different location (triggering a scene split via Director agent).
4. **Tab appears:** Verify a second tab appears for the new room. Both rooms show scene name + player count.
5. **View other room:** Click the other room's tab. Verify:
   - Messages from that room load (lazy fetch)
   - Input area is hidden
   - "Watching {scene}" banner shows
   - Dice animations play when the other room has a round
6. **Live streaming:** While viewing the other room, have those players submit input. Verify narrative streams in real-time.
7. **Switch back:** Click your room's tab. Verify input area returns. Scroll position preserved.
8. **Scene merge:** If rooms merge, verify tabs consolidate back to one.

**Step 4: Commit final state**

```bash
git add -A
git commit -m "feat: complete multiplayer scene room tabs implementation"
```
