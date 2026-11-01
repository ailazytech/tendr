# tendr

English ｜ [繁體中文](README.md)

A side-panel work board for Claude Code (a hooks plugin). It **writes a handoff and compacts the conversation right before the prompt cache expires**, so long-running work survives cache expiry and context limits. It also brings parallel workstreams (lanes), layered memory, and agents driven through herdr into one panel.

> Requires Claude Code **2.1.287 or later** (tested on 2.1.288). macOS and Windows share the same code.

> The board, handoff instructions and briefings follow the user's language (Traditional Chinese and English for now); see `language` under Configuration.

## What it solves

Long-running work in Claude Code (an afternoon-long refactor, several agents running separate workstreams) tends to hit the same walls:

- **Step away and the cache is gone**: the prompt cache lasts an hour by default. Come back from a meeting or lunch and the next turn re-processes the whole conversation — slow and expensive, and the longer the conversation, the more tokens it burns.
- **Forced compaction loses your place**: auto-compaction happens at the worst time, and the summary may drop what you care about (the next step, the decision still waiting on you).
- **A new session starts from zero**: you paste the handoff back yourself, or spend several turns re-explaining context.
- **Parallel lanes, no idea who's waiting on you**: one agent is stuck on a permission dialog, another finished and needs review, a third failed — and you're switching pane by pane to find out.

What tendr does:

- **Hands off proactively with 5 minutes of cache left**: Claude writes the goal, progress, next step and open decisions into a handoff document, then the conversation is compacted. The handoff turn runs while the cache is still warm, so it's cheap; work continues from a clean context.
- **Restores context automatically**: the first prompt of a new session (or after compaction) gets the handoff attached — no pasting.
- **One panel for every lane**: each lane is a JSON status file. "Waiting on you", "failed" and "needs review" come first with notifications; open a lane to see its live screen, send keys, or reply without switching panes.
- **Layered memory**: user preferences, project facts, lane-specific details and short-lived phase notes are kept apart, and stale ones are flagged for review.
- **Never repeat yourself**: requests and corrections you make are distilled into memory with a count; at 3, Claude is asked to write them into the project's CLAUDE.md / AGENTS.md, and if they keep being broken after that, a guard is drafted.
- **Catch bad habits on the spot**: retrying the same failure as is, claiming "done" without verifying, drifting out of your language — Claude gets a one-line nudge right away.

## Quick start

```bash
claude update                                          # make sure you're on 2.1.287+
claude plugin marketplace add ailazytech/tendr   # or a local path
claude plugin install tendr@tendr
```

Open a new session and type `/tendr`.

- `/tendr`: toggle the board. **Only sessions that have run `/tendr` get automatic handoff** (they become the lead session). In the herdr app you can skip `/tendr` and pick the lead on the app's tendr board instead (see "Lead session and auto-handoff (app)").
- `/handoff`: hand off now without opening the board. Use this when the mouse can't reach the board buttons (non-fullscreen layout).
- `/distill`: update notes now (see "Auto notes").
- `/guard`: view and manage guards (see "Guards").
- While the board is closed, a "🔥 Work board" button (a tendr tends the fire) appears at the top right of the prompt box (disable with `launcher_button` in `/config`).

Docking on the right requires the fullscreen layout (`CLAUDE_CODE_NO_FLICKER=1`) and a terminal at least 110 columns wide; otherwise the board sits above the prompt box.

### Upgrading from baton

tendr was called baton. Reinstall under the new name:

```bash
claude plugin uninstall baton@baton
claude plugin marketplace remove baton
claude plugin marketplace add ailazytech/tendr
claude plugin install tendr@tendr
```

- The `/board` command is now `/tendr` (`/board` is gone)
- Project overrides: without `tendr.json`, `baton.json` and then `session-board.json` are read; no need to move them
- Guards: `baton-guards.json` is copied to `tendr-guards.json` on first load
- Plugin storage (conversation not yet turned into notes, guard hit counts, ...): imported from baton's storage on first start; existing keys are kept

## Features

### Tabs

- **Tasks** — only when the project sets `tasks_dir` (see "Lane status files"): one or two lines per lane plus a percentage. Lanes that need you (blocked, failed, review, dialog awaiting confirmation) come first; idle and done lanes are collapsed.
  - Click a lane to open its page: steps, decisions waiting on you, notes, live screen (`herdr pane read`, or `hc read` in the herdr app, refreshed every 3 s), keys (Enter / Esc / 1 / 2 / 3), a reply box (`herdr agent prompt`, or `hc send` in the app), the report, and memories for that lane.
  - The report is one level deeper; "← Back" walks up one level at a time and restores the list scroll position.
  - Toasts when another lane becomes blocked, review, or failed.
- **Memory**: grouped by frontmatter `metadata.layer` into user / project / workstream / phase. Workstream memories attach to a lane page via `metadata.lane`; phase memories past `metadata.review_by` are flagged "due for review". Memories without a layer go under "unlayered", grouped by type.
- **Progress** (called **Handoff** when the Tasks tab exists): run state, todos, context usage, handoff document.
- **Herdr** — only inside herdr or the herdr app, and when there is no Tasks tab: agents/panes this session has commanded through herdr (`hc` in the app) and their live state; toasts on blocked or done.
- **Footer**: current model, cache countdown, auto-handoff toggle.

### Auto-handoff flow

1. Every request from the lead session restarts the cache timer.
2. With 5 minutes left, and when all of the following hold, the plugin sends an instruction starting with `[auto-handoff]` (`[自動交接]` in the Chinese UI) asking Claude to update the handoff document (or its own lane status file) and memory:
   - this session has run `/tendr` (or, in the herdr app, was picked as the lead on the board) and auto-handoff is on
   - `cache_ttl` is `1h` (no auto-handoff with a 5-minute cache — it would interrupt constantly)
   - context usage is at least 20% (otherwise compaction isn't worth it)
   - the last user input is within `away_hours`, or Claude is still working
3. When the handoff turn ends, the conversation is compacted. The summary is saved next to the handoff document as `*.compact.md` and can be expanded on the board.
4. The first prompt after compaction gets the handoff document attached again (disable with `brief_on_start`). Projects without `tasks_dir` also get a note asking Claude to offer you a Tasks tab when it sees several parallel workstreams.

### Nudges

One-line messages to Claude; you don't see them and they never block your tools. All on by default, each can be turned off in `/config`. The logic is ported from [ctx-handoff-mod](https://github.com/cablate/ctx-handoff-mod) (MIT).

- **Repeated failure** (`retry_nudge`): when a tool fails twice in a row for the same reason, Claude is asked to find the cause and change approach; if the error looks transient (timeout, still loading), to wait and retry once
- **"Done" without verifying** (`done_check`): if Claude edited code this turn and then claims it's done without a passing test / build / check after the edit (or the check failed), that stop is blocked and Claude is asked to verify or explain honestly. Docs-only edits (`.md` etc.), `scratchpad/` and `.review/` don't count. Claude Code shows this as "Stop hook feedback"
- **Reply language** (`reply_language`): a one-time reminder when an explanation is mostly not in the target language. `auto` follows Claude Code's `language` setting (Traditional / Simplified Chinese, English, Japanese). Code, commands, paths and very short replies are ignored, so English terms inside Chinese prose don't trigger it

### Auto notes

Your own requests, preferences and corrections are distilled into the memory folder (the one the Memory tab reads).

- **When**: after `distill_every` of your messages (default 30), before a handoff, on `/distill`, or with "Update now" on the Memory tab
- **What is sent**: your messages and Claude's replies since the last pass (slash commands excluded), to `notes_model` (default Sonnet, effort low). Each pass is one background request and doesn't occupy the main conversation. The log is kept per project in the plugin store, so anything not yet distilled carries over to the next session
- **What is written**: only `feedback` (requests and corrections) and `user` (your background). New ones become one file each and are added to `MEMORY.md`; repeated ones get `metadata.count` incremented and `last_seen` updated in their frontmatter
- **No made-up notes**: every entry must quote your exact words, which are checked against the messages you actually typed; anything that doesn't match is dropped, as is anything that looks like a key or password. If a pass fails (no reply from the model, etc.) the log is kept for the next pass
- **Said 3 times**: at the start of a new session Claude is asked, after finishing what you asked for, to put `layer: project` ones into the project's CLAUDE.md / AGENTS.md (without committing), and to ask you before adding `layer: user` ones to the global `~/.claude/CLAUDE.md`; once placed, the memory is marked `promoted`
- The Memory tab shows `×count`, `✓project` and the last pass; `distill` turns the whole thing off

### Guards

For requests that keep being broken even when written down: a check before tool calls. Ported from ctx-handoff-mod.

- **When drafted**: after a notes pass, when a request already placed in the project gets a higher count again (you corrected it again), or one you kept out of the project (`promoted: declined`) reaches 3. Or run `/guard suggest`
- **Drafts**: the model writes a tool name and regular expressions (`match` / `unless`) plus one violating and one correct example; the program checks both before accepting. Stored in `{config}/projects/{project}/tendr-guards.json` (outside the repo)
- **Nothing takes effect until you agree**: at the start of a new session Claude asks you after finishing your request; if you say yes, Claude sets that entry's `state` to `on` in the file (`off` if not). Or run `/guard on N`
- **Once on**: `deny` blocks before running and shows a toast; `remind` runs as usual and appends a reminder for Claude. If the check itself errors, the call goes through
- `/guard` lists all guards with hit counts; `/guard off N`, `/guard drop N`, `/guard mode N deny|remind`

## Configuration

In `/config`:

| Setting | Description | Default |
| --- | --- | --- |
| `memory_dir` | Memory folder | `{config}/projects/{project}/memory` |
| `handoff_path` | Handoff document | `docs/HANDOFF.md` |
| `brief_on_start` | Attach the handoff on a new session / after compaction | on |
| `launcher_button` | Board button above the prompt box | on |
| `cache_ttl` | Prompt cache TTL, `1h` / `5m`; the value reported by the engine on model switch wins | `1h` |
| `away_hours` | Stop auto-handoff after this many hours without input (`24` / `8` / `2`) | `24` |
| `language` | UI language, `auto` / `zh-TW` / `en`. `auto` uses Claude Code's `language` setting, else `LANG`; any Chinese maps to Traditional Chinese, anything else to English | `auto` |
| `retry_nudge` | Repeated-failure nudge | on |
| `done_check` | Block "done" without verifying | on |
| `reply_language` | Reply language nudge, `auto` / `off` / `zh-TW` / `zh-CN` / `en` / `ja` | `auto` |
| `distill` | Auto notes (also turns off "said 3 times" and guard drafting) | on |
| `distill_every` | Update notes every N messages (`30` / `50` / `15`) | `30` |
| `notes_model` | Model for notes and guard drafts (`sonnet` / `haiku` / `opus`) | `sonnet` |

Paths may use `{config}` (`~/.claude` or `CLAUDE_CONFIG_DIR`), `{project}` (project slug), `{root}` (project root), and `~`. Relative paths resolve against the project root.

### Per-project overrides

Put overrides in `{config}/projects/{project}/tendr.json` (outside the project repo). Changes are picked up on save. If there's no `tendr.json`, the pre-rename `baton.json` and then `session-board.json` are read instead:

```json
{
  "handoff_path": "docs/migration/PROGRESS.md",
  "handoff_section": "## Handoff"
}
```

- `handoff_path`, `memory_dir`: as above
- `handoff_section`: use when the handoff document is one of the project's own docs. The board and new sessions read only the first section whose heading starts with this; auto-handoff only asks Claude to update that section, never rewrite the whole file
- `compact_path`: where the compaction summary goes. Defaults to next to the global `handoff_path`, so switching to a project doc doesn't write summaries into the repo
- `tasks_dir`: lane status folder; enables the Tasks tab
- `tasks_self`: the lead session's own status file name (default `architect`). A lane whose `pane` is a session's own terminal belongs to that session; in the herdr app, when the folder's lead is another terminal, other Claude sessions aren't told to overwrite `tasks_self` but to add their own lane (with `pane` set to themselves)
- `sync_command`: a command that syncs the lanes, as an array (executable first); `{tasks_dir}` becomes the lane folder. It always runs before compaction (auto-handoff or manual `/compact`), with a toast on success or failure; it also runs at the end of a lead-session turn when the lane files (names or modification times) differ from the last sync, toasting only on failure. It never blocks compaction. For example, syncing lanes into ZJNote: `"sync_command": ["/Applications/…/zjnote-mcp", "pm-sync", "{tasks_dir}", "--project", "Website"]`

### Lane status files

One `<lane>.json` per lane in `tasks_dir`:

```json
{
  "lane": "api",
  "title": "Paginate REST API responses",
  "state": "working",
  "steps": [
    { "id": "S1", "title": "Inventory existing endpoints", "state": "done" },
    { "id": "S2", "title": "Add cursor parameter", "state": "doing" },
    { "id": "S3", "title": "Add tests", "state": "todo" }
  ],
  "updated": "2026-10-16T09:30:00Z",
  "notes": ["Old clients still use offset; keep it compatible for now"]
}
```

- Required: `lane`, `title` (one line), `state` (`blocked` / `failed` / `review` / `working` / `idle` / `done`), `steps` (`{ id, title, state: todo|doing|done|skip }`), `updated`
- Optional: `needs` (decision waiting on the user), `pane` (herdr pane id; in the herdr app, a terminal address like `t7` or a name), `spec`, `head`, `report` (report file path), `notes`
- Percentage = done steps ÷ (total − skipped)
- Put project-specific rules and validation tooling in that folder's README

With `tasks_dir` set, handoff switches to status-file mode:

- The first prompt of a new session / after compaction gets only the lane overview plus the lead's own steps and notes; the detailed handoff document is referenced by path, to be read on demand
- Auto-handoff asks the lead to update its own status file (steps, needs, notes) instead of rewriting the handoff document

### Memory file format

One `.md` per memory in the memory folder (`MEMORY.md` is the index and isn't listed):

```markdown
---
name: no-hotkeys
description: Don't use hotkeys on the board
metadata:
  type: feedback        # user / feedback / project / reference
  layer: user           # user / project / workstream / phase
  lane: api             # for workstream: which lane it belongs to
  review_by: 2026-11-01 # for phase: flagged after this date
  count: 2              # from auto notes: how many times you said it
  last_seen: 2026-10-19 # the last day you said it
  promoted: AGENTS.md   # where it was placed in the project; declined if you said no
  promoted_count: 3     # the count when it was placed (a higher count later drafts a guard)
---

Don't add hotkeys for me.
```

The fields from `count` down are used by auto notes and guards; hand-written memories don't need them (missing count means 1).

## Handing this to an AI agent

[AGENTS.en.md](AGENTS.en.md) (Chinese: [AGENTS.md](AGENTS.md)) is the guide for coding agents: architecture, conventions, tests, and pitfalls. Claude Code picks it up automatically through `CLAUDE.md`.

Prompts you can paste:

**Change the plugin**

```text
Read AGENTS.en.md first, then the parts of hooks/register.js relevant to this change.
I want to: <description>.
Run `claude plugin test` when done and report only after everything passes. If behavior changes, update both README.md and README.en.md.
```

**Set up the Tasks tab in your own project**

```text
I want to use tendr's Tasks tab for the parallel work in this project.
Set tasks_dir in ~/.claude/projects/<project slug>/tendr.json to <folder>,
write a README in that folder describing the lane status file format and update rules,
then create a <lane>.json for each piece of ongoing work. The lead's own file is architect.json.
```

**Pick up someone else's handoff**

```text
Read <handoff path> (and the status files in tasks_dir, if any).
In 3–5 lines tell me the goal, where things stand, the next step, and anything waiting on my decision. Don't change anything yet.
```

## macOS and Windows

Paths are normalized to `/` internally; both platforms run the same code.

### Paths and folders

| Item | macOS | Windows |
| --- | --- | --- |
| Home (`~`) | `HOME`, e.g. `/Users/<name>` | `USERPROFILE`, e.g. `C:\Users\<name>` |
| Default `{config}` | `/Users/<name>/.claude` | `C:\Users\<name>\.claude` |
| Absolute paths | start with `/` | start with a drive letter (`D:/...`) |
| `{project}` slug | `/Users/<name>/Projects/app` → `-Users-<name>-Projects-app` | `D:\work\app` → `D--work-app` |
| Case sensitivity | APFS is case-insensitive by default (the plugin compares paths case-insensitively) | NTFS is case-insensitive |

- **Use relative paths in project settings**: `handoff_path`, `tasks_dir`, `compact_path` in `tendr.json`, and `report`, `spec` in lane files, relative to the project root, work on both
- **If you need absolute paths**: `~/...` on macOS; `/`-separated on Windows (`D:/notes`). Backslashes in JSON must be escaped (`D:\\notes`), so `/` is less error-prone
- **Moving to another machine**: the `{project}` slug follows the project path. Copy `tendr.json` and `memory/` from `{config}/projects/<old slug>/` to the new slug's folder, or the Memory tab will be empty and overrides won't apply
- **Different config folder**: `CLAUDE_CONFIG_DIR` changes `{config}` on both platforms
- **Line endings**: CRLF is handled; no conversion needed

### Fullscreen layout

- macOS (zsh): `echo 'export CLAUDE_CODE_NO_FLICKER=1' >> ~/.zshrc`, then open a new tab
- Windows (PowerShell): `setx CLAUDE_CODE_NO_FLICKER 1`, then open a new terminal window

### Clicking buttons

- macOS Terminal.app: turn on View → "Allow Mouse Reporting" (⌘R)
- macOS iTerm2: turn on Settings → Profiles → Terminal → "Enable mouse reporting"
- Windows Terminal: works by default
- If clicks don't land, use `/tendr` and `/handoff`

### herdr

- macOS: herdr usually lives in `~/.local/bin/herdr`. Sessions started inside herdr use `HERDR_BIN_PATH` and don't depend on PATH; otherwise make sure `~/.local/bin` is on PATH
- Windows: `herdr.exe` must be on PATH

### herdr app

Sessions started in a terminal of the herdr desktop app (herdr-core) get the Herdr tab and lane live screens too. The app sets no `HERDR_*`; when tendr sees `HC_TERMINAL_ID` it uses `hc` instead (`hc ls --json`, `hc read`, `hc send`, `hc keys`). `hc` must be on PATH (the app installer adds it).

- The agent list only shows terminals that report status (OSC 7501). hc doesn't recognize agent brands, so programs that don't report (e.g. Claude Code on Windows) aren't listed, but a lane's live screen, replies and keys still work
- "Same workspace" means the same app space
- `hc send` / `keys` / `run` / `interrupt` … inside Bash are recorded as targets this session commanded; for `hc run` without `--name`, the returned address is recorded

#### The tendr board inside the app

The app's right-side panel can hold a tendr board too (lanes and lane pages, live screen, keys, replies, handoff document, memories), without switching to the Claude Code session:

```bash
node app/install.mjs --layout my-main   # use your layout's name
```

- The app's built-in layouts are read-only (restored on every start): Duplicate layout from the command palette first, then install into the copy. `--layout` adds a `tendr` block to its right-side panel (stack `panel-body`); for layouts without that stack, place `{ "mod": "tendr-board" }` yourself
- Open it with `herdr-app do layout.select '{"stack":"panel-body","child":"tendr"}'` then `herdr-app do layout.show '{"id":"panel"}'`, or build your own button / key. To have the tab bar remember it per space, add `tendr` to the shared `workspace.panels`
- Which project: the focused terminal's folder (focused, then same tab, then same space), the first one with `tendr.json` (or a pre-rename file)
- Commands (`herdr-app do tendr-board.<command>` or `tendr-board:<command>` in `keys.json`): `urgent` jumps to the lane that needs you most, `next` / `prev` move in list order, `back` returns to the list
- Data is read by `app/board-data.mjs` with the plugin's path rules; install records absolute paths to node and that script, so reinstall after moving the repo. Install also writes `~/.tendr/install.json` (the repo, `resume.mjs` and the board) so other mods can find tendr
- A lane needs `pane` set to an hc address (`t7`) or name for the live screen; one `hc read` takes about 2–3 s

#### Lead session and auto-handoff (app)

In the app you usually look at the tendr board on the right and never type `/tendr` in Claude, so the lead is picked on the board. The "交接" (handoff) block at the top of the list is about **the Claude you have selected** (whichever you click in the agent list on the left; if the selection isn't a Claude, one in the same tab, then the same space):

- Its terminal address and "space / tab" name (tabs are often all called Claude Code, so the tab name alone doesn't say which one), a cache countdown bar (green → yellow at 10 min → red at 5 min, seconds under 10 min), what it's doing (hands off at 5 min / not the lead, won't hand off automatically / handing off (writing status file and memory) / compacting / handed off, waiting for input) and a "立即交接" (hand off now) button that goes to this one only
- Below it, its project folder and status file; when other Claude sessions run in the same folder, a yellow note says the lane folder, memory and handoff document are shared, and that work on different projects should start Claude in each project's own folder
- When the lead is another terminal, a separate "★ 主控是 t16 · space / tab" line shows it with its countdown; with no lead, a note says nothing will hand off automatically. "設這格為主控" (make this the lead), "取消主控" (clear lead) and "其他 N 個 Claude" (other sessions, each can be made lead) are at the bottom
- The board uses the project folder the selected Claude reported (`~/.tendr/sessions`), not the terminal's current cwd: the cwd may have changed, and a neighbouring pane's folder may be another project with another lead
- The lead is stored in `~/.tendr/lead.json` (`{ project key: { terminal } }`, the key being the session root with non-alphanumerics replaced by `-`, lowercased), per terminal, so it survives app restarts and resumed conversations. The plugin sees changes within 5 s
- Conditions and steps are those of "Auto-handoff flow" above (`1h` cache, context at least 20%, within `away_hours`): with 5 minutes left, Claude is asked to update its own lane status file (or the handoff document) and memory, then the conversation is compacted
- Each Claude writes its cache countdown and handoff state to `~/.tendr/sessions/<terminal>.json` (only on change); the board reads it every 10 s, every 3 s during a handoff. "Hand off now" writes `~/.tendr/requests/<terminal>.json`; the plugin picks it up within 2 s and marks it `done`, ignoring requests older than 2 minutes
- Needs plugin 0.12 or later; restart Claude Code after updating for it to show up on the board
- The flame before the board's title: a tendr is the one who tends the fire and keeps it from going out. It's lit while the project has a lead keeping watch (handing off automatically), dim without one

#### Bringing Claude back after a reboot

Closing or updating the herdr app doesn't stop terminals, but after a reboot or logout the core only gives each kept terminal a new shell in its last folder; it never runs Claude again (upstream waits for OSC 7501 to carry session ids). tendr fills the gap:

- Inside an app terminal, the plugin records "terminal ↔ conversation" at the start of every turn in `~/.tendr/resume/<address>.json`: the terminal's creation time and shell pid, the session id, the project folder, `CLAUDE_CONFIG_DIR`
- Sessions you leave yourself (`/exit`, ctrl+c, logout) are marked ended and not brought back; shutdowns and reboots (SIGHUP / SIGTERM) are kept
- `node app/resume.mjs`: for a terminal that is still there with the same creation time but a new pid (replaced by a recovery shell), it sends `claude --resume <id>` into that shell, with the right syntax for PowerShell, cmd or bash-like shells, after going back to the project folder and restoring `CLAUDE_CONFIG_DIR`. Safe to run repeatedly (a terminal is resumed once); `--dry-run` only lists what it would do
- To run it when the app starts, `exec("node", ["<repo>/app/resume.mjs"])` from a mod that is always shown (e.g. your status bar), and again every minute for the first few minutes (recovery can come a little later). The status bar of [herdr-quota](https://github.com/ailazytech/herdr-quota) does this already: it finds `resume.mjs` through `~/.tendr/install.json`
- Only Claude Code is brought back; launch flags (e.g. `--model`, `--dangerously-skip-permissions`) are not restored

#### Showing whether Claude is busy in the app sidebar (Windows)

The herdr app only shows status that programs report themselves through OSC 7501 (the Program Status Protocol). Claude Code reports it since 2.1.295, but only after its `OSC 7501 ; ?` query gets an answer; on Windows, ConPTY filters the terminal's reply, so Claude Code decides it is unsupported and never reports, and the sidebar can't tell whether it is working, waiting on you or done.

In the **herdr app on Windows**, tendr reports for it: `working` when a turn starts, `blocked` on a permission prompt or a question, `done` when it answers, `idle` when interrupted, `working` during a compaction outside a turn (auto-handoff, manual `/compact`) and `done` after it, cleared on exit. Plugin child processes aren't attached to the terminal's console, so `hooks/osc7501.ps1` uses `AttachConsole` to write into the console of the terminal's shell (about 0.4 s each, sent in order, latest only). On macOS / Linux Claude Code reports by itself and tendr stays out of it.

## Development

A marketplace added from a local folder reads that folder directly: saving a file hot-reloads running sessions — no version bump or update needed. Don't also load the same folder with `--plugin-dir`, or it loads twice.

```bash
claude plugin test
```

Users, projects and paths in the tests are fictional (`/Users/user/Projects/example-app`, `D:\work\example-app`). Tests default to macOS paths and `HOME`; `setup(on, { windows: true })` switches to Windows paths and `USERPROFILE`. The suite has been run on both macOS and Windows.

See [AGENTS.en.md](AGENTS.en.md) for architecture and contributor notes.

## License

[MIT](LICENSE)
