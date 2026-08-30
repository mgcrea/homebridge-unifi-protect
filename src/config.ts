import type { PlatformConfig } from "homebridge";
import { z } from "zod";

/**
 * The plugin's configuration.
 *
 * Two conventions carried from the other plugins in this family. Required
 * fields that are missing throw, with a sentence a person can act on. Numeric
 * fields are **clamped rather than rejected**: a too-eager motion duration is a
 * mistake worth correcting silently, not a reason to refuse to start.
 */

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Below this, a single burst of motion becomes a stream of notifications. */
const MIN_MOTION_DURATION_S = 2;
const MAX_MOTION_DURATION_S = 300;

const zPerCamera = z.looseObject({
  /** The camera's MAC, as shown by `pnpm diagnose`. Matched case-insensitively. */
  mac: z.string(),
  exclude: z.boolean().optional(),
  /** Which encoder profile to stream from. Defaults to the highest usable one. */
  channel: z.union([z.literal("high"), z.literal("medium"), z.literal("low")]).optional(),
});

const zConfig = z.looseObject({
  name: z.string().optional(),

  host: z.string().optional(),
  port: z.number().optional(),
  rtspPort: z.number().optional(),
  username: z.string().optional(),
  password: z.string().optional(),

  /** SHA-256 fingerprint of the console's certificate. See the README. */
  fingerprint: z.string().optional(),
  /** Turns TLS verification off entirely. Logged loudly on every start. */
  insecureTls: z.boolean().optional(),

  exposeCameras: z.boolean().optional(),
  exposeSensors: z.boolean().optional(),
  exposeLights: z.boolean().optional(),
  exposeNvr: z.boolean().optional(),

  motionDuration: z.number().optional(),
  cameras: z.array(zPerCamera).optional(),

  enableStreaming: z.boolean().optional(),
  enableRecording: z.boolean().optional(),
  videoProcessor: z.string().optional(),
  verboseFfmpeg: z.boolean().optional(),

  debug: z.boolean().optional(),
});

export type CameraOverride = {
  mac: string;
  exclude: boolean;
  channel: "high" | "medium" | "low" | undefined;
};

export type UnifiProtectConfig = {
  host: string;
  port: number;
  rtspPort: number;
  username: string;
  password: string;
  fingerprint: string | undefined;
  insecureTls: boolean;
  exposeCameras: boolean;
  exposeSensors: boolean;
  exposeLights: boolean;
  exposeNvr: boolean;
  motionDurationMs: number;
  cameras: CameraOverride[];
  enableStreaming: boolean;
  enableRecording: boolean;
  videoProcessor: string;
  verboseFfmpeg: boolean;
  debug: boolean;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export const parseConfig = (config: PlatformConfig): UnifiProtectConfig => {
  const parsed = zConfig.safeParse(config);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(
      `Invalid configuration at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "unknown"}.`,
    );
  }
  const raw = parsed.data;

  if (!raw.host) {
    throw new ConfigError(
      "No controller address configured. Set `host` to your UniFi console's hostname or IP.",
    );
  }
  if (!raw.username || !raw.password) {
    throw new ConfigError(
      "No credentials configured. Set `username` and `password` to a Local Access Only user on " +
        "the console — a Ubiquiti cloud (SSO) account usually cannot log in locally, and a " +
        "long-running bridge cannot answer a 2FA prompt.",
    );
  }

  return {
    // Accept a pasted URL as well as a bare address; people copy what is in
    // their browser, and `https://10.0.0.1/` is not a host name.
    host: raw.host.replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
    port: raw.port ?? 443,
    // Protect serves RTSPS on its own port, separate from the web interface.
    rtspPort: raw.rtspPort ?? 7441,
    username: raw.username,
    password: raw.password,
    fingerprint: raw.fingerprint,
    insecureTls: raw.insecureTls ?? false,

    // Everything is exposed unless it is turned off. Someone installing a
    // Protect plugin wants their Protect devices.
    exposeCameras: raw.exposeCameras ?? true,
    exposeSensors: raw.exposeSensors ?? true,
    exposeLights: raw.exposeLights ?? true,
    // The NVR's own sensors are diagnostics, not home automation, so they are
    // opt-in — they would otherwise clutter the Home app for everyone.
    exposeNvr: raw.exposeNvr ?? false,

    // How long a motion sensor stays tripped after the console reports motion.
    // Protect's own events can be seconds apart during continuous movement; a
    // short window turns one person walking up a path into a burst of
    // notifications.
    motionDurationMs:
      clamp(raw.motionDuration ?? 10, MIN_MOTION_DURATION_S, MAX_MOTION_DURATION_S) * 1000,

    // Live video is on by default, but it is the one part that can fail for
    // reasons outside the plugin — a missing ffmpeg, a console that refuses to
    // enable RTSP — so it can be switched off while keeping motion and
    // doorbell events working.
    enableStreaming: raw.enableStreaming ?? true,
    // HomeKit Secure Video is offered but does nothing until the user turns it
    // on per camera in the Home app, at which point one ffmpeg runs
    // continuously for that camera to keep the pre-event buffer. Offering it is
    // free; that cost is the user's to opt into.
    enableRecording: raw.enableRecording ?? true,
    videoProcessor: raw.videoProcessor ?? "ffmpeg",
    verboseFfmpeg: raw.verboseFfmpeg ?? false,

    cameras: (raw.cameras ?? []).map((entry) => ({
      mac: normalizeMac(entry.mac),
      exclude: entry.exclude ?? false,
      channel: entry.channel,
    })),

    debug: raw.debug ?? false,
  };
};

/** Protect reports MACs unpunctuated and upper-case; people type them either way. */
export const normalizeMac = (mac: string): string =>
  mac.replaceAll(/[^0-9a-zA-Z]/g, "").toUpperCase();

export const cameraOverrideFor = (
  config: UnifiProtectConfig,
  mac: string | undefined,
): CameraOverride | undefined =>
  mac ? config.cameras.find((entry) => entry.mac === normalizeMac(mac)) : undefined;
