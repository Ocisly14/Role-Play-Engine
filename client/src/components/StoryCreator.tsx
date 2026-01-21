import React, { useState } from 'react';

export interface StoryCreatorProps {
  apiBaseUrl?: string;
  onComplete: (moduleName: string) => void;
  onCancel: () => void;
}

type SettingType = 'small_town' | 'city' | 'academic' | 'isolated' | 'single_structure' | 'route';

interface ProgressUpdate {
  stage: string;
  progress: number;
  message: string;
}

const SETTING_TYPES: { value: SettingType; label: string; description: string; icon: string }[] = [
  {
    value: 'small_town',
    label: 'Small Town',
    description: 'A close-knit rural community where secrets run deep',
    icon: '🏘️'
  },
  {
    value: 'city',
    label: 'City',
    description: 'An urban sprawl where the strange hides in plain sight',
    icon: '🌆'
  },
  {
    value: 'academic',
    label: 'Academic',
    description: 'A university or research facility harboring forbidden knowledge',
    icon: '🎓'
  },
  {
    value: 'isolated',
    label: 'Isolated',
    description: 'A remote location cut off from civilization',
    icon: '🏔️'
  },
  {
    value: 'single_structure',
    label: 'Single Structure',
    description: 'A mansion, hotel, or building with dark history',
    icon: '🏰'
  },
  {
    value: 'route',
    label: 'Route',
    description: 'A journey through dangerous or mysterious terrain',
    icon: '🚂'
  }
];

export function StoryCreator({
  apiBaseUrl = '/api',
  onComplete,
  onCancel
}: StoryCreatorProps) {
  const [creativePrompt, setCreativePrompt] = useState('');
  const [settingType, setSettingType] = useState<SettingType>('small_town');
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runGeneration = async (endpoint: string, payload: Record<string, string>) => {
    const token = localStorage.getItem('accessToken');
    const response = await fetch(`${apiBaseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) {
      throw new Error('No response body');
    }

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.substring(6));
            setProgress(data);

            if (data.stage === 'complete') {
              return data;
            }

            if (data.stage === 'error') {
              throw new Error(data.message || 'Generation failed');
            }
          } catch (parseError) {
            console.error('Failed to parse SSE data:', parseError);
          }
        }
      }
    }

    return null;
  };

  const handleGenerateWorld = async () => {
    if (!creativePrompt.trim()) {
      setError('Please enter your story idea');
      return;
    }

    setError(null);
    setIsGenerating(true);
    setProgress({ stage: 'starting', progress: 0, message: 'Starting world generation...' });

    try {
      const data = await runGeneration('/module/generate-world', {
        settingType,
        creativePrompt: creativePrompt.trim()
      });

      if (data?.stage === 'complete') {
        const moduleName = data.result?.moduleName || 'Generated_Module';
        setIsGenerating(false);
        setTimeout(() => {
          onComplete(moduleName);
        }, 1000);
      }
    } catch (err) {
      console.error('Error generating world:', err);
      setError((err as Error).message || 'Failed to generate world');
      setIsGenerating(false);
    }
  };

  const getProgressPercentage = () => {
    if (!progress) return 0;
    return progress.progress || 0;
  };

  const getStageLabel = (stage: string) => {
    switch (stage) {
      case 'macro_scene': return 'Building World Structure';
      case 'npc_builder': return 'Creating Characters';
      case 'persistence': return 'Saving Files';
      case 'complete': return 'Complete!';
      case 'error': return 'Error';
      default: return 'Processing...';
    }
  };

  return (
    <>
      <div className="story-creator-overlay">
        <div className="story-creator-modal">
          <div className="modal-header">
            <div className="modal-header-content">
              <img src="/asset/icon.png" alt="Create Story" className="header-icon" />
              <div className="header-text">
                <h2>Create Your Own Story</h2>
                <p className="header-subtitle">Design your own Call of Cthulhu adventure</p>
              </div>
            </div>
            <button onClick={onCancel} className="close-button" aria-label="Close" disabled={isGenerating}>×</button>
          </div>

          <div className="modal-content">
            {!isGenerating ? (
              <>
                {error && (
                  <div className="error-message">
                    {error}
                  </div>
                )}

                <>
                  <div className="form-section">
                    <label htmlFor="settingType" className="form-label">
                      Setting Type
                    </label>
                    <div className="setting-grid">
                      {SETTING_TYPES.map((setting) => (
                        <div
                          key={setting.value}
                          className={`setting-card ${settingType === setting.value ? 'selected' : ''}`}
                          onClick={() => setSettingType(setting.value)}
                        >
                          <div className="setting-icon">{setting.icon}</div>
                          <div className="setting-content">
                            <div className="setting-label">{setting.label}</div>
                            <div className="setting-description">{setting.description}</div>
                          </div>
                          {settingType === setting.value && (
                            <div className="setting-checkmark">✓</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="form-section">
                    <label htmlFor="creativePrompt" className="form-label">
                      Your Story Idea <span className="required">*</span>
                    </label>
                    <textarea
                      id="creativePrompt"
                      value={creativePrompt}
                      onChange={(e) => setCreativePrompt(e.target.value)}
                      placeholder="Describe your story concept... What mysteries lurk beneath the surface? What horrors await the investigators? Be as detailed or as brief as you like."
                      className="form-textarea"
                      rows={8}
                    />
                    <p className="form-hint">
                      The AI will generate a complete Call of Cthulhu scenario based on your prompt.
                    </p>
                  </div>
                </>

                <div className="modal-footer">
                  <button onClick={onCancel} className="btn-secondary">
                    Cancel
                  </button>
                  <button
                    onClick={handleGenerateWorld}
                    className="btn-primary"
                    disabled={!creativePrompt.trim()}
                  >
                    Generate World →
                  </button>
                </div>
              </>
            ) : (
              <div className="generation-progress">
                <div className="progress-header">
                  <h3>{progress ? getStageLabel(progress.stage) : 'Generating...'}</h3>
                  <div className="progress-percentage">{getProgressPercentage()}%</div>
                </div>

                <div className="progress-bar-container">
                  <div
                    className="progress-bar-fill"
                    style={{ width: `${getProgressPercentage()}%` }}
                  />
                </div>

                <div className="progress-message">
                  {progress?.message || 'Starting generation...'}
                </div>

                <div className="progress-info">
                  <p>This may take a few minutes. The AI is:</p>
                  <ul>
                    <li>Generating world structure and locations</li>
                    <li>Creating historical events and mythology</li>
                    <li>Building truth timeline and mysteries</li>
                    <li>Instantiating NPCs with clues and secrets</li>
                    <li>Saving JSON files</li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        .story-creator-overlay {
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

        .story-creator-modal {
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

        .close-button:hover:not(:disabled) {
          background: var(--border, #3d2f1f);
          color: var(--paper, #f5f1e8);
          transform: rotate(90deg) scale(1.1);
          box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
        }

        .close-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .modal-content {
          padding: 32px 28px;
          overflow-y: auto;
          flex: 1;
          background: #f9f6f0;
        }

        .error-message {
          background: #f8d7da;
          color: #721c24;
          padding: 12px 16px;
          border-radius: 4px;
          margin-bottom: 20px;
          border: 1px solid #f5c6cb;
        }

        .form-section {
          margin-bottom: 28px;
        }

        .form-label {
          display: block;
          font-size: 1.1rem;
          font-weight: 700;
          color: var(--title, #3d2f1f);
          margin-bottom: 8px;
          font-family: var(--serif);
          letter-spacing: 0.5px;
        }

        .required {
          color: #c82333;
        }

        .form-input {
          width: 100%;
          padding: 12px 16px;
          border: 2px solid var(--border, #3d2f1f);
          border-radius: 6px;
          font-size: 1rem;
          font-family: inherit;
          background: white;
          transition: all 0.2s;
          box-sizing: border-box;
        }

        .form-input:focus {
          outline: none;
          border-color: var(--accent, #8b7355);
          box-shadow: 0 0 0 3px rgba(139, 115, 85, 0.2);
        }

        .form-textarea {
          width: 100%;
          padding: 12px 16px;
          border: 2px solid var(--border, #3d2f1f);
          border-radius: 6px;
          font-size: 1rem;
          font-family: inherit;
          background: white;
          transition: all 0.2s;
          resize: vertical;
          min-height: 120px;
          box-sizing: border-box;
        }

        .form-textarea:focus {
          outline: none;
          border-color: var(--accent, #8b7355);
          box-shadow: 0 0 0 3px rgba(139, 115, 85, 0.2);
        }

        .form-hint {
          margin: 8px 0 0;
          font-size: 0.9rem;
          color: #5a4a3a;
          font-style: italic;
        }

        .setting-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 12px;
        }

        .setting-card {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 16px;
          background: white;
          border: 2px solid var(--border, #3d2f1f);
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s;
          position: relative;
        }

        .setting-card:hover {
          border-color: var(--accent, #8b7355);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
          transform: translateY(-2px);
        }

        .setting-card.selected {
          background: linear-gradient(135deg, #fef9ed 0%, #f5ead0 100%);
          border-color: var(--accent, #8b7355);
          box-shadow: 0 0 0 3px rgba(139, 115, 85, 0.2);
        }

        .setting-icon {
          font-size: 2rem;
          flex-shrink: 0;
        }

        .setting-content {
          flex: 1;
          min-width: 0;
        }

        .setting-label {
          font-weight: 700;
          color: var(--title, #3d2f1f);
          margin-bottom: 4px;
        }

        .setting-description {
          font-size: 0.85rem;
          color: #5a4a3a;
          line-height: 1.4;
        }

        .setting-checkmark {
          position: absolute;
          top: 8px;
          right: 8px;
          width: 24px;
          height: 24px;
          background: var(--accent, #8b7355);
          color: white;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.9rem;
          font-weight: bold;
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

        .generation-progress {
          text-align: center;
          padding: 20px;
        }

        .progress-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }

        .progress-header h3 {
          margin: 0;
          font-size: 1.5rem;
          color: var(--title, #3d2f1f);
        }

        .progress-percentage {
          font-size: 1.8rem;
          font-weight: 700;
          color: var(--accent, #8b7355);
        }

        .progress-bar-container {
          width: 100%;
          height: 30px;
          background: #e0d8c8;
          border-radius: 15px;
          overflow: hidden;
          margin-bottom: 16px;
          border: 2px solid var(--border, #3d2f1f);
        }

        .progress-bar-fill {
          height: 100%;
          background: linear-gradient(90deg, var(--accent, #8b7355) 0%, #6d5840 100%);
          transition: width 0.5s ease;
          display: flex;
          align-items: center;
          justify-content: flex-end;
          padding-right: 10px;
        }

        .progress-message {
          font-size: 1.1rem;
          color: #5a4a3a;
          margin-bottom: 24px;
          font-style: italic;
        }

        .progress-info {
          background: white;
          padding: 20px;
          border-radius: 6px;
          border: 2px solid #e0d8c8;
          text-align: left;
        }

        .progress-info p {
          margin: 0 0 12px;
          font-weight: 700;
          color: var(--title, #3d2f1f);
        }

        .progress-info ul {
          margin: 0;
          padding-left: 24px;
          color: #5a4a3a;
        }

        .progress-info li {
          margin-bottom: 8px;
          line-height: 1.5;
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

          .setting-grid {
            grid-template-columns: 1fr;
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
