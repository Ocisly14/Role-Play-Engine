/**
 * GameSidebar Component - Character status and notes panel
 *
 * Displays character information and a player notes memo pad in separate tabs.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import { authFetch } from "../utils/authFetch";
import { CharacterSheetModal } from "./CharacterSheetModal";

export interface RoomPlayerInfo {
  characterName: string;
  hp: number;
  maxHp: number;
  san: number;
  maxSan: number;
  isCurrentUser: boolean;
}

interface GameSidebarProps {
  sessionId: string;
  apiBaseUrl?: string;
  refreshTrigger?: number; // When this changes, refresh game state
  // New props for mobile drawer
  isMobile?: boolean;
  isOpen?: boolean;
  onClose?: () => void;
  // Multiplayer: other players in the scene room
  roomPlayers?: RoomPlayerInfo[];
}

type TabType = "status" | "notes" | "knowledge" | "map";

interface Weapon {
  name: string;
  damage?: string;
  range?: string;
  attacks?: number;
  ammo?: number;
  malfunction?: string;
}

interface InventoryItem {
  name: string;
  quantity?: number;
  description?: string;
}

interface CharacterStatus {
  hp: number;
  maxHp: number;
  sanity: number;
  maxSanity: number;
  luck: number;
  mp?: number;
  conditions: string[];
}

interface CharacterProfile {
  id: string;
  name: string;
  status: CharacterStatus;
  skills: Record<string, number>;
  occupation?: string;
  weapons?: Weapon[];
  inventory?: InventoryItem[];
}

interface DiscoveredClue {
  text: string;
  type: "scenario" | "npc" | "secret";
  sourceName: string;
  discoveredBy: string;
  discoveredAt: string;
  category?:
    | "physical"
    | "witness"
    | "document"
    | "environment"
    | "knowledge"
    | "observation";
  difficulty?: "automatic" | "regular" | "hard" | "extreme";
  method?: string;
}

interface CurrentScenario {
  name: string;
  location: string;
  mapImagePath?: string;
  sceneImage?: {
    path: string;
    mimeType?: string;
    generatedAt?: string;
  };
  showMap?: boolean;
}

interface GameEndingInfo {
  isEnded: boolean;
  endingType: "death" | "time_limit" | "victory" | "failure" | "other";
  reason: string;
  timestamp: string;
}

interface ModuleDigest {
  moduleNotes: string;
  keeperGuidance: string;
  moduleLimitations: string;
  introduction: string;
  macroMapPath?: string; // Module-relative path to macro map (e.g. "Map/[Module Name].png")
}

// GameState interface - compatible with both GameState and DynamicGameState
interface GameState {
  playerCharacter: CharacterProfile;
  discoveredClues: DiscoveredClue[];
  currentScenario: CurrentScenario | null;
  gameDay: number;
  timeOfDay: string;
  gameEnding: GameEndingInfo | null;
  // Additional fields from DynamicGameState (optional, for compatibility)
  moduleName?: string;
  moduleDigest?: ModuleDigest;
  npcCharacters?: CharacterProfile[];
  tension?: number;
  // DynamicWorld-specific fields (ignored by frontend but present in response)
  [key: string]: any; // Allow additional fields for DynamicGameState compatibility
}

export function GameSidebar({
  sessionId,
  apiBaseUrl = "/api",
  refreshTrigger,
  isMobile = false,
  isOpen = true,
  onClose,
  roomPlayers,
}: GameSidebarProps) {
  const { t, i18n } = useTranslation(["game", "common"]);
  const [activeTab, setActiveTab] = useState<TabType>("status");
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCharacterSheet, setShowCharacterSheet] = useState(false);
  const [memoDraft, setMemoDraft] = useState("");
  const [memoItems, setMemoItems] = useState<
    Array<{
      id: string;
      text: string;
      gameDay?: number | null;
      gameTime?: string | null;
      location?: string | null;
    }>
  >([]);
  const [memoLoading, setMemoLoading] = useState(false);
  const [memoError, setMemoError] = useState<string | null>(null);
  const [memoDayFilter, setMemoDayFilter] = useState("all");
  const [memoLocationFilter, setMemoLocationFilter] = useState("all");
  const [memoQuery, setMemoQuery] = useState("");
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeMessages, setKnowledgeMessages] = useState<
    Array<{ role: "user" | "assistant"; content: string }>
  >([]);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const knowledgeChatEndRef = useRef<HTMLDivElement>(null);
  const isInitialLoadRef = useRef(true);
  const memoSaveTimers = useRef<Record<string, number>>({});

  useEffect(() => {
    const fetchMemos = async () => {
      if (!sessionId) {
        setMemoItems([]);
        return;
      }
      try {
        setMemoLoading(true);
        const response = await authFetch(
          `${apiBaseUrl}/memos?sessionId=${encodeURIComponent(sessionId)}`
        );
        if (!response.ok) {
          throw new Error(t("game:sidebar.memo.errors.fetchFailed"));
        }
        const data = await response.json();
        if (data.success && Array.isArray(data.memos)) {
          setMemoItems(
            data.memos.map(
              (memo: {
                id: string;
                text: string;
                gameDay?: number | null;
                gameTime?: string | null;
                location?: string | null;
              }) => ({
                id: memo.id,
                text: memo.text,
                gameDay: memo.gameDay ?? null,
                gameTime: memo.gameTime ?? null,
                location: memo.location ?? null,
              })
            )
          );
          setMemoError(null);
        } else {
          throw new Error(t("game:sidebar.memo.errors.invalidResponse"));
        }
      } catch (err) {
        console.error("Error fetching memos:", err);
        setMemoError(
          err instanceof Error ? err.message : t("common:error.generic")
        );
      } finally {
        setMemoLoading(false);
      }
    };

    fetchMemos();
    setMemoDraft("");
  }, [apiBaseUrl, sessionId, t]);

  useEffect(() => {
    return () => {
      Object.values(memoSaveTimers.current).forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      memoSaveTimers.current = {};
    };
  }, []);

  const addMemo = async () => {
    const trimmed = memoDraft.trim();
    if (!trimmed) return;
    const memoLocation =
      gameState?.currentScenario?.location ||
      gameState?.currentScenario?.name ||
      null;
    try {
      const response = await authFetch(`${apiBaseUrl}/memos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          text: trimmed,
          gameDay: gameState?.gameDay ?? null,
          gameTime: gameState?.timeOfDay ?? null,
          location: memoLocation,
        }),
      });
      if (!response.ok) {
        throw new Error(t("game:sidebar.memo.errors.saveFailed"));
      }
      const data = await response.json();
      if (data.success && data.memo) {
        setMemoItems((prev) => [
          ...prev,
          {
            id: data.memo.id,
            text: data.memo.text,
            gameDay: data.memo.gameDay ?? null,
            gameTime: data.memo.gameTime ?? null,
            location: data.memo.location ?? null,
          },
        ]);
        setMemoDraft("");
        setMemoError(null);
      } else {
        throw new Error(t("game:sidebar.memo.errors.invalidResponse"));
      }
    } catch (err) {
      console.error("Error saving memo:", err);
      setMemoError(
        err instanceof Error ? err.message : t("common:error.generic")
      );
    }
  };

  const persistMemo = async (id: string, text: string) => {
    try {
      const response = await authFetch(
        `${apiBaseUrl}/memos/${encodeURIComponent(id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        }
      );
      if (!response.ok) {
        throw new Error(t("game:sidebar.memo.errors.updateFailed"));
      }
      setMemoError(null);
    } catch (err) {
      console.error("Error updating memo:", err);
      setMemoError(
        err instanceof Error ? err.message : t("common:error.generic")
      );
    }
  };

  const updateMemo = (id: string, text: string) => {
    setMemoItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, text } : item))
    );
    if (memoSaveTimers.current[id]) {
      window.clearTimeout(memoSaveTimers.current[id]);
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    memoSaveTimers.current[id] = window.setTimeout(() => {
      persistMemo(id, trimmed);
    }, 600);
  };

  const removeMemo = async (id: string) => {
    setMemoItems((prev) => prev.filter((item) => item.id !== id));
    if (memoSaveTimers.current[id]) {
      window.clearTimeout(memoSaveTimers.current[id]);
      delete memoSaveTimers.current[id];
    }
    try {
      const response = await authFetch(
        `${apiBaseUrl}/memos/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
        }
      );
      if (!response.ok) {
        throw new Error(t("game:sidebar.memo.errors.deleteFailed"));
      }
      setMemoError(null);
    } catch (err) {
      console.error("Error deleting memo:", err);
      setMemoError(
        err instanceof Error ? err.message : t("common:error.generic")
      );
    }
  };

  const askKnowledge = async () => {
    const trimmed = knowledgeQuery.trim();
    if (!trimmed || !sessionId) return;

    setKnowledgeQuery("");
    setKnowledgeMessages((prev) => [
      ...prev,
      { role: "user", content: trimmed },
    ]);
    setKnowledgeError(null);

    setTimeout(() => {
      knowledgeChatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 0);

    try {
      setKnowledgeLoading(true);

      const response = await authFetch(`${apiBaseUrl}/rag/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          question: trimmed,
          topK: 4,
          language: i18n.language?.startsWith("en") ? "en" : "zh",
        }),
      });

      if (!response.ok) {
        throw new Error(t("game:sidebar.knowledge.errors.askFailed"));
      }

      const data = await response.json();
      if (!data?.success || typeof data.answer !== "string") {
        throw new Error(t("game:sidebar.knowledge.errors.invalidResponse"));
      }

      setKnowledgeMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.answer },
      ]);
    } catch (err) {
      console.error("Error asking session knowledge:", err);
      setKnowledgeError(
        err instanceof Error ? err.message : t("common:error.generic")
      );
    } finally {
      setKnowledgeLoading(false);
      setTimeout(() => {
        knowledgeChatEndRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 0);
    }
  };

  // Fetch game state from backend
  useEffect(() => {
    const fetchGameState = async () => {
      try {
        // Only show loading on initial load
        if (isInitialLoadRef.current) {
          setLoading(true);
        }

        const response = await authFetch(`${apiBaseUrl}/gamestate`);

        if (!response.ok) {
          throw new Error(t("game:sidebar.errors.fetchGameStateFailed"));
        }

        const data = await response.json();

        if (data.success && data.gameState) {
          setGameState(data.gameState);
          setError(null);
        } else {
          throw new Error(t("game:sidebar.errors.invalidGameState"));
        }
      } catch (err) {
        console.error("Error fetching game state:", err);
        setError(
          err instanceof Error ? err.message : t("common:error.generic")
        );
      } finally {
        // Clear loading state and mark as no longer initial load
        if (isInitialLoadRef.current) {
          setLoading(false);
          isInitialLoadRef.current = false;
        }
      }
    };

    fetchGameState();
  }, [apiBaseUrl, sessionId, refreshTrigger, t]); // Refetch when refreshTrigger changes

  const memoDayOptions = Array.from(
    new Set(
      memoItems
        .map((item) => item.gameDay)
        .filter((day): day is number => typeof day === "number")
    )
  ).sort((a, b) => a - b);

  const memoLocationOptions = Array.from(
    new Set(
      memoItems
        .map((item) => item.location?.trim())
        .filter((location): location is string => Boolean(location))
    )
  ).sort((a, b) => a.localeCompare(b));

  const normalizedMemoQuery = memoQuery.trim().toLowerCase();
  const filteredMemoItems = memoItems.filter((item) => {
    if (memoDayFilter !== "all" && item.gameDay !== Number(memoDayFilter)) {
      return false;
    }
    if (
      memoLocationFilter !== "all" &&
      (item.location?.trim() ?? "") !== memoLocationFilter
    ) {
      return false;
    }
    if (normalizedMemoQuery) {
      return item.text.toLowerCase().includes(normalizedMemoQuery);
    }
    return true;
  });

  // Determine drawer state classes for mobile
  const drawerClass = isMobile
    ? isOpen
      ? "sidebar-drawer-open"
      : "sidebar-drawer-closed"
    : "";

  return (
    <div
      className={`game-sidebar backdrop-blur-sm border border-slate-200 shadow-md rounded-lg ${drawerClass}`}
    >
      {/* Character Sheet Modal */}
      {showCharacterSheet && (
        <CharacterSheetModal
          sessionId={sessionId}
          apiBaseUrl={apiBaseUrl}
          onClose={() => setShowCharacterSheet(false)}
        />
      )}

      {/* Close button - only visible on mobile */}
      {isMobile && (
        <button
          className="sidebar-close-btn"
          onClick={onClose}
          aria-label={t("game:sidebar.close")}
        >
          ×
        </button>
      )}

      {/* Players Here — multiplayer only */}
      {roomPlayers && roomPlayers.length > 1 && (
        <div className="px-3 py-2 border-b border-amber-900/30">
          <h3 className="text-xs font-semibold text-amber-400/70 uppercase tracking-wider mb-1.5">
            {t("game:sidebar.playersHere", "Players Here")}
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

      {/* Tab Headers */}
      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg hover:bg-white/70 transition-all ${activeTab === "status" ? "active" : ""}`}
          onClick={() => setActiveTab("status")}
        >
          {t("game:sidebar.tabs.status")}
        </button>
        <button
          className={`sidebar-tab backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg hover:bg-white/70 transition-all ${activeTab === "notes" ? "active" : ""}`}
          onClick={() => setActiveTab("notes")}
        >
          {t("game:sidebar.tabs.notes")}
        </button>
        <button
          className={`sidebar-tab backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg hover:bg-white/70 transition-all ${activeTab === "knowledge" ? "active" : ""}`}
          onClick={() => setActiveTab("knowledge")}
        >
          {t("game:sidebar.tabs.knowledge")}
        </button>
        <button
          className={`sidebar-tab backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg hover:bg-white/70 transition-all ${activeTab === "map" ? "active" : ""}`}
          onClick={() => setActiveTab("map")}
        >
          {t("game:sidebar.tabs.map")}
        </button>
      </div>

      {/* Tab Content */}
      <div className="sidebar-content">
        {activeTab === "status" && (
          <div className="tab-panel status-panel">
            {loading ? (
              <p className="empty-state">{t("common:loading.loading")}</p>
            ) : error ? (
              <p className="empty-state" style={{ color: "#c41e3a" }}>
                {t("game:sidebar.errors.loadFailed")}: {error}
              </p>
            ) : gameState ? (
              <>
                <div className="status-section">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "12px",
                    }}
                  >
                    <h3 style={{ margin: 0 }}>
                      {t("game:sidebar.status.basicAttributes")}
                    </h3>
                    <button
                      className="view-character-btn-sidebar"
                      onClick={() => setShowCharacterSheet(true)}
                      title={t("game:sidebar.status.viewCharacterTitle")}
                    >
                      {t("game:sidebar.status.viewCharacter")}
                    </button>
                  </div>
                  <div className="status-grid">
                    <div className="status-item">
                      <span className="status-label">
                        {t("game:sidebar.status.hp")}
                      </span>
                      <span className="status-value">
                        {gameState.playerCharacter.status.hp}/
                        {gameState.playerCharacter.status.maxHp}
                      </span>
                    </div>
                    <div className="status-item">
                      <span className="status-label">
                        {t("game:sidebar.status.mp")}
                      </span>
                      <span className="status-value">
                        {gameState.playerCharacter.status.mp || 0}/
                        {gameState.playerCharacter.status.mp || 0}
                      </span>
                    </div>
                    <div className="status-item">
                      <span className="status-label">
                        {t("game:sidebar.status.san")}
                      </span>
                      <span className="status-value">
                        {gameState.playerCharacter.status.sanity}/
                        {gameState.playerCharacter.status.maxSanity}
                      </span>
                    </div>
                    <div className="status-item">
                      <span className="status-label">
                        {t("game:sidebar.status.luck")}
                      </span>
                      <span className="status-value">
                        {gameState.playerCharacter.status.luck}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="status-section">
                  <h3>{t("game:sidebar.status.currentStatus")}</h3>
                  <div className="status-list">
                    <div className="status-item-full">
                      <span className="status-label">
                        {t("game:sidebar.status.location")}
                      </span>
                      <span className="status-value">
                        {gameState.currentScenario?.name ||
                          t("game:sidebar.status.unknown")}
                      </span>
                    </div>
                    <div className="status-item-full">
                      <span className="status-label">
                        {t("game:sidebar.status.time")}
                      </span>
                      <span className="status-value">
                        {gameState.timeOfDay || "--"}
                      </span>
                    </div>
                    <div className="status-item-full">
                      <span className="status-label">
                        {t("game:sidebar.status.day")}
                      </span>
                      <span className="status-value">
                        {t("game:sidebar.dayNumber", {
                          day: gameState.gameDay,
                        })}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="status-section">
                  <h3>{t("game:sidebar.status.statusEffects")}</h3>
                  <div className="status-effects">
                    {/* Fatigue badge from staminaState */}
                    {gameState.staminaState?.fatigueActive && (
                      <div
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                          background: "#fef3c7",
                          border: "1px solid #f59e0b",
                          borderRadius: "9999px",
                          padding: "2px 10px",
                          fontSize: "12px",
                          color: "#92400e",
                          marginBottom: "4px",
                        }}
                        title={t("game:sidebar.status.fatiguedDesc")}
                      >
                        😴 {t("game:sidebar.status.fatigued")}
                      </div>
                    )}
                    {gameState.playerCharacter.status.conditions.length > 0 ? (
                      <ul style={{ margin: 0, paddingLeft: "20px" }}>
                        {gameState.playerCharacter.status.conditions.map(
                          (condition, idx) => (
                            <li key={idx}>{condition}</li>
                          )
                        )}
                      </ul>
                    ) : !gameState.staminaState?.fatigueActive ? (
                      <p className="empty-state">
                        {t("game:sidebar.status.noStatusEffects")}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="status-section">
                  <h3>{t("game:sidebar.status.weapons")}</h3>
                  <div className="weapons-list">
                    {gameState.playerCharacter.weapons &&
                    gameState.playerCharacter.weapons.length > 0 ? (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "8px",
                        }}
                      >
                        {gameState.playerCharacter.weapons.map(
                          (weapon, idx) => (
                            <div
                              key={idx}
                              style={{
                                padding: "8px 10px",
                                backgroundColor: "#fff",
                                border: "1px solid var(--accent)",
                                borderRadius: "3px",
                              }}
                            >
                              <div
                                style={{
                                  fontWeight: "bold",
                                  marginBottom: "4px",
                                  fontSize: "0.9rem",
                                }}
                              >
                                {weapon.name}
                              </div>
                              <div
                                style={{
                                  fontSize: "0.75rem",
                                  color: "#666",
                                  display: "flex",
                                  flexWrap: "wrap",
                                  gap: "8px",
                                }}
                              >
                                {weapon.damage && (
                                  <span>
                                    {t("game:sidebar.status.dmg")}{" "}
                                    {weapon.damage}
                                  </span>
                                )}
                                {weapon.range && (
                                  <span>
                                    {t("game:sidebar.status.range")}{" "}
                                    {weapon.range}
                                  </span>
                                )}
                                {weapon.attacks && (
                                  <span>
                                    {t("game:sidebar.status.attacks")}{" "}
                                    {weapon.attacks}
                                  </span>
                                )}
                                {weapon.ammo !== undefined && (
                                  <span>
                                    {t("game:sidebar.status.ammo")}{" "}
                                    {weapon.ammo}
                                  </span>
                                )}
                              </div>
                            </div>
                          )
                        )}
                      </div>
                    ) : (
                      <p className="empty-state">
                        {t("game:sidebar.status.noWeapons")}
                      </p>
                    )}
                  </div>
                </div>

                <div className="status-section">
                  <h3>{t("game:sidebar.status.inventory")}</h3>
                  <div className="inventory-list">
                    {gameState.playerCharacter.inventory &&
                    gameState.playerCharacter.inventory.length > 0 ? (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "6px",
                        }}
                      >
                        {gameState.playerCharacter.inventory.map(
                          (item, idx) => (
                            <div
                              key={idx}
                              style={{
                                padding: "6px 10px",
                                backgroundColor: "#fff",
                                border: "1px solid #ddd",
                                borderRadius: "3px",
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                              }}
                            >
                              <span
                                style={{
                                  fontSize: "0.85rem",
                                  fontWeight: "500",
                                }}
                              >
                                {item.name}
                              </span>
                              {item.quantity && item.quantity > 1 && (
                                <span
                                  style={{
                                    fontSize: "0.75rem",
                                    color: "#666",
                                    backgroundColor: "var(--header-bg)",
                                    padding: "2px 6px",
                                    borderRadius: "3px",
                                    fontWeight: "bold",
                                  }}
                                >
                                  x{item.quantity}
                                </span>
                              )}
                            </div>
                          )
                        )}
                      </div>
                    ) : (
                      <p className="empty-state">
                        {t("game:sidebar.status.noItems")}
                      </p>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <p className="empty-state">{t("game:sidebar.noData")}</p>
            )}
          </div>
        )}

        {activeTab === "notes" && (
          <div className="tab-panel notes-panel">
            <div className="clues-section">
              <div className="memo-header">
                <h3>{t("game:sidebar.memo.title")}</h3>
              </div>
              <p className="memo-hint">{t("game:sidebar.memo.hint")}</p>
              {memoError && (
                <p className="empty-state" style={{ color: "#c41e3a" }}>
                  {t("game:sidebar.memo.errorPrefix")} {memoError}
                </p>
              )}
              {memoLoading ? (
                <p className="empty-state">{t("common:loading.loading")}</p>
              ) : (
                <>
                  <div className="memo-filters">
                    <div className="memo-filter">
                      <label
                        className="memo-filter-label"
                        htmlFor="memo-day-filter"
                      >
                        {t("game:sidebar.memo.gameDay")}
                      </label>
                      <select
                        id="memo-day-filter"
                        className="memo-filter-select"
                        value={memoDayFilter}
                        onChange={(event) =>
                          setMemoDayFilter(event.target.value)
                        }
                      >
                        <option value="all">
                          {t("game:sidebar.memo.allDays")}
                        </option>
                        {memoDayOptions.map((day) => (
                          <option key={day} value={String(day)}>
                            {t("game:sidebar.dayNumber", { day })}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="memo-filter">
                      <label
                        className="memo-filter-label"
                        htmlFor="memo-location-filter"
                      >
                        {t("game:sidebar.memo.location")}
                      </label>
                      <select
                        id="memo-location-filter"
                        className="memo-filter-select"
                        value={memoLocationFilter}
                        onChange={(event) =>
                          setMemoLocationFilter(event.target.value)
                        }
                      >
                        <option value="all">
                          {t("game:sidebar.memo.allLocations")}
                        </option>
                        {memoLocationOptions.map((location) => (
                          <option key={location} value={location}>
                            {location}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="memo-search">
                      <label
                        className="memo-filter-label"
                        htmlFor="memo-search"
                      >
                        {t("game:sidebar.memo.search")}
                      </label>
                      <input
                        id="memo-search"
                        className="memo-filter-input"
                        type="search"
                        placeholder={t("game:sidebar.memo.searchPlaceholder")}
                        value={memoQuery}
                        onChange={(event) => setMemoQuery(event.target.value)}
                      />
                    </div>
                  </div>
                  <div className="memo-compose">
                    <textarea
                      className="memo-input"
                      rows={3}
                      placeholder={t("game:sidebar.memo.newNotePlaceholder")}
                      value={memoDraft}
                      onChange={(event) => setMemoDraft(event.target.value)}
                    />
                    <button
                      className="memo-btn memo-btn-primary"
                      onClick={addMemo}
                      disabled={!memoDraft.trim() || !sessionId}
                    >
                      {t("game:sidebar.memo.addNote")}
                    </button>
                  </div>
                  <div className="memo-list">
                    {memoItems.length > 0 ? (
                      filteredMemoItems.length > 0 ? (
                        filteredMemoItems.map((item, idx) => (
                          <div key={item.id} className="memo-item">
                            <div className="memo-item-header">
                              <span>
                                {t("game:sidebar.memo.noteNumber", {
                                  number: idx + 1,
                                })}
                              </span>
                              <button
                                className="memo-btn memo-btn-ghost"
                                onClick={() => removeMemo(item.id)}
                              >
                                {t("common:button.delete")}
                              </button>
                            </div>
                            {(item.gameDay ||
                              item.gameTime ||
                              item.location) && (
                              <div className="memo-item-meta">
                                {item.gameDay
                                  ? t("game:sidebar.dayNumber", {
                                      day: item.gameDay,
                                    })
                                  : t("game:sidebar.dayUnknown")}
                                {item.gameTime ? ` · ${item.gameTime}` : ""}
                                {item.location ? ` · ${item.location}` : ""}
                              </div>
                            )}
                            <textarea
                              className="memo-input memo-input-item"
                              rows={3}
                              value={item.text}
                              onChange={(event) =>
                                updateMemo(item.id, event.target.value)
                              }
                            />
                          </div>
                        ))
                      ) : (
                        <p className="empty-state">
                          {t("game:sidebar.memo.noNotesMatchFilters")}
                        </p>
                      )
                    ) : (
                      <p className="empty-state">
                        {t("game:sidebar.memo.noNotesYet")}
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {activeTab === "knowledge" && (
          <div
            className="tab-panel"
            style={{
              display: "flex",
              flexDirection: "column",
              height: "100%",
              padding: 0,
              overflow: "hidden",
            }}
          >
            {/* Chat message history */}
            <div
              className="messages-scroll-area"
              style={{ flex: 1, paddingBottom: "12px" }}
            >
              {knowledgeMessages.length === 0 && (
                <div className="empty-chat-prompt">
                  <p>{t("game:sidebar.knowledge.hint")}</p>
                </div>
              )}

              {knowledgeMessages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`chat-message ${msg.role === "user" ? "character" : "keeper"}`}
                >
                  <div className="message-meta">
                    <span className="sender-name">
                      {msg.role === "user"
                        ? `📝 ${t("game:sidebar.knowledge.you")}`
                        : `🔍 ${t("game:sidebar.knowledge.assistant")}`}
                    </span>
                  </div>
                  <div
                    className={`message-text backdrop-blur-sm border border-slate-200 shadow-md rounded-lg px-[18px] py-[14px] ${
                      msg.role === "user"
                        ? "bg-[rgba(232,220,196,0.5)]"
                        : "bg-white/50"
                    }`}
                  >
                    <ReactMarkdown className="markdown-content">
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                </div>
              ))}

              {knowledgeLoading && (
                <div className="chat-message keeper loading">
                  <div className="message-meta">
                    <span className="sender-name">
                      🔍 {t("game:sidebar.knowledge.assistant")}
                    </span>
                  </div>
                  <div className="message-text backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg px-[18px] py-[14px]">
                    <span className="typing-indicator">
                      <span>•</span>
                      <span>•</span>
                      <span>•</span>
                    </span>
                  </div>
                </div>
              )}

              {knowledgeError && (
                <div className="error-message">{knowledgeError}</div>
              )}

              <div ref={knowledgeChatEndRef} />
            </div>

            {/* Input area */}
            <div className="px-2 pb-2 pt-1">
              <div className="rounded-3xl border border-white/30 backdrop-blur-md shadow-[0_5px_13px_rgba(15,23,42,0.55)] px-2 pb-2 pt-2">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    askKnowledge();
                  }}
                  className="relative overflow-hidden rounded-2xl border border-white/50 shadow-[0_6px_15px_rgba(15,23,42,0.25)] bg-white/80 supports-[backdrop-filter]:bg-white/55 supports-[backdrop-filter]:backdrop-blur-2xl"
                >
                  <textarea
                    className="select-none text-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 w-full min-h-[64px] resize-none rounded-md bg-transparent border-0 py-2 px-3 shadow-none focus-visible:ring-0"
                    value={knowledgeQuery}
                    onChange={(e) => setKnowledgeQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        askKnowledge();
                      }
                    }}
                    placeholder={t("game:sidebar.knowledge.queryPlaceholder")}
                    disabled={knowledgeLoading}
                  />
                  <div className="flex items-center p-1.5 pt-0">
                    <button
                      type="submit"
                      disabled={knowledgeLoading || !knowledgeQuery.trim()}
                      className="inline-flex items-center justify-center whitespace-nowrap font-medium transition-all focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 backdrop-blur-md bg-white/50 border border-slate-200 text-slate-900 shadow-md hover:bg-white/70 hover:border-slate-300 hover:-translate-y-0.5 rounded-xl px-3 text-xs ml-auto gap-0.5 h-[30px]"
                    >
                      {t("game:sidebar.knowledge.ask")}
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="size-3.5"
                      >
                        <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
                        <path d="m21.854 2.147-10.94 10.939" />
                      </svg>
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        )}

        {/* Map Tab */}
        {activeTab === "map" && (
          <div className="tab-panel map-panel">
            {loading ? (
              <p className="empty-state">{t("common:loading.loading")}</p>
            ) : error ? (
              <p className="empty-state" style={{ color: "#c41e3a" }}>
                {t("game:sidebar.errors.loadFailed")}: {error}
              </p>
            ) : gameState ? (
              <>
                {/* Macro Map (DynamicWorld modules only) */}
                {gameState.moduleName &&
                gameState.moduleDigest?.macroMapPath ? (
                  <div className="status-section">
                    <h3>{t("game:sidebar.map.macroMap")}</h3>
                    <div className="map-display">
                      <img
                        src={`/api/maps/${gameState.moduleDigest.macroMapPath}`}
                        alt={t("game:sidebar.map.macroMapAlt")}
                        style={{
                          width: "100%",
                          height: "auto",
                          borderRadius: "4px",
                          border: "1px solid #ddd",
                          cursor: "pointer",
                        }}
                        onClick={(e) => {
                          const img = e.currentTarget;
                          if (document.fullscreenElement) {
                            void document.exitFullscreen();
                            return;
                          }
                          if (img.requestFullscreen) {
                            void img.requestFullscreen();
                          }
                        }}
                        onError={(e) => {
                          console.error("Failed to load macro map");
                          e.currentTarget.style.display = "none";
                        }}
                      />
                    </div>
                  </div>
                ) : gameState.moduleName ? (
                  <div className="status-section">
                    <p className="empty-state">
                      {t("game:sidebar.map.macroMapUnavailable")}
                    </p>
                  </div>
                ) : null}

                {/* Current Scene Info */}
                {gameState.currentScenario && (
                  <div className="status-section">
                    <h3>{t("game:sidebar.map.currentScene")}</h3>
                    <div className="status-list">
                      <div className="status-item-full">
                        <span className="status-label">
                          {t("game:sidebar.map.sceneName")}
                        </span>
                        <span className="status-value">
                          {gameState.currentScenario.name ||
                            t("game:sidebar.status.unknown")}
                        </span>
                      </div>
                      <div className="status-item-full">
                        <span className="status-label">
                          {t("game:sidebar.status.location")}
                        </span>
                        <span className="status-value">
                          {gameState.currentScenario.location ||
                            t("game:sidebar.status.unknown")}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="empty-state">{t("game:sidebar.noData")}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
