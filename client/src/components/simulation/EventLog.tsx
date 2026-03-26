import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { SimulationEvent } from "../../hooks/useSimulationWebSocket";

interface EventLogProps {
  events: SimulationEvent[];
}

const SYSTEM_EVENT_TYPES = new Set([
  "day_transition",
  "npc_death",
  "simulation_state_changed",
]);

const ACTION_EVENT_TYPES = new Set([
  "action_executed",
  "action_failed",
  "action_interrupted",
]);

const WORLD_EVENT_TYPES = new Set(["scene_updated", "feature_triggered"]);

function sanitizeOutcomeForDisplay(
  outcome: string | undefined
): string | undefined {
  if (!outcome) return outcome;

  return outcome
    .replace(/\s*\[arrived at [^\]]+\]/gi, "")
    .replace(/\s*\[已到达 [^\]]+\]/g, "")
    .replace(/\s*(succeeded?|failed|interrupted)\s*$/i, "")
    .replace(/\s*(成功|失败|已中断)\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function localizeLegacyOutcome(
  outcome: string | undefined,
  t: (key: string, params?: Record<string, string>) => string
): string | undefined {
  if (!outcome) return outcome;

  const encounteredMatch = outcome.match(
    /^Encountered others in person:\s*(.+)$/i
  );
  if (encounteredMatch) {
    return t("events.legacyEncounteredOthers", {
      outcome: encounteredMatch[1]?.trim() ?? "",
    });
  }

  const failedMatch = outcome.match(
    /^Action "(.+)" at ([0-2]\d:[0-5]\d) failed with (.+)\.$/i
  );
  if (failedMatch) {
    return t("events.legacyActionFailed", {
      action: failedMatch[1]?.trim() ?? "",
      gameTime: failedMatch[2]?.trim() ?? "",
      reason: failedMatch[3]?.trim() ?? "",
    });
  }

  return outcome;
}

export function EventLog({ events }: EventLogProps) {
  const { t } = useTranslation("simulation");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (events.length === 0) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  return (
    <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1.5">
      {events.length === 0 && (
        <div className="px-3 py-4 text-xs text-slate-400 text-center">
          {t("events.noEvents")}
        </div>
      )}
      {events.map((event) => {
        if (SYSTEM_EVENT_TYPES.has(event.type)) {
          return <SystemMessage key={event.id} event={event} />;
        }
        if (WORLD_EVENT_TYPES.has(event.type)) {
          return <WorldEventMessage key={event.id} event={event} />;
        }
        if (ACTION_EVENT_TYPES.has(event.type)) {
          return <ActionMessage key={event.id} event={event} />;
        }
        return <CompactMessage key={event.id} event={event} />;
      })}
      <div ref={bottomRef} />
    </div>
  );
}

function ActionMessage({ event }: { event: SimulationEvent }) {
  const { t } = useTranslation("simulation");
  const isFailed = event.type === "action_failed";
  const isInterrupted = event.type === "action_interrupted";
  const name =
    (event.data.characterName as string) ||
    event.actorNpcId ||
    t("events.unknown");
  const outcome = sanitizeOutcomeForDisplay(
    localizeLegacyOutcome(event.data.outcome as string | undefined, t)
  );
  const containerClass = isFailed
    ? "bg-red-50/60 border border-red-200/50"
    : isInterrupted
      ? "bg-amber-50/60 border border-amber-200/50"
      : "bg-white/60 border border-slate-200/50";
  const outcomeClass = isFailed
    ? "text-red-500"
    : isInterrupted
      ? "text-amber-700"
      : "text-emerald-600";
  const outcomePrefix = isFailed ? "✗" : isInterrupted ? "↺" : "✓";

  return (
    <div className={`rounded-lg px-3 py-2 text-xs ${containerClass}`}>
      <div className="flex items-center justify-between mb-0.5">
        <span className="font-semibold text-slate-800 truncate">{name}</span>
        <span className="text-[10px] text-slate-400 ml-2 shrink-0">
          {event.gameTime}
        </span>
      </div>
      {outcome && (
        <div className={`text-[11px] leading-relaxed ${outcomeClass}`}>
          {outcomePrefix} {outcome}
        </div>
      )}
    </div>
  );
}

function SystemMessage({ event }: { event: SimulationEvent }) {
  const { t } = useTranslation("simulation");
  let text: string;
  switch (event.type) {
    case "day_transition":
      text = t("events.day", { day: event.gameDay });
      break;
    case "npc_death":
      text = t("events.died", {
        name: (event.data.npcName as string) || event.actorNpcId,
      });
      break;
    default:
      text = event.type.replace(/_/g, " ");
  }

  return (
    <div className="flex items-center gap-2 py-1">
      <div className="flex-1 border-t border-slate-300/50" />
      <span className="text-[10px] text-slate-400 whitespace-nowrap">
        {text}
      </span>
      <div className="flex-1 border-t border-slate-300/50" />
    </div>
  );
}

function WorldEventMessage({ event }: { event: SimulationEvent }) {
  const { t } = useTranslation("simulation");
  const description =
    (event.data.description as string) || event.type.replace(/_/g, " ");

  return (
    <div className="rounded-lg px-3 py-2 text-xs bg-amber-50/60 border border-amber-200/50">
      <div className="flex items-center justify-between mb-0.5">
        <span className="font-semibold text-amber-800">
          {t("events.worldEvent")}
        </span>
        <span className="text-[10px] text-slate-400 ml-2 shrink-0">
          {event.gameTime}
        </span>
      </div>
      <div className="text-[11px] leading-relaxed text-amber-700">
        {description}
      </div>
    </div>
  );
}

function CompactMessage({ event }: { event: SimulationEvent }) {
  return (
    <div className="px-2 py-1 text-[11px] text-slate-500 flex items-center gap-1.5">
      <span className="text-slate-400">{event.gameTime}</span>
      <span className="truncate">{formatCompactText(event)}</span>
    </div>
  );
}

function formatCompactText(event: SimulationEvent): string {
  const name = (event.data.characterName as string) || event.actorNpcId || "";
  switch (event.type) {
    case "npc_moved":
      return `${name} → ${event.location}`;
    default:
      return `${name} — ${event.type.replace(/_/g, " ")}`;
  }
}
