// Turns fetched text into either a parsed feed (RSS 2.0, RSS 1.0/RDF, Atom)
// or, for an HTML page, the feed links it advertises. Needs DOMParser, so it
// runs in an extension page, the Firefox background page or Chrome's
// offscreen document.

const FEED_TYPES = ['application/rss+xml', 'application/atom+xml', 'application/rdf+xml', 'application/xml', 'text/xml'];

export function parseDocument(text, url) {
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (/^<!doctype html|^<html/i.test(trimmed)) {
    return { kind: 'html', feedLinks: discoverFeeds(trimmed, url) };
  }
  return { kind: 'feed', feed: parseFeed(trimmed, url) };
}

export function parseFeed(text, url) {
  let doc = parseXml(text);
  if (!doc) {
    // Many real feeds contain bare "&" or HTML entities such as &nbsp;.
    doc = parseXml(text.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;'));
  }
  if (!doc) {
    throw new Error('This address did not return valid RSS or Atom.');
  }
  const root = doc.documentElement;
  const name = root.localName.toLowerCase();
  if (name === 'feed') {
    return parseAtom(root, url);
  }
  if (name === 'rss' || name === 'rdf') {
    return parseRss(root, url);
  }
  throw new Error('This address did not return an RSS or Atom feed.');
}

export function discoverFeeds(html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const links = [];
  for (const link of doc.querySelectorAll('link[rel~="alternate"][href]')) {
    const type = (link.getAttribute('type') || '').toLowerCase();
    const href = safeUrl(link.getAttribute('href'), url);
    if (FEED_TYPES.includes(type) && href && !links.some((l) => l.url === href)) {
      links.push({ url: href, title: link.getAttribute('title') || '' });
    }
  }
  return links;
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}

function parseRss(root, url) {
  const channel = child(root, 'channel') || root;
  const siteUrl = safeUrl(textOf(child(channel, 'link')), url);
  const itemParent = root.localName.toLowerCase() === 'rdf' ? root : channel;
  const items = children(itemParent, 'item').map((item) => {
    const guid = textOf(child(item, 'guid'));
    const link = safeUrl(textOf(child(item, 'link')), url)
      || (child(item, 'guid')?.getAttribute('isPermaLink') !== 'false' ? safeUrl(guid, url) : '');
    const date = parseDate(textOf(child(item, 'pubDate')) || textOf(child(item, 'date')));
    return makeItem(guid || link, textOf(child(item, 'title')), link, date);
  });
  return { title: textOf(child(channel, 'title')), siteUrl, items };
}

function parseAtom(root, url) {
  const items = children(root, 'entry').map((entry) => {
    const link = atomLink(entry, url);
    const date = parseDate(textOf(child(entry, 'published')) || textOf(child(entry, 'updated')));
    return makeItem(textOf(child(entry, 'id')) || link, textOf(child(entry, 'title')), link, date);
  });
  return { title: textOf(child(root, 'title')), siteUrl: atomLink(root, url), items };
}

function atomLink(el, url) {
  const links = children(el, 'link');
  const alt = links.find((l) => (l.getAttribute('rel') || 'alternate') === 'alternate');
  return alt ? safeUrl(alt.getAttribute('href'), url) : '';
}

function makeItem(id, title, link, date) {
  const cleanTitle = title.replace(/\s+/g, ' ').trim() || '(untitled)';
  return { id: id || `${cleanTitle}|${date ?? ''}`, title: cleanTitle, link, date };
}

function child(el, name) {
  return children(el, name)[0] || null;
}

function children(el, name) {
  return [...el.children].filter((c) => c.localName === name);
}

function textOf(el) {
  return el ? el.textContent.trim() : '';
}

function parseDate(value) {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// Only http(s) links are kept, so a feed can't inject javascript: or data: URLs.
export function safeUrl(value, base) {
  if (!value) {
    return '';
  }
  try {
    const parsed = new URL(value.trim(), base);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
  } catch {
    return '';
  }
}
