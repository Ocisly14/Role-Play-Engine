import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { StoryCreator } from "../components/StoryCreator";
import { authFetch } from "../utils/authFetch";

export const StoryCreatorPage: React.FC = () => {
  const { t } = useTranslation("module");
  const navigate = useNavigate();
  const [generatedModuleName, setGeneratedModuleName] = useState<string | null>(
    null
  );
  const [isSharing, setIsSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  const handleSkipShare = () => {
    setGeneratedModuleName(null);
    navigate("/mod/select");
  };

  const handleShare = async () => {
    if (!generatedModuleName) return;

    setIsSharing(true);
    setShareError(null);

    try {
      const response = await authFetch("/api/mods/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modName: generatedModuleName }),
      });

      const data: { error?: string } = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error || t("storyCreator.sharePrompt.shareFailed")
        );
      }

      setGeneratedModuleName(null);
      navigate("/mod/select");
    } catch (error) {
      setShareError(
        (error as Error).message || t("storyCreator.sharePrompt.shareFailed")
      );
    } finally {
      setIsSharing(false);
    }
  };

  return (
    <>
      <StoryCreator
        onComplete={(moduleName) => {
          setShareError(null);
          setGeneratedModuleName(moduleName);
        }}
        onCancel={() => navigate("/mod/select")}
      />

      {generatedModuleName && (
        <>
          <div className="story-share-overlay" role="dialog" aria-modal="true">
            <div className="story-share-modal">
              <h3 className="story-share-title">
                {t("storyCreator.sharePrompt.title")}
              </h3>
              <p className="story-share-message">
                {t("storyCreator.sharePrompt.message", {
                  moduleName: generatedModuleName,
                })}
              </p>

              {shareError && <p className="story-share-error">{shareError}</p>}

              <div className="story-share-actions">
                <button
                  className="story-share-btn-secondary"
                  onClick={handleSkipShare}
                  disabled={isSharing}
                >
                  {t("storyCreator.sharePrompt.skip")}
                </button>
                <button
                  className="story-share-btn-primary"
                  onClick={handleShare}
                  disabled={isSharing}
                >
                  {isSharing
                    ? t("storyCreator.sharePrompt.sharing")
                    : t("storyCreator.sharePrompt.share")}
                </button>
              </div>
            </div>
          </div>

          <style>{`
            .story-share-overlay {
              position: fixed;
              inset: 0;
              background: rgba(0, 0, 0, 0.45);
              display: flex;
              align-items: center;
              justify-content: center;
              z-index: 1200;
              padding: 20px;
            }

            .story-share-modal {
              background: rgba(255, 255, 255, 0.92);
              backdrop-filter: blur(10px);
              -webkit-backdrop-filter: blur(10px);
              border: 1px solid rgba(226, 232, 240, 0.8);
              border-radius: 14px;
              max-width: 520px;
              width: 100%;
              padding: 24px;
              box-shadow: 0 20px 50px rgba(15, 23, 42, 0.25);
            }

            .story-share-title {
              margin: 0 0 10px;
              font-size: 1.2rem;
              color: var(--title, #3d2f1f);
            }

            .story-share-message {
              margin: 0;
              color: #444;
              line-height: 1.5;
            }

            .story-share-error {
              margin: 12px 0 0;
              color: #b42318;
              background: #fff4f2;
              border: 1px solid #fecdc9;
              border-radius: 8px;
              padding: 10px 12px;
            }

            .story-share-actions {
              display: flex;
              justify-content: flex-end;
              gap: 8px;
              margin-top: 16px;
              flex-wrap: wrap;
            }

            .story-share-btn-primary {
              background: #6b5a45;
              color: #fff;
              border: none;
              border-radius: 6px;
              padding: 8px 14px;
              cursor: pointer;
              font-weight: 600;
            }

            .story-share-btn-secondary {
              background: #fff;
              color: #6b5a45;
              border: 1px solid #6b5a45;
              border-radius: 6px;
              padding: 8px 14px;
              cursor: pointer;
              font-weight: 600;
            }

            .story-share-btn-primary:disabled,
            .story-share-btn-secondary:disabled {
              opacity: 0.65;
              cursor: not-allowed;
            }
          `}</style>
        </>
      )}
    </>
  );
};
