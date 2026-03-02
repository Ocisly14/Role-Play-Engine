import type React from "react";
import { useTranslation } from "react-i18next";
import type { SceneRoomInfo } from "../../types/gamechat";

interface SceneRoomTabsProps {
  sceneRooms: SceneRoomInfo[];
  activeTabId: string;
  mySceneRoomId: string;
  onTabChange: (sceneRoomId: string) => void;
}

export const SceneRoomTabs: React.FC<SceneRoomTabsProps> = ({
  sceneRooms,
  activeTabId,
  mySceneRoomId,
  onTabChange,
}) => {
  const { t } = useTranslation("game");

  // Hide when only one room
  if (sceneRooms.length <= 1) {
    return null;
  }

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 bg-black/30 backdrop-blur-sm border-b border-amber-900/30 overflow-x-auto scrollbar-hide">
      {sceneRooms.map((room) => {
        const isActive = room.sceneRoomId === activeTabId;
        const isMine = room.sceneRoomId === mySceneRoomId;
        const playerCount = room.memberPlayerIds.length;
        const displayName = room.scenarioName || t("multiplayer.unknownScene", "Unknown");

        return (
          <button
            key={room.sceneRoomId}
            type="button"
            onClick={() => onTabChange(room.sceneRoomId)}
            className={`
              flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium
              whitespace-nowrap transition-all duration-200 min-w-0
              ${
                isActive
                  ? "bg-amber-900/60 text-amber-100 border border-amber-600/50 shadow-sm"
                  : "bg-black/20 text-amber-300/70 border border-transparent hover:bg-amber-900/30 hover:text-amber-200"
              }
            `}
          >
            {isMine && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0"
                title={t("multiplayer.yourRoom", "Your room")}
              />
            )}
            <span className="truncate max-w-[120px]">{displayName}</span>
            <span
              className={`text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                isActive
                  ? "bg-amber-700/50 text-amber-200"
                  : "bg-black/30 text-amber-400/60"
              }`}
            >
              {playerCount}
            </span>
          </button>
        );
      })}
    </div>
  );
};
