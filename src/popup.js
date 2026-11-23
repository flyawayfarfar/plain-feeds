import { ext } from './lib/ext.js';
import { findFeedLinks } from './lib/detect.js';
import { getFeeds, getItems } from './lib/store.js';

const readerUrl = ext.runtime.getURL('reader.html');

document.getElementById('open').addEventListener('click', () => openReader(readerUrl));

async function openReader(url) {
  await ext.tabs.create({ url });
  window.close();
}

async function showUnread() {
  const feeds = await getFeeds();
  let unread = 0;
  for (const feed of feeds) {
    unread += (await getItems(feed.id)).filter((i) => !i.read).length;
  }
  if (unread) {
    document.getElementById('open').textContent = `Open reader (${unread} unread)`;
  }
}

async function showPageFeeds() {
  let links = [];
  try {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    const [injection] = await ext.scripting.executeScript({ target: { tabId: tab.id }, func: findFeedLinks });
    links = injection?.result || [];
  } catch {
    // Browser pages (settings, the store) can't be scripted; treat as no feeds.
  }
  const known = new Set((await getFeeds()).map((f) => f.url));
  const list = document.getElementById('found');
  for (const link of links) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = link.title || link.url;
    name.title = link.url;
    const button = document.createElement('button');
    button.type = 'button';
    if (known.has(link.url)) {
      button.textContent = 'Added';
      button.disabled = true;
    } else {
      button.textContent = 'Add';
      button.addEventListener('click', () => openReader(`${readerUrl}?add=${encodeURIComponent(link.url)}`));
    }
    li.append(name, button);
    list.append(li);
  }
  document.getElementById('none').hidden = links.length > 0;
}

showUnread();
showPageFeeds();
