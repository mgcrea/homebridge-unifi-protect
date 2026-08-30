import { describe, expect, it } from "vitest";

import {
  parseCodecList,
  parseVersion,
  selectAudioEncoder,
  selectVideoEncoder,
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

describe("selectVideoEncoder", () => {
  it("uses VideoToolbox on a Mac", () => {
    const encoders = parseCodecList(ENCODERS);
    expect(selectVideoEncoder(encoders, "darwin")).toEqual({
      encoder: "h264_videotoolbox",
      hardware: true,
    });
  });

  it("prefers a discrete GPU over the Pi's encoder on Linux", () => {
    // v4l2m2m also shows up on desktop kernels, where it is slow — so a box
    // with NVENC must not end up on it.
    const encoders = new Set(["h264_v4l2m2m", "h264_nvenc", "libx264"]);
    expect(selectVideoEncoder(encoders, "linux").encoder).toBe("h264_nvenc");
  });

  it("uses the Pi's encoder when that is all there is", () => {
    const encoders = new Set(["h264_v4l2m2m", "libx264"]);
    expect(selectVideoEncoder(encoders, "linux")).toEqual({
      encoder: "h264_v4l2m2m",
      hardware: true,
    });
  });

  it("falls back to software, and says so", () => {
    // The flag is what decides whether preset flags are passed; a hardware
    // encoder rejects them outright.
    expect(selectVideoEncoder(new Set(["libx264"]), "linux")).toEqual({
      encoder: "libx264",
      hardware: false,
    });
  });

  it("still names an encoder on a build with neither", () => {
    expect(selectVideoEncoder(new Set(), "linux").encoder).toBe("h264");
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
