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
  setMessagesForRoom: (targetRoomId: string, updater: Message[] | ((prev: Message[]) => Message[])) => void;
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

  // Set messages for any specific room (used for routing WS events by sceneRoomId)
  const setMessagesForRoom = useCallback(
    (targetRoomId: string, updater: Message[] | ((prev: Message[]) => Message[])) => {
      setSceneRooms((prev) => {
        const next = new Map(prev);
        const room = next.get(targetRoomId);
        if (!room) return prev;
        const newMessages =
          typeof updater === "function" ? updater(room.messages) : updater;
        next.set(targetRoomId, { ...room, messages: newMessages });
        return next;
      });
    },
    []
  );

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
    setMessagesForRoom,
    handleSceneRoomSplit,
    handleSceneRoomMerged,
    updateSceneRoomInfo,
    saveScrollPosition,
    getScrollPosition,
    sortedSceneRooms,
  };
}
