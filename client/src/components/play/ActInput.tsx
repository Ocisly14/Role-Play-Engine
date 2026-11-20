import type React from "react";
import { useMemo, useRef, useState } from "react";
import type { MentionLabel, PlayerInput } from "../../services/playerApi";
import { MentionPreview } from "./TaggedText";
import { type LabelLookup, SKILL_DOMAINS } from "./playConstants";

interface PickerState {
  /** Index of the `@` in the text. */
  start: number;
  /** What was typed after the `@`, up to the caret. */
  query: string;
}

/** An open `@` directly before the caret, if the caret sits in one. */
function detectPicker(value: string, caret: number): PickerState | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (/[\s[\]@]/.test(query) || query.length > 20) return null;
  return { start: at, query };
}

const KIND_TEXT: Record<MentionLabel["kind"], string> = {
  character: "人",
  item: "物",
  scene: "地",
};

/** 行动: free text with an `@` picker that inserts `@[handle]` tokens, a
 *  preview with labels substituted, and an optional skill. */
export function ActInput({
  mentions,
  skillValues,
  busy,
  labelOf,
  onCommand,
}: {
  mentions: MentionLabel[];
  skillValues: Record<string, number>;
  busy: boolean;
  labelOf: LabelLookup;
  onCommand: (input: PlayerInput) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [skillId, setSkillId] = useState("");
  const selectedSkill = Object.hasOwn(skillValues, skillId) ? skillId : "";
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const matches = useMemo(() => {
    if (!picker) return [];
    const q = picker.query.toLowerCase();
    return mentions.filter(
      (m) =>
        q === "" ||
        m.label.toLowerCase().includes(q) ||
        m.handle.toLowerCase().includes(q)
    );
  }, [picker, mentions]);

  const pickerOpen =
    picker !== null && picker.start !== dismissedAt && matches.length > 0;

  function syncPicker(value: string, caret: number) {
    const next = detectPicker(value, caret);
    setPicker(next);
    setHighlight(0);
    if (!next || next.start !== dismissedAt) setDismissedAt(null);
  }

  function choose(m: MentionLabel) {
    if (!picker) return;
    const end = picker.start + 1 + picker.query.length;
    const token = `@[${m.handle}] `;
    const next = text.slice(0, picker.start) + token + text.slice(end);
    const caret = picker.start + token.length;
    setText(next);
    setPicker(null);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(caret, caret);
    });
  }

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const ok = await onCommand({
      kind: "act",
      text: trimmed,
      ...(selectedSkill ? { skillId: selectedSkill } : {}),
    });
    if (ok) {
      setText("");
      setPicker(null);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Chinese IME: Enter confirms the composition, not the action.
    if (e.nativeEvent.isComposing) return;
    if (pickerOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const m = matches[Math.min(highlight, matches.length - 1)];
        if (m) choose(m);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (picker) setDismissedAt(picker.start);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="space-y-1">
      <div className="text-sm font-medium text-gray-700">行动</div>
      <div className="relative">
        <textarea
          ref={taRef}
          rows={2}
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm text-gray-800"
          placeholder="描述你要做的事，输入 @ 提及在场的人、物、地点（Enter 提交，Shift+Enter 换行）"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            syncPicker(
              e.target.value,
              e.target.selectionStart ?? e.target.value.length
            );
          }}
          onKeyDown={onKeyDown}
          onClick={(e) =>
            syncPicker(
              e.currentTarget.value,
              e.currentTarget.selectionStart ?? e.currentTarget.value.length
            )
          }
          onBlur={() => setTimeout(() => setPicker(null), 150)}
        />
        {pickerOpen && (
          <ul className="absolute z-20 left-0 bottom-full mb-1 w-64 max-h-56 overflow-auto bg-white border border-gray-300 rounded shadow text-sm">
            {matches.map((m, i) => (
              <li key={m.handle}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(m);
                  }}
                  className={`w-full text-left px-2 py-1 ${
                    i === highlight ? "bg-blue-100" : "hover:bg-gray-100"
                  }`}
                >
                  <span className="text-xs text-gray-400 mr-1">
                    [{KIND_TEXT[m.kind]}]
                  </span>
                  {m.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {text.includes("@[") && (
        <div className="text-xs text-gray-600 bg-gray-50 rounded px-2 py-1">
          预览：
          <MentionPreview text={text} labelOf={labelOf} />
        </div>
      )}
      <div className="flex gap-2 items-center">
        <select
          className="border border-gray-300 rounded px-2 py-1 text-sm text-gray-800"
          aria-label="行动技能"
          value={selectedSkill}
          onChange={(e) => setSkillId(e.target.value)}
        >
          <option value="">技能（可选）</option>
          {SKILL_DOMAINS.filter((s) => Object.hasOwn(skillValues, s.id)).map(
            (s) => (
              <option key={s.id} value={s.id}>
                {s.label} · {skillValues[s.id]}
              </option>
            )
          )}
        </select>
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={() => void submit()}
          className="px-3 py-1 rounded bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          行动
        </button>
      </div>
    </div>
  );
}
