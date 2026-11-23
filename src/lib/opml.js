import { safeUrl } from './parse.js';

export function parseOpml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('This file is not valid OPML.');
  }
  const feeds = [];
  for (const outline of doc.getElementsByTagName('outline')) {
    const url = safeUrl(outline.getAttribute('xmlUrl'));
    if (url && !feeds.some((f) => f.url === url)) {
      feeds.push({ url, title: outline.getAttribute('title') || outline.getAttribute('text') || '' });
    }
  }
  return feeds;
}

export function buildOpml(feeds) {
  const lines = feeds.map((f) => `    <outline type="rss" text="${esc(f.title)}" title="${esc(f.title)}" xmlUrl="${esc(f.url)}"${f.siteUrl ? ` htmlUrl="${esc(f.siteUrl)}"` : ''}/>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head><title>Plain Feeds export</title></head>',
    '  <body>',
    ...lines,
    '  </body>',
    '</opml>',
    '',
  ].join('\n');
}

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
