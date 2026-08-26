import type { ReferencedEntity } from "../core/types.js";

/**
 * Minimal node shape consumed by `buildStateContext`. Only `characterId` and
 * `referencedEntities` are read — synthetic shims (e.g. SimulationRunner's
 * resolve callback) and real engine actions both qualify. Replaces the
 * legacy `PlanNode` import (deleted in Phase F).
 */
interface ResolverContextNode {
  characterId: string;
  referencedEntities?: ReferencedEntity[];
}
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { buildWorldStateBlock } from "../shared/worldStateBlock.js";
import type { ActionDefinition } from "../types.js";

// ==================== State context sections ====================

function buildActorSection(
  characterId: string,
  dgsm: DynamicGameStateManager,
  fields?: string[]
): string {
  const state = dgsm.getState();
  const npc = state.npcCharacters.find((n) => n.id === characterId);
  if (!npc) return "## Actor\n(not found)";

  const lines = ["## Actor", `ID: ${npc.id}`, `Name: ${npc.name}`];

  const allFields = !fields || fields.length === 0;

  if (allFields || fields?.includes("occupation")) {
    if (npc.occupation) lines.push(`Occupation: ${npc.occupation}`);
  }
  if (allFields || fields?.includes("appearance")) {
    if (npc.appearance) lines.push(`Appearance: ${npc.appearance}`);
  }
  if (allFields || fields?.includes("personality")) {
    if (npc.personality) lines.push(`Personality: ${npc.personality}`);
  }
  if (allFields || fields?.includes("isAlive")) {
    lines.push(`Status: ${dgsm.isNpcAlive(characterId) ? "alive" : "dead"}`);
  }
  if (allFields || fields?.includes("stats")) {
    if (npc.status) {
      lines.push(`Stats: HP=${npc.status.hp}, SAN=${npc.status.san}`);
    }
  }
  if (allFields || fields?.includes("inventory")) {
    const inv = dgsm.getNpcInventory(characterId);
    lines.push(
      `Inventory: ${JSON.stringify(inv.map((i) => ({ id: i.id, name: i.name, description: i.description })))}`
    );
  }
  if (allFields || fields?.includes("position")) {
    const pos = dgsm.getCharacterPosition(characterId);
    const locId = pos ? dgsm.resolveLocationId(pos) : "unknown";
    lines.push(`Position: ${locId}`);
  }
  if (allFields || fields?.includes("conditions")) {
    const conditions = npc.status?.conditions ?? [];
    if (conditions.length > 0) {
      lines.push(
        `Conditions: ${conditions.map((c) => c.description).join(", ")}`
      );
    }
  }

  return lines.join("\n");
}

function buildTargetSection(
  targetId: string,
  actorId: string,
  dgsm: DynamicGameStateManager,
  fields?: string[]
): string {
  const state = dgsm.getState();
  const npc = state.npcCharacters.find((n) => n.id === targetId);
  if (!npc) {
    return [
      `## Target: ${targetId}`,
      `ID: ${targetId}`,
      `**This person is NOT present in the current scene. The actor cannot find them here.**`,
    ].join("\n");
  }

  const lines = [`## Target: ${npc.name}`, `ID: ${npc.id}`];

  const allFields = !fields || fields.length === 0;

  if (allFields || fields?.includes("occupation")) {
    if (npc.occupation) lines.push(`Occupation: ${npc.occupation}`);
  }
  if (allFields || fields?.includes("appearance")) {
    if (npc.appearance) lines.push(`Appearance: ${npc.appearance}`);
  }
  if (allFields || fields?.includes("personality")) {
    if (npc.personality) lines.push(`Personality: ${npc.personality}`);
  }
  if (allFields || fields?.includes("isAlive")) {
    lines.push(`Status: ${dgsm.isNpcAlive(targetId) ? "alive" : "dead"}`);
  }
  if (allFields || fields?.includes("stats")) {
    if (npc.status) {
      lines.push(`Stats: HP=${npc.status.hp}, SAN=${npc.status.san}`);
    }
  }
  if (allFields || fields?.includes("inventory")) {
    const inv = dgsm.getNpcInventory(targetId);
    lines.push(
      `Inventory: ${JSON.stringify(inv.map((i) => ({ id: i.id, name: i.name, description: i.description })))}`
    );
  }
  if (allFields || fields?.includes("position")) {
    const pos = dgsm.getCharacterPosition(targetId);
    const locId = pos ? dgsm.resolveLocationId(pos) : "unknown";
    lines.push(`Position: ${locId}`);
  }
  if (allFields || fields?.includes("conditions")) {
    const conditions = npc.status?.conditions ?? [];
    if (conditions.length > 0) {
      lines.push(
        `Conditions: ${conditions.map((c) => c.description).join(", ")}`
      );
    }
  }
  if (allFields || fields?.includes("relationship")) {
    const rel = dgsm.getRelationship?.(actorId, targetId);
    if (rel) {
      lines.push(
        `Relationship with actor: score=${rel.score}, note="${rel.note}"`
      );
    } else {
      lines.push("Relationship with actor: none");
    }
  }

  return lines.join("\n");
}

function buildSceneSection(
  locationId: string,
  dgsm: DynamicGameStateManager,
  fields?: string[]
): string {
  const scene = dgsm.getScene(locationId);
  if (!scene) return "## Scene\n(no scene data)";

  const lines = [
    "## Scene",
    `ID: ${(scene as any).id ?? locationId}`,
    `Name: ${(scene as any).name ?? "unknown"}`,
  ];

  const allFields = !fields || fields.length === 0;

  if (allFields || fields?.includes("description")) {
    lines.push(`Description: ${(scene as any).description ?? ""}`);
  }
  if (allFields || fields?.includes("conditions")) {
    const conditions = dgsm.getSceneConditions(locationId);
    if (conditions.length > 0) {
      lines.push(`Conditions: ${JSON.stringify(conditions)}`);
    }
  }
  if (allFields || fields?.includes("items")) {
    const items = (scene as any).items ?? [];
    if (items.length > 0) {
      lines.push(
        `Items: ${JSON.stringify(items.map((i: any) => ({ id: i.id, name: i.name, description: i.description })))}`
      );
    }
  }
  if (allFields || fields?.includes("connections")) {
    const connections = (scene as any).connections ?? [];
    if (connections.length > 0) {
      const connLines = connections.map((c: any) => {
        const entry: any = { targetId: c.targetId, description: c.description };
        if (c.hidden) entry.hidden = "[HIDDEN]";
        const blockReason = dgsm.getConnectionBlockReason(
          locationId,
          c.targetId
        );
        if (blockReason) entry.blocked = blockReason;
        return entry;
      });
      lines.push(`Connections: ${JSON.stringify(connLines)}`);
    }
  }

  return lines.join("\n");
}

function formatItemDetailed(item: any): string {
  const parts = [`- **${item.name}** (id: ${item.id})`];
  if (item.type) parts.push(`  type: ${item.type}`);
  if (item.category) parts.push(`  category: ${item.category}`);
  if (item.description) parts.push(`  description: ${item.description}`);
  if (item.discoveryMethod)
    parts.push(`  discoveryMethod: ${item.discoveryMethod}`);
  if (item.reveals) parts.push(`  reveals: ${item.reveals}`);
  if (item.damaged)
    parts.push(`  damaged: true, details: ${item.damageDetails ?? ""}`);
  if (item.isLightSource)
    parts.push(`  lightSource: ${item.lightLevel ?? "dim"}`);
  if (item.consumableStats)
    parts.push(`  consumable: ${JSON.stringify(item.consumableStats)}`);
  if (item.containerStats)
    parts.push(`  container: ${JSON.stringify(item.containerStats)}`);
  if (item.weaponStats)
    parts.push(`  weapon: ${JSON.stringify(item.weaponStats)}`);
  return parts.join("\n");
}

function buildItemSection(
  characterId: string,
  locationId: string,
  dgsm: DynamicGameStateManager,
  inject: string[]
): string {
  const sections: string[] = [];

  if (inject.includes("actorInventory")) {
    const inv = dgsm.getNpcInventory(characterId);
    if (inv.length > 0) {
      sections.push("### Actor Inventory");
      sections.push(...inv.map((item) => formatItemDetailed(item)));
    } else {
      sections.push("### Actor Inventory\n(empty)");
    }
  }

  if (inject.includes("sceneItems")) {
    const scene = dgsm.getScene(locationId);
    const items = (scene as any)?.items ?? [];
    if (items.length > 0) {
      sections.push("### Scene Items");
      sections.push(...items.map((item: any) => formatItemDetailed(item)));
    } else {
      sections.push("### Scene Items\n(none)");
    }
  }

  return sections.join("\n\n");
}

// ==================== Main builder ====================

/**
 * The complete universe of REAL entity ids for one resolution — everything the
 * resolver may legally reference. Built alongside the prompt sections so
 * `resolveState` can reject fabricated ids (invented witnesses, staged-scene
 * featureIds cited as items, ghost inventories) and feed the errors back to
 * the LLM for one corrective retry, instead of the Applier silently dropping
 * them at commit time.
 */
export interface ResolverValidRefs {
  characterIds: Set<string>;
  itemIds: Set<string>;
  sceneIds: Set<string>;
  junctionIds: Set<string>;
  /** The scene the action executes in — named in error feedback. */
  executionSceneId: string;
}

function buildValidRefs(
  node: ResolverContextNode,
  dgsm: DynamicGameStateManager,
  locationId: string
): ResolverValidRefs {
  const state = dgsm.getState();
  const itemIds = new Set<string>();
  for (const item of dgsm.getNpcInventory(node.characterId)) {
    itemIds.add(item.id);
  }
  // Target inventories are rendered into the prompt (buildTargetSection), so
  // their ids are legal references too.
  for (const ref of node.referencedEntities ?? []) {
    if (ref.kind === "character") {
      for (const item of dgsm.getNpcInventory(ref.id)) itemIds.add(item.id);
    }
  }
  const scene = dgsm.getScene(locationId);
  for (const item of (scene as any)?.items ?? []) {
    itemIds.add((item as { id: string }).id);
  }
  return {
    characterIds: new Set(state.npcCharacters.map((n) => n.id)),
    itemIds,
    sceneIds: new Set(state.scenes.keys()),
    junctionIds: new Set(state.junctions.keys()),
    executionSceneId: locationId,
  };
}

export interface StateContext {
  actorSection?: string;
  targetSections?: string;
  sceneSection?: string;
  itemSection?: string;
  worldStateSection?: string;
  /** Real-entity universe for reference validation; absent on legacy callers
   *  that build a StateContext by hand (validation is then skipped). */
  validRefs?: ResolverValidRefs;
}

export function buildStateContext(
  definition: ActionDefinition,
  node: ResolverContextNode,
  dgsm: DynamicGameStateManager,
  locationId: string
): StateContext {
  const domains = definition.stateDomains;
  if (!domains) {
    // Legacy definition without stateDomains — minimal context
    return {
      actorSection: buildActorSection(node.characterId, dgsm),
      sceneSection: buildSceneSection(locationId, dgsm),
      worldStateSection: buildWorldStateBlock(
        dgsm,
        node.characterId,
        locationId
      ),
      validRefs: buildValidRefs(node, dgsm, locationId),
    };
  }

  const result: StateContext = {
    validRefs: buildValidRefs(node, dgsm, locationId),
  };

  // Character domain
  if (domains.character) {
    const spec = domains.character;
    const fieldsMap =
      spec.fields &&
      typeof spec.fields === "object" &&
      !Array.isArray(spec.fields)
        ? (spec.fields as Record<string, string[]>)
        : {};

    if (spec.inject.includes("actor")) {
      result.actorSection = buildActorSection(
        node.characterId,
        dgsm,
        fieldsMap.actor
      );
    }
    if (spec.inject.includes("targets")) {
      const targetIds = (node.referencedEntities ?? [])
        .filter((r) => r.kind === "character")
        .map((r) => r.id);
      if (targetIds.length > 0) {
        result.targetSections = targetIds
          .map((tid) =>
            buildTargetSection(tid, node.characterId, dgsm, fieldsMap.targets)
          )
          .join("\n\n");
      }
    }
  }

  // Scene domain
  if (domains.scene) {
    const fields = Array.isArray(domains.scene.fields)
      ? domains.scene.fields
      : undefined;
    result.sceneSection = buildSceneSection(
      locationId,
      dgsm,
      fields as string[] | undefined
    );
  }

  // Item domain
  if (domains.item) {
    result.itemSection = buildItemSection(
      node.characterId,
      locationId,
      dgsm,
      domains.item.inject
    );
  }

  // World state (always include)
  result.worldStateSection = buildWorldStateBlock(
    dgsm,
    node.characterId,
    locationId
  );

  return result;
}
