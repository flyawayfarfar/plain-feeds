// Store-size (1280x800) screenshots of the --test build with made-up feeds.
// Run: node build.mjs --test && node tools/screenshots.mjs
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const EXT_PATH = resolve('dist/chrome-test');
const now = Date.UTC(2026, 10, 23, 9);
const feeds = {
  '/garden.xml': ['Backyard Garden Notes (example)', ['Planting tomatoes before the heat arrives', 'A cheap drip line that actually works', 'What to sow in late spring', 'Composting in a small yard']],
  '/kitchen.xml': ['Weeknight Kitchen (example)', ['Five pantry dinners under 30 minutes', 'Freezing herbs the easy way', 'One-pan lemon chicken']],
  '/tech.xml': ['Small Web Digest (example)', ['Why RSS is having a quiet comeback', 'Building a personal site in an afternoon', 'Reading without an algorithm', 'Notes on keeping software simple', 'The joy of plain text']],
};

function rss(path) {
  const [title, items] = feeds[path];
  const body = items.map((t, i) => `<item><title>${t}</title><link>/post${i}</link><guid>${path}${i}</guid><pubDate>${new Date(now - (i * 7 + path.length) * 3600e3).toUTCString()}</pubDate></item>`).join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>${body}</channel></rss>`;
}

const server = http.createServer((req, res) => {
  if (feeds[req.url]) {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(rss(req.url));
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
});
const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
const extId = new URL(worker.url()).host;
const page = await context.newPage();
await page.goto(`chrome-extension://${extId}/reader.html`);
mkdirSync('screenshots', { recursive: true });

await page.screenshot({ path: 'screenshots/0-empty.png' });
for (const path of Object.keys(feeds)) {
  await page.fill('#add-url', `${base}${path}`);
  await page.click('#add-form button[type="submit"]');
  await page.locator('#notice', { hasText: 'Feed added.' }).waitFor();
}
await page.click('.feed[data-feed-id="all"]');
await page.locator('.item', { hasText: 'Five pantry dinners' }).getByRole('button', { name: 'Mark read' }).click();
await page.locator('.item.read').first().waitFor();
await page.evaluate(() => { document.getElementById('notice').hidden = true; });
await page.screenshot({ path: 'screenshots/1-reader.png' });

await page.emulateMedia({ colorScheme: 'dark' });
await page.screenshot({ path: 'screenshots/2-reader-dark.png' });
await context.close();
server.close();
console.log('screenshots written');
