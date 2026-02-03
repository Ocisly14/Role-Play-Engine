import React, { useEffect, useState } from 'react';
import { authFetch } from '../utils/authFetch';

export interface Mod {
  name: string;
  path: string;
}

export interface ModSelectorProps {
  apiBaseUrl?: string;
  onSelectMod: (modName: string) => void;
  onCancel: () => void;
  onCreateStory?: () => void;
}

export function ModSelector({
  apiBaseUrl = '/api',
  onSelectMod,
  onCancel,
  onCreateStory
}: ModSelectorProps) {
  const [mods, setMods] = useState<Mod[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMod, setSelectedMod] = useState<string>('');

  useEffect(() => {
    fetchMods();
  }, []);

  const fetchMods = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await authFetch(`${apiBaseUrl}/mods`);
      const data = await response.json();

      if (response.ok && data.success) {
        setMods(data.mods || []);
        if (data.mods && data.mods.length > 0) {
          setSelectedMod(data.mods[0].name);
        }
      } else {
        setError(data.error || 'Failed to load mods');
      }
    } catch (err) {
      console.error('Error fetching mods:', err);
      setError('Network error, unable to connect to server');
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = () => {
    if (selectedMod) {
      onSelectMod(selectedMod);
    }
  };

  if (loading) {
    return (
      <>
        <div className="mod-selector-overlay">
          <div className="mod-selector-modal">
            <div className="modal-header">
              <h2>Select Module</h2>
            </div>
            <div className="modal-content">
              <div className="loading-state">
                <p>Loading module list...</p>
              </div>
            </div>
          </div>
        </div>
        <style>{`
          .mod-selector-overlay {
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
            .mod-selector-overlay {
              background: rgba(0, 0, 0, 0.3);
            }
          }
          .mod-selector-modal {
            background: rgba(255, 255, 255, 0.8);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid rgba(255, 255, 255, 0.5);
            box-shadow: 0 30px 80px rgba(15, 23, 42, 0.25);
            max-width: 600px;
            width: 100%;
            border-radius: 1.5rem;
            position: relative;
          }
          @supports (backdrop-filter: blur(16px)) {
            .mod-selector-modal {
              background: rgba(255, 255, 255, 0.55);
            }
          }
          .loading-state {
            text-align: center;
            padding: 40px 20px;
          }
        `}</style>
      </>
    );
  }

  if (error) {
    return (
      <>
        <div className="mod-selector-overlay">
          <div className="mod-selector-modal">
            <div className="modal-header">
              <h2>Select Module</h2>
              <button onClick={onCancel} className="close-button">×</button>
            </div>
            <div className="modal-content">
              <div className="error-state">
                <div style={{ color: '#721c24', padding: '12px', backgroundColor: '#f8d7da', borderRadius: '4px', marginBottom: '16px' }}>
                  {error}
                </div>
                <div className="modal-actions">
                  <button onClick={onCancel} className="secondary">Cancel</button>
                  <button onClick={fetchMods} className="primary">Retry</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <style>{`
          .mod-selector-overlay {
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
            .mod-selector-overlay {
              background: rgba(0, 0, 0, 0.3);
            }
          }
          .mod-selector-modal {
            background: rgba(255, 255, 255, 0.8);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid rgba(255, 255, 255, 0.5);
            box-shadow: 0 30px 80px rgba(15, 23, 42, 0.25);
            max-width: 600px;
            width: 100%;
            border-radius: 1.5rem;
          }
          @supports (backdrop-filter: blur(16px)) {
            .mod-selector-modal {
              background: rgba(255, 255, 255, 0.55);
            }
          }
          .error-state {
            text-align: center;
            padding: 20px;
          }
        `}</style>
      </>
    );
  }

  return (
    <>
      <div className="mod-selector-overlay">
        <div className="mod-selector-modal">
          <div className="modal-header">
            <div className="modal-header-content">
              <img src="/asset/icon.png" alt="Call of Cthulhu" className="header-icon" />
              <div className="header-text">
                <h2>Choose Your Adventure</h2>
                <p className="header-subtitle">Select a scenario to begin your investigation</p>
              </div>
            </div>
            <button onClick={onCancel} className="close-button" aria-label="Close">×</button>
          </div>
          <div className="modal-content">
            <div className="mod-grid">
              {/* Create Your Own Story Card */}
              {onCreateStory && (
                <div
                  className="mod-card create-story-card"
                  onClick={onCreateStory}
                >
                  <div className="mod-card-inner">
                    <div className="mod-card-icon">✨</div>
                    <div className="mod-card-content">
                      <h3 className="mod-card-title">Create Your Own Story</h3>
                      <p className="mod-card-subtitle">Design your own TaleCraft adventure with AI</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Existing Mods */}
              {mods.map((mod) => (
                <div
                  key={mod.name}
                  className={`mod-card ${selectedMod === mod.name ? 'selected' : ''}`}
                  onClick={() => setSelectedMod(mod.name)}
                >
                  <div className="mod-card-inner">
                    <div className="mod-card-icon">🎲</div>
                    <div className="mod-card-content">
                      <h3 className="mod-card-title">{mod.name}</h3>
                    </div>
                    {selectedMod === mod.name && (
                      <div className="mod-card-checkmark">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="11" stroke="currentColor" strokeWidth="2" fill="var(--accent)"/>
                          <path d="M7 12L10.5 15.5L17 9" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="modal-footer">
              <button onClick={onCancel} className="btn-secondary">Cancel</button>
              <button
                onClick={handleSelect}
                className="btn-primary"
                disabled={!selectedMod}
              >
                Start Adventure →
              </button>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .mod-selector-overlay {
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
          .mod-selector-overlay {
            background: rgba(0, 0, 0, 0.3);
          }
        }

        .mod-selector-modal {
          background: rgba(255, 255, 255, 0.8);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.5);
          box-shadow: 0 30px 80px rgba(15, 23, 42, 0.25);
          max-width: 900px;
          width: 100%;
          max-height: 90vh;
          display: flex;
          flex-direction: column;
          border-radius: 1.5rem;
          position: relative;
          overflow: hidden;
        }

        @supports (backdrop-filter: blur(16px)) {
          .mod-selector-modal {
            background: rgba(255, 255, 255, 0.55);
          }
        }

        @keyframes modalSlideIn {
          from {
            opacity: 0;
            transform: translateY(-30px) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        .modal-header {
          padding: 12px 28px;
          background: transparent;
          border-bottom: 1px solid rgba(226, 232, 240, 0.5);
          display: flex;
          justify-content: space-between;
          align-items: center;
          position: relative;
        }


        .modal-header-content {
          display: flex;
          align-items: center;
          gap: 16px;
        }

        .header-icon {
          width: 120px;
          height: 120px;
          object-fit: contain;
          filter: drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3));
          background: transparent;
          border: none;
        }

        .header-text {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .modal-header h2 {
          margin: 0;
          letter-spacing: 2px;
          font-size: 1.8rem;
          color: var(--title, #3d2f1f);
          text-transform: uppercase;
          font-weight: 700;
          text-shadow: 1px 1px 2px rgba(255, 255, 255, 0.5);
        }

        .header-subtitle {
          margin: 0;
          font-size: 0.95rem;
          color: #5a4a3a;
          font-style: italic;
          letter-spacing: 0.5px;
        }

        .close-button {
          width: 40px;
          height: 40px;
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          background: rgba(255, 255, 255, 0.3);
          border: 1px solid rgba(226, 232, 240, 0.8);
          color: rgba(0, 0, 0, 0.7);
          font-size: 2rem;
          line-height: 1;
          cursor: pointer;
          transition: all 0.2s ease-in-out;
          border-radius: 0.75rem;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          box-shadow: 0 2px 4px -1px rgba(0, 0, 0, 0.1);
        }

        .close-button:hover {
          background: rgba(255, 255, 255, 0.5);
          border-color: rgba(203, 213, 225, 1);
          opacity: 1;
        }

        .modal-content {
          padding: 32px 28px;
          overflow-y: auto;
          flex: 1;
          background: transparent;
        }

        .empty-state {
          text-align: center;
          padding: 10px 0 18px;
          color: #5a4a3a;
        }

        .mod-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
          gap: 20px;
          margin-bottom: 32px;
        }

        @media (max-width: 900px) {
          .mod-grid {
            grid-template-columns: 1fr;
          }
        }

        .mod-card {
          cursor: pointer;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          animation: cardFadeIn 0.4s ease-out backwards;
        }

        .mod-card:nth-child(1) { animation-delay: 0.05s; }
        .mod-card:nth-child(2) { animation-delay: 0.1s; }
        .mod-card:nth-child(3) { animation-delay: 0.15s; }
        .mod-card:nth-child(4) { animation-delay: 0.2s; }
        .mod-card:nth-child(5) { animation-delay: 0.25s; }
        .mod-card:nth-child(6) { animation-delay: 0.3s; }

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

        .mod-card-inner {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 20px;
          background: rgba(255, 255, 255, 0.6);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border: 2px solid rgba(255, 255, 255, 0.5);
          border-radius: 8px;
          box-shadow:
            0 2px 8px rgba(0, 0, 0, 0.1),
            inset 0 1px 0 rgba(255, 255, 255, 0.5);
          position: relative;
          height: 100%;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .mod-card:hover .mod-card-inner {
          transform: translateY(-4px);
          box-shadow:
            0 8px 20px rgba(0, 0, 0, 0.2),
            0 0 0 2px rgba(139, 115, 85, 0.6),
            inset 0 1px 0 rgba(255, 255, 255, 0.5);
          border-color: rgba(139, 115, 85, 0.6);
          background: rgba(255, 255, 255, 0.75);
        }

        .mod-card.selected .mod-card-inner {
          background: rgba(254, 249, 237, 0.8);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          border-color: rgba(139, 115, 85, 0.8);
          box-shadow:
            0 6px 16px rgba(139, 115, 85, 0.3),
            0 0 0 3px rgba(139, 115, 85, 0.6),
            inset 0 1px 0 rgba(255, 255, 255, 0.8);
          transform: translateY(-2px);
        }

        .mod-card-icon {
          font-size: 3rem;
          line-height: 1;
          flex-shrink: 0;
          filter: grayscale(0.2) drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.15));
          transition: all 0.3s ease;
        }

        .mod-card:hover .mod-card-icon {
          transform: scale(1.1) rotate(5deg);
          filter: grayscale(0) drop-shadow(2px 2px 6px rgba(0, 0, 0, 0.25));
        }

        .mod-card.selected .mod-card-icon {
          animation: iconBounce 0.6s ease-out;
        }

        @keyframes iconBounce {
          0%, 100% {
            transform: scale(1) rotate(0deg);
          }
          25% {
            transform: scale(1.15) rotate(-10deg);
          }
          50% {
            transform: scale(1.1) rotate(5deg);
          }
          75% {
            transform: scale(1.05) rotate(-5deg);
          }
        }

        .mod-card-content {
          flex: 1;
          min-width: 0;
        }

        .mod-card-title {
          margin: 0;
          font-size: 1.3rem;
          color: var(--title, #3d2f1f);
          font-weight: 700;
          letter-spacing: 1px;
          text-transform: uppercase;
          font-family: var(--serif);
          line-height: 1.3;
          word-break: break-word;
        }

        .mod-card-checkmark {
          position: absolute;
          top: 12px;
          right: 12px;
          color: var(--accent, #8b7355);
          animation: checkmarkPop 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55);
        }

        .create-story-card .mod-card-inner {
          background: rgba(240, 230, 255, 0.6);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border-color: rgba(139, 111, 184, 0.6);
        }

        .create-story-card:hover .mod-card-inner {
          background: rgba(230, 217, 255, 0.75);
          border-color: rgba(120, 89, 166, 0.7);
          box-shadow:
            0 8px 20px rgba(136, 111, 184, 0.3),
            0 0 0 2px rgba(139, 111, 184, 0.6),
            inset 0 1px 0 rgba(255, 255, 255, 0.5);
        }

        .mod-card-subtitle {
          margin: 4px 0 0;
          font-size: 0.9rem;
          color: #5a4a3a;
          font-weight: 400;
          font-style: italic;
          letter-spacing: 0.3px;
        }

        @keyframes checkmarkPop {
          0% {
            transform: scale(0) rotate(-180deg);
            opacity: 0;
          }
          50% {
            transform: scale(1.2) rotate(10deg);
          }
          100% {
            transform: scale(1) rotate(0deg);
            opacity: 1;
          }
        }

        .modal-footer {
          display: flex;
          justify-content: flex-end;
          gap: 12px;
          padding-top: 20px;
          border-top: 2px solid #e0d8c8;
        }

        .btn-secondary,
        .btn-primary {
          padding: 14px 32px;
          font-size: 1rem;
          font-weight: 700;
          letter-spacing: 1.5px;
          text-transform: uppercase;
          font-family: var(--serif);
          border-radius: 0.75rem;
          cursor: pointer;
          transition: all 0.2s ease-in-out;
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
        }

        .btn-secondary {
          background: rgba(255, 255, 255, 0.5);
          border: 1px solid rgba(226, 232, 240, 1);
          color: var(--title, #3d2f1f);
        }

        .btn-secondary:hover {
          background: rgba(255, 255, 255, 0.7);
          border-color: rgba(203, 213, 225, 1);
          transform: translateY(-2px);
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
        }

        .btn-primary {
          background: rgba(255, 255, 255, 0.5);
          border: 1px solid rgba(226, 232, 240, 1);
          color: var(--title, #3d2f1f);
        }

        .btn-primary:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.7);
          border-color: rgba(203, 213, 225, 1);
          transform: translateY(-2px);
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
        }

        .btn-primary:active:not(:disabled) {
          transform: translateY(0);
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
        }

        .btn-primary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
          transform: none;
        }

        @media (max-width: 600px) {
          .modal-header {
            padding: 10px 20px;
          }

          .header-icon {
            width: 100px;
            height: 100px;
          }

          .modal-header h2 {
            font-size: 1.4rem;
          }

          .header-subtitle {
            font-size: 0.85rem;
          }

          .modal-content {
            padding: 24px 20px;
          }

          .modal-footer {
            flex-direction: column;
          }

          .btn-secondary,
          .btn-primary {
            width: 100%;
          }
        }
      `}</style>
    </>
  );
}
