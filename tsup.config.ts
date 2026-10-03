import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  dts: false,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  // Native, optional: loaded on first use when text has to be drawn as images.
  external: ["@napi-rs/canvas"],
});
