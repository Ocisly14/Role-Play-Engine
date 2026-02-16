import React, { useState } from "react";
import { useTranslation } from "react-i18next";

interface Checkpoint {
  checkpointId: string;
  checkpointName: string;
  modName: string;
  currentSceneName?: string;
  currentLocation?: string;
  gameDay?: number;
  gameTime?: string;
  createdAt?: string;
}

interface CheckpointSelectorModalProps {
  open: boolean;
  onClose: () => void;
  checkpoints: Checkpoint[];
  loadingCheckpoints: boolean;
  loadingCheckpoint?: boolean;
  onLoad: (checkpointId: string) => Promise<void>;
  onDelete: (checkpointId: string, checkpointName: string, e: React.MouseEvent) => Promise<void>;
  onBatchDelete: (checkpointIds: string[]) => Promise<void>;
}

export const CheckpointSelectorModal: React.FC<
  CheckpointSelectorModalProps
> = ({
  open,
  onClose,
  checkpoints,
  loadingCheckpoints,
  loadingCheckpoint = false,
  onLoad,
  onDelete,
  onBatchDelete,
}) => {
  const { t } = useTranslation('checkpoint');
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  if (!open) {
    return null;
  }

  // Group checkpoints by module name
  const groupedCheckpoints = checkpoints.reduce(
    (acc: Record<string, Checkpoint[]>, checkpoint: Checkpoint) => {
      const modName = checkpoint.modName || "Unknown Module";
      if (!acc[modName]) {
        acc[modName] = [];
      }
      acc[modName].push(checkpoint);
      return acc;
    },
    {}
  );

  const handleToggleSelect = (checkpointId: string) => {
    if (loadingCheckpoint) return;
    const newSelected = new Set(selectedIds);
    if (newSelected.has(checkpointId)) {
      newSelected.delete(checkpointId);
    } else {
      newSelected.add(checkpointId);
    }
    setSelectedIds(newSelected);
  };

  const handleSelectAll = () => {
    if (loadingCheckpoint) return;
    if (selectedIds.size === checkpoints.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(checkpoints.map(cp => cp.checkpointId)));
    }
  };

  const handleBatchDelete = async () => {
    if (loadingCheckpoint) return;
    if (selectedIds.size === 0) return;

    const confirmed = window.confirm(
      t('confirmBatchDelete', { count: selectedIds.size })
    );

    if (!confirmed) return;

    await onBatchDelete(Array.from(selectedIds));
    setSelectedIds(new Set());
    setBatchMode(false);
  };

  const handleCloseBatchMode = () => {
    if (loadingCheckpoint) return;
    setBatchMode(false);
    setSelectedIds(new Set());
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm supports-[backdrop-filter]:bg-black/30 supports-[backdrop-filter]:backdrop-blur-sm flex items-center justify-center p-5">
      <div className="fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] max-w-[800px] max-h-[80vh] w-[90%] overflow-y-auto rounded-3xl p-12 supports-[backdrop-filter]:backdrop-blur-lg border border-white/50 bg-white/80 shadow-[0_30px_80px_rgba(15,23,42,0.25)] supports-[backdrop-filter]:bg-white/55">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-semibold m-0">
            {batchMode ? t('batchDeleteTitle') : t('select')}
          </h2>
          <button
            onClick={onClose}
            className="close-button"
            aria-label={t('common:button.close')}
            disabled={loadingCheckpoint}
          >
            ×
          </button>
        </div>

        {!loadingCheckpoints && !loadingCheckpoint && checkpoints.length > 0 && (
          <div style={{ display: "flex", gap: "10px", marginBottom: "20px" }}>
            {!batchMode ? (
              <button
                onClick={() => setBatchMode(true)}
                style={{
                  padding: "8px 16px",
                  backgroundColor: "#dc3545",
                  color: "#fff",
                  border: "none",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontWeight: "600",
                  fontSize: "14px",
                  transition: "all 0.2s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "#c82333";
                  e.currentTarget.style.transform = "translateY(-1px)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "#dc3545";
                  e.currentTarget.style.transform = "translateY(0)";
                }}
              >
                🗑️ {t('batchDelete')}
              </button>
            ) : (
              <>
                <button
                  onClick={handleSelectAll}
                  style={{
                    padding: "8px 16px",
                    backgroundColor: "#6c757d",
                    color: "#fff",
                    border: "none",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontWeight: "600",
                    fontSize: "14px",
                    transition: "all 0.2s",
                  }}
                >
                  {selectedIds.size === checkpoints.length ? t('deselectAll') : t('selectAll')}
                </button>
                <button
                  onClick={handleBatchDelete}
                  disabled={selectedIds.size === 0}
                  style={{
                    padding: "8px 16px",
                    backgroundColor: selectedIds.size === 0 ? "#ccc" : "#dc3545",
                    color: "#fff",
                    border: "none",
                    borderRadius: "6px",
                    cursor: selectedIds.size === 0 ? "not-allowed" : "pointer",
                    fontWeight: "600",
                    fontSize: "14px",
                    transition: "all 0.2s",
                  }}
                >
                  {t('deleteSelected', { count: selectedIds.size })}
                </button>
                <button
                  onClick={handleCloseBatchMode}
                  style={{
                    padding: "8px 16px",
                    backgroundColor: "#fff",
                    color: "#333",
                    border: "2px solid #8b7355",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontWeight: "600",
                    fontSize: "14px",
                    transition: "all 0.2s",
                  }}
                >
                  {t('cancel')}
                </button>
              </>
            )}
          </div>
        )}

        {loadingCheckpoints || loadingCheckpoint ? (
          <p>{loadingCheckpoint ? t('loadingCheckpoint') : t('loading')}</p>
        ) : checkpoints.length === 0 ? (
          <p style={{ color: "#666" }}>{t('empty')}</p>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "20px",
            }}
          >
            {Object.entries(groupedCheckpoints).map(
              ([modName, modCheckpoints]: [string, Checkpoint[]]) => (
                <div
                  key={modName}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                  }}
                >
                  {/* Module Header */}
                  <div
                    style={{
                      padding: "8px 12px",
                      backgroundColor: "#8b7355",
                      color: "#fff",
                      fontWeight: "bold",
                      fontSize: "0.9rem",
                      borderRadius: "4px",
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <span>📚</span>
                    <span>{modName}</span>
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: "0.85rem",
                        fontWeight: "normal",
                        opacity: 0.9,
                      }}
                    >
                      ({modCheckpoints.length} {t('title', { count: modCheckpoints.length })})
                    </span>
                  </div>

                  {/* Checkpoints in this module */}
                  {modCheckpoints.map((checkpoint) => {
                    const isSelected = selectedIds.has(checkpoint.checkpointId);
                    return (
                      <div
                        key={checkpoint.checkpointId}
                        onClick={() =>
                          batchMode
                            ? handleToggleSelect(checkpoint.checkpointId)
                            : onLoad(checkpoint.checkpointId)
                        }
                        style={{
                          padding: "15px",
                          border: isSelected ? "2px solid #dc3545" : "2px solid #8b7355",
                          borderRadius: "4px",
                          cursor: loadingCheckpoint ? "not-allowed" : "pointer",
                          backgroundColor: isSelected ? "#ffe5e5" : "#fff",
                          transition: "all 0.2s",
                          position: "relative",
                          marginLeft: "15px",
                          opacity: loadingCheckpoint ? 0.7 : 1,
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = isSelected ? "#ffd5d5" : "#f0ebe0";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = isSelected ? "#ffe5e5" : "#fff";
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "flex-start",
                            marginBottom: "5px",
                            gap: "10px",
                          }}
                        >
                          {batchMode && (
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleToggleSelect(checkpoint.checkpointId)}
                              onClick={(e) => e.stopPropagation()}
                              style={{
                                width: "20px",
                                height: "20px",
                                cursor: "pointer",
                                flexShrink: 0,
                                marginTop: "2px",
                              }}
                            />
                          )}
                          <div
                            style={{
                              fontWeight: "bold",
                              color: "#3d2817",
                              flex: 1,
                            }}
                          >
                            {checkpoint.checkpointName || t('unnamed')}
                          </div>
                        {!batchMode && (
                          <button
                            onClick={(e) =>
                              onDelete(
                                checkpoint.checkpointId,
                                checkpoint.checkpointName || t('unnamed'),
                                e
                              )
                            }
                            style={{
                            width: "28px",
                            height: "28px",
                            borderRadius: "50%",
                            border: "2px solid #c82333",
                            backgroundColor: "#fff",
                            color: "#c82333",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "1.2rem",
                            lineHeight: "1",
                            padding: 0,
                            flexShrink: 0,
                            fontFamily: "var(--serif)",
                            transition: "all 0.2s ease",
                            boxShadow: "0 2px 4px rgba(0, 0, 0, 0.2)",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = "#dc3545";
                            e.currentTarget.style.color = "#fff";
                            e.currentTarget.style.borderColor = "#c82333";
                            e.currentTarget.style.transform = "translateY(-1px)";
                            e.currentTarget.style.boxShadow =
                              "0 3px 6px rgba(0, 0, 0, 0.3)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = "#fff";
                            e.currentTarget.style.color = "#c82333";
                            e.currentTarget.style.borderColor = "#c82333";
                            e.currentTarget.style.transform = "translateY(0)";
                            e.currentTarget.style.boxShadow =
                              "0 2px 4px rgba(0, 0, 0, 0.2)";
                          }}
                          title={t('delete')}
                        >
                          ×
                        </button>
                        )}
                      </div>
                      <div style={{ fontSize: "0.85rem", color: "#666" }}>
                        {checkpoint.currentSceneName &&
                          `${t('scene')} ${checkpoint.currentSceneName}`}
                        {checkpoint.currentLocation &&
                          ` | ${t('location')} ${checkpoint.currentLocation}`}
                        {checkpoint.gameDay && ` | ${t('day')} ${checkpoint.gameDay}`}
                        {checkpoint.gameTime && ` | ${checkpoint.gameTime}`}
                      </div>
                      <div
                        style={{
                          fontSize: "0.75rem",
                          color: "#999",
                          marginTop: "5px",
                        }}
                      >
                        {checkpoint.createdAt &&
                          new Date(checkpoint.createdAt).toLocaleString(
                            "en-US"
                          )}
                      </div>
                    </div>
                  );
                  })}
                </div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
};
