import { ext } from './ext.js';

export const MAX_ITEMS_PER_FEED = 200;

export async function getFeeds() {
  const { feeds = [] } = await ext.storage.local.get('feeds');
  return feeds;
}

export async function setFeeds(feeds) {
  await ext.storage.local.set({ feeds });
}

export function itemsKey(feedId) {
  return `items:${feedId}`;
}

export async function getItems(feedId) {
  const key = itemsKey(feedId);
  const stored = await ext.storage.local.get(key);
  return stored[key] || [];
}

export async function setItems(feedId, items) {
  await ext.storage.local.set({ [itemsKey(feedId)]: items });
}

// Fresh items arrive unread; items seen before keep their read state; old
// items that dropped out of the feed are kept until the cap pushes them out.
export function mergeItems(oldItems, freshItems) {
  const known = new Map(oldItems.map((i) => [i.id, i]));
  const freshIds = new Set();
  const merged = [];
  for (const item of freshItems) {
    if (!freshIds.has(item.id)) {
      freshIds.add(item.id);
      merged.push({ ...item, read: known.get(item.id)?.read ?? false });
    }
  }
  for (const item of oldItems) {
    if (!freshIds.has(item.id)) {
      merged.push(item);
    }
  }
  merged.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  return merged.slice(0, MAX_ITEMS_PER_FEED);
}
