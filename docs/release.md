# Release

Run `npm run pack:check`, install the produced tarball globally into a temporary prefix, then smoke-test `openfloor --version`, `openfloor --help`, and `openfloor doctor --json`.

Tags matching `v*` run the full macOS/Linux matrix and attach the npm tarball plus SHA-256 checksum to a private GitHub Release. This package is not published to a registry.
