interface SubSceneTabsProps {
  subScenes: Array<{ id: string; name: string }>;
  activeSubSceneId: string | null;
  onSelect: (subSceneId: string) => void;
  onBack: () => void;
}

export function SubSceneTabs({
  subScenes,
  activeSubSceneId,
  onSelect,
  onBack,
}: SubSceneTabsProps) {
  if (subScenes.length === 0) return null;

  return (
    <div className="absolute top-0 left-0 right-0 z-40 bg-gray-900/90 border-b border-gray-700 px-3 py-1 flex items-center gap-2">
      <button
        onClick={onBack}
        className="text-xs text-gray-400 hover:text-gray-200 mr-2"
      >
        &larr; Town
      </button>
      {subScenes.map((scene) => (
        <button
          key={scene.id}
          onClick={() => onSelect(scene.id)}
          className={`text-xs px-2 py-1 rounded ${
            scene.id === activeSubSceneId
              ? "bg-amber-700 text-amber-100"
              : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
          }`}
        >
          {scene.name}
        </button>
      ))}
    </div>
  );
}
