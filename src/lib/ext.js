// Firefox exposes the promise-based `browser`; Chrome exposes `chrome`.
export const ext = globalThis.browser ?? globalThis.chrome;

export function originPattern(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

// Accepts "example.com/feed" as well as full URLs.
export function normalizeUrl(input) {
  const value = input.trim();
  const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  return url.href;
}
