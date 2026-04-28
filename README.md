# Claude Browser Plus

A live, interactive Chromium browser embedded in a VS Code side panel — drivable by [Claude Code](https://claude.com/claude-code) through an MCP server hosted by the extension. Same feel as ChatGPT Atlas, but inside your editor.

- 🖥 **Real Chromium**, not a screenshot loop. Click, type, scroll, switch tabs, all live.
- 🤖 **24 MCP tools** for navigation, screenshots, accessibility snapshots, console/network logs, DOM extraction, downloads, and viewport control.
- 🎯 **Pick mode** — click an element on the page, send selector + screenshot to Claude.
- ✏️ **Annotate mode** (own-project only) — draw rectangles, arrows, freehand, and text over a localhost dev site, then ship the composite + DOM-target JSON to Claude.
- ⚡ **Auto-deliver** — Pick / Annotate results land on Claude's next tool call automatically. No copy-paste.
- 🔐 **Token-gated MCP** — bearer auth on a localhost-only port; token stored in VS Code's secrets store.
- 🔄 **Crash reconnect** — if Chromium dies, tabs are restored from the last URL list.

---

## Install

### 1. Requirements

- **VS Code 1.106 or newer** (October 2025+). Uses the stable `secondarySidebar` view-container contribution.
- **Claude Code** (CLI or VS Code extension).
- **Recommended: Google Chrome installed.** The extension prefers system Chrome over bundled Chromium because real Chrome has a much smaller bot-detection fingerprint. Without Chrome, the extension falls back to bundled Chromium and warns in the output channel; sites with aggressive anti-bot (Cloudflare, Datadome) may then block requests.
- **~250 MB disk** for the bundled Chromium download (skipped if system Chrome is detected).
- **Internet access** for the first-run Chromium download. Behind a corporate proxy? Set `HTTPS_PROXY` or `PLAYWRIGHT_DOWNLOAD_HOST` before launching VS Code.

### 2. Get the `.vsix`

Download `claude-browser-plus.vsix` from the [latest release](https://github.com/colin-automates/Claude-Browser-Plus/releases/latest).

### 3. Install in VS Code

- Open the **Extensions** view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
- Click `…` (top-right of Extensions panel) → **Install from VSIX…** → pick the file.
- **Reload VS Code when prompted** (or run **Developer: Reload Window** from the Command Palette — `Ctrl+Shift+P` / `Cmd+Shift+P`). The extension won't activate until the window reloads.

### 4. First launch

On first activation, the extension will:

1. Download Chromium to `globalStorage` (~250 MB; progress notification shown).
2. Start a local MCP HTTP server on a random port, with a freshly-generated bearer token.
3. **Auto-register** the server with Claude Code (via `claude mcp add` if the CLI is on PATH, or by writing directly to `~/.claude.json` otherwise).
4. Show a notification: *"Claude Browser Plus is registered with Claude Code. Restart your Claude Code chat to load the tools."*

After the toast appears, **restart your Claude Code session** so it picks up the new MCP server.

### 5. Open the panel

Three ways:

- Click **Claude Browser** in the secondary side bar (right edge of the editor).
- `Ctrl+Alt+B` / `Cmd+Alt+B`.
- Command palette → **Claude Browser: Show Panel**.

If the secondary side bar is hidden, toggle it via **View → Appearance → Secondary Side Bar**.

---

## Use it

### From Claude

Ask Claude things like:

> *"Open https://news.ycombinator.com, find the top story, and show me a screenshot."*
>
> *"Take an accessibility snapshot of the current page so we can find the search box."*
>
> *"Open three tabs (a, b, c) and switch between them."*
>
> *"Annotate the layout issues on my localhost:3000 site."* (you'll do the drawing)

Claude has access to 24 tools. Browse the full list by asking Claude *"what claude-browser tools do you have?"*

### Pick / Annotate (manual flow)

- **Pick** — click "Pick", click any element. Selector + screenshot go to Claude on its next browser tool call.
- **Annotate** — only enabled on your own project (localhost / `file://` / hosts in `aiBrowser.projectHosts`). Click "Annotate", draw with rect/arrow/freehand/text, click "Send to Claude". Composite PNG + structured JSON (with target selectors and computed styles per annotation) ship automatically.

Both flows also copy a markdown payload to the clipboard as a fallback.

### Take/Release control

The 👤 button in the chrome bar toggles user control. When *off*, mouse and keyboard input from the panel is ignored — useful when Claude is driving and you don't want to fight it.

---

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `aiBrowser.defaultViewport` | `desktop` | Startup viewport. `desktop`/`laptop`/`tablet`/`mobile`. |
| `aiBrowser.screencastFps` | `60` | Live preview FPS (5–60). Drop to save bandwidth. |
| `aiBrowser.screencastQuality` | `85` | JPEG quality (30–95). |
| `aiBrowser.highRes` | `false` | Enable 2576px screenshot cap (Opus 4.x). Off = 1568px. |
| `aiBrowser.projectHosts` | `[]` | Extra hosts treated as "your own project" (e.g. `dev.mysite.test`). Enables annotate mode. |

All apply live — no reload.

---

## Commands

- **Claude Browser: Show Panel** — open / focus the panel
- **Claude Browser: Open URL…** — quick navigate via input box
- **Claude Browser: Copy MCP Connection Command** — clipboard copy of the `claude mcp add` line (for manual registration)
- **Claude Browser: Rotate Auth Token** — invalidate existing sessions, generate a new bearer token
- **Claude Browser: Reset Project Profile** — wipe cookies / cache for the current workspace
- **Claude Browser: Clear Captures** — empty `.ai-browser/captures/`

---

## Troubleshooting

### Chromium download fails / hangs

Behind a proxy? Set `HTTPS_PROXY` or `PLAYWRIGHT_DOWNLOAD_HOST` env vars before launching VS Code.

If the partial download is corrupt, delete the extension's `globalStorage` folder (find it via **View → Output → Claude Browser** — the path is logged on activation) and reload.

### Claude doesn't see the tools

1. Make sure you restarted your Claude Code session after install.
2. Check the **Output → Claude Browser** log for a registration error.
3. Open Claude Code's MCP UI (or run `claude mcp list`) — `claude-browser-plus` (or `ai-browser` on older installs) should be listed and connected.
4. If something looks broken, try `Claude Browser: Rotate Auth Token` and restart Claude Code.

### Tab is unresponsive / Chromium hung

`Claude Browser: Reset Project Profile` (modal-confirmed) wipes cookies/storage and reopens fresh.

### Profile in use by another VS Code window

Detected automatically — falls back to an ephemeral context (no persistence) and shows a warning toast. Close the other window if you want persistence back.

---

## How it works

```
┌──────────────┐     postMessage(jpeg buffer)     ┌────────────────┐
│   Webview    │ ◀──────────────────────────────▶ │  Extension     │
│   (canvas +  │                                  │  host          │
│   pick/      │     vscode.postMessage(input)    │                │
│   annotate)  │ ──────────────────────────────▶  │  Playwright    │
└──────────────┘                                  │  + CDP         │
                                                  │  screencast    │
                                                  └────────┬───────┘
                                                           │
                                          token-gated      │
                                          POST /mcp        ▼
                                                   ┌──────────────┐
                                                   │ MCP HTTP srv │
                                                   │ (Streamable) │
                                                   └──────┬───────┘
                                                          │
                                                          ▼
                                                   Claude Code
```

- **Frame transport**: Chromium emits JPEG screencast frames over CDP. The extension host forwards each as an `ArrayBuffer` to the webview via `postMessage`. No second port; no WebSocket; no CSP relaxation.
- **MCP transport**: Streamable HTTP (single `POST /mcp` per request, optional `text/event-stream` upgrade). Stateless per request.
- **Auth**: 32-byte hex bearer token, stored in `vscode.secrets`, validated with timing-safe compare.
- **Push queue**: when the user clicks "Send to Claude" (Pick / Annotate), the artifact is enqueued. The next `browser_*` tool result Claude receives gets a one-line system note prepended; Claude calls `browser_get_user_pushes` to drain the queue.

---

## Develop

```sh
git clone https://github.com/colin-automates/Claude-Browser-Plus.git
cd Claude-Browser-Plus
npm install
npm run watch     # rebuild on change
```

Open the folder in VS Code, press `F5` to launch a second VS Code window with the extension loaded.

To rebuild the `.vsix`:

```sh
npm run package
```

The output is `claude-browser-plus.vsix` in the project root.

---

## License

[MIT](LICENSE) © colin-automates

Not affiliated with or endorsed by Anthropic.
