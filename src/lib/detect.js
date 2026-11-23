// Injected into the current tab by the popup, so it must be self-contained:
// no imports, no closures over module variables.
export function findFeedLinks() {
  const types = ['application/rss+xml', 'application/atom+xml', 'application/rdf+xml'];
  const seen = new Set();
  const links = [];
  for (const link of document.querySelectorAll('link[rel~="alternate"][href]')) {
    const type = (link.getAttribute('type') || '').toLowerCase();
    if (types.includes(type) && /^https?:/.test(link.href) && !seen.has(link.href)) {
      seen.add(link.href);
      links.push({ url: link.href, title: link.title || '' });
    }
  }
  return links;
}
