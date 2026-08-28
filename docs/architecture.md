# Architecture

The CLI has one typed HTTP client and one action layer. Commander commands and Ink screens call those actions; neither owns transport behavior. Zod schemas validate required response shape while accepting additive fields.

Cloudflare Access remains identity authority. Production HTTP and WebSocket requests carry an in-memory `cf-access-token` fetched from `cloudflared`. Loopback development sends no token.

TUI state separates authoritative HTTP data from ephemeral WebSocket state. Mutation responses adopt only equal/newer floor revisions. `floor.changed` invalidates affected reads; presence and teammate drafts never enter persistent config. Run events deduplicate by sequence and catch up over HTTP after reconnect.

No client code executes agents, clones repositories, calls GitHub directly, or stores provider credentials.

## Local workspace bridge

Agent execution remains server-side. At startup the CLI asks Git for the current worktree root and `origin`; only GitHub remotes produce a local workspace. An owner-readable config map binds canonical worktree roots to session IDs. No marker enters the repository.

An unbound workspace opens session creation with repository options restricted to the matching account-authorized GitHub repository. Creation requires a clean worktree, and confirmation discloses checkout behavior. A teammate opening an existing session whose repository matches the local origin receives the same one-time confirmation before binding. Once enabled, the CLI invokes Git with argument arrays to fetch the candidate ref, verifies the fetched commit equals the server's `remoteCandidateSha`, creates or switches to its local tracking branch, and applies later SHA changes using `merge --ff-only`. Sync keys on candidate branch and SHA rather than unrelated floor revisions; `/sync` explicitly retries a paused checkout. The bridge refuses dirty state, invalid refs, divergence, stale bindings, externally modified repository state, and repository mismatches. It never uses reset, clean, commit, or push, and it leaves the candidate branch checked out on exit. Existing Git configuration owns fetch authentication; the CLI never reads credential material.

This bridge materializes shared server-agent work locally. It is not a local agent runtime and does not upload local human edits. External candidate pushes remain invalid under the server contract.

Bare TUI startup has one versioned setup gate before application queries. Loopback development completes it without external tools. Production checks an executable `cloudflared`, may run Homebrew with a fixed argument array after explicit confirmation, authenticates through Cloudflare Access, verifies `/api/bootstrap/me`, and opens browser-owned onboarding when required. Only successful completion writes the setup version.

Session creation is a native TUI flow because repository choice is required before the single create mutation. Repository options stay API-authoritative. Local workspaces restrict this set to the matching origin. One option is selected by default; multiple options use keyboard selection/search. Scripted creation accepts owner/name, repository ID/prefix, and installation disambiguation. Creation is never retried after an unknown mutation outcome.

The primary session screen is a three-column collaborative floor at 100 columns or wider: team chat, agents, and prompt queue. Narrower supported terminals stack the same panes. One persistent bottom bar owns focus by default, submits queue work, or parses bounded slash commands. Tab enters pane navigation; arrows select; Enter opens an inline detail; Esc returns to input. Detail pages replace the floor temporarily and retain the same bar. `/run` and the home command palette use the existing command/action layers in a child process; stdout is suppressed and only concise sanitized completion or failure state is shown inline.

## Safety

- Reads may retry transient failures; mutations never retry.
- Redirects are not followed, preventing Access HTML from masquerading as JSON.
- Remote strings are stripped of ANSI and unsafe control bytes.
- Destructive commands require interactive confirmation or `--yes`.
- Config stores only origin, current session, color preference, non-secret setup version, and local-root/session bindings with owner-only permissions.
