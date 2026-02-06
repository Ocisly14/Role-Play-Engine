/**
 * GameSidebar Component - Character status and notes panel
 *
 * Displays character information and a player notes memo pad in separate tabs.
 */

import { useState, useEffect, useRef } from "react";
import { CharacterSheetModal } from "./CharacterSheetModal";
import { authFetch } from "../utils/authFetch";

interface GameSidebarProps {
  sessionId: string;
  apiBaseUrl?: string;
  refreshTrigger?: number; // When this changes, refresh game state
}

type TabType = "status" | "notes" | "clues" | "map";

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
}: GameSidebarProps) {
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
          throw new Error("Failed to fetch memos");
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
          throw new Error("Invalid memo response");
        }
      } catch (err) {
        console.error("Error fetching memos:", err);
        setMemoError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setMemoLoading(false);
      }
    };

    fetchMemos();
    setMemoDraft("");
  }, [apiBaseUrl, sessionId]);

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
        throw new Error("Failed to save memo");
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
        throw new Error("Invalid memo response");
      }
    } catch (err) {
      console.error("Error saving memo:", err);
      setMemoError(err instanceof Error ? err.message : "Unknown error");
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
        throw new Error("Failed to update memo");
      }
      setMemoError(null);
    } catch (err) {
      console.error("Error updating memo:", err);
      setMemoError(err instanceof Error ? err.message : "Unknown error");
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
        throw new Error("Failed to delete memo");
      }
      setMemoError(null);
    } catch (err) {
      console.error("Error deleting memo:", err);
      setMemoError(err instanceof Error ? err.message : "Unknown error");
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
          throw new Error("Failed to fetch game state");
        }

        const data = await response.json();

        if (data.success && data.gameState) {
          setGameState(data.gameState);
          setError(null);
        } else {
          throw new Error("Invalid game state response");
        }
      } catch (err) {
        console.error("Error fetching game state:", err);
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        // Clear loading state and mark as no longer initial load
        if (isInitialLoadRef.current) {
          setLoading(false);
          isInitialLoadRef.current = false;
        }
      }
    };

    fetchGameState();
  }, [apiBaseUrl, sessionId, refreshTrigger]); // Refetch when refreshTrigger changes

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

  return (
    <div className="game-sidebar backdrop-blur-sm border border-slate-200 shadow-md rounded-lg">
      {/* Character Sheet Modal */}
      {showCharacterSheet && (
        <CharacterSheetModal
          sessionId={sessionId}
          apiBaseUrl={apiBaseUrl}
          onClose={() => setShowCharacterSheet(false)}
        />
      )}

      {/* Tab Headers */}
      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg hover:bg-white/70 transition-all ${activeTab === "status" ? "active" : ""}`}
          onClick={() => setActiveTab("status")}
        >
          Character Status
        </button>
        <button
          className={`sidebar-tab backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg hover:bg-white/70 transition-all ${activeTab === "notes" ? "active" : ""}`}
          onClick={() => setActiveTab("notes")}
        >
          Notes
        </button>
        <button
          className={`sidebar-tab backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg hover:bg-white/70 transition-all ${activeTab === "clues" ? "active" : ""}`}
          onClick={() => setActiveTab("clues")}
        >
          Discovered Clues
        </button>
        <button
          className={`sidebar-tab backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg hover:bg-white/70 transition-all ${activeTab === "map" ? "active" : ""}`}
          onClick={() => setActiveTab("map")}
        >
          Map
        </button>
      </div>

      {/* Tab Content */}
      <div className="sidebar-content">
        {activeTab === "status" && (
          <div className="tab-panel status-panel">
            {loading ? (
              <p className="empty-state">Loading...</p>
            ) : error ? (
              <p className="empty-state" style={{ color: "#c41e3a" }}>
                Load failed: {error}
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
                    <h3 style={{ margin: 0 }}>Basic Attributes</h3>
                    <button
                      className="view-character-btn-sidebar"
                      onClick={() => setShowCharacterSheet(true)}
                      title="View full character sheet"
                    >
                      View Character
                    </button>
                  </div>
                  <div className="status-grid">
                    <div className="status-item">
                      <span className="status-label">HP:</span>
                      <span className="status-value">
                        {gameState.playerCharacter.status.hp}/
                        {gameState.playerCharacter.status.maxHp}
                      </span>
                    </div>
                    <div className="status-item">
                      <span className="status-label">MP:</span>
                      <span className="status-value">
                        {gameState.playerCharacter.status.mp || 0}/
                        {gameState.playerCharacter.status.mp || 0}
                      </span>
                    </div>
                    <div className="status-item">
                      <span className="status-label">SAN:</span>
                      <span className="status-value">
                        {gameState.playerCharacter.status.sanity}/
                        {gameState.playerCharacter.status.maxSanity}
                      </span>
                    </div>
                    <div className="status-item">
                      <span className="status-label">LUCK:</span>
                      <span className="status-value">
                        {gameState.playerCharacter.status.luck}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="status-section">
                  <h3>Current Status</h3>
                  <div className="status-list">
                    <div className="status-item-full">
                      <span className="status-label">Location:</span>
                      <span className="status-value">
                        {gameState.currentScenario?.name || "Unknown"}
                      </span>
                    </div>
                    <div className="status-item-full">
                      <span className="status-label">Time:</span>
                      <span className="status-value">
                        {gameState.timeOfDay || "--"}
                      </span>
                    </div>
                    <div className="status-item-full">
                      <span className="status-label">Day:</span>
                      <span className="status-value">
                        Day {gameState.gameDay}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="status-section">
                  <h3>Status Effects</h3>
                  <div className="status-effects">
                    {gameState.playerCharacter.status.conditions.length > 0 ? (
                      <ul style={{ margin: 0, paddingLeft: "20px" }}>
                        {gameState.playerCharacter.status.conditions.map(
                          (condition, idx) => (
                            <li key={idx}>{condition}</li>
                          )
                        )}
                      </ul>
                    ) : (
                      <p className="empty-state">No status effects</p>
                    )}
                  </div>
                </div>

                <div className="status-section">
                  <h3>Weapons</h3>
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
                                  <span>DMG: {weapon.damage}</span>
                                )}
                                {weapon.range && (
                                  <span>Range: {weapon.range}</span>
                                )}
                                {weapon.attacks && (
                                  <span>Attacks: {weapon.attacks}</span>
                                )}
                                {weapon.ammo !== undefined && (
                                  <span>Ammo: {weapon.ammo}</span>
                                )}
                              </div>
                            </div>
                          )
                        )}
                      </div>
                    ) : (
                      <p className="empty-state">No weapons</p>
                    )}
                  </div>
                </div>

                <div className="status-section">
                  <h3>Inventory</h3>
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
                      <p className="empty-state">No items</p>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <p className="empty-state">No data</p>
            )}
          </div>
        )}

        {activeTab === "notes" && (
          <div className="tab-panel notes-panel">
            <div className="clues-section">
              <div className="memo-header">
                <h3>Memo Pad</h3>
              </div>
              <p className="memo-hint">
                Write your own notes here. New entries auto-save when you add
                them.
              </p>
              {memoError && (
                <p className="empty-state" style={{ color: "#c41e3a" }}>
                  Memo error: {memoError}
                </p>
              )}
              {memoLoading ? (
                <p className="empty-state">Loading...</p>
              ) : (
                <>
                  <div className="memo-filters">
                    <div className="memo-filter">
                      <label
                        className="memo-filter-label"
                        htmlFor="memo-day-filter"
                      >
                        Game day
                      </label>
                      <select
                        id="memo-day-filter"
                        className="memo-filter-select"
                        value={memoDayFilter}
                        onChange={(event) =>
                          setMemoDayFilter(event.target.value)
                        }
                      >
                        <option value="all">All days</option>
                        {memoDayOptions.map((day) => (
                          <option key={day} value={String(day)}>
                            Day {day}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="memo-filter">
                      <label
                        className="memo-filter-label"
                        htmlFor="memo-location-filter"
                      >
                        Location
                      </label>
                      <select
                        id="memo-location-filter"
                        className="memo-filter-select"
                        value={memoLocationFilter}
                        onChange={(event) =>
                          setMemoLocationFilter(event.target.value)
                        }
                      >
                        <option value="all">All locations</option>
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
                        Search
                      </label>
                      <input
                        id="memo-search"
                        className="memo-filter-input"
                        type="search"
                        placeholder="Search notes..."
                        value={memoQuery}
                        onChange={(event) => setMemoQuery(event.target.value)}
                      />
                    </div>
                  </div>
                  <div className="memo-compose">
                    <textarea
                      className="memo-input"
                      rows={3}
                      placeholder="Write a new note..."
                      value={memoDraft}
                      onChange={(event) => setMemoDraft(event.target.value)}
                    />
                    <button
                      className="memo-btn memo-btn-primary"
                      onClick={addMemo}
                      disabled={!memoDraft.trim() || !sessionId}
                    >
                      Add Note
                    </button>
                  </div>
                  <div className="memo-list">
                    {memoItems.length > 0 ? (
                      filteredMemoItems.length > 0 ? (
                        filteredMemoItems.map((item, idx) => (
                          <div key={item.id} className="memo-item">
                            <div className="memo-item-header">
                              <span>Note {idx + 1}</span>
                              <button
                                className="memo-btn memo-btn-ghost"
                                onClick={() => removeMemo(item.id)}
                              >
                                Delete
                              </button>
                            </div>
                            {(item.gameDay ||
                              item.gameTime ||
                              item.location) && (
                              <div className="memo-item-meta">
                                {item.gameDay
                                  ? `Day ${item.gameDay}`
                                  : "Day --"}
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
                          No notes match the current filters
                        </p>
                      )
                    ) : (
                      <p className="empty-state">No notes yet</p>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {activeTab === "clues" && (
          <div className="tab-panel clues-panel">
            {loading ? (
              <p className="empty-state">Loading...</p>
            ) : error ? (
              <p className="empty-state" style={{ color: "#c41e3a" }}>
                Load failed: {error}
              </p>
            ) : gameState ? (
              <div className="clues-section">
                <h3>Important Clues</h3>
                <div className="clues-list">
                  {gameState.discoveredClues.length > 0 ? (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "10px",
                      }}
                    >
                      {gameState.discoveredClues.map((clue, idx) => (
                        <div
                          key={idx}
                          style={{
                            padding: "10px",
                            backgroundColor: "#fff",
                            border: "1px solid #ddd",
                            borderRadius: "4px",
                          }}
                        >
                          <div
                            style={{ fontWeight: "bold", marginBottom: "5px" }}
                          >
                            {clue.sourceName}
                            <span
                              style={{
                                marginLeft: "8px",
                                fontSize: "0.8rem",
                                color: "#666",
                                fontWeight: "normal",
                              }}
                            >
                              (
                              {clue.type === "scenario"
                                ? "Scenario Clue"
                                : clue.type === "npc"
                                  ? "NPC Clue"
                                  : "Secret"}
                              )
                            </span>
                          </div>
                          <div
                            style={{
                              fontSize: "0.9rem",
                              color: "#333",
                              marginBottom: "5px",
                            }}
                          >
                            {clue.text}
                          </div>
                          <div style={{ fontSize: "0.75rem", color: "#999" }}>
                            Discovered by: {clue.discoveredBy}
                            {clue.method && ` | Method: ${clue.method}`}
                            {clue.difficulty &&
                              ` | Difficulty: ${clue.difficulty}`}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="empty-state">No clues</p>
                  )}
                </div>
              </div>
            ) : (
              <p className="empty-state">No data</p>
            )}
          </div>
        )}

        {/* Map Tab */}
        {activeTab === "map" && (
          <div className="tab-panel map-panel">
            {loading ? (
              <p className="empty-state">Loading...</p>
            ) : error ? (
              <p className="empty-state" style={{ color: "#c41e3a" }}>
                Load failed: {error}
              </p>
            ) : gameState ? (
              <>
                {/* Macro Map (DynamicWorld modules only) */}
                {gameState.moduleName &&
                gameState.moduleDigest?.macroMapPath ? (
                  <div className="status-section">
                    <h3>Macro Map</h3>
                    <div className="map-display">
                      <img
                        src={`${apiBaseUrl}/maps/${gameState.moduleDigest.macroMapPath}`}
                        alt="Macro Map"
                        style={{
                          width: "100%",
                          height: "auto",
                          borderRadius: "4px",
                          border: "1px solid #ddd",
                          cursor: "pointer",
                        }}
                        onClick={(e) => {
                          // Optional: Open in modal/full screen
                          const img = e.currentTarget;
                          if (img.requestFullscreen) {
                            img.requestFullscreen();
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
                      Macro map not available (module was created without
                      GOOGLE_API_KEY)
                    </p>
                  </div>
                ) : null}

                {/* Current Scene Info */}
                {gameState.currentScenario && (
                  <div className="status-section">
                    <h3>Current Scene</h3>
                    <div className="status-list">
                      <div className="status-item-full">
                        <span className="status-label">Scene Name:</span>
                        <span className="status-value">
                          {gameState.currentScenario.name || "Unknown"}
                        </span>
                      </div>
                      <div className="status-item-full">
                        <span className="status-label">Location:</span>
                        <span className="status-value">
                          {gameState.currentScenario.location || "Unknown"}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="empty-state">No data</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
