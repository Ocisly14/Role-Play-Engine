// src/engine/resolution/contextBuilder.ts
//
// Builds the single EngineResolutionContext (plan D7, two-tier since M3).
// Called only when an action resolution trigger exists. Everything comes from
// the same tick-start DGSM state; forbidden inputs (renderer text, RoleSim
// thoughts, unflushed deltas) simply have no path in.
//
// Two tiers:
//   Tier 1 (`state.graph`)  — the WHOLE world as a graph: every macro
//     location, every place (scene/junction/road) and every authored
//     connection, with travel times and blocked/hidden flags. No prose.
//   Tier 2 (`state.places`) — full snapshots of only the INVOLVED places:
//     where a triggering actor stands, what an objectRef points at, and where
//     a referenced item is held.
//
// `state.itemHolders` is the FULL-world item→holder map: the validator reads
// it (and the graph) rather than the trimmed prompt lists, so prompt
// trimming never narrows what counts as a real reference.

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { JunctionNode, RoadNode } from "../../state/topologyTypes.js";
import type { DynamicScene, Item, SceneConnection } from "../../state/types.js";
import type { ActionCommand, EngineAction } from "../actions/types.js";
import { ACTION_SCHEMA_VERSION } from "../actions/types.js";
import type { GameTime } from "../core/types.js";
import type {
  CharacterSnapshot,
  DeterministicResult,
  EngineResolutionContext,
  ItemSnapshot,
  ObjectiveWorldEvent,
  PlaceKind,
  PlaceSnapshot,
  ResolutionTrigger,
  WorldGraph,
  WorldInvariant,
} from "./types.js";

/** Code-side invariants restated to the Engine and enforced by the validator
 *  regardless of what the model outputs. */
export const WORLD_INVARIANTS: WorldInvariant[] = [
  {
    id: "unique-item-ownership",
    description:
      "An item exists in exactly one place (one scene or one character inventory).",
  },
  {
    id: "real-references",
    description:
      "Every characterId/sceneId/itemId in a delta or occurrence must exist in the world (the graph lists every place; items may also sit at places without a detailed snapshot).",
  },
  {
    id: "dead-actors-act-no-more",
    description:
      "A dead character's actions terminate; no new effects originate from them.",
  },
  {
    id: "sourced-changes",
    description:
      "Every delta names its source action/event and a causal basis explaining it.",
  },
  {
    id: "single-transition",
    description: "Each action gets at most one transition per resolution.",
  },
  {
    id: "engine-owned-timing",
    description:
      "resolvedDurationTicks/nextWakeAt come only from the Engine with a timing reason; the actor's proposal is advisory.",
  },
];

export interface BuildContextParams {
  dgsm: DynamicGameStateManager;
  tickId: string;
  tickStartTime: GameTime;
  durationMinutes: number;
  triggers: ResolutionTrigger[];
  newCommands: ActionCommand[];
  activeActions: EngineAction[];
  objectiveWorldEvents?: ObjectiveWorldEvent[];
  deterministicResults?: DeterministicResult[];
}

interface PlaceEntry {
  kind: PlaceKind;
  place: DynamicScene | JunctionNode | RoadNode;
}

export function buildEngineResolutionContext(
  params: BuildContextParams
): EngineResolutionContext {
  const { dgsm } = params;
  const state = dgsm.getState();
  const scenes: Map<string, DynamicScene> = state.scenes ?? new Map();
  const junctions: Map<string, JunctionNode> = state.junctions ?? new Map();
  const roads: Map<string, RoadNode> = state.roads ?? new Map();

  // ── One id-addressed index over every place, kind attached. ──
  const placeById = new Map<string, PlaceEntry>();
  for (const scene of scenes.values()) {
    placeById.set(scene.id, { kind: "scene", place: scene });
  }
  for (const junction of junctions.values()) {
    placeById.set(junction.id, { kind: "junction", place: junction });
  }
  for (const road of roads.values()) {
    placeById.set(road.id, { kind: "road", place: road });
  }

  // ── Full-world item→holder map (validation lookup, never trimmed). ──
  const itemHolders: Record<string, string> = {};
  for (const [placeId, entry] of placeById) {
    for (const item of entry.place.items ?? []) {
      itemHolders[item.id] = `scene:${placeId}`;
    }
  }
  for (const [npcId, inventory] of Object.entries(state.npcInventories ?? {})) {
    for (const item of inventory ?? []) {
      itemHolders[item.id] = npcId;
    }
  }

  // ── Tier 1: the world graph. ──
  const edges: WorldGraph["edges"] = [];
  const pushEdge = (
    ownerId: string,
    connection: SceneConnection,
    travelTimeMinutes?: number
  ): void => {
    const blockedReason = dgsm.getConnectionBlockReason(
      ownerId,
      connection.targetId
    );
    edges.push({
      connectionId: connection.id,
      from: ownerId,
      to: connection.targetId,
      ...(travelTimeMinutes !== undefined ? { travelTimeMinutes } : {}),
      ...(connection.hidden !== undefined ? { hidden: connection.hidden } : {}),
      ...(blockedReason !== undefined ? { blockedReason } : {}),
    });
  };
  for (const scene of scenes.values()) {
    for (const connection of scene.connections ?? []) {
      pushEdge(scene.id, connection);
    }
  }
  for (const junction of junctions.values()) {
    for (const connection of junction.connections ?? []) {
      pushEdge(junction.id, connection);
    }
  }
  for (const road of roads.values()) {
    for (const connection of road.connections ?? []) {
      // Endpoint edges carry the full-length walk time; an access point is a
      // step off the road, not the road.
      pushEdge(
        road.id,
        connection,
        connection.role === "access" ? undefined : road.travelTimeMinutes
      );
    }
  }
  const graph: WorldGraph = {
    macroLocations: (state.scenarioOutlines ?? []).map((outline) => ({
      id: outline.id,
      name: outline.name,
    })),
    places: [...placeById.entries()].map(([id, entry]) => ({
      id,
      kind: entry.kind,
      name: entry.place.name,
      parentLocationId: entry.place.parentLocationId,
    })),
    edges,
  };

  // ── The involved set: the triggering actors' places, the places their
  //    objectRefs point at, and the holder places of referenced items. ──
  const commands: ActionCommand[] = [
    ...params.newCommands,
    ...params.activeActions.map((action) => action.command),
  ];
  const involvedPlaceIds = new Set<string>();
  const involvedActorIds = new Set<string>();
  for (const command of commands) {
    involvedActorIds.add(command.actorId);
    const position = dgsm.getCharacterPosition(command.actorId);
    if (position) involvedPlaceIds.add(dgsm.resolveLocationId(position));
    for (const ref of command.objectRefs ?? []) {
      if (ref.kind === "scene") {
        involvedPlaceIds.add(ref.id);
      } else if (ref.kind === "item") {
        const holder = itemHolders[ref.id];
        if (holder?.startsWith("scene:")) {
          involvedPlaceIds.add(holder.slice("scene:".length));
        }
      }
    }
  }

  // ── Tier 2: full snapshots of the involved places. ──
  const places: PlaceSnapshot[] = [];
  for (const placeId of involvedPlaceIds) {
    const entry = placeById.get(placeId);
    if (!entry) continue;
    places.push(snapshotPlace(dgsm, placeId, entry));
  }

  // ── Items: the involved places' items + the involved actors' pockets. ──
  const items: ItemSnapshot[] = [];
  for (const placeId of involvedPlaceIds) {
    const entry = placeById.get(placeId);
    for (const item of entry?.place.items ?? []) {
      items.push(snapshotItem(item, `scene:${placeId}`));
    }
  }
  for (const actorId of involvedActorIds) {
    for (const item of state.npcInventories?.[actorId] ?? []) {
      items.push(snapshotItem(item, actorId));
    }
  }

  // ── Characters: ALL characters, real values (skills, stats, knowledge). ──
  const characters: CharacterSnapshot[] = state.npcCharacters.map((npc) => {
    const position = dgsm.getCharacterPosition(npc.id);
    const spot = dgsm.getCharacterSpot(npc.id);
    return {
      id: npc.id,
      name: npc.name,
      ...(npc.occupation !== undefined ? { occupation: npc.occupation } : {}),
      ...(npc.appearance !== undefined ? { appearance: npc.appearance } : {}),
      alive: dgsm.isNpcAlive(npc.id),
      attributes: { ...npc.attributes } as unknown as Record<string, number>,
      skills: { ...npc.skills },
      hp: npc.status.hp,
      maxHp: npc.status.maxHp,
      san: npc.status.san,
      maxSan: npc.status.maxSan,
      fatigue: npc.status.fatigue,
      maxFatigue: npc.status.maxFatigue,
      position,
      locationId: position ? dgsm.resolveLocationId(position) : "",
      ...(spot ? { spot } : {}),
      conditions: npc.status.conditions ?? [],
      inventoryItemIds: dgsm.getNpcInventory(npc.id).map((i) => i.id),
      // Relationships are deliberately absent. They are subjective reading,
      // not world state: the Renderer uses them to decide whether a viewer
      // knows a face, and the character keeps their own `relationship`
      // memories. Putting affinity in front of the adjudicator invites
      // outcomes that turn on who likes whom rather than on objective
      // constraints.
    };
  });

  return {
    trigger: {
      triggers: params.triggers,
      actionIds: [...new Set(params.triggers.flatMap((t) => t.actionIds))],
    },
    tick: {
      tickId: params.tickId,
      tickStartTime: params.tickStartTime,
      durationMinutes: params.durationMinutes,
    },
    rules: {
      resolutionGuide: "src/engine/rules/world-action-resolution.md",
      outputSchemaVersion: ACTION_SCHEMA_VERSION,
      worldInvariants: WORLD_INVARIANTS,
    },
    state: { graph, places, items, itemHolders, characters },
    actions: {
      newCommands: params.newCommands,
      activeActions: params.activeActions,
    },
    events: {
      objectiveWorldEvents: params.objectiveWorldEvents ?? [],
      deterministicResults: params.deterministicResults ?? [],
    },
  };
}

function snapshotPlace(
  dgsm: DynamicGameStateManager,
  placeId: string,
  entry: PlaceEntry
): PlaceSnapshot {
  const { kind, place } = entry;
  const env = dgsm.getEnvironmentReading(placeId);
  const scene = kind === "scene" ? (place as DynamicScene) : undefined;
  const presentCharacterIds =
    kind === "scene"
      ? dgsm.getCharactersInScene(placeId)
      : kind === "junction"
        ? dgsm.getCharactersAtJunction(placeId)
        : dgsm.getCharactersOnRoad(placeId).map((c) => c.characterId);
  return {
    id: placeId,
    kind,
    name: place.name,
    description: place.description,
    parentLocationId: place.parentLocationId,
    ...(scene?.indoor !== undefined ? { indoor: scene.indoor } : {}),
    conditions: dgsm.getSceneConditions(placeId),
    itemIds: (place.items ?? []).map((i) => i.id),
    connections: (place.connections ?? []).map((c) => {
      const blockedReason = dgsm.getConnectionBlockReason(placeId, c.targetId);
      return {
        connectionId: c.id,
        targetId: c.targetId,
        ...(c.description !== undefined ? { description: c.description } : {}),
        ...(c.hidden !== undefined ? { hidden: c.hidden } : {}),
        ...(blockedReason !== undefined ? { blockedReason } : {}),
      };
    }),
    environment: {
      temperature: env.temperature,
      illumination: env.illumination,
      oxygen: env.oxygen,
      noise: env.noise,
      airborneHazards: [...env.airborneHazards],
    },
    presentCharacterIds,
  };
}

function snapshotItem(item: Item, holder: string): ItemSnapshot {
  return {
    id: item.id,
    name: item.name,
    ...(item.description !== undefined
      ? { description: item.description }
      : {}),
    holder,
    ...(item.hidden !== undefined ? { hidden: item.hidden } : {}),
  };
}
