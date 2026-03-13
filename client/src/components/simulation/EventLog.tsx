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
      <div className="px-3 py-2 text-xs font-medium text-gray-500 border-b border-gray-800">
        Event Log
      </div>
      {events.map((event) => (
        <div
          key={event.id}
          className="px-3 py-1.5 text-xs border-b border-gray-900 hover:bg-gray-800/30"
        >
          <div className="flex items-center gap-1">
            <span className="text-gray-600">
              [{EVENT_LABELS[event.type] ?? event.type}]
            </span>
            <span className="text-gray-500">{event.gameTime}</span>
            <span className="text-gray-300 truncate">
              {formatEventText(event)}
            </span>
          </div>
        </div>
      ))}
      {events.length === 0 && (
        <div className="px-3 py-4 text-xs text-gray-600 text-center">
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
