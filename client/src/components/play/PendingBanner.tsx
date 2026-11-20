import { useState } from "react";
import type { PlayerPending } from "../../services/playerApi";
import { formatClock } from "./playConstants";

const REASON_TEXT: Record<
  Extract<PlayerPending, { kind: "decision" }>["reason"],
  string
> = {
  woken: "你被惊醒了",
  failed: "刚才的行动失败了",
  idle: "你手头没有事可做",
  rejected: "世界拒绝了你的行动",
};

/** What the world is waiting on, above the inputs. */
export function PendingBanner({
  pending,
  busy,
  onContinue,
  onAnswer,
}: {
  pending: PlayerPending;
  busy: boolean;
  onContinue: () => void;
  onAnswer: (text: string) => Promise<boolean>;
}) {
  const [answer, setAnswer] = useState("");

  if (pending.kind === "dead") {
    return (
      <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-red-800 font-semibold">
        角色已死亡（{formatClock(pending.since)}）
      </div>
    );
  }

  if (pending.kind === "decision") {
    return (
      <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 space-y-2">
        <div className="font-semibold">
          世界已暂停，等你决定
          <span className="ml-2 text-sm font-normal text-amber-700">
            {REASON_TEXT[pending.reason]} · {formatClock(pending.since)}
          </span>
        </div>
        {pending.rejection && (
          <div className="text-sm whitespace-pre-wrap">{pending.rejection}</div>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={onContinue}
          className="px-3 py-1 rounded bg-amber-600 text-white text-sm hover:bg-amber-700 disabled:opacity-50"
        >
          继续
        </button>
      </div>
    );
  }

  return (
    <div className="rounded border border-blue-300 bg-blue-50 px-4 py-3 text-blue-900 space-y-2">
      <div className="text-sm text-blue-700">
        你的角色在问你（{formatClock(pending.since)}）：
      </div>
      <div className="font-semibold text-base bg-yellow-100 rounded px-2 py-1 whitespace-pre-wrap">
        {pending.question}
      </div>
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!answer.trim()) return;
          if (await onAnswer(answer.trim())) setAnswer("");
        }}
      >
        <input
          className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm text-gray-800"
          placeholder="回答你的角色……"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
        <button
          type="submit"
          disabled={busy || !answer.trim()}
          className="px-3 py-1 rounded bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          回答
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onContinue}
          className="px-3 py-1 rounded bg-gray-200 text-gray-700 text-sm hover:bg-gray-300 disabled:opacity-50"
        >
          不回答
        </button>
      </form>
    </div>
  );
}
