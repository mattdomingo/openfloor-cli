# Contributing to openfloor CLI

Use issues for reproducible bugs and focused feature proposals. Use the private process in [SECURITY.md](SECURITY.md) for vulnerabilities; never include credentials, invite links, production data, or personal account details in public reports.

Read [AGENTS.md](AGENTS.md) before changing code. Keep changes focused, preserve existing user work, and update the engineering guide and relevant architecture/decision documentation when a durable contract changes. Do not commit local environment files, provider auth state, database contents, or generated build/test output.

## Development

Follow [README.md](README.md) for prerequisites and setup. Use `npm ci` with the committed lockfile. Production credentials are not required for the isolated automated tests.

Run `npm run check` before handoff and `npm run pack:check` for distribution changes. The CLI supports macOS and Linux with Node.js >=22.13. Use `OPENFLOOR_BASE_URL=http://127.0.0.1:3000` for a local server.

Never persist tokens or provider credentials, retry mutations after an unknown outcome, or overwrite a user's Git worktree to make synchronization succeed. Contract changes require matching Zod schemas, fixtures, and documentation. See [architecture](docs/architecture.md) and [release steps](docs/release.md).

## Pull requests

Explain the user-visible problem, resulting behavior, and validation. Screenshots must use test data. Keep secrets and personal workspace paths out of descriptions and logs. Deployments, remote migrations, release tags, and repository visibility changes require explicit maintainer authorization.

Contributions are accepted under the repository's [Apache License 2.0](LICENSE). Preserve existing copyright notices and identify the source and license of any third-party material you add. Treat other contributors respectfully and keep feedback about the work.
