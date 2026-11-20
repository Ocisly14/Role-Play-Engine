import { useEffect, useMemo, useRef } from "react";
import type { PlayerDialogue, PlayerView } from "../../services/playerApi";
import { TaggedText } from "./TaggedText";
import { type LabelLookup, formatClock, formatGameTime } from "./playConstants";

/** 此地 + the visited places (a stand-in for the map). */
export function HerePanel({
  player,
  labelOf,
}: {
  player: PlayerView;
  labelOf: LabelLookup;
}) {
  const latest = player.perceptions[player.perceptions.length - 1];
  const scenes = Object.entries(player.state.visited.scenes).sort((a, b) =>
    a[1].localeCompare(b[1])
  );
  const roads = Object.entries(player.state.visited.roads).sort((a, b) =>
    a[1].localeCompare(b[1])
  );

  return (
    <div className="space-y-4">
      <section className="bg-white rounded shadow p-3">
        <h3 className="text-sm font-semibold text-gray-500 mb-1">此地</h3>
        {latest ? (
          <>
            <div className="font-semibold text-gray-800">
              {labelOf(latest.location) ?? latest.location}
            </div>
            <div className="text-xs text-gray-400 mb-1">
              {formatGameTime(latest.gameDateTime)}
            </div>
            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
              <TaggedText text={latest.narrative} labelOf={labelOf} />
            </p>
          </>
        ) : (
          <p className="text-sm text-gray-400">还没有感知到什么。</p>
        )}
      </section>

      <section className="bg-white rounded shadow p-3">
        <h3 className="text-sm font-semibold text-gray-500 mb-1">
          到过的地方
        </h3>
        {scenes.length === 0 && roads.length === 0 ? (
          <p className="text-sm text-gray-400">暂无</p>
        ) : (
          <ul className="text-sm text-gray-700 space-y-0.5">
            {scenes.map(([id, at]) => (
              <li key={id} className="flex justify-between gap-2">
                <span>{labelOf(id) ?? id}</span>
                <span className="text-xs text-gray-400">
                  {formatGameTime(at)}
                </span>
              </li>
            ))}
            {roads.map(([id, at]) => (
              <li key={id} className="flex justify-between gap-2">
                <span className="italic">{labelOf(id) ?? id}</span>
                <span className="text-xs text-gray-400">
                  {formatGameTime(at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type StreamItem =
  | {
      kind: "perception";
      at: string;
      order: number;
      location: string;
      narrative: string;
    }
  | {
      kind: "friend";
      at: string;
      order: number;
      question?: string;
      answer: string;
    }
  | {
      kind: "dialogue";
      at: string;
      order: number;
      exchange: PlayerDialogue;
    };

function DialogueCard({
  exchange,
  labelOf,
}: { exchange: PlayerDialogue; labelOf: LabelLookup }) {
  return (
    <section className="space-y-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
      <div className="text-xs text-slate-500">
        {formatClock(exchange.spokenAt ?? exchange.gameDateTime)} · 对话
      </div>
      <div className="border-l-2 border-sky-400 pl-2">
        <div className="text-xs font-semibold text-sky-800">你</div>
        <p className="whitespace-pre-wrap break-words text-slate-900">
          {exchange.words}
        </p>
      </div>
      <div className="space-y-2" aria-live="polite">
        {exchange.replies.map((reply) => {
          const label = labelOf(reply.handle) ?? reply.label;
          return (
            <div
              key={reply.handle}
              className="border-l-2 border-amber-500 pl-2"
            >
              <div
                className="text-xs font-semibold text-amber-900"
                title={label}
              >
                {label.split(/[；。]/, 1)[0]}
              </div>
              <p className="whitespace-pre-wrap break-words text-slate-900">
                {reply.words}
              </p>
            </div>
          );
        })}
        {exchange.replies.length === 0 && (
          <p className="pl-2 text-xs text-slate-500">
            {exchange.status === "waiting"
              ? "等待回应…"
              : exchange.status === "unspoken"
                ? "这句话没能说出口。"
                : "没有听到立即回应。"}
          </p>
        )}
      </div>
    </section>
  );
}

/** Every paragraph, oldest first, with the friend log interleaved by time;
 *  follows the bottom as new paragraphs arrive. */
export function PerceptionStream({
  player,
  labelOf,
}: {
  player: PlayerView;
  labelOf: LabelLookup;
}) {
  const items = useMemo<StreamItem[]>(() => {
    const all: StreamItem[] = [
      ...player.perceptions.map(
        (p, i): StreamItem => ({
          kind: "perception",
          at: p.gameDateTime,
          order: i,
          location: p.location,
          narrative: p.narrative,
        })
      ),
      ...player.state.friendLog.map(
        (f, i): StreamItem => ({
          kind: "friend",
          at: f.gameDateTime,
          order: 100000 + i,
          ...(f.question !== undefined ? { question: f.question } : {}),
          answer: f.answer,
        })
      ),
      ...(player.state.dialogue ?? []).map(
        (exchange, i): StreamItem => ({
          kind: "dialogue",
          at: exchange.spokenAt ?? exchange.gameDateTime,
          order: 200000 + i,
          exchange,
        })
      ),
    ];
    return all.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  }, [player.perceptions, player.state.friendLog, player.state.dialogue]);

  const bottomRef = useRef<HTMLDivElement>(null);
  const latestDialogueStatus = player.state.dialogue?.at(-1)?.status;
  useEffect(() => {
    if (items.length === 0) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [items.length, latestDialogueStatus]);

  return (
    <div className="h-full overflow-y-auto bg-white rounded shadow p-3 space-y-3">
      {items.length === 0 && (
        <p className="text-sm text-gray-400">感知流为空。开始世界后会出现。</p>
      )}
      {items.map((item) =>
        item.kind === "perception" ? (
          <div key={`p${item.order}`} className="text-sm text-gray-800">
            <div className="text-xs text-gray-400">
              {formatClock(item.at)} · {labelOf(item.location) ?? item.location}
            </div>
            <p className="leading-relaxed whitespace-pre-wrap">
              <TaggedText text={item.narrative} labelOf={labelOf} />
            </p>
          </div>
        ) : item.kind === "dialogue" ? (
          <DialogueCard
            key={item.exchange.id}
            exchange={item.exchange}
            labelOf={labelOf}
          />
        ) : (
          <div
            key={`f${item.order}`}
            className="text-sm border-l-4 border-blue-300 bg-blue-50 rounded px-2 py-1"
          >
            <div className="text-xs text-blue-500">
              {formatClock(item.at)} · 朋友的话
            </div>
            {item.question && (
              <div className="text-gray-600">角色问：{item.question}</div>
            )}
            <div className="text-blue-900">你说：{item.answer}</div>
          </div>
        )
      )}
      <div ref={bottomRef} />
    </div>
  );
}
