# Architecture

The CLI has one typed HTTP client and one action layer. Commander commands and Ink screens call those actions; neither owns transport behavior. Zod schemas validate required response shape while accepting additive fields.

Cloudflare Access remains identity authority. Production HTTP and WebSocket requests carry an in-memory `cf-access-token` fetched from `cloudflared`. Loopback development sends no token.

TUI state separates authoritative HTTP data from ephemeral WebSocket state. Mutation responses adopt only equal/newer floor revisions. `floor.changed` invalidates affected reads; presence and teammate drafts never enter persistent config. Run events deduplicate by sequence and catch up over HTTP after reconnect.

No client code executes agents, clones repositories, calls GitHub directly, or stores provider credentials.

Bare TUI startup has one versioned setup gate before application queries. Loopback development completes it without external tools. Production checks an executable `cloudflared`, may run Homebrew with a fixed argument array after explicit confirmation, authenticates through Cloudflare Access, verifies `/api/bootstrap/me`, and opens browser-owned onboarding when required. Only successful completion writes the setup version.

Session creation is a native TUI flow because repository choice is required before the single create mutation. Repository options stay API-authoritative. One option is selected by default; multiple options use keyboard selection/search. Scripted creation accepts owner/name, repository ID/prefix, and installation disambiguation. Creation is never retried after an unknown mutation outcome.

Session panes expose a shared selected-row model. Arrows move selection, tab/left/right change panes, and Enter opens a detail, file, or prefilled context command. The command palette remains a fallback over the same command/action layers, not a second transport path.

## Safety

- Reads may retry transient failures; mutations never retry.
- Redirects are not followed, preventing Access HTML from masquerading as JSON.
- Remote strings are stripped of ANSI and unsafe control bytes.
- Destructive commands require interactive confirmation or `--yes`.
- Config stores only origin, current session, color preference, and non-secret setup version with owner-only permissions.
