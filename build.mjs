// Builds dist/chrome and dist/firefox from src/.
// `node build.mjs --test` also grants http://127.0.0.1 so automated tests
// never hit a permission prompt; never ship a --test build.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const test = process.argv.includes('--test');
const version = '0.1.0';

const base = {
  manifest_version: 3,
  name: 'Plain Feeds — Private RSS Reader',
  short_name: 'Plain Feeds',
  version,
  description: 'A simple, private RSS and Atom reader. No account, no tracking. Import your feeds from any reader with OPML.',
  icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
  action: { default_popup: 'popup.html', default_title: 'Plain Feeds', default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' } },
  permissions: ['storage', 'unlimitedStorage', 'alarms', 'activeTab', 'scripting'],
  optional_host_permissions: ['https://*/*', 'http://*/*'],
};

const targets = {
  chrome: {
    ...base,
    permissions: [...base.permissions, 'offscreen'],
    background: { service_worker: 'background.js', type: 'module' },
  },
  firefox: {
    ...base,
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: {
      gecko: {
        id: 'plain-feeds@flyawayfarfar',
        strict_min_version: '142.0',
        data_collection_permissions: { required: ['none'] },
      },
    },
  },
};

for (const [name, manifest] of Object.entries(targets)) {
  const out = `dist/${name}${test ? '-test' : ''}`;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync('src', out, { recursive: true });
  if (name === 'firefox') {
    rmSync(`${out}/offscreen.html`);
    rmSync(`${out}/offscreen.js`);
  }
  const final = test ? { ...manifest, host_permissions: ['http://127.0.0.1/*'] } : manifest;
  writeFileSync(`${out}/manifest.json`, `${JSON.stringify(final, null, 2)}\n`);
  console.log(`built ${out}`);
}
