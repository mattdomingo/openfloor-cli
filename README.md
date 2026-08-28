# openfloor CLI

Private keyboard-first CLI and TUI for [openfloor](https://app.opnflr.com).

## Requirements

- Node.js 22.13 or newer
- macOS or Linux

## Install

```bash
npm install -g ./openfloor-cli-0.1.0.tgz
openfloor
```

First launch shows the openfloor mark, then checks setup. On macOS, it offers to run `brew install cloudflared` only after explicit confirmation. It opens Cloudflare Access login and browser-owned account onboarding as needed, then starts the TUI. Linux users receive Cloudflare's install instructions when `cloudflared` is missing. Recovery repeats if the dependency, authentication, or onboarding later becomes unavailable.

Run `openfloor` inside a clean Git clone with a GitHub `origin` to create a repository-matched local session. After confirmation, openfloor verifies and checks out the server-created candidate branch, then fast-forwards the worktree whenever shared agent changes integrate. Teammates opening an existing matching session confirm once before their clone is bound. Running outside such a worktree opens session selection.

Local sync is deliberately receive-only: agents still run in openfloor's isolated remote runtime. The CLI never resets, cleans, commits, or pushes. Uncommitted or diverged work pauses sync without overwriting anything. Local human edits are not uploaded to openfloor.

Every action is also scriptable; use `openfloor --help` and `openfloor <group> --help`. Machine output uses `--json` and never mixes progress into stdout.

## Authentication

`openfloor auth login` delegates to Cloudflare's supported Access flow:

```text
cloudflared access login --no-verbose --app https://app.opnflr.com/api/bootstrap/me
```

The CLI keeps the returned JWT only in memory. Later invocations ask `cloudflared access token` for its cached token. Credential expiry, removal, and account switching remain owned by Cloudflare Access and `cloudflared`; there is intentionally no misleading CLI logout.

## Session floor

- Left: team chat
- Center: live agent floor
- Right: prompt queue
- Bottom: prompt and slash-command bar

Type ordinary text to add work to the queue. Use `/chat <message>` for team chat. `/overview`, `/review`, `/repository`, and `/settings` open detail pages; `/floor` returns; `/sessions` opens session selection; `/commands` lists all shortcuts. `/run <CLI subcommand>` executes an existing command in the background without an output popup.

Prompt input has focus by default. Press `Tab` to enter pane navigation, use arrows to select panes and rows, `Enter` to open a row, and `Esc` to return to the prompt. `/sync` retries paused local synchronization after the worktree is clean.

## Local development

```bash
npm install
npm run dev
npm run check
```

Use `OPENFLOOR_BASE_URL=http://localhost:3000` for an openfloor development Worker. Loopback skips `cloudflared` and uses the server's loopback development identity.

See [architecture](docs/architecture.md), [security](docs/security.md), [commands](docs/commands.md), [key map](docs/keymap.md), [development](docs/development.md), and [release](docs/release.md).

API contracts were verified against openfloor commit `f6cdccc3074b841d07fcbc4a3731b925699fbb43` on 2026-08-28. Additive response fields remain compatible; missing or wrongly typed required fields produce an actionable compatibility error.
