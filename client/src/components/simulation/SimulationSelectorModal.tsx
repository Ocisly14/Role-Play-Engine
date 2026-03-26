import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  type SimulationListItem,
  deleteSimulation,
  listSimulations,
} from "../../services/simulationApi";

interface SimulationSelectorModalProps {
  open: boolean;
  onClose: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  running: "bg-green-100 text-green-700 border-green-300",
  paused: "bg-yellow-100 text-yellow-700 border-yellow-300",
  stopped: "bg-gray-100 text-gray-600 border-gray-300",
  completed: "bg-blue-100 text-blue-700 border-blue-300",
};

export function SimulationSelectorModal({
  open,
  onClose,
}: SimulationSelectorModalProps) {
  const { t } = useTranslation("simulation");
  const navigate = useNavigate();
  const [simulations, setSimulations] = useState<SimulationListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setConfirmDeleteId(null);
    setSelectionMode(false);
    setSelectedIds({});
    setError(null);
    listSimulations()
      .then(setSimulations)
      .catch((err) => console.error("Failed to load simulations:", err))
      .finally(() => setLoading(false));
  }, [open]);

  async function handleDelete(sessionId: string) {
    setError(null);
    setDeleting(true);
    try {
      await deleteSimulation(sessionId);
      setSimulations((prev) => prev.filter((s) => s.sessionId !== sessionId));
    } catch (err) {
      console.error("Failed to delete simulation:", err);
      setError(t("selector.deleteFailed"));
    } finally {
      setDeleting(false);
      setConfirmDeleteId(null);
    }
  }

  function handleToggleSelected(sessionId: string) {
    setSelectedIds((prev) => ({
      ...prev,
      [sessionId]: !prev[sessionId],
    }));
  }

  function handleSelectAll() {
    const nextSelected: Record<string, boolean> = {};
    for (const sim of simulations) {
      nextSelected[sim.sessionId] = true;
    }
    setSelectedIds(nextSelected);
  }

  function handleClearSelection() {
    setSelectedIds({});
  }

  function handleExitSelectionMode() {
    setSelectionMode(false);
    setSelectedIds({});
  }

  async function handleBulkDelete() {
    const sessionIds = simulations
      .filter((sim) => selectedIds[sim.sessionId])
      .map((sim) => sim.sessionId);
    if (sessionIds.length === 0) return;

    setError(null);
    setBulkDeleting(true);
    const results = await Promise.allSettled(
      sessionIds.map((sessionId) => deleteSimulation(sessionId))
    );

    const failedIds = sessionIds.filter(
      (_, index) => results[index]?.status === "rejected"
    );

    setSimulations((prev) =>
      prev.filter((sim) => failedIds.includes(sim.sessionId))
    );
    setSelectedIds(
      failedIds.reduce<Record<string, boolean>>((acc, sessionId) => {
        acc[sessionId] = true;
        return acc;
      }, {})
    );
    setBulkDeleting(false);

    if (failedIds.length > 0) {
      console.error("Failed to delete simulations:", failedIds);
      setError(t("selector.bulkDeleteFailed", { count: failedIds.length }));
      return;
    }

    handleExitSelectionMode();
  }

  const selectedCount = simulations.filter((sim) => selectedIds[sim.sessionId])
    .length;
  const isBusy = deleting || bulkDeleting;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-5"
      onClick={onClose}
    >
      <div
        className="max-w-[700px] w-full max-h-[80vh] overflow-y-auto rounded-2xl p-8 bg-white/80 backdrop-blur-lg border border-white/50 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start gap-4 mb-6">
          <div>
            <h2
              className="text-xl font-bold"
              style={{ color: "var(--title, #3d2f1f)" }}
            >
              {t("selector.continueSimulation")}
            </h2>
            {selectionMode && (
              <p className="text-sm text-gray-500 mt-1">
                {t("selector.selectedCount", { count: selectedCount })}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {simulations.length > 0 &&
              (selectionMode ? (
                <>
                  <button
                    type="button"
                    onClick={handleSelectAll}
                    disabled={isBusy}
                    className="text-sm px-3 py-1.5 rounded-lg bg-white/70 border border-gray-200 text-gray-700 hover:bg-white disabled:opacity-50"
                  >
                    {t("selector.selectAll")}
                  </button>
                  <button
                    type="button"
                    onClick={handleClearSelection}
                    disabled={isBusy || selectedCount === 0}
                    className="text-sm px-3 py-1.5 rounded-lg bg-white/70 border border-gray-200 text-gray-700 hover:bg-white disabled:opacity-50"
                  >
                    {t("selector.clearSelection")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleBulkDelete()}
                    disabled={isBusy || selectedCount === 0}
                    className="text-sm px-3 py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50"
                  >
                    {bulkDeleting
                      ? t("selector.deleting")
                      : t("selector.deleteSelected", { count: selectedCount })}
                  </button>
                  <button
                    type="button"
                    onClick={handleExitSelectionMode}
                    disabled={isBusy}
                    className="text-sm px-3 py-1.5 rounded-lg bg-white/70 border border-gray-200 text-gray-700 hover:bg-white disabled:opacity-50"
                  >
                    {t("selector.done")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setSelectionMode(true)}
                  disabled={isBusy}
                  className="text-sm px-3 py-1.5 rounded-lg bg-white/70 border border-gray-200 text-gray-700 hover:bg-white disabled:opacity-50"
                >
                  {t("selector.multiSelect")}
                </button>
              ))}
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-2xl"
            >
              &times;
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-center text-gray-500 py-8">
            {t("selector.loading")}
          </p>
        ) : simulations.length === 0 ? (
          <p className="text-center text-gray-500 py-8">
            {t("selector.noSimulations")}
          </p>
        ) : (
          <div className="space-y-3">
            {simulations.map((sim) => (
              <div
                key={sim.sessionId}
                className={`flex items-center gap-2 rounded-xl border transition-all ${
                  selectionMode && selectedIds[sim.sessionId]
                    ? "border-amber-300 bg-amber-50/80"
                    : "border-gray-200 bg-white/50 hover:bg-white/80 hover:border-gray-300"
                }`}
              >
                {selectionMode && (
                  <label className="pl-4 flex items-center">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedIds[sim.sessionId])}
                      onChange={() => handleToggleSelected(sim.sessionId)}
                      disabled={isBusy}
                      className="h-4 w-4 rounded border-gray-300 text-amber-600 focus:ring-amber-500"
                    />
                  </label>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (selectionMode) {
                      handleToggleSelected(sim.sessionId);
                      return;
                    }
                    onClose();
                    navigate(
                      `/simulation/${encodeURIComponent(sim.moduleName ?? sim.sessionId)}`
                    );
                  }}
                  className={`flex-1 text-left p-4 ${selectionMode ? "pr-2" : ""}`}
                >
                  <div className="flex justify-between items-center">
                    <span
                      className="font-medium"
                      style={{ color: "var(--title, #3d2f1f)" }}
                    >
                      {sim.moduleName ?? t("selector.unknownModule")}
                    </span>
                    <span
                      className={`text-xs px-2 py-1 rounded-full border ${STATUS_COLORS[sim.state] ?? ""}`}
                    >
                      {sim.state}
                    </span>
                  </div>
                  <div className="text-sm text-gray-500 mt-1">
                    {t("selector.day", { day: sim.currentDay })} &middot;{" "}
                    {sim.currentTime} &middot;{" "}
                    {t("selector.ticks", { count: sim.ticksExecuted })}
                  </div>
                </button>

                {!selectionMode && confirmDeleteId === sim.sessionId ? (
                  <div className="flex items-center gap-1 pr-3">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleDelete(sim.sessionId)}
                      className="text-xs px-2 py-1 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
                    >
                      {deleting ? "..." : t("selector.confirm")}
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => setConfirmDeleteId(null)}
                      className="text-xs px-2 py-1 rounded-lg bg-gray-200 text-gray-600 hover:bg-gray-300 transition-colors"
                    >
                      {t("selector.cancel")}
                    </button>
                  </div>
                ) : !selectionMode ? (
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(sim.sessionId)}
                    className="pr-4 pl-2 py-4 text-gray-300 hover:text-red-400 transition-colors"
                    title={t("selector.deleteSimulation")}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
