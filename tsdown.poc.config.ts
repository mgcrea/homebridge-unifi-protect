import { defineConfig } from "tsdown";

// A self-contained build for hand-deploying to a Homebridge host: the plugin's
// own dependencies are unpublished or absent there, so everything but
// `homebridge` (supplied by the host) is bundled in.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  external: ["homebridge"],
  noExternal: [/^(?!homebridge$).*/],
  target: "node22",
  platform: "node",
  outDir: "dist-poc",
  dts: false,
  clean: true,
  sourcemap: false,
});
