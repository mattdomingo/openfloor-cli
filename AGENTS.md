# openfloor CLI Engineering Guide

This repository owns the private `openfloor` command-line and terminal client. It is a remote client only: openfloor's Worker, D1, Durable Objects, Workflows, Sandbox, R2, and GitHub integration remain authoritative.

## Invariants

- Never persist or fabricate application state. HTTP snapshots are durable authority; WebSocket messages are invalidation and ephemeral presence/draft signals.
- Authenticate only with a Cloudflare Access JWT obtained from `cloudflared`. Never log or persist that JWT.
- Every server mutation remains subject to server membership and role checks. Preserve concealed `404` behavior.
- Never retry mutations automatically. A lost response has unknown outcome until a fresh read proves it.
- Never send provider, GitHub, or repository credentials from this client.
- `Ctrl+C` stops local watching or exits the TUI; it never cancels a remote run.
- Sanitize remote text before terminal rendering. User content must not emit terminal control sequences.
- Account onboarding, billing, profile, provider credentials, GitHub installation setup, and account deletion remain browser-owned.
- Support macOS and Linux with Node.js 22.13 or newer. Windows is outside v1.

## Workflow

Run `npm run check` before handoff. Any durable architecture, security, command-contract, release, or workflow decision must update this file and `docs/architecture.md` in the same change.

Tested API contract source: openfloor commit `f5fe93fca745331170a45eb3c3cd68af7412237f` (2026-08-28).
