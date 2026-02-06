import React, { useState } from "react";
import { authFetch } from "../utils/authFetch";
import { CharacterSheetModal } from "../components/CharacterSheetModal";
import { FrameImage } from "../components/FrameImage";

interface HomeProps {
  onCreate: () => void;
  onStartGame: () => void;
  onContinueGame: () => void;
  onManageMods: () => void;
}

interface Character {
  character_id: string;
  name: string;
  occupation?: string;
  age?: number;
  attributes?: string;
  status?: string;
}

const Homes: React.FC<HomeProps> = ({
  onCreate,
  onStartGame,
  onContinueGame,
  onManageMods,
}) => {
  const [showCharacterBrowser, setShowCharacterBrowser] = useState(false);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string>("");
  const [showCharacterSheet, setShowCharacterSheet] = useState(false);

  const handleStartGame = () => {
    // Just trigger the character selector
    onStartGame();
  };

  const handleViewCharacters = async () => {
    setShowCharacterBrowser(true);
    setLoading(true);

    try {
      const response = await authFetch("/api/characters");
      const data = await response.json();

      if (data.success) {
        setCharacters(data.characters || []);
      }
    } catch (error) {
      console.error("Error loading characters:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleViewCharacterSheet = (characterId: string) => {
    setSelectedCharacterId(characterId);
    setShowCharacterSheet(true);
  };

  const parseAttributes = (attrStr?: string) => {
    if (!attrStr) return null;
    try {
      return JSON.parse(attrStr);
    } catch {
      return null;
    }
  };

  const parseStatus = (statusStr?: string) => {
    if (!statusStr) return null;
    try {
      return JSON.parse(statusStr);
    } catch {
      return null;
    }
  };

  return (
    <>
      <div className="home">
        <div className="home-frame">
          <FrameImage />
          <div className="home-actions">
            <button className="primary" onClick={handleStartGame}>
              New Game
            </button>
            <button className="secondary" onClick={onContinueGame}>
              Continue Game
            </button>
            <button className="secondary" onClick={onManageMods}>
              Manage Modules
            </button>
            <button className="secondary" onClick={onCreate}>
              Create Character
            </button>
            <button className="secondary" onClick={handleViewCharacters}>
              View Characters
            </button>
          </div>
        </div>
      </div>

      {/* Character Browser Modal */}
      {showCharacterBrowser && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm supports-[backdrop-filter]:bg-black/30 supports-[backdrop-filter]:backdrop-blur-sm flex items-center justify-center p-5">
          <div className="fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] max-w-[1000px] max-h-[90vh] w-full overflow-y-auto rounded-3xl p-0 supports-[backdrop-filter]:backdrop-blur-lg border border-white/50 bg-white/80 shadow-[0_30px_80px_rgba(15,23,42,0.25)] supports-[backdrop-filter]:bg-white/55 flex flex-col">
            <div className="p-12 space-y-12">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <h2 className="text-2xl font-semibold m-0">
                    Your Characters
                  </h2>
                  <p className="text-sm text-gray-600 italic m-0">
                    {characters.length}{" "}
                    {characters.length === 1 ? "investigator" : "investigators"}{" "}
                    ready
                  </p>
                </div>
                <button
                  onClick={() => setShowCharacterBrowser(false)}
                  className="close-button"
                  aria-label="Close"
                >
                  ×
                </button>
              </div>

              <div className="overflow-y-auto flex-1">
                {loading ? (
                  <div
                    style={{
                      textAlign: "center",
                      padding: "60px 20px",
                      fontSize: "1.1rem",
                      color: "var(--title)",
                    }}
                  >
                    <div
                      style={{
                        fontSize: "3rem",
                        marginBottom: "20px",
                        animation: "spin 1s linear infinite",
                      }}
                    >
                      🎲
                    </div>
                    Loading characters...
                  </div>
                ) : characters.length === 0 ? (
                  <div
                    style={{
                      textAlign: "center",
                      padding: "60px 20px",
                      color: "#999",
                    }}
                  >
                    <div style={{ fontSize: "4rem", marginBottom: "20px" }}>
                      📋
                    </div>
                    <p
                      style={{
                        fontSize: "1.2rem",
                        marginBottom: "8px",
                        color: "var(--title)",
                      }}
                    >
                      No characters created yet
                    </p>
                    <p style={{ fontSize: "0.95rem" }}>
                      Create your first investigator to begin your journey
                    </p>
                  </div>
                ) : (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fill, minmax(300px, 1fr))",
                      gap: "20px",
                    }}
                  >
                    {characters.map((char, index) => {
                      const attrs = parseAttributes(char.attributes);
                      const status = parseStatus(char.status);

                      return (
                        <div
                          key={char.character_id}
                          onClick={() =>
                            handleViewCharacterSheet(char.character_id)
                          }
                          className="backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-xl hover:bg-white/70 hover:border-slate-300 hover:-translate-y-1 transition-all"
                          style={{
                            padding: "20px",
                            cursor: "pointer",
                            animation: `cardFadeIn 0.4s ease-out ${index * 0.05}s backwards`,
                            position: "relative",
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              position: "absolute",
                              top: "12px",
                              right: "12px",
                              background:
                                "linear-gradient(135deg, var(--accent) 0%, #6d5840 100%)",
                              color: "var(--paper)",
                              padding: "4px 10px",
                              borderRadius: "12px",
                              fontSize: "0.75rem",
                              fontWeight: "bold",
                              letterSpacing: "0.5px",
                              textTransform: "uppercase",
                              boxShadow: "0 2px 6px rgba(0, 0, 0, 0.2)",
                            }}
                          >
                            View Sheet
                          </div>
                          <div
                            style={{
                              marginBottom: "16px",
                              borderBottom: "2px solid var(--accent)",
                              paddingBottom: "12px",
                            }}
                          >
                            <h3
                              style={{
                                margin: "0 0 6px 0",
                                fontSize: "1.4rem",
                                color: "var(--title, #3d2f1f)",
                                fontWeight: "700",
                                letterSpacing: "1px",
                                wordBreak: "break-word",
                              }}
                            >
                              {char.name}
                            </h3>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                              }}
                            >
                              <span style={{ fontSize: "1.2rem" }}>👤</span>
                              <span
                                style={{
                                  fontSize: "0.95rem",
                                  color: "#666",
                                  fontStyle: "italic",
                                  fontWeight: "500",
                                }}
                              >
                                {char.occupation || "Unknown Occupation"}
                              </span>
                            </div>
                          </div>

                          <div style={{ fontSize: "0.9rem" }}>
                            {char.age && (
                              <div
                                style={{
                                  margin: "8px 0",
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "8px",
                                }}
                              >
                                <span style={{ fontSize: "1.1rem" }}>🎂</span>
                                <span
                                  style={{
                                    fontWeight: "600",
                                    color: "var(--title)",
                                  }}
                                >
                                  Age: {char.age}
                                </span>
                              </div>
                            )}

                            {status && (
                              <div
                                style={{
                                  display: "flex",
                                  gap: "8px",
                                  margin: "12px 0",
                                  flexWrap: "wrap",
                                }}
                              >
                                <span
                                  className="backdrop-blur-sm bg-blue-50/60 border border-blue-200 rounded-lg"
                                  style={{
                                    padding: "6px 12px",
                                    fontFamily: "var(--mono)",
                                    fontSize: "0.85rem",
                                    fontWeight: "700",
                                    color: "#1565c0",
                                  }}
                                >
                                  ❤️ {status.hp || "?"}
                                </span>
                                <span
                                  className="backdrop-blur-sm bg-purple-50/60 border border-purple-200 rounded-lg"
                                  style={{
                                    padding: "6px 12px",
                                    fontFamily: "var(--mono)",
                                    fontSize: "0.85rem",
                                    fontWeight: "700",
                                    color: "#6a1b9a",
                                  }}
                                >
                                  🧠 {status.sanity || "?"}
                                </span>
                                <span
                                  className="backdrop-blur-sm bg-green-50/60 border border-green-200 rounded-lg"
                                  style={{
                                    padding: "6px 12px",
                                    fontFamily: "var(--mono)",
                                    fontSize: "0.85rem",
                                    fontWeight: "700",
                                    color: "#2e7d32",
                                  }}
                                >
                                  ✨ {status.mp || "?"}
                                </span>
                              </div>
                            )}

                            {attrs && (
                              <div
                                style={{
                                  display: "grid",
                                  gridTemplateColumns: "repeat(3, 1fr)",
                                  gap: "6px",
                                  margin: "12px 0",
                                }}
                              >
                                {["STR", "CON", "DEX", "INT", "POW", "SIZ"].map(
                                  (attr) =>
                                    attrs[attr] && (
                                      <span
                                        key={attr}
                                        className="backdrop-blur-sm bg-white/60 border border-slate-200 rounded-lg"
                                        style={{
                                          padding: "4px 8px",
                                          fontFamily: "var(--mono)",
                                          fontSize: "0.75rem",
                                          fontWeight: "600",
                                          textAlign: "center",
                                          color: "var(--title)",
                                        }}
                                      >
                                        {attr}: {attrs[attr]}
                                      </span>
                                    )
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes modalSlideUp {
          from {
            opacity: 0;
            transform: translateY(30px) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        @keyframes cardFadeIn {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        .close-button {
          position: absolute;
          top: 1.5rem;
          right: 1.5rem;
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          background: rgba(255, 255, 255, 0.3);
          border: 1px solid rgba(226, 232, 240, 0.8);
          color: rgba(0, 0, 0, 0.7);
          border-radius: 0.75rem;
          width: 40px;
          height: 40px;
          font-size: 1.5rem;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10;
          transition: all 0.2s ease-in-out;
          opacity: 0.7;
          box-shadow: 0 2px 4px -1px rgba(0, 0, 0, 0.1);
        }

        .close-button:hover {
          opacity: 1;
          background: rgba(255, 255, 255, 0.5);
          border-color: rgba(203, 213, 225, 1);
        }
      `}</style>

      {/* Character Sheet Modal */}
      {showCharacterSheet && selectedCharacterId && (
        <CharacterSheetModal
          characterId={selectedCharacterId}
          apiBaseUrl="/api"
          onClose={() => {
            setShowCharacterSheet(false);
            setSelectedCharacterId("");
          }}
        />
      )}
    </>
  );
};

export default Homes;
