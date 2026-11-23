import { parseDocument } from './lib/parse.js';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') {
    return false;
  }
  try {
    sendResponse({ ok: true, result: parseDocument(msg.text, msg.url) });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
  return false;
});
