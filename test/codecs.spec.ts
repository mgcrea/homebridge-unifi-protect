import { describe, expect, it } from "vitest";

import {
  hardwareCandidates,
  parseCodecList,
  parseVersion,
  resolveVideoEncoder,
  selectAudioEncoder,
  softwareEncoder,
  verifyEncoder,
} from "#media/codecs";

/** A trimmed but otherwise verbatim `ffmpeg -encoders` listing. */
const ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)
 A....D aac                  AAC (Advanced Audio Coding)
 A....D libfdk_aac           Fraunhofer FDK AAC (codec aac)
`;

describe("parseCodecList", () => {
  it("takes the name after the fixed-width flag column", () => {
    expect(parseCodecList(ENCODERS)).toEqual(
      new Set(["h264_videotoolbox", "libx264", "aac", "libfdk_aac"]),
    );
  });

  it("ignores the header and the legend", () => {
    // The legend lines look enough like entries to fool a looser pattern.
    expect(parseCodecList(ENCODERS).has("=")).toBe(false);
    expect(parseCodecList(ENCODERS).has("Video")).toBe(false);
  });

  it("returns nothing for output it does not recognise", () => {
    expect(parseCodecList("command not found")).toEqual(new Set());
  });
});

describe("parseVersion", () => {
  it("reads the version out of the banner", () => {
    expect(parseVersion("ffmpeg version 7.1.1 Copyright (c) 2000-2025")).toBe("7.1.1");
  });

  it("copes with a build that reports no version", () => {
    expect(parseVersion("")).toBeUndefined();
  });
});

describe("hardwareCandidates", () => {
  it("offers VideoToolbox on a Mac", () => {
    expect(hardwareCandidates(parseCodecList(ENCODERS), "darwin")).toEqual(["h264_videotoolbox"]);
  });

  it("puts a discrete GPU ahead of the Pi's encoder on Linux", () => {
    // v4l2m2m also shows up on desktop kernels, where it is slow or absent — so
    // a box with NVENC must not end up on it.
    const encoders = new Set(["h264_v4l2m2m", "h264_nvenc", "libx264"]);
    expect(hardwareCandidates(encoders, "linux")).toEqual(["h264_nvenc", "h264_v4l2m2m"]);
  });

  it("offers nothing on a build with no hardware encoder compiled in", () => {
    expect(hardwareCandidates(new Set(["libx264"]), "linux")).toEqual([]);
  });
});

describe("softwareEncoder", () => {
  it("prefers libx264", () => {
    expect(softwareEncoder(new Set(["libx264"]))).toBe("libx264");
  });

  it("still names an encoder on a stripped build", () => {
    expect(softwareEncoder(new Set())).toBe("h264");
  });
});

describe("verifyEncoder", () => {
  it("rejects an encoder that is listed but cannot run", async () => {
    // The case this exists for: the Homebridge image ships a static ffmpeg with
    // h264_v4l2m2m compiled in, and on any x86 host — no /dev/video* — it opens
    // with "Could not find a valid device". Verified against that exact build.
    expect(await verifyEncoder("ffmpeg", "h264_v4l2m2m")).toBe(false);
  });

  it("accepts one that does run", async () => {
    expect(await verifyEncoder("ffmpeg", "libx264")).toBe(true);
  });

  it("reports false rather than throwing when ffmpeg is missing entirely", async () => {
    expect(await verifyEncoder("definitely-not-ffmpeg", "libx264")).toBe(false);
  });
});

describe("resolveVideoEncoder", () => {
  it("falls back to software when the listed hardware encoder will not run", async () => {
    // Choosing on the listing alone hands every camera an encoder that cannot
    // work, and the failure only shows up when somebody opens a stream.
    const encoders = new Set(["h264_v4l2m2m", "libx264"]);
    expect(await resolveVideoEncoder("ffmpeg", encoders, undefined, "linux")).toEqual({
      encoder: "libx264",
      hardware: false,
    });
  });

  it("uses a hardware encoder that does run", async () => {
    const encoders = new Set(["h264_videotoolbox", "libx264"]);
    const resolved = await resolveVideoEncoder("ffmpeg", encoders, undefined, "darwin");
    // Only assert the hardware flag agrees with the encoder chosen; which one
    // is available depends on the machine the suite runs on.
    expect(resolved.hardware).toBe(resolved.encoder !== "libx264");
  });
});

describe("selectAudioEncoder", () => {
  it("requires libfdk_aac, which is the only encoder that produces AAC-ELD", () => {
    expect(selectAudioEncoder(new Set(["libfdk_aac", "aac"]))).toBe("libfdk_aac");
  });

  it("reports no audio rather than settling for the built-in AAC encoder", () => {
    // The built-in encoder cannot do the ELD profile HomeKit negotiates, so
    // using it would produce a stream the viewer hears nothing from.
    expect(selectAudioEncoder(new Set(["aac"]))).toBeUndefined();
  });
});
