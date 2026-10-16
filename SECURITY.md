# Security policy

## Reporting a vulnerability

Report privately through [GitHub private vulnerability reporting](https://github.com/mattdomingo/openfloor-cli/security/advisories/new). If GitHub does not offer that form, ask a maintainer through the contact method on their GitHub profile for a private channel before sending details. Do not open a public issue with exploit details, credentials, session content, or invite links.

Include the affected commit/version, reproduction steps using disposable test data, impact, and any proposed fix. Redact keys, cookies, JWTs, private repository data, and user information. Do not test against other users or the hosted service without permission.

## Supported code

Security fixes target the default branch. Older releases do not have a separate support commitment. Dependency advisories and GitHub settings must be reviewed again before each public release.

## Client trust boundaries

Access JWTs stay in memory. Cloudflared's cache and non-secret CLI settings use an isolated owner-only directory. Provider credentials never enter arguments or config. Remote text is sanitized before terminal rendering, and local repository synchronization only checks out or fast-forwards a clean worktree. See [security model](docs/security.md) for the complete client boundary.
