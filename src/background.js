import { ext, originPattern } from './lib/ext.js';
import { parseDocument } from './lib/parse.js';
import { getFeeds, setFeeds, getItems, setItems, mergeItems, itemsKey } from './lib/store.js';

const REFRESH_MINUTES = 30;
const FETCH_TIMEOUT_MS = 20000;
const PARALLEL_FETCHES = 6;

// All storage writes go through this queue so a refresh can't overwrite a
// "mark read" that happened while the feed was downloading.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

ext.runtime.onInstalled.addListener(scheduleRefresh);
ext.runtime.onStartup.addListener(scheduleRefresh);
ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'refresh') {
    refreshAll();
  }
});

function scheduleRefresh() {
  ext.alarms.create('refresh', { periodInMinutes: REFRESH_MINUTES });
  updateBadge();
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') {
    return false;
  }
  const handler = handlers[msg?.type];
  if (!handler) {
    return false;
  }
  handler(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
  return true;
});

const handlers = {
  async addFeed({ url }) {
    const feeds = await getFeeds();
    if (feeds.some((f) => f.url === url)) {
      return { ok: false, error: 'This feed is already in your list.' };
    }
    await requirePermission(url);
    let feedUrl = url;
    let result = await fetchAndParse(url);
    if (result.kind === 'html') {
      if (!result.feedLinks.length) {
        return { ok: false, error: 'No RSS or Atom feed was found at this address.' };
      }
      feedUrl = result.feedLinks[0].url;
      if (feeds.some((f) => f.url === feedUrl)) {
        return { ok: false, error: 'This feed is already in your list.' };
      }
      if (!(await hasPermission(feedUrl))) {
        return { ok: false, needOrigin: originPattern(feedUrl), feedUrl };
      }
      result = await fetchAndParse(feedUrl);
      if (result.kind !== 'feed') {
        return { ok: false, error: 'The linked feed could not be read.' };
      }
    }
    const feed = {
      id: crypto.randomUUID(),
      url: feedUrl,
      title: result.feed.title || new URL(feedUrl).hostname,
      siteUrl: result.feed.siteUrl,
      lastFetched: Date.now(),
      error: null,
    };
    await serial(async () => {
      await setFeeds([...(await getFeeds()), feed]);
      await setItems(feed.id, mergeItems([], result.feed.items));
    });
    await updateBadge();
    return { ok: true, feedId: feed.id };
  },

  async removeFeed({ feedId }) {
    await serial(async () => {
      await setFeeds((await getFeeds()).filter((f) => f.id !== feedId));
      await ext.storage.local.remove(itemsKey(feedId));
    });
    await updateBadge();
    return { ok: true };
  },

  async markRead({ feedId, ids, read }) {
    await serial(async () => {
      const wanted = ids ? new Set(ids) : null;
      const items = await getItems(feedId);
      await setItems(feedId, items.map((i) => (!wanted || wanted.has(i.id) ? { ...i, read } : i)));
    });
    await updateBadge();
    return { ok: true };
  },

  async importFeeds({ feeds: incoming }) {
    const added = await serial(async () => {
      const feeds = await getFeeds();
      const fresh = incoming
        .filter((f) => !feeds.some((existing) => existing.url === f.url))
        .map((f) => ({ id: crypto.randomUUID(), url: f.url, title: f.title || new URL(f.url).hostname, siteUrl: '', lastFetched: null, error: null }));
      await setFeeds([...feeds, ...fresh]);
      return fresh.length;
    });
    refreshAll();
    return { ok: true, added };
  },

  async refresh() {
    await refreshAll();
    return { ok: true };
  },
};

async function refreshAll() {
  const pending = [...(await getFeeds())];
  const worker = async () => {
    while (pending.length) {
      await refreshFeed(pending.shift());
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_FETCHES }, worker));
  await updateBadge();
}

async function refreshFeed(feed) {
  let update;
  try {
    await requirePermission(feed.url);
    const result = await fetchAndParse(feed.url);
    if (result.kind !== 'feed') {
      throw new Error('This address no longer returns a feed.');
    }
    update = { parsed: result.feed, error: null };
  } catch (err) {
    update = { parsed: null, error: err.message };
  }
  await serial(async () => {
    const feeds = await getFeeds();
    const current = feeds.find((f) => f.id === feed.id);
    if (!current) {
      return;
    }
    current.lastFetched = Date.now();
    current.error = update.error;
    if (update.parsed) {
      current.title = update.parsed.title || current.title;
      current.siteUrl = update.parsed.siteUrl || current.siteUrl;
      await setItems(feed.id, mergeItems(await getItems(feed.id), update.parsed.items));
    }
    await setFeeds(feeds);
  });
}

async function hasPermission(url) {
  return ext.permissions.contains({ origins: [originPattern(url)] });
}

async function requirePermission(url) {
  if (!(await hasPermission(url))) {
    throw new Error(`Access to ${new URL(url).hostname} has not been allowed.`);
  }
}

async function fetchAndParse(url) {
  let response;
  try {
    response = await fetch(url, { credentials: 'omit', cache: 'no-cache', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new Error(`Could not reach ${new URL(url).hostname}.`);
  }
  if (!response.ok) {
    throw new Error(`${new URL(url).hostname} answered with error ${response.status}.`);
  }
  return parseText(await response.text(), response.url || url);
}

// Firefox's background page has DOMParser; Chrome's service worker does not,
// so Chrome parses in an offscreen document.
async function parseText(text, url) {
  if (typeof DOMParser !== 'undefined') {
    return parseDocument(text, url);
  }
  await ensureOffscreen();
  const reply = await ext.runtime.sendMessage({ target: 'offscreen', text, url });
  if (!reply?.ok) {
    throw new Error(reply?.error || 'The feed could not be parsed.');
  }
  return reply.result;
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  const contexts = await ext.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) {
    return;
  }
  creatingOffscreen ??= ext.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Parse RSS and Atom feeds',
  }).finally(() => {
    creatingOffscreen = null;
  });
  await creatingOffscreen;
}

async function updateBadge() {
  const feeds = await getFeeds();
  let unread = 0;
  for (const feed of feeds) {
    unread += (await getItems(feed.id)).filter((i) => !i.read).length;
  }
  await ext.action.setBadgeText({ text: unread ? String(Math.min(unread, 999)) : '' });
  await ext.action.setBadgeBackgroundColor({ color: '#2f6f4f' });
}
