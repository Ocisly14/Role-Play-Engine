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
          <img src="/src/asset/frame.png" alt="CoC Frame" className="frame-image" />
          <div className="home-actions">
            <button className="primary" onClick={handleStartGame}>
              🎮 New Game
            </button>
            <button className="secondary" onClick={onContinueGame}>
              📂 Continue Game
            </button>
            <button onClick={onCreate}>
              Create Character
            </button>
            <button onClick={handleViewCharacters}>
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
          background: 'rgba(0, 0, 0, 0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2000,
          padding: '20px',
        }}>
          <div style={{
            background: 'var(--paper, #f5f1e8)',
            border: '3px solid var(--border, #3d2f1f)',
            boxShadow: '0 10px 40px rgba(0, 0, 0, 0.5)',
            maxWidth: '900px',
            width: '100%',
            maxHeight: '90vh',
            display: 'flex',
            flexDirection: 'column',
            borderRadius: '4px',
          }}>
            <div style={{
              padding: '20px 24px',
              borderBottom: '2px solid var(--border, #3d2f1f)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'var(--header-bg, #d4c4b0)',
            }}>
              <h2 style={{ margin: 0, fontSize: '1.8rem', color: 'var(--title, #3d2f1f)' }}>
                👥 Your Characters
              </h2>
              <button
                onClick={() => setShowCharacterBrowser(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '2rem',
                  cursor: 'pointer',
                  color: 'var(--title, #3d2f1f)',
                  width: '40px',
                  height: '40px',
                  borderRadius: '4px',
                }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: '24px', overflowY: 'auto', flex: 1 }}>
              {loading ? (
                <p style={{ textAlign: 'center', padding: '40px 20px' }}>Loading characters...</p>
              ) : characters.length === 0 ? (
                <p style={{ textAlign: 'center', padding: '40px 20px', color: '#666' }}>
                  No characters created yet
                </p>
              ) : (
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                  gap: '16px',
                }}>
                  {characters.map((char) => {
                    const attrs = parseAttributes(char.attributes);
                    const status = parseStatus(char.status);

                    return (
                      <div
                        key={char.character_id}
                        onClick={() => handleViewCharacterSheet(char.character_id)}
                        style={{
                          border: '2px solid var(--border, #3d2f1f)',
                          padding: '16px',
                          cursor: 'pointer',
                          transition: 'all 0.2s',
                          background: 'white',
                          borderRadius: '4px',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.2)';
                          e.currentTarget.style.transform = 'translateY(-2px)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.boxShadow = 'none';
                          e.currentTarget.style.transform = 'translateY(0)';
                        }}
                      >
                        <div style={{
                          marginBottom: '12px',
                          borderBottom: '1px solid #ddd',
                          paddingBottom: '8px',
                        }}>
                          <h3 style={{
                            margin: '0 0 4px 0',
                            fontSize: '1.3rem',
                            color: 'var(--title, #3d2f1f)',
                          }}>
                            {char.name}
                          </h3>
                          <span style={{ fontSize: '0.9rem', color: '#666', fontStyle: 'italic' }}>
                            {char.occupation || 'Unknown Occupation'}
                          </span>
                        </div>

                        <div style={{ fontSize: '0.9rem' }}>
                          {char.age && <p style={{ margin: '4px 0' }}>Age: {char.age}</p>}

                          {status && (
                            <div style={{
                              display: 'flex',
                              gap: '12px',
                              margin: '8px 0',
                              fontFamily: 'monospace',
                              fontSize: '0.85rem',
                            }}>
                              <span style={{ padding: '2px 6px', background: '#e9ecef', borderRadius: '3px' }}>
                                HP: {status.hp || '?'}
                              </span>
                              <span style={{ padding: '2px 6px', background: '#e9ecef', borderRadius: '3px' }}>
                                SAN: {status.sanity || '?'}
                              </span>
                              <span style={{ padding: '2px 6px', background: '#e9ecef', borderRadius: '3px' }}>
                                MP: {status.mp || '?'}
                              </span>
                            </div>
                          )}

                          {attrs && (
                            <div style={{
                              display: 'flex',
                              gap: '8px',
                              margin: '8px 0',
                              fontFamily: 'monospace',
                              fontSize: '0.75rem',
                              flexWrap: 'wrap',
                            }}>
                              <span style={{ padding: '2px 6px', background: '#e9ecef', borderRadius: '3px' }}>
                                STR: {attrs.STR || '?'}
                              </span>
                              <span style={{ padding: '2px 6px', background: '#e9ecef', borderRadius: '3px' }}>
                                CON: {attrs.CON || '?'}
                              </span>
                              <span style={{ padding: '2px 6px', background: '#e9ecef', borderRadius: '3px' }}>
                                DEX: {attrs.DEX || '?'}
                              </span>
                              <span style={{ padding: '2px 6px', background: '#e9ecef', borderRadius: '3px' }}>
                                INT: {attrs.INT || '?'}
                              </span>
                              <span style={{ padding: '2px 6px', background: '#e9ecef', borderRadius: '3px' }}>
                                POW: {attrs.POW || '?'}
                              </span>
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
