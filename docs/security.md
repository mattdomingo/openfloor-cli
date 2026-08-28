# Security model

Cloudflare Access remains identity authority. `cloudflared` owns cached credentials; this client requests a short-lived JWT for each process, keeps it only in memory, and sends it as `cf-access-token`. No logout command claims to revoke cloudflared state. To switch accounts, clear or replace cloudflared's Access cache using Cloudflare's documented procedure, then run `openfloor auth login`.

Loopback HTTP intentionally skips Access for openfloor's server-only development identity. Non-loopback HTTP is refused. Redirects are never followed, response bodies are bounded, mutations are never retried, and all remote terminal text loses ANSI and unsafe control bytes. Debug output contains method and path only; token-shaped values are redacted.

First-run macOS dependency installation requires a visible `y` confirmation. The CLI resolves an executable Homebrew path and invokes it with the fixed argument array `install`, `cloudflared`; no shell or remote script is used. Linux setup opens Cloudflare's installation documentation. `OPENFLOOR_CLOUDFLARED` remains an explicit executable override and fails closed when invalid.

Config contains only base URL, selected session UUID, color preference, and setup version. File and directory modes are `0600` and `0700`. Provider secrets, GitHub credentials, repository clones, and Access JWTs never belong in config.
