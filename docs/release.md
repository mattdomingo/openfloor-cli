# Release

The source is licensed under Apache 2.0. Distributions are GitHub release tarballs; npm-registry publication is not configured. `private: true` protects against accidental registry publishing.

## Validate locally

```bash
npm ci
npm run pack:check
npm pack
```

Install the resulting `openfloor-cli-<version>.tgz` into a temporary prefix and verify `openfloor --version`, `openfloor --help`, and `openfloor doctor --json --base-url http://127.0.0.1:9`. The final command must report a failed API check and exit 6 when the test port is closed. Against a configured local app, doctor should pass every check.

Inspect `npm pack --dry-run` before tagging. The archive must include LICENSE, NOTICE, THIRD_PARTY_NOTICES.md, and SECURITY.md and must exclude credentials, local configuration, node_modules, and test artifacts. Keep dependency licenses available when redistributing dependencies alongside the archive.

## Tagged releases

A tag matching `v<package.json version>` runs the macOS/Linux check matrix. Only after both jobs pass does the release job build and attach the npm tarball plus SHA-256 checksum to the tag's GitHub Release. Checkout credentials are not persisted; validation uses read-only permissions, and only the release job can write release assets. Creating/pushing a tag publishes a release and requires maintainer authorization.

Before the first public release, review the full Git history and third-party licensing, enable private vulnerability reporting and branch protection in GitHub settings, and confirm repository visibility and community links. GitHub visibility and registry publishing are separate actions from preparing the source.
