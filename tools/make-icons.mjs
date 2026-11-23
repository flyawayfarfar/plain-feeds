// Renders the toolbar/store icon to src/icons/*.png with headless Chromium.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect x="4" y="4" width="120" height="120" rx="28" fill="#2f6f4f"/>
  <circle cx="38" cy="90" r="11" fill="#fbfaf7"/>
  <path d="M27 58a43 43 0 0 1 43 43" stroke="#fbfaf7" stroke-width="13" fill="none" stroke-linecap="round"/>
  <path d="M27 29a72 72 0 0 1 72 72" stroke="#fbfaf7" stroke-width="13" fill="none" stroke-linecap="round"/>
</svg>`;

mkdirSync('src/icons', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml,${encodeURIComponent(svg)}" width="${size}" height="${size}">`);
  writeFileSync(`src/icons/${size}.png`, await page.screenshot({ omitBackground: true }));
}
await browser.close();
console.log('icons written');
