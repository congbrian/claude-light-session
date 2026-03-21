# ⚡ LightSession for Claude

Keep Claude fast by trimming the DOM in long conversations.

Local-only, privacy-first browser extension that fixes UI lag on [claude.ai](https://claude.ai).

## The Problem

Long Claude conversations (50+ messages) cause the browser tab to bog down — sluggish scrolling, typing lag, high memory usage. Every message stays in the DOM even though you're only reading the recent ones.

## The Fix

LightSession hides older messages from the DOM (via `display: none`) so the browser only has to render the last N messages. The conversation data on Anthropic's servers is **completely untouched** — refresh the page to restore the full history anytime.

## Features

- **Automatic DOM trimming** — keeps only the last N messages visible (configurable 2–100)
- **Status pill** — optional floating indicator showing trim stats
- **Ultra Lean Mode** *(beta)* — kills all CSS animations and applies `content-visibility: auto` containment for maximum performance
- **SPA-aware** — detects navigation between conversations and re-trims automatically
- **Multi-tier selectors** — resilient to minor UI changes on claude.ai
- **Zero network requests** — nothing leaves your browser, ever
- **Reversible** — refresh the page to restore everything

## Install (Chrome)

1. Clone or download this repo
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked**
5. Select the `lightsession-claude/` folder
6. Navigate to any Claude conversation — the extension activates automatically

## Install (Firefox)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select `manifest.json` from the `lightsession-claude/` folder

> **Note**: For persistent Firefox install, the manifest would need slight adjustments for `browser_specific_settings`. The current manifest targets Chrome MV3.

## Usage

1. Open a long Claude conversation
2. Click the ⚡ icon in the toolbar
3. Adjust the slider to set how many messages to keep
4. Toggle Ultra Lean mode if the tab is really struggling

## How It Works

```
content.js (runs on claude.ai)
  ├── findMessages()        — multi-tier selector strategy to locate message elements
  ├── trimConversation()    — hides all but the last N messages via display:none
  ├── MutationObserver      — watches for new messages / React re-renders
  ├── SPA navigation poll   — detects URL changes for conversation switches
  └── Ultra Lean CSS        — optional: kills animations + applies CSS containment

popup.html / popup.js
  └── Settings UI           — syncs with content.js via chrome.storage + messages

background.js
  └── Message relay         — routes messages between popup ↔ content script
```

The approach is intentionally simple: DOM-level trimming is more resilient than intercepting API responses (which depend on internal, undocumented endpoints that can change without notice).

## Architecture Decisions

**Why DOM trimming instead of fetch interception?**

The ChatGPT version (light-session) intercepts `window.fetch` and trims the conversation JSON before React renders it. That's elegant but fragile — it requires reverse-engineering the internal API response format, which is undocumented and changes frequently.

DOM trimming is cruder but far more robust: find message elements, hide the old ones. Even if Claude redesigns their UI, the worst case is the selectors stop matching and trimming silently stops (fail-safe), rather than corrupting the API response and breaking the whole page.

**Why `display: none` instead of removing elements?**

Removing elements from a React-managed DOM tree causes React's virtual DOM to desync, leading to crashes or duplicate renders. `display: none` keeps React happy while eliminating layout/paint costs.

## Caveats

- Selectors are based on the claude.ai DOM as of March 2026. Major UI redesigns may require selector updates.
- The extension polls for URL changes every 1s (Claude is an SPA, so `pushState` doesn't fire standard navigation events).
- Ultra Lean mode suppresses *all* CSS animations site-wide, which may affect some UI elements.

## License

MIT
