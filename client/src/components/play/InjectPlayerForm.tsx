import type React from "react";
import { useState } from "react";
import {
  type PlayerAttributes,
  errorMessage,
  injectPlayer,
} from "../../services/playerApi";
import {
  ATTRIBUTE_KEYS,
  ATTRIBUTE_LABELS,
  type AttributeKey,
  SKILL_DOMAINS,
  START_RESIDENCES,
} from "./playConstants";

const inputCls =
  "w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400";

/** Shown when the session has no player yet: one click injects a test
 *  character with sensible defaults. */
export function InjectPlayerForm({
  sessionId,
  onInjected,
}: {
  sessionId: string;
  onInjected: () => void;
}) {
  const [name, setName] = useState("测试旅人");
  const [residence, setResidence] = useState(START_RESIDENCES[0].id);
  const [backstory, setBackstory] = useState(
    "一个开车路过灰港的外地人，车子出了点毛病，只好在镇上停留几天。"
  );
  const [intent, setIntent] = useState("修好车，顺便看看这个小镇。");
  const [occupation, setOccupation] = useState("自由撰稿人");
  const [personality, setPersonality] = useState("好奇、谨慎");
  const [gender, setGender] = useState("");
  const [age, setAge] = useState("30");
  const [attributes, setAttributes] = useState<PlayerAttributes>({
    STR: 50,
    CON: 50,
    DEX: 50,
    APP: 50,
    POW: 50,
    SIZ: 50,
    INT: 50,
    EDU: 50,
  });
  const [skills, setSkills] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setAttr(key: AttributeKey, value: string) {
    const n = Number.parseInt(value, 10);
    setAttributes((prev) => ({ ...prev, [key]: Number.isNaN(n) ? 0 : n }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const skillValues: Record<string, number> = {};
    for (const [id, raw] of Object.entries(skills)) {
      const n = Number.parseInt(raw, 10);
      if (!Number.isNaN(n)) skillValues[id] = n;
    }
    const ageNum = Number.parseInt(age, 10);
    try {
      await injectPlayer(sessionId, {
        name: name.trim(),
        attributes,
        skills: skillValues,
        backstory: backstory.trim(),
        residence,
        intent: intent.trim(),
        ...(personality.trim() ? { personality: personality.trim() } : {}),
        ...(occupation.trim() ? { occupation: occupation.trim() } : {}),
        ...(gender.trim() ? { gender: gender.trim() } : {}),
        ...(Number.isNaN(ageNum) ? {} : { age: ageNum }),
      });
      onInjected();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="max-w-2xl mx-auto bg-white rounded-lg shadow p-6 space-y-4 text-gray-800"
    >
      <h2 className="text-lg font-semibold">创建你的角色</h2>
      <p className="text-sm text-gray-500">
        这个会话还没有玩家角色。默认值即可直接开始（世界需处于暂停状态）。
      </p>

      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">
          名字
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="text-sm">
          出发地点
          <select
            className={inputCls}
            value={residence}
            onChange={(e) => setResidence(e.target.value)}
          >
            {START_RESIDENCES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          职业
          <input
            className={inputCls}
            value={occupation}
            onChange={(e) => setOccupation(e.target.value)}
          />
        </label>
        <label className="text-sm">
          性格
          <input
            className={inputCls}
            value={personality}
            onChange={(e) => setPersonality(e.target.value)}
          />
        </label>
        <label className="text-sm">
          年龄
          <input
            className={inputCls}
            type="number"
            min={1}
            value={age}
            onChange={(e) => setAge(e.target.value)}
          />
        </label>
        <label className="text-sm">
          性别（可留空）
          <input
            className={inputCls}
            value={gender}
            onChange={(e) => setGender(e.target.value)}
          />
        </label>
      </div>

      <label className="block text-sm">
        背景故事
        <textarea
          className={inputCls}
          rows={3}
          value={backstory}
          onChange={(e) => setBackstory(e.target.value)}
          required
        />
      </label>
      <label className="block text-sm">
        长期意图
        <textarea
          className={inputCls}
          rows={2}
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          required
        />
      </label>

      <fieldset>
        <legend className="text-sm font-medium mb-1">属性</legend>
        <div className="grid grid-cols-4 gap-2">
          {ATTRIBUTE_KEYS.map((key) => (
            <label key={key} className="text-xs">
              {ATTRIBUTE_LABELS[key]} {key}
              <input
                className={inputCls}
                type="number"
                min={0}
                max={100}
                value={attributes[key]}
                onChange={(e) => setAttr(key, e.target.value)}
              />
            </label>
          ))}
        </div>
      </fieldset>

      <details>
        <summary className="text-sm font-medium cursor-pointer">
          技能（可选，留空即用基础值）
        </summary>
        <div className="grid grid-cols-3 gap-2 mt-2">
          {SKILL_DOMAINS.map((s) => (
            <label key={s.id} className="text-xs">
              {s.label}
              <input
                className={inputCls}
                type="number"
                min={0}
                max={100}
                value={skills[s.id] ?? ""}
                onChange={(e) =>
                  setSkills((prev) => ({ ...prev, [s.id]: e.target.value }))
                }
              />
            </label>
          ))}
        </div>
      </details>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="px-4 py-2 rounded bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? "创建中……" : "创建角色并进入"}
      </button>
    </form>
  );
}
