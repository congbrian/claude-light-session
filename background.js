// background.js — LightSession for Claude v2
// Minimal: just relays GET_STATUS and handles REFRESH_TAB.
// Settings sync now uses chrome.storage.onChanged (no message relay needed).

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_STATUS") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.url || !tab.url.includes("claude.ai")) {
        sendResponse({ error: "not on claude.ai" });
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" }, (resp) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse(resp || { error: "no response" });
        }
      });
    });
    return true; // keep channel open for async
  }

  if (msg.type === "REFRESH_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) chrome.tabs.reload(tabs[0].id);
    });
  }
});
