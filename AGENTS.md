# openfloor CLI Engineering Guide

This repository owns the private `openfloor` command-line and terminal client. Agent execution remains remote: openfloor's Worker, D1, Durable Objects, Workflows, Sandbox, R2, and GitHub integration remain authoritative. A local Git bridge may materialize the authoritative candidate in a user's existing clone.

## Invariants

- Never persist or fabricate application state. HTTP snapshots are durable authority; WebSocket messages are invalidation and ephemeral presence/draft signals.
- Authenticate only with a Cloudflare Access JWT obtained from `cloudflared`. Every subprocess uses openfloor's owner-only isolated home, never the user's shared Cloudflare cache. Never log or persist the JWT.
- Every server mutation remains subject to server membership and role checks. Preserve concealed `404` behavior.
- Never retry mutations automatically. A lost response has unknown outcome until a fresh read proves it.
- Provider credentials are write-only through a full-page masked TUI flow. Never accept them through argv, print them, persist them, broadcast them as drafts, or retain them after submit/cancel/error. GitHub and repository credentials remain inaccessible. Local candidate fetches run `git` with fixed arguments and may use the user's existing Git credential helper without exposing credentials to this process.
- `Ctrl+C` stops local watching or exits the TUI; it never cancels a remote run.
- Sanitize remote text before terminal rendering. User content must not emit terminal control sequences.
- First-time profile and GitHub device authorization are guided by the CLI. Provider credential connect/disconnect is available through a write-only TUI. Ongoing profile, billing, GitHub installation management, and account deletion remain browser-owned.
- Support macOS and Linux with Node.js 22.13 or newer. Windows is outside v1.
- Bare `openfloor` owns first-run recovery: branded splash, explicit Homebrew confirmation on macOS when `cloudflared` is missing, Cloudflare Access login, native profile entry, GitHub device authorization with browser fallback, and Free onboarding completion. Persist only setup completion version; never credentials. Setup renderer and alternate-screen viewport must clear before application renderer starts because Ink may retain prior setup frames as static output.
- Session creation always uses account-authorized repository options from the API. Multiple repositories require an explicit interactive or command selection, and one create mutation must never be retried automatically.
- TUI rows are keyboard-operable with arrows and Enter. Navigation, forms, confirmations, settings, and help are full pages; do not reintroduce absolute modal overlays. Inline slash suggestions and bounded notices are normal page content.
- Bare `openfloor` detects only a Git worktree with a GitHub `origin` as a local workspace. Unbound workspaces enter repository-matched session creation; active or archived bindings open their floor; ended, missing, inaccessible, or repository-mismatched bindings are cleared before creation. Non-workspace directories open Sessions.
- Local live sync is receive-only. After explicit confirmation it verifies the fetched ref against the server's remote candidate SHA, switches a clean worktree to its tracking branch, and applies future candidate updates only by fast-forward. Teammates confirm before binding their clone. Dirty, diverged, mismatched, stale, externally modified, or invalid state pauses. Never reset, clean, auto-commit, or push local state; leave the candidate checked out on exit.
- Workspace-to-session bindings live only in owner-readable CLI config. They do not enter the repository or server state.
- Floor is the primary session view: persisted public team chat and ephemeral teammate drafts are separate stacked panels on the left, agents center, active-first queue right, prompt/slash-command bar below. Terminal queue results sort below live work without changing server order. Prompt input owns focus until Tab enters pane navigation. Detail pages remain available through slash commands. Background command output never obscures the floor.
- Sessions has its own persistent command bar. `/` starts commands and shows inline filtered suggestions; it never filters sessions. `Ctrl+K` focuses the same bar and never opens a popup.
- TUI `/repository` is intentionally absent; repository operations remain scriptable. `/run` remains a hidden compatibility path while direct slash aliases expose command groups. `/exit` is contextual Back; `/quit` always exits. `/cd` is deferred.
- All editable TUI fields share one cursor-aware input. Option+Backspace deletes the prior word. Secret mode never renders contents. Slash command suggestions are keyboard-selectable and Enter autocompletes partial matches before execution.
- Review reads authoritative contribution list/detail APIs and supports active/history, Files/Prompts, and one-file diff inspection. Session routing settings and agent creation are full-page keyboard flows and remain server-authorized.
- `auth logout` and TUI `/logout` delete only openfloor's isolated Cloudflare cache and identity-bound CLI state, preserve base URL and color, restore the terminal, and exit. Existing shared `~/.cloudflared` state is never touched.

## Workflow

Run `npm run check` before handoff. Any durable architecture, security, command-contract, release, or workflow decision must update this file and `docs/architecture.md` in the same change.

Tested API contract source: openfloor commit `f6cdccc3074b841d07fcbc4a3731b925699fbb43` (2026-08-28).
