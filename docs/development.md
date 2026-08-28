# Development

Use Node.js 22.13 or newer.

```bash
npm ci
npm run check
npm pack
```

For local openfloor, set `OPENFLOOR_BASE_URL=http://127.0.0.1:3000`. Loopback uses openfloor's development identity and does not run cloudflared. `OPENFLOOR_CLOUDFLARED` may point to an explicit current cloudflared binary for production-origin tests.

Contract fixtures name tested openfloor commit `f6cdccc3074b841d07fcbc4a3731b925699fbb43`. When consumed API shapes change, update Zod contracts, tests, fixture commit, README compatibility note, and architecture documentation together.
