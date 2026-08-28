# Architecture

The CLI has one typed HTTP client and one action layer. Commander commands and Ink screens call those actions; neither owns transport behavior. Zod schemas validate required response shape while accepting additive fields.

Cloudflare Access remains identity authority. Production HTTP and WebSocket requests carry an in-memory `cf-access-token` fetched from `cloudflared`. Loopback development sends no token.

TUI state separates authoritative HTTP data from ephemeral WebSocket state. Mutation responses adopt only equal/newer floor revisions. `floor.changed` invalidates affected reads; presence and teammate drafts never enter persistent config. Run events deduplicate by sequence and catch up over HTTP after reconnect.

No client code executes agents, clones repositories, calls GitHub directly, or stores provider credentials.

## Safety

- Reads may retry transient failures; mutations never retry.
- Redirects are not followed, preventing Access HTML from masquerading as JSON.
- Remote strings are stripped of ANSI and unsafe control bytes.
- Destructive commands require interactive confirmation or `--yes`.
- Config stores only origin, current session, and color preference with owner-only permissions.
