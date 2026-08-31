/**
 * Build a tarball that can be dropped onto a Homebridge host by hand.
 *
 * The published package externalises its dependencies, because npm installs
 * them. A host being trialled has none of them — `@mgcrea/unifi-protect` is not
 * published yet, and `zod`, `ws` and `undici` are not there either — so the
 * plugin has to arrive self-contained. `tsdown.poc.config.ts` bundles
 * everything but `homebridge`, and this strips the dependency list so npm does
 * not try to resolve what is already inside.
 *
 *   pnpm pack:poc                 # -> poc/homebridge-unifi-protect-<version>.tgz
 *
 * Deploying it, on the host:
 *
 *   tar -xzf <tarball> -C /tmp
 *   rm -rf <homebridge>/node_modules/@mgcrea/homebridge-unifi-protect
 *   mv /tmp/package <homebridge>/node_modules/@mgcrea/homebridge-unifi-protect
 */
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "poc");
const STAGE = join(OUT, "package");

/** Everything npm would install for us, and therefore must not be asked for. */
const RESOLVED_AT_BUILD_TIME = ["dependencies", "devDependencies", "pnpm", "scripts", "imports"];

const main = async (): Promise<void> => {
  await run("npx", ["tsdown", "--config", "tsdown.poc.config.ts"], { cwd: ROOT });

  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(STAGE, "dist"), { recursive: true });
  await cp(join(ROOT, "dist-poc/index.mjs"), join(STAGE, "dist/index.mjs"));
  for (const file of ["config.schema.json", "README.md", "LICENSE"]) {
    await cp(join(ROOT, file), join(STAGE, file));
  }

  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  for (const key of RESOLVED_AT_BUILD_TIME) delete manifest[key];
  // A prerelease tag, so a host that later installs the published package is a
  // clear upgrade rather than an ambiguous same-version swap.
  const version = `${String(manifest["version"])}-poc.${process.env["POC_BUILD"] ?? "1"}`;
  manifest["version"] = version;
  manifest["types"] = undefined;
  await writeFile(join(STAGE, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const tarball = join(OUT, `homebridge-unifi-protect-${version}.tgz`);
  await run("tar", ["-czf", tarball, "-C", OUT, "package"], { cwd: ROOT });
  await rm(STAGE, { recursive: true, force: true });

  console.log(tarball);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
});
