# Changelog

All notable changes to **Claude Browser Plus** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
