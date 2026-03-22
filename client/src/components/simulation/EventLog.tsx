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

const ACTION_EVENT_TYPES = new Set(["action_executed", "action_failed"]);

function sanitizeOutcomeForDisplay(outcome: string | undefined): string | undefined {
  if (!outcome) return outcome;

  return outcome
    .replace(/\s*\[arrived at [^\]]+\]\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function EventLog({ events }: EventLogProps) {
  const { t } = useTranslation("simulation");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
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
  const name =
    (event.data.characterName as string) || event.actorNpcId || t("events.unknown");
  const outcome = sanitizeOutcomeForDisplay(
    event.data.outcome as string | undefined
  );

  return (
    <div
      className={`rounded-lg px-3 py-2 text-xs ${isFailed ? "bg-red-50/60 border border-red-200/50" : "bg-white/60 border border-slate-200/50"}`}
    >
      <div className="flex items-center justify-between mb-0.5">
        <span className="font-semibold text-slate-800 truncate">{name}</span>
        <span className="text-[10px] text-slate-400 ml-2 shrink-0">
          {event.gameTime}
        </span>
      </div>
      {outcome && (
        <div
          className={`text-[11px] leading-relaxed ${isFailed ? "text-red-500" : "text-emerald-600"}`}
        >
          {isFailed ? "✗" : "✓"} {outcome}
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

function CompactMessage({ event }: { event: SimulationEvent }) {
  return (
    <div className="px-2 py-1 text-[11px] text-slate-500 flex items-center gap-1.5">
      <span className="text-slate-400">{event.gameTime}</span>
      <span className="truncate">{formatCompactText(event)}</span>
    </div>
  );
}

function formatCompactText(event: SimulationEvent): string {
  const name =
    (event.data.characterName as string) || event.actorNpcId || "";
  switch (event.type) {
    case "npc_moved":
      return `${name} → ${event.location}`;
    case "relationship_changed":
      return `${name} — relationship`;
    case "clue_discovered":
      return `${name} — clue`;
    case "encounter":
      return `${name} — encounter`;
    default:
      return `${name} — ${event.type.replace(/_/g, " ")}`;
  }
}
