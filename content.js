// content.js — LightSession for Claude v2.3
// Self-discovering DOM trimmer with chunked scroll pagination.
//
// Settings sync: chrome.storage.onChanged (no message relay).
// Trim method: display:none !important via <style> tag + inline.
// Scroll-to-load: scrolling near the top reveals the previous keepMessages
//   chunk. Works by operating directly on [data-ls-hidden] elements —
//   no re-discovery needed, no index recomputation.

(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    keepMessages: 10,
    showStatusBar: true,
    showDebugPanel: false,
  };

  let S = { ...DEFAULTS };
  let stats = { total: 0, visible: 0, hidden: 0, strategy: "none", selector: "none" };
  let observer = null;
  let debounceTimer = null;
  let cachedSelector = null;
  let styleTag = null;
  let statusEl = null;
  let debugEl = null;
  let ultraLeanEl = null;
  let ultraLeanActive = false;
  let isPeeking = false;   // true while user has loaded extra chunks above
  let scrollContainer = null;
  let scrollListener = null;
  let chunkCooldown = false;

  // ═══════════════════════════════════════════════════════════════
  //  SELECTOR DISCOVERY
  // ═══════════════════════════════════════════════════════════════

  function tryTestIdSelector() {
    const els = document.querySelectorAll(
      '[data-testid*="turn"], [data-testid*="message-row"], [data-testid*="chat-message"]'
    );
    return els.length >= 2
      ? { selector: '[data-testid*="turn"], [data-testid*="message-row"], [data-testid*="chat-message"]', elements: [...els] }
      : null;
  }

  function tryRoleSelector() {
    const els = document.querySelectorAll(
      '[data-role="human"], [data-role="assistant"], [data-role="user"]'
    );
    return els.length >= 2
      ? { selector: '[data-role="human"], [data-role="assistant"], [data-role="user"]', elements: [...els] }
      : null;
  }

  function tryScrollContainerChildren() {
    const candidates = document.querySelectorAll("main div, body > div > div div");
    const scrollables = [];

    for (const div of candidates) {
      const cs = getComputedStyle(div);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") &&
          div.scrollHeight > div.clientHeight + 200 &&
          div.children.length >= 2) {
        scrollables.push(div);
      }
    }

    scrollables.sort((a, b) => b.children.length - a.children.length);

    for (const container of scrollables.slice(0, 3)) {
      const msgs = [...container.children].filter((el) => {
        if (el.tagName !== "DIV") return false;
        if (el.offsetHeight < 40) return false;
        if (el.querySelector('[contenteditable="true"], textarea')) return false;
        if ((el.textContent || "").trim().length < 5) return false;
        if (el.id && el.id.startsWith("ls-")) return false;
        return true;
      });

      if (msgs.length >= 2) {
        msgs.forEach((el, i) => el.setAttribute("data-ls-idx", String(i)));
        return { selector: "[data-ls-idx]", elements: msgs };
      }
    }
    return null;
  }

  function tryGroupedDivHeuristic() {
    const main = document.querySelector("main") || document.body;
    const byParent = new Map();

    main.querySelectorAll("div").forEach((parent) => {
      const kids = [...parent.children].filter(
        (c) => c.tagName === "DIV" && c.offsetHeight > 40 &&
               (c.textContent || "").trim().length > 20 &&
               !c.querySelector('[contenteditable="true"], textarea') &&
               !(c.id && c.id.startsWith("ls-"))
      );
      if (kids.length >= 4) byParent.set(parent, kids);
    });

    let best = null;
    let bestLen = 0;
    for (const [, kids] of byParent) {
      if (kids.length > bestLen) { bestLen = kids.length; best = kids; }
    }

    if (best && best.length >= 2) {
      best.forEach((el, i) => el.setAttribute("data-ls-idx", String(i)));
      return { selector: "[data-ls-idx]", elements: best };
    }
    return null;
  }

  const STRATEGIES = [
    { name: "data-testid",      fn: tryTestIdSelector },
    { name: "data-role",        fn: tryRoleSelector },
    { name: "scroll-container", fn: tryScrollContainerChildren },
    { name: "grouped-div",      fn: tryGroupedDivHeuristic },
  ];

  function discoverMessages() {
    for (const { name, fn } of STRATEGIES) {
      try {
        const result = fn();
        if (result && result.elements.length >= 2) {
          cachedSelector = result.selector;
          stats.strategy = name;
          stats.selector = result.selector;
          return result.elements;
        }
      } catch (e) {
        console.warn(`[LS] Strategy "${name}" threw:`, e);
      }
    }
    return [];
  }

  function findMessages() {
    if (cachedSelector) {
      const els = document.querySelectorAll(cachedSelector);
      if (els.length >= 2) return [...els];
    }
    return discoverMessages();
  }

  // ═══════════════════════════════════════════════════════════════
  //  TRIM LOGIC
  // ═══════════════════════════════════════════════════════════════

  function ensureStyleTag() {
    if (styleTag && document.head.contains(styleTag)) return styleTag;
    styleTag = document.createElement("style");
    styleTag.id = "ls-trim-styles";
    document.head.appendChild(styleTag);
    return styleTag;
  }

  // Rebuild the CSS rules to match whatever is currently marked data-ls-hidden.
  // Called after partial reveals so the stylesheet stays in sync.
  function rebuildStyleTag() {
    const tag = ensureStyleTag();
    const rules = [];
    document.querySelectorAll("[data-ls-hidden]").forEach((el) => {
      const idx = el.getAttribute("data-ls-idx");
      if (idx !== null) rules.push(`[data-ls-idx="${idx}"] { display: none !important; }`);
    });
    tag.textContent = rules.join("\n");
  }

  function trimConversation() {
    if (!S.enabled) { restoreAll(); return; }
    if (isPeeking) return; // user is reading older messages — don't re-hide

    const messages = findMessages();
    const total = messages.length;
    const keep = S.keepMessages;

    if (total === 0) {
      stats = { ...stats, total: 0, visible: 0, hidden: 0 };
      renderOverlays();
      return;
    }

    if (total <= keep) {
      const tag = ensureStyleTag();
      tag.textContent = "";
      messages.forEach((el) => {
        el.style.removeProperty("display");
        el.removeAttribute("data-ls-hidden");
      });
      stats = { ...stats, total, visible: total, hidden: 0 };
      renderOverlays();
      return;
    }

    const cutoff = total - keep;
    const tag = ensureStyleTag();
    const rules = [];

    messages.forEach((el, i) => {
      if (i < cutoff) {
        el.style.setProperty("display", "none", "important");
        el.setAttribute("data-ls-hidden", "true");
        const idx = el.getAttribute("data-ls-idx");
        if (idx !== null) rules.push(`[data-ls-idx="${idx}"] { display: none !important; }`);
      } else {
        el.style.removeProperty("display");
        el.removeAttribute("data-ls-hidden");
      }
    });

    tag.textContent = rules.join("\n");
    stats = { ...stats, total, visible: keep, hidden: cutoff };
    renderOverlays();
  }

  function restoreAll() {
    if (styleTag) styleTag.textContent = "";
    document.querySelectorAll("[data-ls-hidden]").forEach((el) => {
      el.style.removeProperty("display");
      el.removeAttribute("data-ls-hidden");
    });
    document.querySelectorAll("[data-ls-idx]").forEach((el) => {
      el.removeAttribute("data-ls-idx");
    });
    cachedSelector = null;
    isPeeking = false;
    stats = { total: 0, visible: 0, hidden: 0, strategy: "none", selector: "none" };
    renderOverlays();
  }

  // Reveal the previous keepMessages-sized chunk.
  // Operates directly on [data-ls-hidden] elements — the exact elements we
  // hid — so no re-discovery or index recomputation is needed.
  function revealChunk() {
    const allHidden = [...document.querySelectorAll("[data-ls-hidden]")];
    if (allHidden.length === 0) return;

    isPeeking = true;

    // The hidden elements are in DOM order: oldest first.
    // The LAST n of them are closest to the visible window — reveal those.
    const n = S.keepMessages;
    const toReveal = allHidden.slice(-n);
    const boundaryEl = toReveal[0]; // will become the new first visible message

    toReveal.forEach((el) => {
      el.style.removeProperty("display");
      el.removeAttribute("data-ls-hidden");
    });

    // Keep the stylesheet in sync with whatever is still hidden.
    rebuildStyleTag();

    stats = {
      ...stats,
      visible: stats.visible + toReveal.length,
      hidden: stats.hidden - toReveal.length,
    };
    renderOverlays();

    // Scroll so the boundary element sits at the top of the container.
    // requestAnimationFrame lets layout settle (including any scroll-anchoring
    // adjustments) before we read positions.
    if (boundaryEl && scrollContainer) {
      requestAnimationFrame(() => {
        const containerRect = scrollContainer.getBoundingClientRect();
        const elRect = boundaryEl.getBoundingClientRect();
        scrollContainer.scrollTop += elRect.top - containerRect.top;
      });
    }
  }

  function scheduleTrim() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(trimConversation, 200);
  }

  // ═══════════════════════════════════════════════════════════════
  //  SCROLL-TO-LOAD
  // ═══════════════════════════════════════════════════════════════

  function findScrollContainer() {
    const candidates = document.querySelectorAll("main div, body > div > div div");
    for (const div of candidates) {
      const cs = getComputedStyle(div);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") &&
          div.scrollHeight > div.clientHeight + 200) {
        return div;
      }
    }
    return null;
  }

  function attachScrollListener() {
    if (scrollContainer && scrollListener) {
      scrollContainer.removeEventListener("scroll", scrollListener);
      scrollListener = null;
      scrollContainer = null;
    }

    const container = findScrollContainer();
    if (!container) {
      setTimeout(attachScrollListener, 2000);
      return;
    }

    scrollContainer = container;
    scrollListener = () => {
      if (!S.enabled) return;
      const nearTop    = container.scrollTop < 150;
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 200;

      if (nearTop && stats.hidden > 0 && !chunkCooldown) {
        chunkCooldown = true;
        setTimeout(() => { chunkCooldown = false; }, 800);
        revealChunk();
      } else if (isPeeking && nearBottom) {
        isPeeking = false;
        scheduleTrim();
      }
    };
    container.addEventListener("scroll", scrollListener, { passive: true });
  }

  // ═══════════════════════════════════════════════════════════════
  //  STATUS PILL
  // ═══════════════════════════════════════════════════════════════

  function renderStatusBar() {
    if (!S.showStatusBar || !S.enabled || stats.total === 0) {
      if (statusEl) statusEl.style.display = "none";
      return;
    }
    if (!statusEl) {
      statusEl = document.createElement("div");
      statusEl.id = "ls-status-bar";
      Object.assign(statusEl.style, {
        position: "fixed", bottom: "80px", right: "16px", zIndex: "10000",
        background: "rgba(30,30,30,0.92)", color: "#e0e0e0",
        fontFamily: "'SF Mono','Fira Code',monospace", fontSize: "11px",
        padding: "6px 12px", borderRadius: "8px", backdropFilter: "blur(8px)",
        border: "1px solid rgba(255,255,255,0.08)",
        pointerEvents: "none", userSelect: "none",
      });
      document.body.appendChild(statusEl);
    }
    statusEl.style.display = "";
    statusEl.textContent = stats.hidden > 0
      ? `\u26A1 ${stats.visible}/${stats.total} msgs \u2014 scroll up for more`
      : `\u26A1 ${stats.total} msgs`;
  }

  // ═══════════════════════════════════════════════════════════════
  //  DEBUG PANEL
  // ═══════════════════════════════════════════════════════════════

  function renderDebugPanel() {
    if (!S.showDebugPanel) {
      if (debugEl) debugEl.style.display = "none";
      return;
    }

    if (!debugEl) {
      debugEl = document.createElement("div");
      debugEl.id = "ls-debug-panel";
      Object.assign(debugEl.style, {
        position: "fixed", top: "60px", right: "16px", zIndex: "10001",
        width: "340px", maxHeight: "80vh", overflowY: "auto",
        background: "rgba(20,20,25,0.96)", color: "#d4d4d8",
        fontFamily: "'SF Mono','Fira Code',monospace", fontSize: "11px",
        lineHeight: "1.6", padding: "14px", borderRadius: "10px",
        backdropFilter: "blur(12px)",
        border: "1px solid rgba(192,132,252,0.2)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)", userSelect: "text",
      });
      document.body.appendChild(debugEl);
    }

    debugEl.style.display = "";

    const allMsgs = findMessages();
    const hiddenEls = document.querySelectorAll("[data-ls-hidden]");
    const actuallyHidden = [...hiddenEls].filter(
      (el) => getComputedStyle(el).display === "none"
    );
    const actuallyVisible = allMsgs.filter(
      (el) => getComputedStyle(el).display !== "none"
    );
    const totalNodes = document.querySelectorAll("*").length;

    const h = hiddenEls[0];
    const v = actuallyVisible[0];
    const e = (s) => (s || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const checks = [];

    if (hiddenEls.length > 0) {
      const ok = actuallyHidden.length === hiddenEls.length;
      checks.push(`<div style="color:${ok ? "#34d399" : "#f87171"}">
        ${ok ? "\u2713" : "\u2717"} display:none working: ${actuallyHidden.length}/${hiddenEls.length} hidden
        ${!ok ? '<br><span style="color:#fbbf24;font-size:10px">\u2192 React is overriding! Try lowering keep count</span>' : ""}
      </div>`);
    }

    if (allMsgs.length > 0) {
      const lastVisible = getComputedStyle(allMsgs[allMsgs.length - 1]).display !== "none";
      checks.push(`<div style="color:${lastVisible ? "#34d399" : "#f87171"}">
        ${lastVisible ? "\u2713" : "\u2717"} Most recent message visible
      </div>`);
    }

    if (allMsgs.length < S.keepMessages) {
      checks.push(`<div style="color:#fbbf24">
        \u26A0 ${allMsgs.length} msgs found, keep=${S.keepMessages} \u2014 nothing to trim yet
      </div>`);
    }

    if (isPeeking) {
      checks.push(`<div style="color:#a78bfa">
        \u2191 Peek mode \u2014 scroll to bottom to re-enable trimming
      </div>`);
    }

    const sampleBlock = (title, el, color) => {
      if (!el) return "";
      const cs = getComputedStyle(el);
      return `<div style="margin-bottom:10px">
        <div style="color:#a1a1aa;font-size:9px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px">${title}</div>
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:4px;padding:5px;font-size:10px">
          <div style="color:${color}">${el.tagName} · display: <b>${cs.display}</b></div>
          <div style="color:#71717a">testid: ${e(el.getAttribute("data-testid") || "\u2014")}</div>
          <div style="color:#71717a">class: ${e((el.className || "").toString().slice(0, 100))}</div>
          <div style="color:#71717a">text: "${e((el.textContent || "").trim().slice(0, 70))}\u2026"</div>
        </div>
      </div>`;
    };

    const ulColor = ultraLeanActive ? "#34d399" : "#71717a";
    const ulLabel = ultraLeanActive ? "Ultra Lean: ON" : "Ultra Lean: OFF";

    debugEl.innerHTML = `
      <div style="color:#c084fc;font-weight:600;font-size:13px;margin-bottom:10px;
                  border-bottom:1px solid rgba(192,132,252,0.2);padding-bottom:6px">
        \u26A1 LightSession Debug
      </div>

      <div style="margin-bottom:10px">
        <div style="color:#a1a1aa;font-size:9px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px">Discovery</div>
        <div><span style="color:#71717a">Strategy:</span> <span style="color:#fbbf24">${e(stats.strategy)}</span></div>
        <div><span style="color:#71717a">Selector:</span> <span style="color:#a78bfa">${e(stats.selector)}</span></div>
      </div>

      <div style="margin-bottom:10px">
        <div style="color:#a1a1aa;font-size:9px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px">Counts</div>
        <div>Found: <b style="color:#34d399">${allMsgs.length}</b> ·
             Hidden: <b style="color:#f87171">${hiddenEls.length}</b> ·
             Visible: <b style="color:#34d399">${actuallyVisible.length}</b></div>
        <div style="color:#71717a">DOM nodes: ${totalNodes.toLocaleString()} · Keep: ${S.keepMessages}</div>
      </div>

      <div style="margin-bottom:10px">
        <div style="color:#a1a1aa;font-size:9px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px">Validation</div>
        ${checks.join("")}
      </div>

      ${sampleBlock("Sample Hidden", h, "#f87171")}
      ${sampleBlock("Sample Visible", v, "#34d399")}

      <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:8px;display:flex;gap:6px;flex-wrap:wrap">
        <button id="ls-btn-highlight" style="flex:1;background:rgba(192,132,252,0.12);color:#c084fc;
          border:1px solid rgba(192,132,252,0.25);border-radius:6px;padding:4px 8px;
          font-family:inherit;font-size:10px;cursor:pointer">Highlight</button>
        <button id="ls-btn-rediscover" style="flex:1;background:rgba(52,211,153,0.12);color:#34d399;
          border:1px solid rgba(52,211,153,0.25);border-radius:6px;padding:4px 8px;
          font-family:inherit;font-size:10px;cursor:pointer">Re-discover</button>
        <button id="ls-btn-ultralean" style="flex:1;background:rgba(251,191,36,0.08);color:${ulColor};
          border:1px solid rgba(251,191,36,0.2);border-radius:6px;padding:4px 8px;
          font-family:inherit;font-size:10px;cursor:pointer">${ulLabel}</button>
      </div>
      <div style="margin-top:6px;font-size:9px;color:#52525b">
        Ultra Lean: kills animations + CSS containment. Experimental — may cause visual glitches.
      </div>
    `;

    debugEl.querySelector("#ls-btn-highlight").onclick = () => {
      allMsgs.forEach((el) => {
        const hidden = el.hasAttribute("data-ls-hidden");
        el.style.outline = `2px solid ${hidden ? "#f87171" : "#34d399"}`;
        el.style.outlineOffset = "-2px";
      });
      setTimeout(() => {
        allMsgs.forEach((el) => {
          el.style.removeProperty("outline");
          el.style.removeProperty("outline-offset");
        });
      }, 4000);
    };

    debugEl.querySelector("#ls-btn-rediscover").onclick = () => {
      restoreAll();
      cachedSelector = null;
      trimConversation();
    };

    debugEl.querySelector("#ls-btn-ultralean").onclick = () => {
      ultraLeanActive = !ultraLeanActive;
      applyUltraLean(ultraLeanActive);
      renderDebugPanel();
    };
  }

  function renderOverlays() {
    renderStatusBar();
    renderDebugPanel();
  }

  // ═══════════════════════════════════════════════════════════════
  //  ULTRA LEAN (debug panel only)
  // ═══════════════════════════════════════════════════════════════

  function applyUltraLean(on) {
    if (on && !ultraLeanEl) {
      ultraLeanEl = document.createElement("style");
      ultraLeanEl.id = "ls-ultra-lean";
      ultraLeanEl.textContent = `
        *, *::before, *::after {
          animation-duration: 0.001ms !important;
          transition-duration: 0.001ms !important;
        }
        [data-ls-idx], [data-testid*="turn"] {
          contain: content;
          content-visibility: auto;
          contain-intrinsic-size: auto 200px;
        }
        pre, code { contain: strict; content-visibility: auto; }
      `;
      document.head.appendChild(ultraLeanEl);
    } else if (!on && ultraLeanEl) {
      ultraLeanEl.remove();
      ultraLeanEl = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  SETTINGS SYNC
  // ═══════════════════════════════════════════════════════════════

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(DEFAULTS, (data) => {
        S = { ...DEFAULTS, ...data };
        resolve();
      });
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in S) S[key] = newValue;
    }
    isPeeking = false;
    scheduleTrim();
    renderOverlays();
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "GET_STATUS") {
      const msgs = findMessages();
      const hiddenCount = document.querySelectorAll("[data-ls-hidden]").length;
      sendResponse({
        total: msgs.length,
        visible: msgs.length - hiddenCount,
        hidden: hiddenCount,
        strategy: stats.strategy,
        selector: stats.selector,
        enabled: S.enabled,
        keepMessages: S.keepMessages,
        selectorHit: msgs.length > 0,
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  //  MUTATION OBSERVER
  // ═══════════════════════════════════════════════════════════════

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "childList" && m.addedNodes.length > 0) {
          for (const n of m.addedNodes) {
            if (n.nodeType === Node.ELEMENT_NODE) {
              scheduleTrim();
              return;
            }
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ═══════════════════════════════════════════════════════════════
  //  SPA NAVIGATION
  // ═══════════════════════════════════════════════════════════════

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      cachedSelector = null;
      isPeeking = false;
      document.querySelectorAll("[data-ls-idx]").forEach((el) =>
        el.removeAttribute("data-ls-idx")
      );
      setTimeout(() => {
        scheduleTrim();
        attachScrollListener();
      }, 600);
    }
  }, 1000);

  // ═══════════════════════════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════════════════════════

  async function init() {
    await loadSettings();
    startObserver();
    attachScrollListener();
    setTimeout(trimConversation, 1000);
    setTimeout(trimConversation, 3000);
    console.log("%c\u26A1 LightSession for Claude v2.3", "color:#c084fc;font-weight:bold;font-size:12px");
  }

  init();
})();
