import type { Item } from "./types.js";

export type ItemContexts = Record<string, string>;

type PersistedSceneItemsWrapper = {
  items?: unknown;
  itemContexts?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeItemContexts(value: unknown): ItemContexts {
  if (!isRecord(value)) return {};

  const contexts: ItemContexts = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" && raw.trim() !== "") {
      contexts[key] = raw;
    }
  }
  return contexts;
}

export function decodeSceneItemsPayload(raw: unknown): {
  items: Item[];
  itemContexts: ItemContexts;
} {
  if (Array.isArray(raw)) {
    return { items: raw as Item[], itemContexts: {} };
  }

  if (!isRecord(raw)) {
    return { items: [], itemContexts: {} };
  }

  const wrapper = raw as PersistedSceneItemsWrapper;
  const items = Array.isArray(wrapper.items) ? (wrapper.items as Item[]) : [];
  const itemContexts = normalizeItemContexts(wrapper.itemContexts);
  return { items, itemContexts };
}

export function encodeSceneItemsPayload(scene: {
  items: Item[];
  itemContexts?: ItemContexts;
}): Item[] | { items: Item[]; itemContexts: ItemContexts } {
  const itemContexts = normalizeItemContexts(scene.itemContexts);
  if (Object.keys(itemContexts).length === 0) {
    return scene.items;
  }

  return {
    items: scene.items,
    itemContexts,
  };
}
