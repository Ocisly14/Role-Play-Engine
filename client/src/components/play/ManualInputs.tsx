import { useEffect, useState } from "react";
import type { PlayerInput, PlayerView } from "../../services/playerApi";
import { ActInput } from "./ActInput";
import type { LabelLookup } from "./playConstants";

const btn =
  "px-3 py-1 rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed";

/** Manual mode: exits, 说话, 行动, 睡觉, and the world's last refusal. */
export function ManualInputs({
  options,
  learnedLanguages,
  skillValues,
  busy,
  labelOf,
  refusal,
  onCommand,
}: {
  options: PlayerView["options"];
  learnedLanguages: string[];
  skillValues: Record<string, number>;
  busy: boolean;
  labelOf: LabelLookup;
  refusal: string | null;
  onCommand: (input: PlayerInput) => Promise<boolean>;
}) {
  const characters = options.mentions.filter((m) => m.kind === "character");
  const [sayTo, setSayTo] = useState<string[]>([]);
  const [words, setWords] = useState("");
  const [language, setLanguage] = useState("");
  const chosenLanguage = learnedLanguages.includes(language) ? language : "";

  // Drop listeners who are no longer here.
  useEffect(() => {
    const present = new Set(
      options.mentions
        .filter((m) => m.kind === "character")
        .map((m) => m.handle)
    );
    setSayTo((prev) => {
      const kept = prev.filter((h) => present.has(h));
      return kept.length === prev.length ? prev : kept;
    });
  }, [options.mentions]);

  function toggle(handle: string) {
    setSayTo((prev) =>
      prev.includes(handle)
        ? prev.filter((h) => h !== handle)
        : [...prev, handle]
    );
  }

  async function say() {
    const w = words.trim();
    if (!w || busy) return;
    if (
      await onCommand({
        kind: "say",
        to: sayTo,
        words: w,
        ...(chosenLanguage ? { language: chosenLanguage } : {}),
      })
    )
      setWords("");
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="text-sm font-medium text-gray-700">出口</div>
        {options.exits.length === 0 ? (
          <div className="text-xs text-gray-400">没有可走的出口</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {options.exits.map((exit) => (
              <button
                key={exit.handle}
                type="button"
                disabled={busy}
                onClick={() => void onCommand({ kind: "move", to: exit.handle })}
                className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}
              >
                → {exit.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1">
        <div className="text-sm font-medium text-gray-700">说话</div>
        <div className="flex flex-wrap gap-1">
          {characters.length === 0 ? (
            <span className="text-xs text-gray-400">身边没有人</span>
          ) : (
            characters.map((c) => {
              const on = sayTo.includes(c.handle);
              return (
                <button
                  key={c.handle}
                  type="button"
                  onClick={() => toggle(c.handle)}
                  className={`px-2 py-0.5 rounded-full text-xs border ${
                    on
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white text-gray-700 border-gray-300 hover:bg-gray-100"
                  }`}
                >
                  {c.label}
                </button>
              );
            })
          )}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void say();
          }}
        >
          {learnedLanguages.length > 0 && (
            <select
              aria-label="说话使用的语言"
              className="max-w-28 border border-gray-300 rounded px-2 py-1 text-sm"
              value={chosenLanguage}
              onChange={(event) => setLanguage(event.target.value)}
            >
              <option value="">母语</option>
              {learnedLanguages.map((tongue) => (
                <option key={tongue} value={tongue}>
                  {tongue}
                </option>
              ))}
            </select>
          )}
          <input
            className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm text-gray-800"
            placeholder="你要说的话……"
            value={words}
            onChange={(e) => setWords(e.target.value)}
          />
          <button
            type="submit"
            disabled={busy || !words.trim()}
            className={`${btn} bg-blue-600 text-white hover:bg-blue-700`}
          >
            说
          </button>
        </form>
      </div>

      <ActInput
        mentions={options.mentions}
        skillValues={skillValues}
        busy={busy}
        labelOf={labelOf}
        onCommand={onCommand}
      />

      <div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onCommand({ kind: "sleep" })}
          className={`${btn} bg-indigo-700 text-white hover:bg-indigo-800`}
        >
          睡觉
        </button>
      </div>

      {refusal && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 whitespace-pre-wrap">
          世界拒绝了：{refusal}
        </div>
      )}
    </div>
  );
}
