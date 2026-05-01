# Changelog

All notable changes to **Claude Browser Plus** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.1] — 2026-04-28

Hotfix for `1.1.0` — partial rebrowser-patches application broke browser launch.

### Fixed

- Browser launch failed with `Cannot read properties of undefined (reading '_sessions')` when system Chrome was used. Cause: `rebrowser-patches@1.0.19` only applies cleanly to playwright-core ≤ 1.49; on the 1.59.x we ship, two of six patch hunks fail (Playwright renamed `_delegate` → `delegate` and the `Worker` import alias). The partial state left `frames.js` calling into properties that no longer exist.
- The postinstall script is now a no-op until rebrowser-patches catches up to playwright-core 1.59+. The dependency stays installed; flip `ENABLE_REBROWSER_PATCHES = true` in `scripts/apply-stealth-patches.mjs` to re-enable. The script also now reverses the patch automatically if it fails to apply cleanly, so a future re-enable can't leave the package in a broken state.

### Notes

- The other 5 anti-detection mitigations from 1.1.0 (non-headless launch, system Chrome channel, automation-flag scrub, `addInitScript` stealth patches, humanized input) are unaffected and remain active. The lost coverage is the CDP `Runtime.enable` suppression — relevant against the most aggressive Cloudflare/Datadome probes but not the bulk of detection vectors.

## [1.1.0] — 2026-04-28

Anti-detection hardening — sites that previously blocked us (Cloudflare, Datadome, sannysoft) should now reach actual content.

### Changed

- **No longer runs headless.** Chrome launches with a real window, hidden offscreen at `-10000,-10000`. The screencast pipeline streams frames to the panel as before; the user never sees the browser window. Headless mode was the single biggest fingerprint tell.
- **Prefers system Google Chrome over bundled Chromium.** If `chrome.exe` / `Google Chrome.app` / `google-chrome` is detected on common install paths, Playwright launches with `channel: 'chrome'`. If absent, falls back to bundled Chromium and warns in the output channel. Real Chrome has a much smaller bot-detection fingerprint.
- **Human-paced click + type.** `browser_click` now resolves selectors to the element's bounding-box center, approaches from a random offset, and presses with jitter (50–150 ms dwell, 50–130 ms hold). `browser_type` types one character at a time with 40–120 ms per-keystroke jitter instead of `page.fill()`'s instant DOM paste. User-driven input from the panel is unchanged (it's already real-human timing).
- **Strips `--enable-automation`.** Playwright's default automation banner / fingerprint is suppressed via `ignoreDefaultArgs`. Adds `--disable-blink-features=AutomationControlled`.

### Added

- **`rebrowser-patches` postinstall hook** patches `playwright-core` to suppress the CDP `Runtime.enable` tell that catches most stealth setups against Cloudflare/Datadome. Failures are logged and don't break installs.
- **Stealth init script** applied to every page before any page script runs: deletes `navigator.webdriver`, restores non-empty `navigator.plugins` and `navigator.languages`, fills out `window.chrome.runtime`/`app`, and overrides `Notification.permission` if it reads as `denied` (a headless tell).
- **Persistent profile note** clarifies that the per-workspace profile is part of the anti-detection strategy — cookies and challenge completions accumulate trust over time.

### Notes

- macOS may clamp the off-screen Chrome window to the primary display (top-left) — known limitation; we'll add a Darwin-specific `--headless=new` branch if it becomes annoying.
- rebrowser-patches applies to 4 of 6 target files cleanly on playwright-core 1.59.x (`crConnection`, `crDevTools`, `frames`, `page`). `crPage.js` and `crServiceWorker.js` hunks fail to match because of a Playwright-internal import-alias change. The patched files cover the main execution-context detection path (`frames.js → _context → __re__emitExecutionContext`), which is the hot path. A future Playwright bump may close this gap.
- Verification: `https://bot.sannysoft.com` should pass green on `WebDriver`, `Plugins`, `Languages`, `Notifications`, `Chrome` checks. `https://www.cloudflare.com` should load without an interstitial.

## [1.0.0] — 2026-04-27

First public release.

### Added

- Live Chromium browser in the VS Code secondary side bar, driven by [Claude Code](https://claude.com/claude-code) over a token-gated localhost MCP HTTP server.
- 24 MCP tools — navigation, click/type/scroll, screenshots, accessibility tree, console / network logs, DOM extraction (resources, styles, HTML), tabs, downloads, viewport switcher, and a `browser_pick_element` interactive prompt.
- Pick mode — click any element, send selector + screenshot to Claude.
- Annotate mode (own-project only) — rect / arrow / freehand / text overlay on localhost dev sites; ships composite PNG + structured JSON with target selectors and computed styles.
- Auto-deliver — Pick / Annotate artifacts queue server-side and ride along on Claude's next tool call (`browser_get_user_pushes`). Clipboard remains as a fallback.
- Auto-registration with Claude Code via `claude mcp add` (CLI) with `~/.claude.json` direct-write fallback.
- Chromium auto-install on first activation with progress UI.
- SingletonLock fallback to ephemeral context when the persistent profile is in use.
- Crash reconnect — restores tabs from the last URL list when Chromium dies.
- Settings: `defaultViewport`, `screencastFps`, `screencastQuality`, `highRes`, `projectHosts`.
- Commands: Show Panel, Open URL, Copy MCP Connection Command, Rotate Auth Token, Reset Project Profile, Clear Captures.

### Notes

- Requires VS Code 1.106+ (October 2025) for the stable `secondarySidebar` view container.
- Chromium download is ~250 MB on first run, cached in extension `globalStorage` thereafter.
- Stateless MCP per request; the auto-deliver mechanism uses a piggyback queue rather than server→client push.
