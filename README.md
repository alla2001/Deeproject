# Deeproject

A Windows app for managing code projects and the Claude Code sessions running in
them. Projects are folders; each one can host any number of terminals, launched
with one click into `claude`, `claude --resume`,
`claude --dangerously-skip-permissions`, a plain shell, or anything else you
define. Terminals live as tabs inside the app and can be dragged into a split or
grid layout.

## Running it

```
npm install
npm run dev     # development, with hot reload
npm run build   # compile to out/
npm run app     # build, then run the compiled app
npm run dist    # build release/Deeproject-0.1.0-setup.exe
```

**Running it day to day without reinstalling.** Double-click `Deeproject.cmd` in
the repo root (there is a "Deeproject (dev)" shortcut on the Desktop pointing at
it). It runs the compiled bundle in `out/` using the Electron binary already in
`node_modules`, and builds first if `out/` is missing. To pick up changes just
run `npm run build` and restart the app — no installer, no reinstall. The
installer in `release/` is only needed if you want a Start Menu entry or want to
run it on another machine.

`npm run dev` and the installer both work without a C++ toolchain: the ConPTY
binding ships as a prebuilt N-API binary, so nothing is compiled locally.

## Using it

**Projects.** Hit `+` in the sidebar (or `Ctrl+Shift+N`) and pick a folder.
Hovering a project row reveals just two controls: `＋` starts a terminal with
your default preset, and `⋯` opens everything else — every launch preset, the
project tools, and customise/reveal/remove. Right-clicking the row opens the
same menu.

Expanding a project shows a labelled tool strip beneath it — **Files**, **Tasks**,
**Rojo** (click to start or stop, right-click for the log), **Studio** and
**Config** — so the per-project actions are readable rather than a row of
similar-looking icons. The Rojo pill turns green with its port while the server
runs, and red if it failed. Project settings are reachable three ways: the
**Config** pill, the ⚙ button on hover, and *Configure project…* in the ⋯ menu.

Terminals are indented under their project with a tree guide, in lighter and
smaller type than the project header, so the two never read as siblings. A
terminal that still has its default name shows what it runs (its preset, e.g.
"Claude — Resume") rather than repeating the project's name; rename one and your
title is used instead.

**Terminals.** Every launch opens a new tab. Tabs carry the preset's emoji and
accent colour plus a live status dot (green running, amber starting, red exited).
Right-click a tab to restart, stop, customise, hide it while keeping the terminal
in the sidebar, or close it for good.

**Docking.** Drag any tab to an edge of another pane to split left / right / top /
bottom, or onto a tab strip to join that group. Drag the dividers to resize. The
four buttons at the top right tile everything at once — grid, columns, rows, or
stack — and the layout is saved and restored across restarts.

**Appearance.** Each terminal has its own accent colour, emoji, background image
(with opacity and blur), and font size. Projects carry the same settings and pass
them to new terminals; "Apply look to existing terminals" pushes a change down to
the ones already open. Settings → Default background applies an image to every
terminal that doesn't set its own.

**Ideas.** The 💡 button in the sidebar footer opens a scratchpad for game ideas:
a searchable list on one side, a title/body editor on the other. Ideas take tags,
can be pinned to the top, and can be linked to a project once you start building
one. Everything saves as you type, into the same `state.json` as the rest.

**Watch.** The ▶ button opens YouTube in a dockable tab — paste any link (watch,
share, playlist, `/shorts`, `/live`, with or without a timestamp) and it plays
beside your terminals. **Save** keeps a link in a sidebar list for later.

It loads youtube.com in a `<webview>` rather than the `/embed` player, because
the embed refuses to run from this app's `app://` origin — YouTube answers with
*Error 153*, and the only workarounds are forging a referrer or serving the whole
renderer over http. Loading the site is plain browsing, so it works, and search
and related videos come with it. The view has its own `persist:watch` session, so
signing in there stays out of the rest of the app. Nothing is downloaded; only
the URLs you save are stored.

**Presets.** Settings → Presets edits the launch list — label, emoji, command,
colour, and whether it is pinned to project rows. The built-in Claude presets can
be edited but not deleted.

**Code editor.** Click any file in the tree, or press `Ctrl+P` to fuzzy-find one.
Files open as Monaco editor tabs with syntax highlighting (Luau included),
`Ctrl+S` to save, a dirty marker on the tab, and Revert. Saving checks the file's
mtime first and asks before overwriting an edit made outside the app.

**Resource monitor.** Each running terminal shows CPU, memory, process count and
uptime for its whole process tree, in a strip along the bottom of the terminal
and compactly in the sidebar. Sampling interval is configurable in Settings, or
0 to turn it off.

**Rojo.** Each project has its own Rojo config — project file (auto-detected),
port (each new project gets the next free one), executable override, and optional
start-on-launch. The 🧩 button on a project row toggles the server, a green chip
shows the live port, and right-clicking the button opens the log panel.

**Roblox Studio.** The 🎮 button opens the project in Studio, either from a local
`.rbxl`/`.rbxlx` in the folder or from a place ID. Configure it under the
project's Roblox tab.

**Uploading assets to Roblox.** Add an Open Cloud API key in Settings → Roblox
and a creator (your user id, or a group id) in each project's Roblox tab, then
**Upload assets…** sends files straight to Roblox and hands back a copyable
`rbxassetid://…` for each. Images go up as Decals, audio as Audio, meshes as
Models; the accepted extensions come from Open Cloud's own list. Uploads are
created as an operation and polled until Roblox finishes moderating, so an id can
take a few seconds — audio in particular is often held for review.

Claude gets this too, as `upload_roblox_asset`, so it can build an image and put
it in-game in one step. The file must live inside the project folder: uploads are
public, owned by the configured account, and cannot be undone from the app.

If that project's place is already open in Studio, the existing window is brought
to the front instead of a second copy being opened. The process Deeproject
launched is remembered per project; after a restart it falls back to matching
Studio's window title against the cached experience name.

A cloud place needs a **universe ID** as well as a place ID — Studio's
`--task EditPlace` requires both, and without it you get *"We could not open the
place [0]"*. Deeproject resolves it from the place ID automatically via
`apis.roblox.com/universes/v1/places/{id}/universe` and caches the result. That
endpoint only answers for places it can reach: a private, unpublished or deleted
place returns nothing, and you'll need to paste the experience ID in by hand.

**Notion tasks.** Add an internal integration token in Settings → Notion, then
paste a database or page link into a project's Tasks tab. The ✅ button opens a
board where you can add, rename, tick off, re-status and delete tasks; changes
are written straight back to Notion. Databases and plain pages with to-do blocks
both work.

A database board shows **every** status, select and multi-select column — Status,
Priority, Type, a platform tag, a version — as coloured pills using Notion's own
option colours, and each one is editable by clicking it. **Group by** buckets the
rows under any of those columns with collapsible headers, mirroring a grouped
Notion view. Search matches column values as well as titles, so typing `bug` or
`high` narrows the board. Wide panels lay this out as a table with a header row;
narrower ones stack the pills under each title so nothing truncates. Boards
larger than one API page are paged through up to 1000 rows.

**Discord bug reports.** If a project's bugs arrive as posts in a Discord forum
channel, add a bot token in Settings → Discord and paste the forum's link into
the project's Reports tab. The 🐛 button then lists every post with its tags,
excerpt, author, reply count and age; you can search, filter by tag, hide closed
posts, retag or close a post in place, and open it in Discord. **→ Notion** turns
a report into a task on that project's board, carrying the tags into the title.

Click a report (or **Read**) to expand it in place: the full opening post with
its line breaks intact, any screenshots attached to it, and the replies
underneath — so you never have to leave the app to triage one. The body and
replies are fetched only when you expand, keeping the board load small.

Discord has no read-only API for guild content and a personal account token
violates their terms, so this needs a bot: create one at
discord.com/developers/applications, invite it to the server, and give it View
Channel + Read Message History (plus Manage Threads to retag or close posts).
Forum tags carry no colour through the API, only an emoji, so severity words
(`critical`, `major`, `minor`, `fixed`, `wont-fix` …) are coloured by meaning.

**Claude can read and edit both.** A terminal launched with a `claude` command in
a project with a linked board or forum is given MCP tools for them:

- Notion — `list_tasks`, `create_task`, `update_task`, `delete_task`
- Discord — `list_bug_reports`, `get_bug_report` (full text plus replies),
  `update_bug_report` (retag by name, close or reopen)
- `create_task_from_report` bridges the two
- Roblox — `upload_roblox_asset`, returning an `rbxassetid://` reference

So you can ask it to read the critical bugs, dig into one, fix it, tick the task
off and tag the report `fixed` without leaving the terminal. Nothing is added to
your repo: the app serves the tools over loopback HTTP and passes Claude a
generated `--mcp-config` file from its own data folder.

## Keyboard

| | |
|---|---|
| `Ctrl+Shift+P` | command palette |
| `Ctrl+P` | quick-open a file (outside a terminal) |
| `Ctrl+S` | save the focused editor |
| `Ctrl+Shift+T` | new terminal in the current project |
| `Ctrl+Shift+W` | close active terminal |
| `Ctrl+Shift+R` | restart active terminal |
| `Ctrl+Shift+F` | find in terminal |
| `Ctrl+Shift+B` | toggle sidebar |
| `Ctrl+Shift+N` | add project folder |
| `Ctrl+,` | settings |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | next / previous tab |
| `Alt+1` … `Alt+9` | jump to tab N |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | copy / paste |

`Ctrl+C` copies when text is selected and sends an interrupt otherwise, so it
behaves the way it does in Windows Terminal.

**Attaching an image to a terminal.** Copy a screenshot (`Win+Shift+S`, or
`PrtSc`) and press `Ctrl+V` in the terminal — the image is written to
`%APPDATA%\deeproject\pastes\` and its path is typed at the cursor, ready for
Claude to read. Dragging any file onto a terminal does the same with that file's
path. A PTY carries bytes, not pictures, so a path is the way images reach a CLI;
paths containing spaces are quoted automatically, and pastes older than a week
are cleaned up on the next paste.

## How it works

```
src/main       Electron main: window, PTY manager, JSON store, IPC
src/preload    contextBridge API exposed to the renderer as window.api
src/renderer   React UI: sidebar, dockview layout, xterm.js terminals
src/shared     types and defaults used by both sides
```

Terminals are real ConPTY sessions spawned by `@lydell/node-pty` in the main
process and rendered by xterm.js. A few details worth knowing:

- **Terminals run cmd.exe.** Claude Code's TUI misbehaves under PowerShell, so
  cmd is the default shell and every session starts with `chcp 65001` — without
  UTF-8 the box drawing and emoji in Claude's interface come out as mojibake.
  PowerShell, Git Bash and WSL are still selectable per terminal.
- **Commands keep the shell alive.** A preset runs via `cmd /K`, so when Claude
  exits you drop to a normal prompt in the same tab instead of losing it.
- **cmd gets a raw command line, not an argv array.** node-pty escapes quotes
  inside an array as `\"` — the C runtime's convention, which cmd.exe does not
  understand. It splits such an argument at the first space, which mangles any
  quoted path containing one. Passing a pre-built command line keeps the quotes
  intact; cmd's documented `/K` rule then strips exactly the outer pair.
- **Output survives the UI.** The main process keeps a 512 KB ring buffer per
  session. Dragging a tab across the dock, or a renderer reload, replays it. Each
  run carries a token and a stream position so a restart can never mix output
  from the previous run into the new one.
- **Backgrounds switch renderer.** Terminals without an image use the WebGL
  renderer; adding an image switches that terminal to the DOM renderer, which is
  the one that composites correctly over a transparent background.
- **Session markers are stripped.** If you launch Deeproject from inside a Claude
  Code session, `CLAUDECODE` / `CLAUDE_CODE_CHILD_SESSION` and friends are removed
  from the child environment so every tab starts as a fresh top-level session
  rather than a nested one.
- **The renderer is served over `app://`, not `file://`.** Monaco's language
  workers refuse to start from an opaque origin, so the built bundle is served
  through a custom protocol with a real origin and a strict CSP.
- **Studio is launched by executable, not by protocol.** The `roblox-studio:`
  URL scheme is undocumented and drops arguments; the supported entry point is
  `RobloxStudioBeta.exe --task EditPlace --placeId .. --universeId ..`. Roblox
  installs each build into its own version folder, so the newest
  `%LOCALAPPDATA%\Roblox\Versions\*\RobloxStudioBeta.exe` is the one to run. The
  protocol URL is kept only as a fallback when no install is found.
- **The PTY pid arrives late.** On Windows `IPty.pid` is `0` until ConPTY's data
  pipe is ready, so it is polled after spawn and the status re-announced once it
  lands. Reading it eagerly hands out `0`, and walking a process tree from pid 0
  measures the System Idle tree — which is how an 8 MB shell can appear to be
  using a gigabyte.
- **Resource stats reject impostor processes.** Windows recycles pids, and a
  process whose parent has exited keeps pointing at that dead pid — so once the
  pid is reused, an unrelated process looks like a child. The tree walk requires
  a child to be no older than its parent. Without that, an idle 9 MB shell gets
  credited with hundreds of megabytes of someone else's process tree (on this
  machine `Registry` and `Secure System` both claim `System` as a parent despite
  predating it).
- **Sampling is one process, not one per poll.** A single long-lived PowerShell
  emits a JSON snapshot on an interval; the main process diffs consecutive
  snapshots to derive CPU, since Windows only exposes cumulative tick counters.
  It only runs while at least one terminal is alive.

State lives in `%APPDATA%\deeproject\` — `state.json` for projects, terminals,
presets and settings; `layout.json` for the dock arrangement; `window.json` for
size and position (kept separate because the main process owns it and the
renderer owns the other two). Structural edits save immediately; only continuous
input like dragging a slider is debounced. Everything is flushed on window close,
on unload, and every 15 seconds. The Notion token is stored separately in
`notion-token.bin`, encrypted with your Windows account key via `safeStorage`.

## Dev scripts

```
node scripts/pty-smoke.cjs                              # ConPTY binding loads
node scripts/seed-test-profile.cjs <dir>                # profile with a 2x2 terminal grid
node scripts/seed-feature-profile.cjs <dir> <project>   # editor + files + rojo layout
powershell -File scripts/screenshot.ps1 -ProcId <pid>   # capture a window to PNG
powershell -File scripts/crop.ps1 -In a.png -Out b.png -X .. -Y .. -Scale 2
powershell -File scripts/tree-check.ps1 -Root <pid>     # process tree, with/without guard
```

`screenshot.ps1` uses `PrintWindow`, so it captures the target window even when
it is behind another one. Pass `-ScreenCopy` to fall back to copying the screen
region (which captures whatever is on top instead).

Set `DEEPROJECT_NOTION_FIXTURE=1` or `DEEPROJECT_DISCORD_FIXTURE=1` to make those
panels serve a canned board instead of calling the real API, so their layout can
be worked on without a token or a live workspace. `seed-feature-profile.cjs
--fake-notion` writes matching dummy tokens so the panels get past their
"connect first" screens.

Run a second instance against a throwaway profile without disturbing a live one:

```
node_modules\electron\dist\electron.exe . --user-data-dir=<dir>
```
