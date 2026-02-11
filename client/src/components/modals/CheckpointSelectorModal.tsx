import React from "react";

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
  onLoad: (checkpointId: string) => Promise<void>;
  onDelete: (checkpointId: string, checkpointName: string, e: React.MouseEvent) => Promise<void>;
}

export const CheckpointSelectorModal: React.FC<
  CheckpointSelectorModalProps
> = ({ open, onClose, checkpoints, loadingCheckpoints, onLoad, onDelete }) => {
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

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm supports-[backdrop-filter]:bg-black/30 supports-[backdrop-filter]:backdrop-blur-sm flex items-center justify-center p-5">
      <div className="fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] max-w-[800px] max-h-[80vh] w-[90%] overflow-y-auto rounded-3xl p-12 supports-[backdrop-filter]:backdrop-blur-lg border border-white/50 bg-white/80 shadow-[0_30px_80px_rgba(15,23,42,0.25)] supports-[backdrop-filter]:bg-white/55">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-semibold m-0">Select Checkpoint</h2>
          <button onClick={onClose} className="close-button" aria-label="Close">
            ×
          </button>
        </div>

        {loadingCheckpoints ? (
          <p>Loading checkpoint list...</p>
        ) : checkpoints.length === 0 ? (
          <p style={{ color: "#666" }}>No checkpoints available</p>
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
                      ({modCheckpoints.length}{" "}
                      {modCheckpoints.length === 1
                        ? "checkpoint"
                        : "checkpoints"}
                      )
                    </span>
                  </div>

                  {/* Checkpoints in this module */}
                  {modCheckpoints.map((checkpoint) => (
                    <div
                      key={checkpoint.checkpointId}
                      onClick={() => onLoad(checkpoint.checkpointId)}
                      style={{
                        padding: "15px",
                        border: "2px solid #8b7355",
                        borderRadius: "4px",
                        cursor: "pointer",
                        backgroundColor: "#fff",
                        transition: "background-color 0.2s",
                        position: "relative",
                        marginLeft: "15px",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = "#f0ebe0";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = "#fff";
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
                        <div
                          style={{
                            fontWeight: "bold",
                            color: "#3d2817",
                            flex: 1,
                          }}
                        >
                          {checkpoint.checkpointName || "Unnamed Checkpoint"}
                        </div>
                        <button
                          onClick={(e) =>
                            onDelete(
                              checkpoint.checkpointId,
                              checkpoint.checkpointName || "Unnamed Checkpoint",
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
                          title="Delete checkpoint"
                        >
                          ×
                        </button>
                      </div>
                      <div style={{ fontSize: "0.85rem", color: "#666" }}>
                        {checkpoint.currentSceneName &&
                          `Scene: ${checkpoint.currentSceneName}`}
                        {checkpoint.currentLocation &&
                          ` | Location: ${checkpoint.currentLocation}`}
                        {checkpoint.gameDay && ` | Day ${checkpoint.gameDay}`}
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
                  ))}
                </div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
};
