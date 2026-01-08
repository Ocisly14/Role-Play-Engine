/**
 * GameSidebar Component - Character status and clues panel
 *
 * Displays character information and collected clues in separate tabs.
 */

import { useState, useEffect, useRef } from 'react';
import { CharacterSheetModal } from './CharacterSheetModal';

interface GameSidebarProps {
  sessionId: string;
  apiBaseUrl?: string;
  refreshTrigger?: number; // When this changes, refresh game state
}

type TabType = 'status' | 'clues';

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
  category?: "physical" | "witness" | "document" | "environment" | "knowledge" | "observation";
  difficulty?: "automatic" | "regular" | "hard" | "extreme";
  method?: string;
}

interface CurrentScenario {
  name: string;
  location: string;
}

interface GameEndingInfo {
  isEnded: boolean;
  endingType: "death" | "time_limit" | "victory" | "failure" | "other";
  reason: string;
  timestamp: string;
}

interface GameState {
  playerCharacter: CharacterProfile;
  discoveredClues: DiscoveredClue[];
  currentScenario: CurrentScenario | null;
  gameDay: number;
  timeOfDay: string;
  gameEnding: GameEndingInfo | null;
}

export function GameSidebar({ sessionId, apiBaseUrl = 'http://localhost:3000/api', refreshTrigger }: GameSidebarProps) {
  const [activeTab, setActiveTab] = useState<TabType>('status');
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCharacterSheet, setShowCharacterSheet] = useState(false);
  const isInitialLoadRef = useRef(true);

  // Fetch game state from backend
  useEffect(() => {
    const fetchGameState = async () => {
      try {
        // Only show loading on initial load
        if (isInitialLoadRef.current) {
          setLoading(true);
        }

        const response = await fetch(`${apiBaseUrl}/gamestate`);

        if (!response.ok) {
          throw new Error('Failed to fetch game state');
        }

        const data = await response.json();

        if (data.success && data.gameState) {
          setGameState(data.gameState);
          setError(null);
        } else {
          throw new Error('Invalid game state response');
        }
      } catch (err) {
        console.error('Error fetching game state:', err);
        setError(err instanceof Error ? err.message : 'Unknown error');
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

  return (
    <div className="game-sidebar">
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
          className={`sidebar-tab ${activeTab === 'status' ? 'active' : ''}`}
          onClick={() => setActiveTab('status')}
        >
          Character Status
        </button>
        <button
          className={`sidebar-tab ${activeTab === 'clues' ? 'active' : ''}`}
          onClick={() => setActiveTab('clues')}
        >
          Discovered Clues
        </button>
      </div>

      {/* Tab Content */}
      <div className="sidebar-content">
        {activeTab === 'status' && (
          <div className="tab-panel status-panel">
            {loading ? (
              <p className="empty-state">Loading...</p>
            ) : error ? (
              <p className="empty-state" style={{ color: '#c41e3a' }}>Load failed: {error}</p>
            ) : gameState ? (
              <>
                <div className="status-section">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <h3 style={{ margin: 0 }}>Basic Attributes</h3>
                    <button
                      className="view-character-btn-sidebar"
                      onClick={() => setShowCharacterSheet(true)}
                      title="View full character sheet"
                    >
                      📋 View Character
                    </button>
                  </div>
                  <div className="status-grid">
                    <div className="status-item">
                      <span className="status-label">HP:</span>
                      <span className="status-value">
                        {gameState.playerCharacter.status.hp}/{gameState.playerCharacter.status.maxHp}
                      </span>
                    </div>
                    <div className="status-item">
                      <span className="status-label">MP:</span>
                      <span className="status-value">
                        {gameState.playerCharacter.status.mp || 0}/{gameState.playerCharacter.status.mp || 0}
                      </span>
                    </div>
                    <div className="status-item">
                      <span className="status-label">SAN:</span>
                      <span className="status-value">
                        {gameState.playerCharacter.status.sanity}/{gameState.playerCharacter.status.maxSanity}
                      </span>
                    </div>
                    <div className="status-item">
                      <span className="status-label">LUCK:</span>
                      <span className="status-value">{gameState.playerCharacter.status.luck}</span>
                    </div>
                  </div>
                </div>

                <div className="status-section">
                  <h3>Current Status</h3>
                  <div className="status-list">
                    <div className="status-item-full">
                      <span className="status-label">Location:</span>
                      <span className="status-value">
                        {gameState.currentScenario?.name || 'Unknown'}
                      </span>
                    </div>
                    <div className="status-item-full">
                      <span className="status-label">Time:</span>
                      <span className="status-value">{gameState.timeOfDay || '--'}</span>
                    </div>
                    <div className="status-item-full">
                      <span className="status-label">Day:</span>
                      <span className="status-value">Day {gameState.gameDay}</span>
                    </div>
                  </div>
                </div>

                <div className="status-section">
                  <h3>Status Effects</h3>
                  <div className="status-effects">
                    {gameState.playerCharacter.status.conditions.length > 0 ? (
                      <ul style={{ margin: 0, paddingLeft: '20px' }}>
                        {gameState.playerCharacter.status.conditions.map((condition, idx) => (
                          <li key={idx}>{condition}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="empty-state">No status effects</p>
                    )}
                  </div>
                </div>

                <div className="status-section">
                  <h3>Weapons</h3>
                  <div className="weapons-list">
                    {gameState.playerCharacter.weapons && gameState.playerCharacter.weapons.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {gameState.playerCharacter.weapons.map((weapon, idx) => (
                          <div
                            key={idx}
                            style={{
                              padding: '8px 10px',
                              backgroundColor: '#fff',
                              border: '1px solid var(--accent)',
                              borderRadius: '3px',
                            }}
                          >
                            <div style={{ fontWeight: 'bold', marginBottom: '4px', fontSize: '0.9rem' }}>
                              {weapon.name}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: '#666', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                              {weapon.damage && <span>DMG: {weapon.damage}</span>}
                              {weapon.range && <span>Range: {weapon.range}</span>}
                              {weapon.attacks && <span>Attacks: {weapon.attacks}</span>}
                              {weapon.ammo !== undefined && <span>Ammo: {weapon.ammo}</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="empty-state">No weapons</p>
                    )}
                  </div>
                </div>

                <div className="status-section">
                  <h3>Inventory</h3>
                  <div className="inventory-list">
                    {gameState.playerCharacter.inventory && gameState.playerCharacter.inventory.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {gameState.playerCharacter.inventory.map((item, idx) => (
                          <div
                            key={idx}
                            style={{
                              padding: '6px 10px',
                              backgroundColor: '#fff',
                              border: '1px solid #ddd',
                              borderRadius: '3px',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                            }}
                          >
                            <span style={{ fontSize: '0.85rem', fontWeight: '500' }}>
                              {item.name}
                            </span>
                            {item.quantity && item.quantity > 1 && (
                              <span style={{
                                fontSize: '0.75rem',
                                color: '#666',
                                backgroundColor: 'var(--header-bg)',
                                padding: '2px 6px',
                                borderRadius: '3px',
                                fontWeight: 'bold'
                              }}>
                                x{item.quantity}
                              </span>
                            )}
                          </div>
                        ))}
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

        {activeTab === 'clues' && (
          <div className="tab-panel clues-panel">
            {loading ? (
              <p className="empty-state">Loading...</p>
            ) : error ? (
              <p className="empty-state" style={{ color: '#c41e3a' }}>Load failed: {error}</p>
            ) : gameState ? (
              <div className="clues-section">
                <h3>Important Clues</h3>
                <div className="clues-list">
                  {gameState.discoveredClues.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      {gameState.discoveredClues.map((clue, idx) => (
                        <div
                          key={idx}
                          style={{
                            padding: '10px',
                            backgroundColor: '#fff',
                            border: '1px solid #ddd',
                            borderRadius: '4px',
                          }}
                        >
                          <div style={{ fontWeight: 'bold', marginBottom: '5px' }}>
                            {clue.sourceName}
                            <span
                              style={{
                                marginLeft: '8px',
                                fontSize: '0.8rem',
                                color: '#666',
                                fontWeight: 'normal',
                              }}
                            >
                              ({clue.type === 'scenario' ? 'Scenario Clue' : clue.type === 'npc' ? 'NPC Clue' : 'Secret'})
                            </span>
                          </div>
                          <div style={{ fontSize: '0.9rem', color: '#333', marginBottom: '5px' }}>
                            {clue.text}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: '#999' }}>
                            Discovered by: {clue.discoveredBy}
                            {clue.method && ` | Method: ${clue.method}`}
                            {clue.difficulty && ` | Difficulty: ${clue.difficulty}`}
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
      </div>
    </div>
  );
}
