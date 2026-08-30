import type { PlatformConfig } from "homebridge";
import { describe, expect, it } from "vitest";

import { ConfigError, cameraOverrideFor, normalizeMac, parseConfig } from "#config";

const base = {
  platform: "UniFiProtect",
  host: "10.0.0.1",
  username: "bridge",
  password: "secret",
} as unknown as PlatformConfig;

const parse = (over: Record<string, unknown> = {}) =>
  parseConfig({ ...base, ...over } as PlatformConfig);

describe("parseConfig", () => {
  it("exposes cameras, sensors and lights by default", () => {
    // Someone installing a Protect plugin wants their Protect devices.
    const config = parse();
    expect(config.exposeCameras).toBe(true);
    expect(config.exposeSensors).toBe(true);
    expect(config.exposeLights).toBe(true);
  });

  it("keeps the console's own diagnostics opt-in", () => {
    // They are diagnostics, not home automation, and would clutter the Home app.
    expect(parse().exposeNvr).toBe(false);
  });

  it("accepts a pasted URL where a host was asked for", () => {
    // People copy what is in their browser, and `https://10.0.0.1/` is not a host.
    expect(parse({ host: "https://10.0.0.1/protect/dashboard" }).host).toBe("10.0.0.1");
  });

  it("says what to do when there are no credentials", () => {
    expect(() => parse({ username: undefined, password: undefined })).toThrow(/Local Access Only/);
  });

  it("says what to do when there is no address", () => {
    expect(() => parse({ host: undefined })).toThrow(/hostname or IP/);
  });

  it("throws ConfigError so the platform can stay dormant instead of crashing", () => {
    expect(() => parse({ host: undefined })).toThrow(ConfigError);
  });

  it("clamps a motion duration rather than refusing to start", () => {
    // A too-eager interval is a mistake worth correcting silently. Below a
    // couple of seconds, one person walking past becomes a burst of
    // notifications.
    expect(parse({ motionDuration: 0 }).motionDurationMs).toBe(2000);
    expect(parse({ motionDuration: 99_999 }).motionDurationMs).toBe(300_000);
    expect(parse({ motionDuration: 30 }).motionDurationMs).toBe(30_000);
  });

  it("rejects a value of the wrong type, naming where it is", () => {
    expect(() => parse({ motionDuration: "ten" })).toThrow(/motionDuration/);
  });

  it("keeps unknown keys rather than failing on a config from a newer version", () => {
    expect(() => parse({ somethingNew: true })).not.toThrow();
  });
});

describe("normalizeMac", () => {
  it("accepts a MAC however it was typed", () => {
    // Protect reports them unpunctuated and upper-case; people type either.
    expect(normalizeMac("aa:bb:cc:dd:ee:ff")).toBe("AABBCCDDEEFF");
    expect(normalizeMac("AA-BB-CC-DD-EE-FF")).toBe("AABBCCDDEEFF");
    expect(normalizeMac("AABBCCDDEEFF")).toBe("AABBCCDDEEFF");
  });
});

describe("cameraOverrideFor", () => {
  it("matches a configured camera regardless of MAC punctuation", () => {
    const config = parse({ cameras: [{ mac: "aa:bb:cc:dd:ee:ff", exclude: true }] });
    expect(cameraOverrideFor(config, "AABBCCDDEEFF")?.exclude).toBe(true);
  });

  it("returns nothing for a camera with no override and none for a camera with no MAC", () => {
    const config = parse({ cameras: [{ mac: "AABBCCDDEEFF" }] });
    expect(cameraOverrideFor(config, "112233445566")).toBeUndefined();
    expect(cameraOverrideFor(config, undefined)).toBeUndefined();
  });
});
