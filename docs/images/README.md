# Screenshot provenance

`agent-floor.png` and `sessions.png` were captured on 2026-10-16 from the compiled CLI (`npm run build`, then `node dist/index.js`) running in a Linux PTY in the cloud at 144 columns × 44 rows. The actual terminal output was displayed with xterm.js and captured with Playwright and system Chromium. The interface was not recreated or composited.

The CLI connected over loopback to the web repository's `tests/e2e/server.mjs`, with an isolated temporary D1 database and test-only GitHub repository fixture. A loopback proxy supplied the harness's disposable Alex Example identity to HTTP and WebSocket requests; authentication and API responses came from the running Worker. The same session appears in the web README, with Jordan Example as the second test member.

Agents, messages, and queued prompts were created through normal application APIs. Auto-dispatch was disabled. The images contain no production account data, credentials, private source, or live provider execution. Keep test identity headers confined to the isolated harness; production uses the normal Cloudflare Access flow.
