import { defineConfig } from "tsdown";

// PoC packaging only: bundles the unpublished client (and zod) so the tarball
// installs with no registry dependencies. The shipping build keeps them
// external — see tsdown.config.ts.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  outDir: "dist-pack",
  target: "node22",
  platform: "node",
  dts: false,
  clean: true,
  deps: { neverBundle: ["homebridge"] },
  noExternal: [/^@mgcrea\/unifi-protect$/, /^zod$/, /^undici$/, /^ws$/],
});
