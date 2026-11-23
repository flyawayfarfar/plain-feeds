// End-to-end tests: load the --test build into real Chromium and drive it
// against synthetic feeds served from 127.0.0.1. No real sites are contacted.
// Run: node build.mjs --test && node --test tests/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { findFeedLinks } from '../src/lib/detect.js';

const EXT_PATH = resolve('dist/chrome-test');
let server;
let base;
let context;
let worker;
let reader;
let dynamicVersion = 1;

const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Synthetic RSS</title><link>/</link>
  <item><title>Tom & Jerry return</title><link>/post-1</link><guid>p1</guid><pubDate>Mon, 23 Nov 2026 09:00:00 GMT</pubDate></item>
  <item><title>&lt;img src=x onerror="window.pwned=1"&gt; Escaped markup</title><link>javascript:window.pwned=1</link><guid isPermaLink="false">p2</guid><pubDate>Sun, 22 Nov 2026 09:00:00 GMT</pubDate></item>
  <item><title>Third post&nbsp;here</title><link>https://example.invalid/post-3</link><guid>p3</guid><pubDate>Sat, 21 Nov 2026 09:00:00 GMT</pubDate></item>
</channel></rss>`;

const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Synthetic Atom</title><link href="/" rel="alternate"/>
  <entry><title>Atom one</title><link href="/a1"/><id>tag:a1</id><updated>2026-11-20T10:00:00Z</updated></entry>
  <entry><title>Atom two</title><link rel="alternate" href="/a2"/><id>tag:a2</id><published>2026-11-19T10:00:00Z</published></entry>
</feed>`;

const rdf = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel><title>Synthetic RDF</title><link>/</link></channel>
  <item><title>RDF item</title><link>/r1</link><dc:date>2026-11-18T10:00:00Z</dc:date></item>
</rdf:RDF>`;

function dynamic() {
  const items = dynamicVersion === 1 ? ['d1', 'd2'] : ['d3', 'd1', 'd2'];
  const day = { d1: 10, d2: 9, d3: 11 };
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Synthetic Dynamic</title>${items
    .map((id) => `<item><title>Item ${id}</title><link>/${id}</link><guid>${id}</guid><pubDate>${day[id]} Nov 2026 00:00:00 GMT</pubDate></item>`)
    .join('')}</channel></rss>`;
}

const routes = {
  '/rss.xml': () => [200, 'application/rss+xml', rss],
  '/atom.xml': () => [200, 'application/atom+xml', atom],
  '/rdf.xml': () => [200, 'application/rdf+xml', rdf],
  '/dynamic.xml': () => [200, 'application/rss+xml', dynamic()],
  '/page.html': () => [200, 'text/html', '<!doctype html><html><head><link rel="alternate" type="application/atom+xml" title="Atom feed" href="/atom.xml"></head><body>Blog</body></html>'],
  '/nofeed.html': () => [200, 'text/html', '<!doctype html><html><head></head><body>No feed</body></html>'],
  '/garbage': () => [200, 'text/plain', 'this is not xml at all <'],
};

before(async () => {
  server = http.createServer((req, res) => {
    const route = routes[req.url];
    const [status, type, body] = route ? route() : [404, 'text/plain', 'not found'];
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const extId = new URL(worker.url()).host;
  reader = await context.newPage();
  await reader.goto(`chrome-extension://${extId}/reader.html`);
});

after(async () => {
  await context?.close();
  server?.close();
});

const badge = () => worker.evaluate(() => chrome.action.getBadgeText({}));
const feedCount = (name) => reader.locator('.feed', { hasText: name }).locator('.count').textContent();

async function addFeed(url) {
  await reader.fill('#add-url', url);
  await reader.click('#add-form button[type="submit"]');
}

test('first run explains how it works and offers example feeds', async () => {
  await reader.locator('#empty-text', { hasText: 'gathers the newest posts' }).waitFor();
  assert.ok(await reader.locator('#examples').isVisible());
  assert.deepEqual(await reader.locator('#examples button').allTextContents(), ['BBC World News', 'xkcd comics']);
});

test('parser handles RSS 2.0, Atom, RDF, bad entities and unsafe links', async () => {
  const out = await reader.evaluate(async ({ rss, atom, rdf }) => {
    const { parseDocument } = await import('./lib/parse.js');
    const u = 'http://127.0.0.1/feed';
    return {
      rss: parseDocument(rss, u),
      atom: parseDocument(atom, u),
      rdf: parseDocument(rdf, u),
      html: parseDocument('<!doctype html><html><head><link rel="alternate" type="application/rss+xml" href="/f.xml"><link rel="alternate" type="text/html" href="/x"></head></html>', u),
      bad: (() => { try { parseDocument('nope <', u); return 'no error'; } catch (e) { return e.message; } })(),
    };
  }, { rss, atom, rdf });
  const items = out.rss.feed.items;
  assert.equal(out.rss.feed.title, 'Synthetic RSS');
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Tom & Jerry return');
  assert.equal(items[0].link, 'http://127.0.0.1/post-1', 'relative link resolved');
  assert.equal(items[1].link, '', 'javascript: link dropped');
  assert.equal(items[1].id, 'p2');
  assert.equal(items[2].title, 'Third post&nbsp;here', 'undefined entity kept as text, not an error');
  assert.equal(items[0].date, Date.UTC(2026, 10, 23, 9));
  assert.deepEqual(out.atom.feed.items.map((i) => [i.id, i.link]), [['tag:a1', 'http://127.0.0.1/a1'], ['tag:a2', 'http://127.0.0.1/a2']]);
  assert.equal(out.rdf.feed.items[0].title, 'RDF item');
  assert.equal(out.rdf.feed.items[0].date, Date.UTC(2026, 10, 18, 10));
  assert.deepEqual(out.html, { kind: 'html', feedLinks: [{ url: 'http://127.0.0.1/f.xml', title: '' }] });
  assert.match(out.bad, /valid RSS or Atom/);
});

test('OPML round trip keeps feed URLs and escapes titles', async () => {
  const out = await reader.evaluate(async () => {
    const { parseOpml, buildOpml } = await import('./lib/opml.js');
    const feeds = [{ url: 'https://a.example/feed?x=1&y=2', title: 'A "quoted" & <odd> title', siteUrl: 'https://a.example/' }, { url: 'https://b.example/rss', title: 'B' }];
    const text = buildOpml(feeds);
    return { back: parseOpml(text), unsafe: parseOpml('<opml><body><outline xmlUrl="javascript:alert(1)"/><outline xmlUrl="https://c.example/f" text="C"/></body></opml>') };
  });
  assert.deepEqual(out.back, [{ url: 'https://a.example/feed?x=1&y=2', title: 'A "quoted" & <odd> title' }, { url: 'https://b.example/rss', title: 'B' }]);
  assert.deepEqual(out.unsafe, [{ url: 'https://c.example/f', title: 'C' }]);
});

test('page feed detection finds only feed links', async () => {
  const page = await context.newPage();
  await page.goto(`${base}/page.html`);
  const found = await page.evaluate(findFeedLinks);
  await page.close();
  assert.deepEqual(found, [{ url: `${base}/atom.xml`, title: 'Atom feed' }]);
});

test('add an RSS feed, render safely, and update the badge', async () => {
  await addFeed(`${base}/rss.xml`);
  await reader.locator('#notice', { hasText: 'number on the toolbar icon' }).waitFor();
  assert.equal(await feedCount('Synthetic RSS'), '3');
  assert.equal(await reader.locator('#examples').isVisible(), false, 'examples hidden once a feed exists');
  assert.equal(await badge(), '3');
  assert.equal(await reader.locator('.item').count(), 3);
  assert.equal(await reader.locator('#items img').count(), 0, 'markup in titles is shown as text');
  assert.equal(await reader.locator('#items a[href^="javascript"]').count(), 0);
  assert.equal(await reader.evaluate(() => window.pwned), undefined);
});

test('opening an article marks it read', async () => {
  const [popup] = await Promise.all([context.waitForEvent('page'), reader.locator('.item a', { hasText: 'Tom & Jerry' }).click()]);
  await popup.close();
  await reader.locator('.item.read', { hasText: 'Tom & Jerry' }).waitFor();
  assert.equal(await feedCount('Synthetic RSS'), '2');
  assert.equal(await badge(), '2');
});

test('duplicate and invalid feeds are refused with a clear message', async () => {
  await addFeed(`${base}/rss.xml`);
  await reader.locator('#notice.error', { hasText: 'already in your list' }).waitFor();
  await addFeed(`${base}/garbage`);
  await reader.locator('#notice.error', { hasText: 'valid RSS or Atom' }).waitFor();
  await addFeed(`${base}/nofeed.html`);
  await reader.locator('#notice.error', { hasText: 'No RSS or Atom feed' }).waitFor();
  await addFeed(`${base}/missing.xml`);
  await reader.locator('#notice.error', { hasText: 'error 404' }).waitFor();
  assert.equal(await reader.locator('.feed').count(), 2, 'All feeds + 1 feed');
});

test('adding a website address finds its feed', async () => {
  await addFeed(`${base}/page.html`);
  await reader.locator('#notice', { hasText: 'Feed added.' }).waitFor();
  assert.equal(await feedCount('Synthetic Atom'), '2');
  assert.equal(await badge(), '4');
});

test('refresh adds new items and keeps read state', async () => {
  await addFeed(`${base}/dynamic.xml`);
  await reader.locator('#notice', { hasText: 'Feed added.' }).waitFor();
  await reader.locator('.item', { hasText: 'Item d1' }).getByRole('button', { name: 'Mark read' }).click();
  await reader.locator('.item.read', { hasText: 'Item d1' }).waitFor();
  dynamicVersion = 2;
  await reader.click('#refresh');
  await reader.locator('#notice', { hasText: 'All feeds refreshed.' }).waitFor();
  await reader.locator('.item', { hasText: 'Item d3' }).waitFor();
  assert.equal(await feedCount('Synthetic Dynamic'), '2', 'd3 new + d2 unread; d1 stays read');
  assert.ok(await reader.locator('.item.read', { hasText: 'Item d1' }).isVisible());
});

test('a feed that starts failing is flagged, not deleted', async () => {
  const original = routes['/rss.xml'];
  routes['/rss.xml'] = () => [500, 'text/plain', 'down'];
  await reader.click('#refresh');
  await reader.locator('#notice.error', { hasText: '1 feed(s) could not be loaded' }).waitFor();
  assert.equal(await reader.locator('.feed', { hasText: 'Synthetic RSS' }).locator('.warn').textContent(), '!');
  routes['/rss.xml'] = original;
  await reader.click('#refresh');
  await reader.locator('#notice', { hasText: 'All feeds refreshed.' }).waitFor();
  assert.equal(await feedCount('Synthetic RSS'), '2', 'read state survived the outage');
});

test('mark all read clears the badge', async () => {
  await reader.click('.feed[data-feed-id="all"]');
  await reader.click('#mark-all');
  await reader.waitForFunction(() => !document.querySelector('.item:not(.read)'));
  assert.equal(await badge(), '');
});

test('OPML import adds new feeds and skips ones already present', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plainfeeds-'));
  const file = join(dir, 'feeds.opml');
  writeFileSync(file, `<?xml version="1.0"?><opml version="2.0"><body>
    <outline text="Dup" xmlUrl="${base}/rss.xml"/>
    <outline text="Folder"><outline text="RDF" xmlUrl="${base}/rdf.xml"/></outline>
  </body></opml>`);
  await reader.setInputFiles('#import-file', file);
  await reader.getByRole('button', { name: 'Allow and import' }).click();
  await reader.locator('#notice', { hasText: 'Imported 1 new feeds' }).waitFor();
  await reader.locator('.feed', { hasText: 'Synthetic RDF' }).waitFor();
  assert.equal(await feedCount('Synthetic RDF'), '1');
});

test('OPML export lists every feed', async () => {
  const [download] = await Promise.all([reader.waitForEvent('download'), reader.click('#export')]);
  const text = readFileSync(await download.path(), 'utf8');
  for (const path of ['/rss.xml', '/atom.xml', '/dynamic.xml', '/rdf.xml']) {
    assert.ok(text.includes(`xmlUrl="${base}${path}"`), `export contains ${path}`);
  }
});

test('popup handoff: reader.html?add= asks before adding', async () => {
  await reader.goto(`${reader.url().split('?')[0]}?add=${encodeURIComponent(`${base}/page.html`)}`);
  await reader.locator('#notice', { hasText: 'Add the feed' }).waitFor();
  await reader.getByRole('button', { name: 'Add feed', exact: true }).last().click();
  await reader.locator('#notice.error', { hasText: 'already in your list' }).waitFor();
});

test('removing a feed deletes it and its articles', async () => {
  reader.once('dialog', (d) => d.accept());
  await reader.click('.feed:has-text("Synthetic Dynamic")');
  await reader.click('#remove-feed');
  await reader.locator('#notice', { hasText: 'Feed removed.' }).waitFor();
  await reader.locator('.feed', { hasText: 'Synthetic Dynamic' }).waitFor({ state: 'detached' });
  const keys = await worker.evaluate(() => chrome.storage.local.get(null).then(Object.keys));
  assert.equal(keys.filter((k) => k.startsWith('items:')).length, 3);
});
