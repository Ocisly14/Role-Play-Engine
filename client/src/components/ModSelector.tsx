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
}

export function ModSelector({ 
  apiBaseUrl = '/api',
  onSelectMod,
  onCancel
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
            background: rgba(0, 0, 0, 0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            padding: 20px;
          }
          .mod-selector-modal {
            background: var(--paper, #f5f1e8);
            border: 3px solid var(--border, #3d2f1f);
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
            max-width: 600px;
            width: 100%;
            border-radius: 4px;
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
            background: rgba(0, 0, 0, 0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            padding: 20px;
          }
          .mod-selector-modal {
            background: var(--paper, #f5f1e8);
            border: 3px solid var(--border, #3d2f1f);
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
            max-width: 600px;
            width: 100%;
            border-radius: 4px;
          }
          .error-state {
            text-align: center;
            padding: 20px;
          }
        `}</style>
      </>
    );
  }

  if (mods.length === 0) {
    return (
      <>
        <div className="mod-selector-overlay">
          <div className="mod-selector-modal">
            <div className="modal-header">
              <h2>Select Module</h2>
              <button onClick={onCancel} className="close-button">×</button>
            </div>
            <div className="modal-content">
              <div className="empty-state">
                <p>No available modules found. Please ensure there are module folders in the <code>data/Mods/</code> directory.</p>
                <button onClick={onCancel} className="secondary" style={{ marginTop: '16px' }}>Back</button>
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
            background: rgba(0, 0, 0, 0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            padding: 20px;
          }
          .mod-selector-modal {
            background: var(--paper, #f5f1e8);
            border: 3px solid var(--border, #3d2f1f);
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
            max-width: 600px;
            width: 100%;
            border-radius: 4px;
          }
          .empty-state {
            text-align: center;
            padding: 40px 20px;
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
          background: rgba(0, 0, 0, 0.85);
          backdrop-filter: blur(4px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          padding: 20px;
          animation: overlayFadeIn 0.3s ease-out;
        }

        @keyframes overlayFadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }

        .mod-selector-modal {
          background: var(--paper, #f5f1e8);
          border: 4px solid var(--border, #3d2f1f);
          box-shadow:
            0 0 0 2px var(--accent, #8b7355),
            0 20px 60px rgba(0, 0, 0, 0.6);
          max-width: 900px;
          width: 100%;
          max-height: 90vh;
          display: flex;
          flex-direction: column;
          border-radius: 8px;
          animation: modalSlideIn 0.4s ease-out;
          position: relative;
          overflow: hidden;
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
          padding: 24px 28px;
          background: linear-gradient(135deg, var(--header-bg, #d4c4b0) 0%, #c4b4a0 100%);
          border-bottom: 3px solid var(--border, #3d2f1f);
          display: flex;
          justify-content: space-between;
          align-items: center;
          position: relative;
        }

        .modal-header::after {
          content: '';
          position: absolute;
          bottom: 0;
          left: 0;
          right: 0;
          height: 3px;
          background: linear-gradient(90deg,
            transparent 0%,
            var(--accent, #8b7355) 50%,
            transparent 100%
          );
        }

        .modal-header-content {
          display: flex;
          align-items: center;
          gap: 16px;
        }

        .header-icon {
          width: 180px;
          height: 180px;
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
          border: 2px solid var(--border, #3d2f1f);
          background: var(--paper, #f5f1e8);
          color: var(--title, #3d2f1f);
          font-size: 2rem;
          line-height: 1;
          cursor: pointer;
          transition: all 0.2s;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }

        .close-button:hover {
          background: var(--border, #3d2f1f);
          color: var(--paper, #f5f1e8);
          transform: rotate(90deg) scale(1.1);
          box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
        }

        .modal-content {
          padding: 32px 28px;
          overflow-y: auto;
          flex: 1;
          background: #f9f6f0;
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
          background: white;
          border: 3px solid var(--border, #3d2f1f);
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
            0 0 0 2px var(--accent, #8b7355),
            inset 0 1px 0 rgba(255, 255, 255, 0.5);
          border-color: var(--accent, #8b7355);
          background: linear-gradient(135deg, #ffffff 0%, #faf8f5 100%);
        }

        .mod-card.selected .mod-card-inner {
          background: linear-gradient(135deg, #fef9ed 0%, #f5ead0 100%);
          border-color: var(--accent, #8b7355);
          box-shadow:
            0 6px 16px rgba(139, 115, 85, 0.3),
            0 0 0 3px var(--accent, #8b7355),
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
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s ease;
          border: 2px solid var(--border, #3d2f1f);
          box-shadow: 0 3px 6px rgba(0, 0, 0, 0.15);
        }

        .btn-secondary {
          background: white;
          color: var(--title, #3d2f1f);
        }

        .btn-secondary:hover {
          background: var(--header-bg, #d4c4b0);
          transform: translateY(-2px);
          box-shadow: 0 5px 10px rgba(0, 0, 0, 0.2);
        }

        .btn-primary {
          background: linear-gradient(135deg, var(--accent, #8b7355) 0%, #6d5840 100%);
          color: var(--paper, #f5f1e8);
          border-color: var(--border, #3d2f1f);
        }

        .btn-primary:hover:not(:disabled) {
          background: linear-gradient(135deg, #6d5840 0%, #5a4633 100%);
          transform: translateY(-2px);
          box-shadow: 0 5px 12px rgba(0, 0, 0, 0.3);
        }

        .btn-primary:active:not(:disabled) {
          transform: translateY(0);
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }

        .btn-primary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
          transform: none;
          background: #bbb;
          border-color: #999;
        }

        @media (max-width: 600px) {
          .modal-header {
            padding: 20px;
          }

          .header-icon {
            width: 150px;
            height: 150px;
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


