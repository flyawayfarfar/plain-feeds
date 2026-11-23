import { ext, normalizeUrl, originPattern } from './lib/ext.js';
import { parseOpml, buildOpml } from './lib/opml.js';
import { getFeeds, getItems } from './lib/store.js';

const MAX_SHOWN = 300;
const $ = (id) => document.getElementById(id);
let selected = 'all';

// --- notices ---------------------------------------------------------------

function notify(message, { error = false, action = null } = {}) {
  const box = $('notice');
  box.replaceChildren(document.createTextNode(message));
  box.classList.toggle('error', error);
  if (action) {
    const button = document.createElement('button');
    button.className = 'primary';
    button.textContent = action.label;
    button.addEventListener('click', action.run);
    box.append(button);
  }
  box.hidden = false;
}

function clearNotice() {
  $('notice').hidden = true;
}

// --- adding feeds ------------------------------------------------------------
// permissions.request must be called directly inside a click, before any
// await, or the browser rejects it. Follow-up prompts therefore get their own
// button in the notice bar.

function addFromInput(event) {
  event.preventDefault();
  let url;
  try {
    url = normalizeUrl($('add-url').value);
  } catch {
    notify('That does not look like a web address.', { error: true });
    return;
  }
  requestThenAdd(url);
}

function requestThenAdd(url) {
  const asked = ext.permissions.request({ origins: [originPattern(url)] });
  notify(`Checking ${new URL(url).hostname}…`);
  asked.then((granted) => (granted ? sendAdd(url) : notify('Access was not allowed, so the feed was not added.', { error: true })));
}

async function sendAdd(url) {
  const res = await ext.runtime.sendMessage({ type: 'addFeed', url });
  if (res.ok) {
    $('add-url').value = '';
    selected = res.feedId;
    const first = (await getFeeds()).length === 1;
    notify(first
      ? 'Feed added. Its newest posts are listed below; click a title to read it and it is marked read. '
        + 'Feeds are checked every 30 minutes, and the number on the toolbar icon shows what is new.'
      : 'Feed added.');
    render();
  } else if (res.needOrigin) {
    const host = new URL(res.feedUrl).hostname;
    notify(`This site's feed is hosted on ${host}.`, { action: { label: `Allow ${host}`, run: () => requestThenAdd(res.feedUrl) } });
  } else {
    notify(res.error, { error: true });
  }
}

// --- OPML --------------------------------------------------------------------

async function importFile() {
  const file = $('import-file').files[0];
  $('import-file').value = '';
  if (!file) {
    return;
  }
  let feeds;
  try {
    feeds = parseOpml(await file.text());
  } catch (err) {
    notify(err.message, { error: true });
    return;
  }
  if (!feeds.length) {
    notify('No feeds were found in that file.', { error: true });
    return;
  }
  const origins = [...new Set(feeds.map((f) => originPattern(f.url)))];
  notify(`Found ${feeds.length} feeds on ${origins.length} sites. The browser will ask you to allow those sites.`, {
    action: {
      label: 'Allow and import',
      run: () => ext.permissions.request({ origins }).then(async (granted) => {
        if (!granted) {
          notify('Access was not allowed, so nothing was imported.', { error: true });
          return;
        }
        const res = await ext.runtime.sendMessage({ type: 'importFeeds', feeds });
        notify(`Imported ${res.added} new feeds. Articles will appear as each feed loads.`);
      }),
    },
  });
}

async function exportFile() {
  const feeds = await getFeeds();
  const blob = new Blob([buildOpml(feeds)], { type: 'text/x-opml' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'plain-feeds.opml';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// --- rendering ---------------------------------------------------------------

async function render() {
  const feeds = await getFeeds();
  const itemsByFeed = new Map(await Promise.all(feeds.map(async (f) => [f.id, await getItems(f.id)])));
  if (selected !== 'all' && !feeds.some((f) => f.id === selected)) {
    selected = 'all';
  }
  renderFeeds(feeds, itemsByFeed);
  renderItems(feeds, itemsByFeed);
}

function renderFeeds(feeds, itemsByFeed) {
  const unread = (id) => itemsByFeed.get(id).filter((i) => !i.read).length;
  const total = feeds.reduce((sum, f) => sum + unread(f.id), 0);
  const buttons = [feedButton('all', 'All feeds', total, null)];
  for (const feed of feeds) {
    buttons.push(feedButton(feed.id, feed.title, unread(feed.id), feed.error));
  }
  $('feeds').replaceChildren(...buttons);
}

function feedButton(id, title, count, error) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `feed${id === selected ? ' selected' : ''}`;
  button.dataset.feedId = id;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = title;
  const badge = document.createElement('span');
  badge.className = error ? 'warn' : 'count';
  badge.textContent = error ? '!' : count ? String(count) : '';
  if (error) {
    button.title = error;
  }
  button.append(name, badge);
  button.addEventListener('click', () => {
    selected = id;
    clearNotice();
    render();
  });
  return button;
}

function renderItems(feeds, itemsByFeed) {
  const feedById = new Map(feeds.map((f) => [f.id, f]));
  const unreadOnly = $('unread-only').checked;
  const chosen = selected === 'all' ? feeds : [feedById.get(selected)];
  let rows = chosen.flatMap((f) => itemsByFeed.get(f.id).map((item) => ({ item, feed: f })));
  if (unreadOnly) {
    rows = rows.filter((r) => !r.item.read);
  }
  rows.sort((a, b) => (b.item.date ?? 0) - (a.item.date ?? 0));
  rows = rows.slice(0, MAX_SHOWN);

  const current = feedById.get(selected);
  $('items-title').textContent = current ? current.title : 'All feeds';
  $('remove-feed').hidden = !current;
  $('items').replaceChildren(...rows.map(itemRow));

  $('empty').hidden = rows.length > 0;
  $('examples').hidden = feeds.length > 0;
  const emptyText = $('empty-text');
  if (!feeds.length) {
    emptyText.textContent = 'Plain Feeds gathers the newest posts from the websites you follow into one list, newest first. '
      + 'Paste a website address above, or click the Plain Feeds icon while you are on a site. '
      + 'Feeds are checked every 30 minutes, and the number on the icon shows how many posts you have not read yet. '
      + 'Moving from another reader? Use Import OPML.';
  } else if (current?.error) {
    emptyText.textContent = `This feed could not be loaded: ${current.error}`;
  } else {
    emptyText.textContent = unreadOnly ? 'Nothing unread.' : 'No articles yet.';
  }
}

function itemRow({ item, feed }) {
  const li = document.createElement('li');
  li.className = `item${item.read ? ' read' : ''}`;
  const text = document.createElement('div');
  const title = document.createElement(item.link ? 'a' : 'span');
  title.textContent = item.title;
  if (item.link) {
    title.href = item.link;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    title.addEventListener('click', () => markRead(feed.id, [item.id], true));
  }
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = [selected === 'all' ? feed.title : '', item.date ? new Date(item.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''].filter(Boolean).join(' · ');
  text.append(title, meta);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = item.read ? 'Mark unread' : 'Mark read';
  toggle.addEventListener('click', () => markRead(feed.id, [item.id], !item.read));
  li.append(text, toggle);
  return li;
}

async function markRead(feedId, ids, read) {
  await ext.runtime.sendMessage({ type: 'markRead', feedId, ids, read });
}

async function markAllRead() {
  const feeds = selected === 'all' ? await getFeeds() : [{ id: selected }];
  for (const feed of feeds) {
    await markRead(feed.id, null, true);
  }
}

async function removeFeed() {
  const feed = (await getFeeds()).find((f) => f.id === selected);
  if (feed && confirm(`Remove "${feed.title}" and its articles?`)) {
    await ext.runtime.sendMessage({ type: 'removeFeed', feedId: feed.id });
    selected = 'all';
    notify('Feed removed.');
  }
}

async function refreshAll() {
  notify('Refreshing…');
  await ext.runtime.sendMessage({ type: 'refresh' });
  const failed = (await getFeeds()).filter((f) => f.error).length;
  notify(failed ? `Refreshed. ${failed} feed(s) could not be loaded; they are marked with "!".` : 'All feeds refreshed.', { error: failed > 0 });
}

// --- wiring ------------------------------------------------------------------

let renderTimer = null;
ext.storage.onChanged.addListener(() => {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 50);
});

$('add-form').addEventListener('submit', addFromInput);
$('import-file').addEventListener('change', importFile);
$('export').addEventListener('click', exportFile);
$('refresh').addEventListener('click', refreshAll);
$('mark-all').addEventListener('click', markAllRead);
$('remove-feed').addEventListener('click', removeFeed);
$('unread-only').addEventListener('change', render);
for (const button of $('examples').querySelectorAll('button')) {
  button.addEventListener('click', () => requestThenAdd(button.dataset.url));
}

// The toolbar popup sends people here as reader.html?add=<feed url>.
const pending = new URLSearchParams(location.search).get('add');
if (pending) {
  history.replaceState(null, '', location.pathname);
  try {
    const url = normalizeUrl(pending);
    notify(`Add the feed ${url}?`, { action: { label: 'Add feed', run: () => requestThenAdd(url) } });
  } catch {
    notify('That feed address is not valid.', { error: true });
  }
}

render();
