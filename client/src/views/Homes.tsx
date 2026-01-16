import React, { useState } from "react";
import { authFetch } from "../utils/authFetch";
import { CharacterSheetModal } from "../components/CharacterSheetModal";

interface HomeProps {
  onCreate: () => void;
  onStartGame: () => void;
  onContinueGame: () => void;
}

interface Character {
  character_id: string;
  name: string;
  occupation?: string;
  age?: number;
  attributes?: string;
  status?: string;
}

const Homes: React.FC<HomeProps> = ({ onCreate, onStartGame, onContinueGame }) => {
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
          <img src="/asset/frame.png" alt="CoC Frame" className="frame-image" />
          <div className="home-actions">
            <button className="primary" onClick={handleStartGame}>
              🎮 New Game
            </button>
            <button className="secondary" onClick={onContinueGame}>
              📂 Continue Game
            </button>
            <button className="secondary" onClick={onCreate}>
              ✏️ Create Character
            </button>
            <button className="secondary" onClick={handleViewCharacters}>
              👥 View Characters
            </button>
          </div>
        </div>
      </div>

      {/* Character Browser Modal */}
      {showCharacterBrowser && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.85)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2000,
          padding: '20px',
          animation: 'fadeIn 0.3s ease-out',
        }}>
          <div style={{
            background: 'var(--paper, #f5f1e8)',
            border: '4px solid var(--border, #3d2f1f)',
            boxShadow: '0 0 0 2px var(--accent), 0 20px 60px rgba(0, 0, 0, 0.6)',
            maxWidth: '1000px',
            width: '100%',
            maxHeight: '90vh',
            display: 'flex',
            flexDirection: 'column',
            borderRadius: '12px',
            overflow: 'hidden',
            animation: 'modalSlideUp 0.4s ease-out',
          }}>
            <div style={{
              padding: '24px 28px',
              borderBottom: '3px solid var(--border, #3d2f1f)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'linear-gradient(135deg, var(--header-bg, #d4c4b0) 0%, #c4b4a0 100%)',
              position: 'relative',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '2rem' }}>👥</span>
                <div>
                  <h2 style={{
                    margin: 0,
                    fontSize: '1.8rem',
                    color: 'var(--title, #3d2f1f)',
                    letterSpacing: '2px',
                    textTransform: 'uppercase',
                    textShadow: '1px 1px 2px rgba(255, 255, 255, 0.5)',
                  }}>
                    Your Characters
                  </h2>
                  <p style={{
                    margin: '4px 0 0 0',
                    fontSize: '0.9rem',
                    color: '#5a4a3a',
                    fontStyle: 'italic',
                  }}>
                    {characters.length} {characters.length === 1 ? 'investigator' : 'investigators'} ready
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowCharacterBrowser(false)}
                style={{
                  background: 'var(--paper)',
                  border: '2px solid var(--border)',
                  fontSize: '2rem',
                  cursor: 'pointer',
                  color: 'var(--title)',
                  width: '44px',
                  height: '44px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'all 0.2s ease',
                  boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--border)';
                  e.currentTarget.style.color = 'var(--paper)';
                  e.currentTarget.style.transform = 'rotate(90deg) scale(1.1)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--paper)';
                  e.currentTarget.style.color = 'var(--title)';
                  e.currentTarget.style.transform = 'rotate(0deg) scale(1)';
                }}
              >
                ×
              </button>
              <div style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: '3px',
                background: 'linear-gradient(90deg, transparent 0%, var(--accent) 50%, transparent 100%)',
              }} />
            </div>

            <div style={{
              padding: '32px 28px',
              overflowY: 'auto',
              flex: 1,
              background: '#f9f6f0',
            }}>
              {loading ? (
                <div style={{
                  textAlign: 'center',
                  padding: '60px 20px',
                  fontSize: '1.1rem',
                  color: 'var(--title)',
                }}>
                  <div style={{
                    fontSize: '3rem',
                    marginBottom: '20px',
                    animation: 'spin 1s linear infinite',
                  }}>
                    🎲
                  </div>
                  Loading characters...
                </div>
              ) : characters.length === 0 ? (
                <div style={{
                  textAlign: 'center',
                  padding: '60px 20px',
                  color: '#999',
                }}>
                  <div style={{ fontSize: '4rem', marginBottom: '20px' }}>📋</div>
                  <p style={{ fontSize: '1.2rem', marginBottom: '8px', color: 'var(--title)' }}>
                    No characters created yet
                  </p>
                  <p style={{ fontSize: '0.95rem' }}>
                    Create your first investigator to begin your journey
                  </p>
                </div>
              ) : (
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                  gap: '20px',
                }}>
                  {characters.map((char, index) => {
                    const attrs = parseAttributes(char.attributes);
                    const status = parseStatus(char.status);

                    return (
                      <div
                        key={char.character_id}
                        onClick={() => handleViewCharacterSheet(char.character_id)}
                        style={{
                          border: '3px solid var(--border, #3d2f1f)',
                          padding: '20px',
                          cursor: 'pointer',
                          transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                          background: 'white',
                          borderRadius: '10px',
                          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
                          animation: `cardFadeIn 0.4s ease-out ${index * 0.05}s backwards`,
                          position: 'relative',
                          overflow: 'hidden',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.2), 0 0 0 2px var(--accent)';
                          e.currentTarget.style.transform = 'translateY(-4px)';
                          e.currentTarget.style.borderColor = 'var(--accent)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.1)';
                          e.currentTarget.style.transform = 'translateY(0)';
                          e.currentTarget.style.borderColor = 'var(--border)';
                        }}
                      >
                        <div style={{
                          position: 'absolute',
                          top: '12px',
                          right: '12px',
                          background: 'linear-gradient(135deg, var(--accent) 0%, #6d5840 100%)',
                          color: 'var(--paper)',
                          padding: '4px 10px',
                          borderRadius: '12px',
                          fontSize: '0.75rem',
                          fontWeight: 'bold',
                          letterSpacing: '0.5px',
                          textTransform: 'uppercase',
                          boxShadow: '0 2px 6px rgba(0, 0, 0, 0.2)',
                        }}>
                          View Sheet
                        </div>
                        <div style={{
                          marginBottom: '16px',
                          borderBottom: '2px solid var(--accent)',
                          paddingBottom: '12px',
                        }}>
                          <h3 style={{
                            margin: '0 0 6px 0',
                            fontSize: '1.4rem',
                            color: 'var(--title, #3d2f1f)',
                            fontWeight: '700',
                            letterSpacing: '1px',
                            wordBreak: 'break-word',
                          }}>
                            {char.name}
                          </h3>
                          <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                          }}>
                            <span style={{ fontSize: '1.2rem' }}>👤</span>
                            <span style={{
                              fontSize: '0.95rem',
                              color: '#666',
                              fontStyle: 'italic',
                              fontWeight: '500',
                            }}>
                              {char.occupation || 'Unknown Occupation'}
                            </span>
                          </div>
                        </div>

                        <div style={{ fontSize: '0.9rem' }}>
                          {char.age && (
                            <div style={{
                              margin: '8px 0',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                            }}>
                              <span style={{ fontSize: '1.1rem' }}>🎂</span>
                              <span style={{ fontWeight: '600', color: 'var(--title)' }}>
                                Age: {char.age}
                              </span>
                            </div>
                          )}

                          {status && (
                            <div style={{
                              display: 'flex',
                              gap: '8px',
                              margin: '12px 0',
                              flexWrap: 'wrap',
                            }}>
                              <span style={{
                                padding: '6px 12px',
                                background: 'linear-gradient(135deg, #e3f2fd 0%, #bbdefb 100%)',
                                borderRadius: '6px',
                                fontFamily: 'var(--mono)',
                                fontSize: '0.85rem',
                                fontWeight: '700',
                                border: '1px solid #90caf9',
                                color: '#1565c0',
                              }}>
                                ❤️ {status.hp || '?'}
                              </span>
                              <span style={{
                                padding: '6px 12px',
                                background: 'linear-gradient(135deg, #f3e5f5 0%, #e1bee7 100%)',
                                borderRadius: '6px',
                                fontFamily: 'var(--mono)',
                                fontSize: '0.85rem',
                                fontWeight: '700',
                                border: '1px solid #ce93d8',
                                color: '#6a1b9a',
                              }}>
                                🧠 {status.sanity || '?'}
                              </span>
                              <span style={{
                                padding: '6px 12px',
                                background: 'linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%)',
                                borderRadius: '6px',
                                fontFamily: 'var(--mono)',
                                fontSize: '0.85rem',
                                fontWeight: '700',
                                border: '1px solid #81c784',
                                color: '#2e7d32',
                              }}>
                                ✨ {status.mp || '?'}
                              </span>
                            </div>
                          )}

                          {attrs && (
                            <div style={{
                              display: 'grid',
                              gridTemplateColumns: 'repeat(3, 1fr)',
                              gap: '6px',
                              margin: '12px 0',
                            }}>
                              {['STR', 'CON', 'DEX', 'INT', 'POW', 'SIZ'].map(attr => (
                                attrs[attr] && (
                                  <span
                                    key={attr}
                                    style={{
                                      padding: '4px 8px',
                                      background: 'var(--header-bg)',
                                      borderRadius: '4px',
                                      fontFamily: 'var(--mono)',
                                      fontSize: '0.75rem',
                                      fontWeight: '600',
                                      textAlign: 'center',
                                      border: '1px solid var(--accent)',
                                      color: 'var(--title)',
                                    }}
                                  >
                                    {attr}: {attrs[attr]}
                                  </span>
                                )
                              ))}
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
