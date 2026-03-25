import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { NpcStatusInfo } from "../../services/simulationApi";

interface NpcDetailProps {
  npc: NpcStatusInfo;
  onBack: () => void;
  onZoomTo: (npcId: string) => void;
}

function ProfileModal({
  npc,
  onClose,
}: {
  npc: NpcStatusInfo;
  onClose: () => void;
}) {
  const { t } = useTranslation("simulation");

  const fields: Array<{ label: string; value: string | number | undefined }> = [
    { label: t("profile.occupation"), value: npc.occupation },
    { label: t("profile.age"), value: npc.age },
    { label: t("profile.gender"), value: npc.gender },
    { label: t("profile.appearance"), value: npc.appearance },
    { label: t("profile.personality"), value: npc.personality },
    { label: t("profile.background"), value: npc.background },
    { label: t("profile.backstory"), value: npc.backstory },
    { label: t("profile.residence"), value: npc.residence },
    { label: t("profile.longTermIntent"), value: npc.longTermIntent },
  ];

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-5"
      style={{
        backgroundColor: "rgba(0, 0, 0, 0.5)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
      }}
      onClick={onClose}
    >
      <div
        className="max-w-3xl w-full max-h-[90vh] flex flex-col rounded-3xl"
        style={{
          background: "rgba(255, 255, 255, 0.55)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          border: "1px solid rgba(255, 255, 255, 0.5)",
          boxShadow: "0 30px 80px rgba(15, 23, 42, 0.25)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/30">
          <h3
            className="text-lg font-bold"
            style={{ color: "var(--title)", fontFamily: "var(--serif)" }}
          >
            {npc.name}
          </h3>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-8 h-8 rounded-xl cursor-pointer"
            style={{
              backdropFilter: "blur(4px)",
              background: "rgba(255, 255, 255, 0.3)",
              border: "1px solid rgba(226, 232, 240, 0.8)",
              color: "rgba(0, 0, 0, 0.7)",
            }}
          >
            &times;
          </button>
        </div>
        <div
          className="overflow-y-auto px-5 py-4 text-sm"
          style={{ color: "var(--ink)" }}
        >
          <img
            src={`/api/maps/npc/${encodeURIComponent(npc.npcId)}.jpg`}
            alt={npc.name}
            className="w-80 h-80 rounded-xl object-cover"
            style={{
              float: "right",
              marginLeft: "1rem",
              marginBottom: "0.5rem",
              border: "1px solid rgba(255, 255, 255, 0.5)",
              boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
            }}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
          <div className="space-y-3">
            {fields.map(
              ({ label, value }) =>
                value != null &&
                value !== "" && (
                  <div key={label}>
                    <span
                      className="text-lg font-semibold tracking-wider"
                      style={{ color: "var(--accent)" }}
                    >
                      {label}
                    </span>
                    <p
                      className="mt-0.5 text-base whitespace-pre-wrap"
                      style={{ fontFamily: "var(--serif)" }}
                    >
                      {value}
                    </p>
                  </div>
                )
            )}
            {fields.every((f) => f.value == null || f.value === "") && (
              <p className="italic" style={{ color: "var(--accent)" }}>
                {t("npc.noProfileInfo")}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function NpcDetail({ npc, onBack, onZoomTo }: NpcDetailProps) {
  const [showProfile, setShowProfile] = useState(false);
  const { t } = useTranslation("simulation");

  return (
    <div className="p-3">
      <button
        onClick={onBack}
        className="text-xs text-slate-500 hover:text-slate-700 mb-2"
      >
        &larr; {t("npc.backToList")}
      </button>
      <div className="flex gap-3 mb-2">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-lg font-bold text-amber-700">{npc.name}</h3>
            <button
              onClick={() => setShowProfile(true)}
              className="px-2 py-0.5 text-xs rounded border border-amber-300 text-amber-700 hover:bg-amber-50 transition-colors"
            >
              {t("npc.profile")}
            </button>
          </div>
          <div className="space-y-1 text-base text-slate-900">
            <div className="text-slate-800">
              <span className="text-slate-700">{t("npc.hp")}:</span> {npc.hp} /{" "}
              {npc.maxHp}
            </div>
            <div className="text-slate-800">
              <span className="text-slate-700">{t("npc.san")}:</span>{" "}
              {npc.sanity} / {npc.maxSanity}
            </div>
            <div className="text-slate-900">
              <span className="text-slate-700">{t("npc.location")}:</span>{" "}
              {npc.location}
            </div>
          </div>
        </div>
        <img
          src={`/api/maps/npc/${encodeURIComponent(npc.npcId)}.jpg`}
          alt={npc.name}
          className="w-20 h-20 rounded-lg object-cover flex-shrink-0"
          style={{
            border: "1px solid rgba(255, 255, 255, 0.5)",
            boxShadow: "0 2px 8px rgba(0, 0, 0, 0.12)",
          }}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      </div>
      <div className="space-y-1 text-base text-slate-900">
        {npc.currentAction && (
          <div className="text-slate-900">
            <span className="text-slate-700">{t("npc.currentAction")}:</span>{" "}
            {npc.currentAction}
          </div>
        )}
        {npc.inventory.length > 0 && (
          <div>
            <span className="text-slate-700 text-base">
              {t("npc.inventory")}:
            </span>
            <ul className="text-base text-slate-900 mt-1">
              {npc.inventory.map((item) => (
                <li key={item.id}>{item.name}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <button
        onClick={() => onZoomTo(npc.npcId)}
        className="mt-3 text-xs text-amber-600 hover:text-amber-700"
      >
        {t("npc.zoomToLocation")} &rarr;
      </button>
      {showProfile &&
        createPortal(
          <ProfileModal npc={npc} onClose={() => setShowProfile(false)} />,
          document.body
        )}
    </div>
  );
}
