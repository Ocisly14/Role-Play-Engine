import { useState } from "react";
import { useTranslation } from "react-i18next";

interface SceneCondition {
  description: string;
  mechanicalEffect?: {
    skillPenalty?: Array<{ skill: string; delta: number }>;
    blocked?: boolean;
  };
}

interface SceneConnection {
  targetId: string;
  description?: string;
}

interface SceneInfoPanelProps {
  sceneName: string | null;
  description: string | null;
  conditions: SceneCondition[];
  connections: SceneConnection[];
  resolveSceneName: (id: string) => string;
}

export function SceneInfoPanel({
  sceneName,
  description,
  conditions,
  connections,
  resolveSceneName,
}: SceneInfoPanelProps) {
  const { t } = useTranslation("simulation");
  const [descExpanded, setDescExpanded] = useState(false);

  return (
    <div className="sim-scene-popup-info p-3">
      {sceneName && (
        <h3 className="text-lg font-bold text-amber-700 mb-2">{sceneName}</h3>
      )}

      <div className="space-y-1 text-base text-slate-900">
        {/* Description */}
        {description && (
          <div className="text-slate-900">
            <span className="text-slate-700">
              {t("scenePanel.description")}:
            </span>{" "}
            <span
              className={descExpanded ? "whitespace-pre-wrap" : "line-clamp-2"}
            >
              {description}
            </span>
            <button
              type="button"
              onClick={() => setDescExpanded((prev) => !prev)}
              className="text-amber-600 hover:text-amber-700 text-xs cursor-pointer px-1 py-0 leading-none inline-flex items-center justify-center"
            >
              ...
            </button>
          </div>
        )}

        {/* Conditions */}
        {conditions.length > 0 && (
          <div>
            <span className="text-slate-700">
              {t("scenePanel.conditions")}:
            </span>
            <ul className="text-base text-slate-900 mt-1">
              {conditions.map((cond, i) => (
                <li key={i}>{cond.description}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Connections */}
        {connections.length > 0 && (
          <div>
            <span className="text-slate-700">
              {t("scenePanel.connections")}:
            </span>
            <ul className="text-base text-slate-900 mt-1">
              {connections.map((conn, i) => (
                <li key={i}>
                  {resolveSceneName(conn.targetId)}
                  {conn.description && (
                    <span className="text-slate-600">
                      {" "}
                      — {conn.description}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
