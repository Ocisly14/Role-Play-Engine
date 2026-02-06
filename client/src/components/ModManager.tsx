import React, { useEffect, useState } from "react";
import { authFetch } from "../utils/authFetch";

type LibraryMod = {
  name: string;
  shared?: boolean;
  ownerEmail?: string | null;
  isOwner?: boolean;
};

type SharedMod = {
  name: string;
  ownerEmail: string;
  inLibrary: boolean;
};

type DeletedMod = {
  name: string;
  deletedAt: string;
  ownerEmail: string;
  daysLeft: number;
};

interface ModManagerProps {
  onClose: () => void;
}

export function ModManager({ onClose }: ModManagerProps) {
  const [tab, setTab] = useState<"library" | "shared" | "deleted">("library");
  const [libraryMods, setLibraryMods] = useState<LibraryMod[]>([]);
  const [sharedMods, setSharedMods] = useState<SharedMod[]>([]);
  const [deletedMods, setDeletedMods] = useState<DeletedMod[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [loadingShared, setLoadingShared] = useState(false);
  const [loadingDeleted, setLoadingDeleted] = useState(false);
  const [selectedDeleted, setSelectedDeleted] = useState<
    Record<string, boolean>
  >({});
  const [selectedLibrary, setSelectedLibrary] = useState<
    Record<string, boolean>
  >({});
  const [searchQuery, setSearchQuery] = useState("");
  const [previewMod, setPreviewMod] = useState<string | null>(null);
  const [previewIntro, setPreviewIntro] = useState<{
    introduction: string;
    moduleNotes: string;
  } | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const hasLibrarySelection = Object.values(selectedLibrary).some(Boolean);
  const hasDeletedSelection = Object.values(selectedDeleted).some(Boolean);
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => Promise<void>;
  }>({
    open: false,
    title: "",
    message: "",
    confirmLabel: "",
    onConfirm: async () => undefined,
  });

  useEffect(() => {
    fetchLibrary();
  }, []);

  const fetchLibrary = async () => {
    try {
      setLoadingLibrary(true);
      const response = await authFetch("/api/mods");
      const data = await response.json();
      if (response.ok && data.success) {
        const mods = data.mods || [];
        setLibraryMods(mods);
        const nextSelected: Record<string, boolean> = {};
        mods.forEach((mod: LibraryMod) => {
          if (selectedLibrary[mod.name]) {
            nextSelected[mod.name] = true;
          }
        });
        setSelectedLibrary(nextSelected);
      }
    } catch (error) {
      console.error("Error fetching library mods:", error);
    } finally {
      setLoadingLibrary(false);
    }
  };

  const fetchShared = async () => {
    try {
      setLoadingShared(true);
      const q = searchQuery.trim();
      const url = q
        ? `/api/mods/shared?q=${encodeURIComponent(q)}`
        : "/api/mods/shared";
      const response = await authFetch(url);
      const data = await response.json();
      if (response.ok && data.success) {
        setSharedMods(data.mods || []);
      }
    } catch (error) {
      console.error("Error fetching shared mods:", error);
    } finally {
      setLoadingShared(false);
    }
  };

  const fetchDeleted = async () => {
    try {
      setLoadingDeleted(true);
      const response = await authFetch("/api/mods/deleted");
      const data = await response.json();
      if (response.ok && data.success) {
        const mods = data.mods || [];
        setDeletedMods(mods);
        const nextSelected: Record<string, boolean> = {};
        mods.forEach((mod: DeletedMod) => {
          if (selectedDeleted[mod.name]) {
            nextSelected[mod.name] = true;
          }
        });
        setSelectedDeleted(nextSelected);
      }
    } catch (error) {
      console.error("Error fetching deleted mods:", error);
    } finally {
      setLoadingDeleted(false);
    }
  };

  const fetchPreview = async (modName: string) => {
    setPreviewMod(modName);
    setLoadingPreview(true);
    try {
      const response = await authFetch(
        `/api/module/introduction?modName=${encodeURIComponent(modName)}`
      );
      const data = await response.json();
      if (response.ok && data.success) {
        setPreviewIntro(data.moduleIntroduction);
      } else {
        setPreviewIntro(null);
      }
    } catch (error) {
      console.error("Error fetching module introduction:", error);
      setPreviewIntro(null);
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleShare = async (modName: string) => {
    try {
      const response = await authFetch("/api/mods/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modName }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to share module");
      }
      await fetchLibrary();
      if (tab === "shared") {
        await fetchShared();
      }
    } catch (error) {
      alert((error as Error).message);
    }
  };

  const handleUnshare = async (modName: string) => {
    try {
      const response = await authFetch("/api/mods/unshare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modName }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to unshare module");
      }
      await fetchLibrary();
      if (tab === "shared") {
        await fetchShared();
      }
    } catch (error) {
      alert((error as Error).message);
    }
  };

  const handleRemove = async (modName: string) => {
    try {
      const response = await authFetch("/api/mods/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modName }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to delete module");
      }
      await fetchLibrary();
      if (tab === "shared") {
        await fetchShared();
      }
      if (tab === "deleted") {
        await fetchDeleted();
      }
    } catch (error) {
      alert((error as Error).message);
    }
  };

  const confirmShare = (modName: string) => {
    setConfirmState({
      open: true,
      title: "Share Module",
      message: `Sharing "${modName}" will make it searchable to all users. Others can add it to their library. You can unshare later.`,
      confirmLabel: "Share",
      onConfirm: async () => {
        await handleShare(modName);
      },
    });
  };

  const confirmRemove = (modName: string) => {
    setConfirmState({
      open: true,
      title: "Delete Module",
      message:
        `Deleting "${modName}" will remove it from your library. ` +
        `If the module is shared, only your library entry is removed. ` +
        `If it is not shared, it will move to Deleted for 7 days before permanent removal.`,
      confirmLabel: "Delete",
      onConfirm: async () => {
        await handleRemove(modName);
      },
    });
  };

  const handleToggleLibrary = (modName: string) => {
    setSelectedLibrary((prev) => ({
      ...prev,
      [modName]: !prev[modName],
    }));
  };

  const handleSelectAllLibrary = () => {
    const allSelected: Record<string, boolean> = {};
    libraryMods.forEach((mod) => {
      allSelected[mod.name] = true;
    });
    setSelectedLibrary(allSelected);
  };

  const handleClearLibrarySelection = () => {
    setSelectedLibrary({});
  };

  const handleRemoveSelected = async () => {
    const modNames = Object.keys(selectedLibrary).filter(
      (name) => selectedLibrary[name]
    );
    if (modNames.length === 0) {
      alert("No modules selected");
      return;
    }
    setConfirmState({
      open: true,
      title: "Delete Modules",
      message:
        `Deleting ${modNames.length} module(s) will remove them from your library. ` +
        `Shared modules are removed only from your library. ` +
        `Unshared modules move to Deleted for 7 days before permanent removal.`,
      confirmLabel: "Delete",
      onConfirm: async () => {
        try {
          const response = await authFetch("/api/mods/delete-bulk", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ modNames }),
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || "Failed to delete modules");
          }
          await fetchLibrary();
          await fetchDeleted();
        } catch (error) {
          alert((error as Error).message);
        }
      },
    });
  };

  const handleAdd = async (modName: string) => {
    try {
      const response = await authFetch("/api/mods/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modName }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to add module");
      }
      await fetchLibrary();
      await fetchShared();
    } catch (error) {
      alert((error as Error).message);
    }
  };

  const handleRestore = async (modName: string) => {
    try {
      const response = await authFetch("/api/mods/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modName }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to restore module");
      }
      await fetchDeleted();
      await fetchLibrary();
    } catch (error) {
      alert((error as Error).message);
    }
  };

  const handleToggleDeleted = (modName: string) => {
    setSelectedDeleted((prev) => ({
      ...prev,
      [modName]: !prev[modName],
    }));
  };

  const handleSelectAllDeleted = () => {
    const allSelected: Record<string, boolean> = {};
    deletedMods.forEach((mod) => {
      allSelected[mod.name] = true;
    });
    setSelectedDeleted(allSelected);
  };

  const handleClearDeletedSelection = () => {
    setSelectedDeleted({});
  };

  const handleRestoreSelected = async () => {
    const modNames = Object.keys(selectedDeleted).filter(
      (name) => selectedDeleted[name]
    );
    if (modNames.length === 0) {
      alert("No modules selected");
      return;
    }
    try {
      const response = await authFetch("/api/mods/restore-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modNames }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to restore modules");
      }
      await fetchDeleted();
      await fetchLibrary();
    } catch (error) {
      alert((error as Error).message);
    }
  };

  return (
    <>
      <div className="mod-manager-overlay">
        <div className="mod-manager-modal">
          <div className="mod-manager-header">
            <h2>Module Manager</h2>
            <button
              onClick={onClose}
              className="close-button"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <div className="mod-manager-tabs">
            <button
              className={`tab-button ${tab === "library" ? "active" : ""}`}
              onClick={() => {
                setTab("library");
                setPreviewMod(null);
              }}
            >
              My Library
            </button>
            <button
              className={`tab-button ${tab === "shared" ? "active" : ""}`}
              onClick={() => {
                setTab("shared");
                setPreviewMod(null);
                fetchShared();
              }}
            >
              Shared Library
            </button>
            <button
              className={`tab-button ${tab === "deleted" ? "active" : ""}`}
              onClick={() => {
                setTab("deleted");
                setPreviewMod(null);
                fetchDeleted();
              }}
            >
              Deleted
            </button>
          </div>

          <div className="mod-manager-content">
            {tab === "library" && (
              <>
                {hasLibrarySelection && (
                  <div className="deleted-actions">
                    <button
                      className="btn-secondary"
                      onClick={handleSelectAllLibrary}
                    >
                      Select All
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={handleClearLibrarySelection}
                    >
                      Clear
                    </button>
                    <button
                      className="btn-primary"
                      onClick={handleRemoveSelected}
                    >
                      Delete Selected
                    </button>
                  </div>
                )}
                {loadingLibrary ? (
                  <p>Loading modules...</p>
                ) : libraryMods.length === 0 ? (
                  <p style={{ color: "#666" }}>No modules in your library.</p>
                ) : (
                  <div className="mod-list">
                    {libraryMods.map((mod) => (
                      <div key={mod.name} className="mod-row">
                        <div className="mod-info">
                          <div className="mod-select">
                            <input
                              type="checkbox"
                              checked={Boolean(selectedLibrary[mod.name])}
                              onChange={() => handleToggleLibrary(mod.name)}
                            />
                            <span
                              className="mod-title mod-title-clickable"
                              onClick={() => fetchPreview(mod.name)}
                            >
                              {mod.name}
                            </span>
                          </div>
                          {mod.shared && (
                            <span className="mod-badge">Shared</span>
                          )}
                        </div>
                        <div className="mod-actions">
                          {!mod.shared && mod.isOwner && (
                            <button
                              className="btn-secondary"
                              onClick={() => confirmShare(mod.name)}
                            >
                              Share
                            </button>
                          )}
                          {mod.shared && mod.isOwner && (
                            <button
                              className="btn-secondary"
                              onClick={() => handleUnshare(mod.name)}
                            >
                              Unshare
                            </button>
                          )}
                          <button
                            className="btn-secondary"
                            onClick={() => confirmRemove(mod.name)}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {tab === "shared" && (
              <>
                <div className="shared-search">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search shared modules..."
                  />
                  <button className="btn-primary" onClick={fetchShared}>
                    Search
                  </button>
                </div>

                {loadingShared ? (
                  <p>Loading shared modules...</p>
                ) : sharedMods.length === 0 ? (
                  <p style={{ color: "#666" }}>No shared modules found.</p>
                ) : (
                  <div className="mod-list">
                    {sharedMods.map((mod) => (
                      <div key={mod.name} className="mod-row">
                        <div className="mod-info">
                          <span
                            className="mod-title mod-title-clickable"
                            onClick={() => fetchPreview(mod.name)}
                          >
                            {mod.name}
                          </span>
                        </div>
                        <div className="mod-actions">
                          <button
                            className="btn-secondary"
                            onClick={() => handleAdd(mod.name)}
                            disabled={mod.inLibrary}
                          >
                            {mod.inLibrary ? "Added" : "Add"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {tab === "deleted" && (
              <>
                {hasDeletedSelection && (
                  <div className="deleted-actions">
                    <button
                      className="btn-secondary"
                      onClick={handleSelectAllDeleted}
                    >
                      Select All
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={handleClearDeletedSelection}
                    >
                      Clear
                    </button>
                    <button
                      className="btn-primary"
                      onClick={handleRestoreSelected}
                    >
                      Restore Selected
                    </button>
                  </div>
                )}
                {loadingDeleted ? (
                  <p>Loading deleted modules...</p>
                ) : deletedMods.length === 0 ? (
                  <p style={{ color: "#666" }}>No deleted modules.</p>
                ) : (
                  <div className="mod-list">
                    {deletedMods.map((mod) => (
                      <div key={mod.name} className="mod-row">
                        <div className="mod-info">
                          <label className="mod-select">
                            <input
                              type="checkbox"
                              checked={Boolean(selectedDeleted[mod.name])}
                              onChange={() => handleToggleDeleted(mod.name)}
                            />
                            <span className="mod-title">{mod.name}</span>
                          </label>
                          <div className="mod-meta">
                            Deleted at{" "}
                            {new Date(mod.deletedAt).toLocaleString()} ·{" "}
                            {mod.daysLeft} day{mod.daysLeft === 1 ? "" : "s"}{" "}
                            left
                          </div>
                        </div>
                        <div className="mod-actions">
                          <button
                            className="btn-secondary"
                            onClick={() => handleRestore(mod.name)}
                          >
                            Restore
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <style>{`
        .mod-manager-overlay {
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
          .mod-manager-overlay {
            background: rgba(0, 0, 0, 0.3);
          }
        }
        .mod-manager-modal {
          background: rgba(255, 255, 255, 0.8);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.5);
          box-shadow: 0 30px 80px rgba(15, 23, 42, 0.25);
          max-width: 900px;
          width: 100%;
          max-height: 85vh;
          display: flex;
          flex-direction: column;
          border-radius: 1.5rem;
          overflow: hidden;
        }
        @supports (backdrop-filter: blur(16px)) {
          .mod-manager-modal {
            background: rgba(255, 255, 255, 0.55);
          }
        }
        .mod-manager-header {
          padding: 16px 24px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid rgba(226, 232, 240, 0.5);
        }
        .mod-manager-header h2 {
          margin: 0;
          font-size: 1.4rem;
          color: var(--title, #3d2f1f);
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
        .mod-manager-tabs {
          display: flex;
          gap: 8px;
          padding: 12px 24px 0;
        }
        .tab-button {
          border: 1px solid rgba(203, 213, 225, 0.8);
          background: rgba(255, 255, 255, 0.6);
          border-radius: 999px;
          padding: 8px 16px;
          cursor: pointer;
          font-weight: 600;
        }
        .tab-button.active {
          background: #6b5a45;
          color: #fff;
          border-color: #6b5a45;
        }
        .mod-manager-content {
          padding: 20px 24px 24px;
          overflow-y: auto;
          flex: 1;
        }
        .deleted-actions {
          display: flex;
          gap: 8px;
          margin-bottom: 12px;
          flex-wrap: wrap;
        }
        .shared-search {
          display: flex;
          gap: 10px;
          margin-bottom: 16px;
        }
        .shared-search input {
          flex: 1;
          padding: 10px 12px;
          border: 1px solid #ccc;
          border-radius: 6px;
        }
        .mod-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .mod-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 14px;
          border: 1px solid rgba(226, 232, 240, 0.8);
          border-radius: 10px;
          background: rgba(255, 255, 255, 0.7);
        }
        .mod-info {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .mod-select {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .mod-select input {
          width: 16px;
          height: 16px;
        }
        .mod-title {
          font-weight: 600;
          color: #3d2f1f;
        }
        .mod-meta {
          font-size: 0.85rem;
          color: #666;
        }
        .mod-actions {
          display: flex;
          gap: 8px;
        }
        .mod-badge {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 999px;
          background: rgba(139, 115, 85, 0.15);
          color: #6b5a45;
          font-size: 0.75rem;
          font-weight: 600;
          width: fit-content;
        }
        .btn-primary {
          background: #6b5a45;
          color: #fff;
          border: none;
          border-radius: 6px;
          padding: 8px 14px;
          cursor: pointer;
          font-weight: 600;
        }
        .btn-secondary {
          background: #fff;
          color: #6b5a45;
          border: 1px solid #6b5a45;
          border-radius: 6px;
          padding: 8px 14px;
          cursor: pointer;
          font-weight: 600;
        }
        .btn-secondary:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .confirm-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.45);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1100;
          padding: 20px;
        }
        .confirm-modal {
          background: rgba(255, 255, 255, 0.9);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          border: 1px solid rgba(226, 232, 240, 0.8);
          border-radius: 14px;
          max-width: 520px;
          width: 100%;
          padding: 24px;
          box-shadow: 0 20px 50px rgba(15, 23, 42, 0.25);
        }
        .confirm-title {
          margin: 0 0 10px;
          font-size: 1.2rem;
          color: var(--title, #3d2f1f);
        }
        .confirm-message {
          margin: 0 0 16px;
          color: #444;
          line-height: 1.5;
        }
        .confirm-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
        }
        .mod-title-clickable {
          cursor: pointer;
          text-decoration: underline;
          text-decoration-color: transparent;
          transition: text-decoration-color 0.2s;
        }
        .mod-title-clickable:hover {
          text-decoration-color: #6b5a45;
        }
        .intro-preview-overlay {
          z-index: 1100;
        }
        .intro-preview-modal {
          max-width: 680px;
          max-height: 80vh;
          overflow-y: auto;
          padding: 28px;
        }
        .intro-preview-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }
        .intro-preview-header .confirm-title {
          margin: 0;
        }
        .preview-section {
          margin-bottom: 24px;
        }
        .preview-section-title {
          color: #5a4a3a;
          margin: 0 0 10px;
          font-size: 1.1rem;
        }
        .preview-content {
          background-color: #fff;
          padding: 20px;
          border-radius: 4px;
          border: 1px solid #ddd;
          line-height: 1.8;
          color: #2c2c2c;
          white-space: pre-wrap;
        }
      `}</style>

      {previewMod && (
        <div className="confirm-overlay intro-preview-overlay">
          <div className="confirm-modal intro-preview-modal">
            <div className="intro-preview-header">
              <h3 className="confirm-title">{previewMod}</h3>
              <button
                className="close-button"
                onClick={() => {
                  setPreviewMod(null);
                  setPreviewIntro(null);
                }}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            {loadingPreview ? (
              <p style={{ color: "#666", margin: "20px 0" }}>
                Loading introduction...
              </p>
            ) : previewIntro ? (
              <>
                <div className="preview-section">
                  <h4 className="preview-section-title">Story Introduction</h4>
                  <div className="preview-content">
                    {previewIntro.introduction ||
                      "No story introduction available."}
                  </div>
                </div>
                <div className="preview-section">
                  <h4 className="preview-section-title">
                    📝 Character Creation Guide
                  </h4>
                  <div className="preview-content">
                    {previewIntro.moduleNotes ||
                      "No character creation guide available."}
                  </div>
                </div>
              </>
            ) : (
              <p style={{ color: "#666", margin: "20px 0" }}>
                No introduction available for this module.
              </p>
            )}
          </div>
        </div>
      )}

      {confirmState.open && (
        <div className="confirm-overlay">
          <div className="confirm-modal">
            <h3 className="confirm-title">{confirmState.title}</h3>
            <p className="confirm-message">{confirmState.message}</p>
            <div className="confirm-actions">
              <button
                className="btn-secondary"
                onClick={() =>
                  setConfirmState((prev) => ({ ...prev, open: false }))
                }
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={async () => {
                  await confirmState.onConfirm();
                  setConfirmState((prev) => ({ ...prev, open: false }));
                }}
              >
                {confirmState.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
