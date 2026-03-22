// popup.js — LightSession for Claude v2.1
// Writes settings directly to chrome.storage.local.
// The content script picks them up via storage.onChanged.

const DEFAULTS = {
  enabled: true,
  keepMessages: 10,
  showStatusBar: true,
  showDebugPanel: false,
};

const $ = (id) => document.getElementById(id);
const enabledEl    = $("enabled");
const keepEl       = $("keepMessages");
const keepValueEl  = $("keepValue");
const showStatusEl = $("showStatus");
const showDebugEl  = $("showDebug");
const refreshBtn   = $("refreshBtn");
const statusReadout = $("statusReadout");

// ─── Load saved settings ──────────────────────────────────────
chrome.storage.local.get(DEFAULTS, (data) => {
  enabledEl.checked    = data.enabled;
  keepEl.value         = data.keepMessages;
  keepValueEl.textContent = data.keepMessages;
  showStatusEl.checked = data.showStatusBar;
  showDebugEl.checked  = data.showDebugPanel;
});

// ─── Save on change (content script picks up via onChanged) ───
function save() {
  chrome.storage.local.set({
    enabled:       enabledEl.checked,
    keepMessages:  parseInt(keepEl.value, 10),
    showStatusBar: showStatusEl.checked,
    showDebugPanel: showDebugEl.checked,
  });
}

enabledEl.addEventListener("change", save);
showStatusEl.addEventListener("change", save);
showDebugEl.addEventListener("change", save);
keepEl.addEventListener("input", () => { keepValueEl.textContent = keepEl.value; });
keepEl.addEventListener("change", save);

refreshBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "REFRESH_TAB" });
  window.close();
});

// ─── Live status from content script ──────────────────────────
function fetchStatus() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (resp) => {
    if (chrome.runtime.lastError || !resp || resp.error) {
      statusReadout.textContent = "Navigate to claude.ai to activate";
      statusReadout.classList.add("error");
      return;
    }
    statusReadout.classList.remove("error");

    if (!resp.selectorHit) {
      statusReadout.innerHTML = 'Searching for messages\u2026';
      return;
    }
    if (!resp.enabled) {
      statusReadout.textContent = "Trimming paused";
      return;
    }

    let html = resp.hidden > 0
      ? `<span class="count">${resp.visible}</span>/${resp.total} msgs (${resp.hidden} trimmed)`
      : `<span class="count">${resp.total}</span> msgs \u2014 nothing to trim`;

    html += `<br><span class="strategy">${resp.strategy || ""}</span>`;
    statusReadout.innerHTML = html;
  });
}

fetchStatus();
setInterval(fetchStatus, 2000);
