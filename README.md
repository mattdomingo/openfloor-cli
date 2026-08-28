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

Every action is also scriptable; use `openfloor --help` and `openfloor <group> --help`. Machine output uses `--json` and never mixes progress into stdout.

## Authentication

`openfloor auth login` delegates to Cloudflare's supported Access flow:

```text
cloudflared access login --no-verbose --app https://app.opnflr.com/api/bootstrap/me
```

The CLI keeps the returned JWT only in memory. Later invocations ask `cloudflared access token` for its cached token. Credential expiry, removal, and account switching remain owned by Cloudflare Access and `cloudflared`; there is intentionally no misleading CLI logout.

## TUI keys

- Arrow keys: select
- `Tab` / `Shift+Tab` or Left/Right: change tab
- `Enter`: open selected session, row, or context action
- `Esc`: return home or close overlay
- `/`: filter sessions
- `Ctrl+K`: run any CLI subcommand inside the TUI
- `r`: refresh
- `?`: help
- `q`: quit outside text input

The command palette accepts commands without the leading `openfloor`, for example `queue add "Fix tests"`.

## Local development

```bash
npm install
npm run dev
npm run check
```

Use `OPENFLOOR_BASE_URL=http://localhost:3000` for an openfloor development Worker. Loopback skips `cloudflared` and uses the server's loopback development identity.

See [architecture](docs/architecture.md), [security](docs/security.md), [commands](docs/commands.md), [key map](docs/keymap.md), [development](docs/development.md), and [release](docs/release.md).

API contracts were verified against openfloor commit `f6cdccc3074b841d07fcbc4a3731b925699fbb43` on 2026-08-28. Additive response fields remain compatible; missing or wrongly typed required fields produce an actionable compatibility error.
