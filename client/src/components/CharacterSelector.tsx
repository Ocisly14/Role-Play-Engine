/**
 * Character Selector Component
 * Displays available characters from database and allows user to select one
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { authFetch } from "../utils/authFetch";

interface Character {
  character_id: string;
  name: string;
  occupation?: string;
  age?: number;
  attributes?: string;
  status?: string;
}

interface CharacterSelectorProps {
  apiBaseUrl?: string;
  onSelectCharacter: (characterId: string, characterName: string) => void;
  onCancel: () => void;
  onCreateNew: () => void;
}

export function CharacterSelector({
  apiBaseUrl = "/api",
  onSelectCharacter,
  onCancel,
  onCreateNew,
}: CharacterSelectorProps) {
  const { t } = useTranslation('home');
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);

  useEffect(() => {
    loadCharacters();
  }, []);

  const loadCharacters = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await authFetch(`${apiBaseUrl}/characters`);
      const data = await response.json();

      if (data.success) {
        setCharacters(data.characters || []);
        if (data.characters && data.characters.length > 0) {
          setSelectedId(data.characters[0].character_id);
        }
      } else {
        setError(t('selector.loadError'));
      }
    } catch (err) {
      console.error("Error loading characters:", err);
      setError(t('selector.networkError'));
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!selectedId) return;

    const selectedChar = characters.find((c) => c.character_id === selectedId);
    if (!selectedChar) return;

    try {
      setImporting(true);
      setImportMessage(t('selector.importingData'));

      // Step 1: Import game data
      const importResponse = await authFetch(`${apiBaseUrl}/game/import-data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const importData = await importResponse.json();

      if (!importResponse.ok) {
        throw new Error(importData.error || t('selector.importFailed'));
      }

      setImportMessage(
        t('selector.dataImportComplete', {
          scenariosLoaded: importData.scenariosLoaded,
          npcsLoaded: importData.npcsLoaded
        })
      );

      // Small delay to show the message
      await new Promise((resolve) => setTimeout(resolve, 500));

      setImportMessage(t('selector.startingGame'));

      // Step 2: Call the parent handler which will start the game
      onSelectCharacter(selectedId, selectedChar.name);
    } catch (err) {
      console.error("Error importing data:", err);
      setError(err instanceof Error ? err.message : t('selector.importFailed'));
      setImporting(false);
      setImportMessage(null);
    }
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
    <div className="character-selector-overlay">
      <div className="character-selector-modal">
        <div className="modal-header">
          <h2>{t('selector.title')}</h2>
          <button className="close-button" onClick={onCancel}>
            ×
          </button>
        </div>

        <div className="modal-content">
          {(loading || importing) && (
            <div className="loading-state">
              <p>
                {importing
                  ? importMessage || t('selector.processing')
                  : t('characters.loading')}
              </p>
              {importing && (
                <div
                  style={{
                    marginTop: "10px",
                    fontSize: "0.9rem",
                    color: "#666",
                  }}
                >
                  {t('selector.importWait')}
                </div>
              )}
            </div>
          )}

          {error && !importing && (
            <div className="error-state">
              <p style={{ color: "#dc3545" }}>{error}</p>
              <button onClick={loadCharacters}>{t('selector.retry')}</button>
            </div>
          )}

          {!loading && !error && characters.length === 0 && (
            <div className="empty-state">
              <p>{t('characters.empty')}</p>
              <button className="primary" onClick={onCreateNew}>
                {t('selector.createFirst')}
              </button>
            </div>
          )}

          {!loading && !importing && !error && characters.length > 0 && (
            <>
              <div className="character-list">
                {characters.map((char) => {
                  const attrs = parseAttributes(char.attributes);
                  const status = parseStatus(char.status);

                  return (
                    <div
                      key={char.character_id}
                      className={`character-card ${selectedId === char.character_id ? "selected" : ""}`}
                      onClick={() => setSelectedId(char.character_id)}
                    >
                      <div className="character-card-header">
                        <h3>{char.name}</h3>
                        <span className="character-occupation">
                          {char.occupation || t('characters.unknownOccupation')}
                        </span>
                      </div>

                      <div className="character-card-body">
                        {char.age && <p>{t('selector.age')} {char.age}</p>}

                        {status && (
                          <div className="character-status">
                            <span>HP: {status.hp || "?"}</span>
                            <span>SAN: {status.sanity || "?"}</span>
                            <span>MP: {status.mp || "?"}</span>
                          </div>
                        )}

                        {attrs && (
                          <div className="character-attributes">
                            <span>STR: {attrs.STR || "?"}</span>
                            <span>CON: {attrs.CON || "?"}</span>
                            <span>DEX: {attrs.DEX || "?"}</span>
                            <span>INT: {attrs.INT || "?"}</span>
                            <span>POW: {attrs.POW || "?"}</span>
                          </div>
                        )}
                      </div>

                      {selectedId === char.character_id && (
                        <div className="selected-indicator">✓</div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="modal-actions">
                <button onClick={onCreateNew} className="secondary">
                  {t('selector.createNew')}
                </button>
                <button onClick={onCancel} className="tertiary">
                  {t('selector.done')}
                </button>
                <button
                  onClick={handleConfirm}
                  className="primary"
                  disabled={!selectedId || importing}
                >
                  {importing
                    ? t('selector.importing')
                    : t('selector.startGame')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <style>{`
        .character-selector-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          padding: 20px;
        }

        @supports (backdrop-filter: blur(4px)) {
          .character-selector-overlay {
            background: rgba(0, 0, 0, 0.3);
          }
        }

        .character-selector-modal {
          background: rgba(255, 255, 255, 0.8);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.5);
          box-shadow: 0 30px 80px rgba(15, 23, 42, 0.25);
          max-width: 800px;
          width: 100%;
          max-height: 90vh;
          display: flex;
          flex-direction: column;
          border-radius: 1.5rem;
        }

        @supports (backdrop-filter: blur(16px)) {
          .character-selector-modal {
            background: rgba(255, 255, 255, 0.55);
          }
        }

        .modal-header {
          padding: 20px 24px;
          border-bottom: 1px solid rgba(226, 232, 240, 0.5);
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: transparent;
        }

        .modal-header h2 {
          margin: 0;
          font-size: 1.8rem;
          color: var(--title, #3d2f1f);
        }

        .close-button {
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          background: rgba(255, 255, 255, 0.3);
          border: 1px solid rgba(226, 232, 240, 0.8);
          font-size: 1.5rem;
          cursor: pointer;
          color: rgba(0, 0, 0, 0.7);
          opacity: 0.7;
          transition: all 0.2s ease-in-out;
          width: 40px;
          height: 40px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 0.75rem;
          box-shadow: 0 2px 4px -1px rgba(0, 0, 0, 0.1);
        }

        .close-button:hover {
          opacity: 1;
          background: rgba(255, 255, 255, 0.5);
          border-color: rgba(203, 213, 225, 1);
        }

        .modal-content {
          padding: 24px;
          overflow-y: auto;
          flex: 1;
        }

        .loading-state, .error-state, .empty-state {
          text-align: center;
          padding: 40px 20px;
        }

        .character-list {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 16px;
          margin-bottom: 24px;
        }

        .character-card {
          border: 2px solid var(--border, #3d2f1f);
          padding: 16px;
          cursor: pointer;
          transition: all 0.2s;
          background: white;
          position: relative;
          border-radius: 4px;
        }

        .character-card:hover {
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
          transform: translateY(-2px);
        }

        .character-card.selected {
          border-color: var(--accent, #8b7355);
          border-width: 3px;
          background: #fff8e7;
        }

        .character-card-header {
          margin-bottom: 12px;
          border-bottom: 1px solid #ddd;
          padding-bottom: 8px;
        }

        .character-card-header h3 {
          margin: 0 0 4px 0;
          font-size: 1.3rem;
          color: var(--title, #3d2f1f);
        }

        .character-occupation {
          font-size: 0.9rem;
          color: #666;
          font-style: italic;
        }

        .character-card-body {
          font-size: 0.9rem;
        }

        .character-card-body p {
          margin: 4px 0;
        }

        .character-status, .character-attributes {
          display: flex;
          gap: 12px;
          margin: 8px 0;
          font-family: monospace;
          font-size: 0.85rem;
        }

        .character-status span, .character-attributes span {
          padding: 2px 6px;
          background: #e9ecef;
          border-radius: 3px;
        }

        .selected-indicator {
          position: absolute;
          top: 8px;
          right: 8px;
          background: var(--accent, #8b7355);
          color: white;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 1.2rem;
          font-weight: bold;
        }

        .modal-actions {
          display: flex;
          gap: 12px;
          justify-content: flex-end;
          padding-top: 16px;
          border-top: 1px solid #ddd;
        }

        .modal-actions button {
          padding: 10px 24px;
          font-size: 1rem;
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          border: 1px solid rgba(226, 232, 240, 1);
          border-radius: 0.75rem;
          cursor: pointer;
          font-weight: bold;
          transition: all 0.2s ease-in-out;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
        }

        .modal-actions button.primary {
          background: rgba(255, 255, 255, 0.5);
          color: var(--title, #3d2f1f);
        }

        .modal-actions button.primary:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.7);
          border-color: rgba(203, 213, 225, 1);
          transform: translateY(-2px);
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
        }

        .modal-actions button.primary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .modal-actions button.secondary {
          background: rgba(255, 255, 255, 0.5);
          color: var(--title, #3d2f1f);
        }

        .modal-actions button.secondary:hover {
          background: rgba(255, 255, 255, 0.7);
          border-color: rgba(203, 213, 225, 1);
          transform: translateY(-2px);
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
        }

        .modal-actions button.tertiary {
          background: #6c757d;
          color: white;
        }

        .modal-actions button.tertiary:hover {
          background: #5a6268;
        }
      `}</style>
    </div>
  );
}
