import type { SimulationEvent } from "../../hooks/useSimulationWebSocket";

interface EventLogProps {
  events: SimulationEvent[];
}

const EVENT_LABELS: Record<string, string> = {
  action_executed: "action",
  action_failed: "failed",
  npc_moved: "moved",
  npc_death: "death",
  day_transition: "day",
  clue_discovered: "clue",
  encounter: "encounter",
  relationship_changed: "social",
  simulation_state_changed: "state",
};

export function EventLog({ events }: EventLogProps) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-3 py-2 text-xs font-medium text-slate-500 border-b border-slate-200/60">
        Event Log
      </div>
      {events.map((event) => (
        <div
          key={event.id}
          className="px-3 py-1.5 text-xs border-b border-slate-200/40 hover:bg-white/30"
        >
          <div className="flex items-center gap-1">
            <span className="text-slate-400">
              [{EVENT_LABELS[event.type] ?? event.type}]
            </span>
            <span className="text-slate-400">{event.gameTime}</span>
            <span className="text-slate-700 truncate">
              {formatEventText(event)}
            </span>
          </div>
        </div>
      ))}
      {events.length === 0 && (
        <div className="px-3 py-4 text-xs text-slate-400 text-center">
          No events yet
        </div>
      )}
    </div>
  );
}

function formatEventText(event: SimulationEvent): string {
  const data = event.data;
  switch (event.type) {
    case "npc_moved":
      return `${event.actorNpcId} moved to ${event.location}`;
    case "action_executed":
    case "action_failed":
      return `${event.actorNpcId}: ${(data.action as string) ?? event.type}`;
    case "npc_death":
      return `${(data.npcName as string) ?? event.actorNpcId} died`;
    case "day_transition":
      return `Day ${event.gameDay}`;
    default:
      return event.type;
  }
}
