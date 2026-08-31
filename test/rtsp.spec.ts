import { parseBootstrap } from "@mgcrea/unifi-protect";
import { describe, expect, it } from "vitest";

import {
  advertisedResolutions,
  isChannelUsable,
  namedChannel,
  recordingResolutions,
  rtspUrl,
  selectChannel,
  lensView,
  usableChannels,
} from "#media/rtsp";

const NVR = { id: "nvr-1", name: "Console" };

const channel = (over: Record<string, unknown> = {}) => ({
  id: 0,
  name: "high",
  width: 3840,
  height: 2160,
  fps: 30,
  isRtspEnabled: true,
  rtspAlias: "alias-high",
  ...over,
});

const cameraWith = (channels: Record<string, unknown>[]) =>
  parseBootstrap({
    nvr: NVR,
    cameras: [{ id: "cam-1", modelKey: "camera", mac: "AABBCCDDEEFF", channels }],
  }).cameras[0]!;

const THREE = [
  channel({ id: 0, name: "high", width: 3840, height: 2160, rtspAlias: "a" }),
  channel({ id: 1, name: "medium", width: 1920, height: 1080, rtspAlias: "b" }),
  channel({ id: 2, name: "low", width: 640, height: 360, rtspAlias: "c" }),
];

describe("isChannelUsable", () => {
  it("requires both the RTSP switch and an alias", () => {
    // Protect sets the flag before it publishes the alias, so a channel can be
    // "enabled" and still have nothing to connect to.
    expect(isChannelUsable(channel())).toBe(true);
    expect(isChannelUsable(channel({ isRtspEnabled: false }))).toBe(false);
    expect(isChannelUsable(channel({ rtspAlias: null }))).toBe(false);
    expect(isChannelUsable(channel({ rtspAlias: "" }))).toBe(false);
  });
});

describe("selectChannel", () => {
  it("prefers an exact match, which is the case that can be copied", () => {
    const chosen = selectChannel(usableChannels(cameraWith(THREE)), { width: 1920, height: 1080 });
    expect(chosen?.name).toBe("medium");
  });

  it("takes the smallest channel that is still big enough", () => {
    // Sending a 4K stream to be scaled down on a phone wastes the console's
    // uplink and the bridge's CPU for a picture the same size either way.
    const chosen = selectChannel(usableChannels(cameraWith(THREE)), { width: 1280, height: 720 });
    expect(chosen?.name).toBe("medium");
  });

  it("scales up rather than refusing when nothing is big enough", () => {
    const camera = cameraWith([
      channel({ id: 2, name: "low", width: 640, height: 360, rtspAlias: "c" }),
    ]);
    const chosen = selectChannel(usableChannels(camera), { width: 1920, height: 1080 });
    expect(chosen?.name).toBe("low");
  });

  it("ignores channels that have no alias yet", () => {
    const camera = cameraWith([
      channel({ id: 0, name: "high", rtspAlias: null }),
      channel({ id: 1, name: "medium", width: 1920, height: 1080, rtspAlias: "b" }),
    ]);
    expect(selectChannel(usableChannels(camera), { width: 3840, height: 2160 })?.name).toBe(
      "medium",
    );
  });

  it("returns nothing when the camera has no streamable channel at all", () => {
    const camera = cameraWith([channel({ isRtspEnabled: false })]);
    expect(selectChannel(usableChannels(camera), { width: 1920, height: 1080 })).toBeUndefined();
  });
});

describe("namedChannel", () => {
  it("honours a configured channel name", () => {
    expect(namedChannel(cameraWith(THREE), "low")?.id).toBe(2);
  });

  it("declines a named channel that is not streamable", () => {
    const camera = cameraWith([channel({ id: 2, name: "low", isRtspEnabled: false })]);
    expect(namedChannel(camera, "low")).toBeUndefined();
  });

  it("returns nothing when no channel was configured", () => {
    expect(namedChannel(cameraWith(THREE), undefined)).toBeUndefined();
  });
});

describe("rtspUrl", () => {
  it("asks the console to encrypt the media, not just the control channel", () => {
    expect(rtspUrl("10.0.0.1", channel({ rtspAlias: "abc" }))).toBe(
      "rtsps://10.0.0.1:7441/abc?enableSrtp",
    );
  });
});

describe("advertisedResolutions", () => {
  it("leads with the camera's own sizes, so HomeKit picks one we can copy", () => {
    const resolutions = advertisedResolutions(cameraWith(THREE));
    expect(resolutions.slice(0, 3)).toEqual([
      [3840, 2160, 30],
      [1920, 1080, 30],
      [640, 360, 30],
    ]);
  });

  it("offers the standard sizes too, for a controller on a slow link", () => {
    const resolutions = advertisedResolutions(cameraWith(THREE));
    expect(resolutions).toContainEqual([320, 180, 30]);
  });

  it("does not offer the same size twice", () => {
    const resolutions = advertisedResolutions(cameraWith(THREE));
    const keys = resolutions.map(([w, h]) => `${w}x${h}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("caps the frame rate at what HomeKit will accept", () => {
    const camera = cameraWith([channel({ width: 1920, height: 1080, fps: 60, rtspAlias: "a" })]);
    expect(advertisedResolutions(camera)[0]).toEqual([1920, 1080, 30]);
  });
});

describe("recordingResolutions", () => {
  it("offers only sizes a channel actually provides", () => {
    // The failure this exists for: a camera whose channels are 2688x1512,
    // 1280x720 and 640x360 was offered 1920x1080 from the standard list,
    // HomeKit chose it, and the prebuffer re-encoded at 152% of a core for as
    // long as Secure Video stayed armed.
    const camera = cameraWith([
      channel({ id: 0, width: 2688, height: 1512 }),
      channel({ id: 1, width: 1280, height: 720 }),
      channel({ id: 2, width: 640, height: 360 }),
    ]);

    expect(recordingResolutions(camera)).toEqual([
      [2688, 1512, 30],
      [1280, 720, 30],
      [640, 360, 30],
    ]);
  });

  it("never offers a standard size the camera cannot produce", () => {
    const camera = cameraWith([channel({ id: 0, width: 2688, height: 1512 })]);
    const keys = recordingResolutions(camera).map(([w, h]) => `${w}x${h}`);

    expect(keys).not.toContain("1920x1080");
    expect(keys).not.toContain("320x180");
  });

  it("falls back to the streaming list when a camera reports no sizes", () => {
    // An empty resolution list is rejected by HAP outright, and a camera with
    // no readable channel has nothing to copy anyway.
    const camera = cameraWith([channel({ id: 0, width: undefined, height: undefined })]);

    expect(recordingResolutions(camera)).toEqual(advertisedResolutions(camera));
    expect(recordingResolutions(camera).length).toBeGreaterThan(0);
  });
});

describe("usableChannels and the package lens", () => {
  it("keeps the second lens out of the main camera's choices", () => {
    // On a G4 Doorbell Pro the package lens is the same 1600x1200 as the High
    // channel but runs at 2fps. Leaving it in the list means selectChannel has
    // two equally good candidates and the viewer can end up on a slideshow of
    // the doormat at the main view's resolution.
    const doorbell = cameraWith([
      channel({ id: 0, name: "High", width: 1600, height: 1200, fps: 20 }),
      channel({ id: 3, name: "Package Camera", width: 1600, height: 1200, fps: 2 }),
    ]);

    expect(usableChannels(doorbell).map((c) => c.id)).toEqual([0]);
  });

  it("narrows a camera to one lens without touching anything else", () => {
    const doorbell = cameraWith([
      channel({ id: 0, name: "High", width: 1600, height: 1200, fps: 20 }),
      channel({ id: 3, name: "Package Camera", width: 1600, height: 1200, fps: 2 }),
    ]);
    const lens = lensView(doorbell, doorbell.channels[1]!);

    expect(lens.channels.map((c) => c.id)).toEqual([3]);
    expect(lens.name).toBe(doorbell.name);
    expect(usableChannels(lens)).toEqual([]);
  });
});
