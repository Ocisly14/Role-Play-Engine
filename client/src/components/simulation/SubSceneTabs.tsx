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
    <div className="fixed top-16 right-2 bottom-2 z-40 backdrop-blur-xl bg-white/50 border border-white/30 px-1.5 py-2 flex flex-col items-center gap-1.5 rounded-2xl shadow-lg">
      <button
        onClick={onBack}
        className="text-xs text-slate-500 hover:text-slate-700 px-1 py-1"
        title="Back to Town"
      >
        &larr;
      </button>
      <div className="w-full border-t border-slate-200/60" />
      {subScenes.map((scene) => (
        <button
          key={scene.id}
          onClick={() => onSelect(scene.id)}
          className={`text-xs px-1.5 py-1.5 rounded-lg transition-colors whitespace-nowrap writing-vertical ${
            scene.id === activeSubSceneId
              ? "bg-amber-600 text-white"
              : "text-slate-500 hover:bg-white/50 hover:text-slate-700"
          }`}
          style={{ writingMode: "vertical-rl" }}
        >
          {scene.name}
        </button>
      ))}
    </div>
  );
}
