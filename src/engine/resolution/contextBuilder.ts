// src/engine/resolution/contextBuilder.ts
//
// Builds the single EngineResolutionContext (plan D7, two-tier since M3).
// Called only when an action resolution trigger exists. Everything comes from
// the same tick-start DGSM state; forbidden inputs (renderer text, RoleSim
// thoughts, unflushed deltas) simply have no path in.
//
// Two tiers:
//   Tier 1 (`state.graph`)  — the world SKELETON: macro locations plus
//     geography (top-level node scenes, roads) and the edges between them. An
//     edge authored on an interior scene is lifted to that scene's parent;
//     interior edges within one location are omitted. Static — blocked state
//     rides separately in `state.blockedEdges` (volatile).
//   Tier 2 (`state.places`) — full snapshots of only the INVOLVED places:
//     where a triggering actor stands, what an objectRef points at, and where
//     a referenced item is held. Interior scenes appear only here.
//
// `state.itemHolders`, `state.placeKinds` and `state.connectionIds` are
// FULL-world lookup maps: the validator reads them rather than the trimmed
// prompt sections, so prompt trimming never narrows what counts as a real
// reference. They are never rendered into the prompt.

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { RoadNode } from "../../state/topologyTypes.js";
import type { DynamicScene, Item, SceneConnection } from "../../state/types.js";
import type { ActionCommand, EngineAction } from "../actions/types.js";
import { ACTION_SCHEMA_VERSION } from "../actions/types.js";
import type { GameTime } from "../core/types.js";
import type {
  BlockedEdge,
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
      "Every characterId/sceneId/itemId in a delta or occurrence must exist in the world (the graph is a skeleton: interior scenes and their contents are real even when only their macro location is drawn; the involved ones appear under Detailed Places).",
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
  place: DynamicScene | RoadNode;
}

export function buildEngineResolutionContext(
  params: BuildContextParams
): EngineResolutionContext {
  const { dgsm } = params;
  const state = dgsm.getState();
  const scenes: Map<string, DynamicScene> = state.scenes ?? new Map();
  const roads: Map<string, RoadNode> = state.roads ?? new Map();

  // ── One id-addressed index over every place, kind attached. ──
  const placeById = new Map<string, PlaceEntry>();
  for (const scene of scenes.values()) {
    placeById.set(scene.id, { kind: "scene", place: scene });
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

  // ── Full-world validation lookups (never trimmed, never rendered). ──
  const placeKinds: Record<string, PlaceKind> = {};
  for (const [placeId, entry] of placeById) {
    placeKinds[placeId] = entry.kind;
  }
  const connectionIds: string[] = [];
  for (const entry of placeById.values()) {
    for (const connection of entry.place.connections ?? []) {
      connectionIds.push(connection.id);
    }
  }

  // ── Tier 1: the skeleton graph, plus the volatile blocked-edge list. ──
  // An interior scene's edge is lifted to its topology attachment (the node
  // scene or road its building hangs off); edges that collapse into a
  // self-edge vanish from the skeleton — a building's own doorway onto its
  // street is already carried by the street's prose and by Tier 2.
  // Top-level scenes and roads stand for themselves.
  const topology = dgsm.getTopology?.() ?? null;
  const liftToSkeleton = (id: string): string => {
    const entry = placeById.get(id);
    if (entry?.kind !== "scene") return id;
    if (!topology || topology.nodeSceneIds.has(id)) return id;
    const attachment = topology.sceneToParent.get(id);
    if (!attachment) return id;
    return attachment.type === "scene" ? attachment.sceneId : attachment.roadId;
  };
  // Skeleton edges run between skeleton nodes only — roads and geography
  // node scenes. An edge still touching an interior scene after lifting is
  // Tier 2 detail, not skeleton.
  const isSkeletonNode = (id: string): boolean =>
    placeById.get(id)?.kind === "road" ||
    (topology?.nodeSceneIds.has(id) ?? false);
  const edges: WorldGraph["edges"] = [];
  const blockedEdges: BlockedEdge[] = [];
  const seenBlockedPairs = new Set<string>();
  const pushEdge = (
    ownerId: string,
    connection: SceneConnection,
    travelTimeMinutes?: number
  ): void => {
    // Blocked state is collected over the AUTHORED endpoints (every
    // connection, including interior ones the skeleton drops), deduplicated
    // on the symmetric pair so a two-way exit reports once.
    const blockedReason = dgsm.getConnectionBlockReason(
      ownerId,
      connection.targetId
    );
    if (blockedReason !== undefined) {
      const pairKey = [ownerId, connection.targetId].sort().join("::");
      if (!seenBlockedPairs.has(pairKey)) {
        seenBlockedPairs.add(pairKey);
        blockedEdges.push({
          connectionId: connection.id,
          from: ownerId,
          to: connection.targetId,
          reason: blockedReason,
        });
      }
    }
    const from = liftToSkeleton(ownerId);
    const to = liftToSkeleton(connection.targetId);
    if (from === to) return;
    if (!isSkeletonNode(from) || !isSkeletonNode(to)) return;
    edges.push({
      connectionId: connection.id,
      from,
      to,
      ...(travelTimeMinutes !== undefined ? { travelTimeMinutes } : {}),
      ...(connection.hidden !== undefined ? { hidden: connection.hidden } : {}),
    });
  };
  for (const scene of scenes.values()) {
    for (const connection of scene.connections ?? []) {
      pushEdge(scene.id, connection);
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
    places: [...placeById.entries()]
      .filter(
        ([, entry]) =>
          entry.kind === "road" ||
          !(entry.place as DynamicScene).parentLocationId
      )
      .map(([id, entry]) => ({
        id,
        kind: entry.kind,
        name: entry.place.name,
        ...(entry.place.description
          ? { description: entry.place.description }
          : {}),
        ...(entry.place.parentLocationId !== undefined
          ? { parentLocationId: entry.place.parentLocationId }
          : {}),
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
    state: {
      graph,
      blockedEdges,
      places,
      items,
      itemHolders,
      placeKinds,
      connectionIds,
      vehicles: (dgsm.getVehicles?.() ?? []).map((v) => ({
        id: v.id,
        name: v.name,
        interiorSceneId: v.interiorSceneId,
        position: v.position,
      })),
      characters,
    },
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
      : dgsm.getCharactersOnRoad(placeId).map((c) => c.characterId);
  return {
    id: placeId,
    kind,
    name: place.name,
    description: place.description,
    ...(place.parentLocationId !== undefined
      ? { parentLocationId: place.parentLocationId }
      : {}),
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
