import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  bundle: true,
  sourcemap: true,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  splitting: false,
});
