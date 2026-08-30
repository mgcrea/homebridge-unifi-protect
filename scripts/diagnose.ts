/**
 * What the plugin would see, without a bridge in the way.
 *
 * The first thing to reach for when something misbehaves on the real
 * Homebridge: it prints the MACs to put in per-camera settings, which channels
 * have RTSP enabled, and any camera whose smart detection is switched off
 * behind a zone that asks for it.
 *
 *   UNIFI_PROTECT_HOST=10.0.0.1 \
 *   UNIFI_PROTECT_USERNAME=bridge \
 *   UNIFI_PROTECT_PASSWORD=... \
 *   pnpm diagnose
 */
import { resolve } from "node:path";

import { connectProtect, nvrStorage, smartDetectGate } from "@mgcrea/unifi-protect";

import { parseConfig } from "#config";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}.`);
    console.error(
      "Set UNIFI_PROTECT_HOST, UNIFI_PROTECT_USERNAME and UNIFI_PROTECT_PASSWORD. " +
        "Use the same Local Access Only account the plugin is configured with.",
    );
    process.exit(1);
  }
  return value;
};

const main = async (): Promise<void> => {
  // Run the real config parser, so the defaults and clamping shown here are the
  // ones the plugin would actually apply.
  const config = parseConfig({
    platform: "UniFiProtect",
    host: required("UNIFI_PROTECT_HOST"),
    username: required("UNIFI_PROTECT_USERNAME"),
    password: required("UNIFI_PROTECT_PASSWORD"),
    fingerprint: process.env["UNIFI_PROTECT_FINGERPRINT"],
    motionDuration: process.env["UNIFI_PROTECT_MOTION_DURATION"]
      ? Number(process.env["UNIFI_PROTECT_MOTION_DURATION"])
      : undefined,
  } as never);

  console.log("Resolved configuration");
  console.log(`  host              ${config.host}:${config.port}`);
  console.log(`  username          ${config.username}`);
  console.log(`  password          (${config.password.length} characters, not shown)`);
  console.log(`  fingerprint       ${config.fingerprint ?? "(learned on first connection)"}`);
  console.log(`  insecureTls       ${config.insecureTls}`);
  console.log(`  motionDuration    ${config.motionDurationMs / 1000}s`);
  console.log("");

  const connection = await connectProtect({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    stateDir: resolve(".cache"),
    fingerprint: config.fingerprint,
    insecureTls: config.insecureTls,
    logger: { warn: (...a) => console.warn("  warn:", ...a) },
  });

  const { store } = connection;
  const nvr = store.nvr!;
  const storage = nvrStorage(nvr);

  console.log(`Console: ${nvr.name ?? nvr.id} — Protect ${nvr.version ?? "?"}`);
  console.log(`  certificate ${connection.fingerprint ?? "(verification disabled)"}`);
  console.log(
    `  storage ${storage.utilizationPercent ?? "?"}% used` +
      (storage.isRecycling ? " (recycling — this is normal)" : ""),
  );
  console.log("");

  console.log("Cameras");
  for (const camera of store.cameras()) {
    console.log(`  ${camera.name ?? camera.id}`);
    console.log(`      mac        ${camera.mac ?? "(none)"}`);
    console.log(`      model      ${camera.marketName ?? camera.type ?? "?"}`);
    console.log(`      state      ${camera.isConnected ? "online" : "OFFLINE"}`);
    console.log(`      recording  ${camera.recordingSettings.mode ?? "?"}`);
    for (const channel of camera.channels) {
      console.log(
        `      channel ${String(channel.id).padEnd(2)} ${(channel.name ?? "?").padEnd(8)}` +
          ` ${channel.width ?? "?"}x${channel.height ?? "?"} @${channel.fps ?? "?"}fps` +
          ` rtsp=${channel.isRtspEnabled ? (channel.rtspAlias ?? "enabled") : "off"}`,
      );
    }

    const gate = smartDetectGate(camera);
    if (gate.blocked.length > 0) {
      console.log(
        `      NOTE: zones ask for [${gate.blocked.join(", ")}] but the camera's own switch ` +
          `allows only [${gate.enabled.join(", ") || "nothing"}] — those never fire.`,
      );
    }
  }
  console.log("");

  console.log("Sensors");
  for (const sensor of store.sensors()) {
    console.log(
      `  ${(sensor.name ?? sensor.id).padEnd(24)} mac=${sensor.mac ?? "-"} mount=${sensor.mountType ?? "?"}`,
    );
  }
  console.log("");

  console.log("Lights");
  for (const light of store.lights()) {
    console.log(`  ${(light.name ?? light.id).padEnd(24)} mac=${light.mac ?? "-"}`);
  }

  await connection.disconnect();
};

main().catch((error: unknown) => {
  console.error("");
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
});
