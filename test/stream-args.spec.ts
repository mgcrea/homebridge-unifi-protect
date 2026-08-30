/**
 * The ffmpeg command lines.
 *
 * This is where the real decisions live — copy versus transcode, which filters
 * and flags, what ffmpeg is told about SRTP and TLS — so it is written as pure
 * functions and asserted directly. None of it would be testable if it only
 * existed inside a call to `spawn`.
 */
import { describe, expect, it } from "vitest";

import { H264Level, H264Profile } from "#media/hap";
import {
  audioArgs,
  canCopyVideo,
  inputArgs,
  snapshotArgs,
  srtpParams,
  streamArgs,
  tlsInputArgs,
  videoArgs,
  type StreamTarget,
  type VideoRequest,
} from "#media/stream-args";
import { FAKE_CODECS } from "./fake-hap.js";

const CODECS = FAKE_CODECS as never;
const HARDWARE = { ...FAKE_CODECS, videoEncoder: "h264_videotoolbox", hardware: true } as never;
const NO_AUDIO = { ...FAKE_CODECS, audioEncoder: undefined } as never;

const channel = (width: number, height: number) => ({
  id: 0,
  name: "high",
  width,
  height,
  fps: 30,
  isRtspEnabled: true,
  rtspAlias: "abc",
});

const target: StreamTarget = {
  address: "192.168.1.50",
  port: 50_000,
  localPort: 60_000,
  srtpKey: Buffer.alloc(16, 1),
  srtpSalt: Buffer.alloc(14, 2),
  ssrc: 12_345,
  payloadType: 99,
  mtu: 1378,
};

const request: VideoRequest = {
  width: 1920,
  height: 1080,
  fps: 30,
  maxBitrateKbps: 2000,
  profile: H264Profile.HIGH,
  level: H264Level.LEVEL4_0,
};

/** The value of the flag immediately following `flag`, if present. */
const valueOf = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

describe("srtpParams", () => {
  it("concatenates the key and salt into the one blob ffmpeg wants", () => {
    const params = srtpParams(Buffer.alloc(16, 1), Buffer.alloc(14, 2));
    const decoded = Buffer.from(params, "base64");
    expect(decoded).toHaveLength(30);
    expect(decoded.subarray(0, 16).every((byte) => byte === 1)).toBe(true);
    expect(decoded.subarray(16).every((byte) => byte === 2)).toBe(true);
  });
});

describe("tlsInputArgs", () => {
  it("verifies against the pinned certificate when one is usable", () => {
    expect(tlsInputArgs({ url: "rtsps://host/a", caFile: "/tmp/console.pem" })).toEqual([
      "-ca_file",
      "/tmp/console.pem",
    ]);
  });

  it("turns verification off when there is no anchor ffmpeg can use", () => {
    // The console's certificate has no IP SAN and ffmpeg cannot pin by
    // fingerprint, so addressing by IP leaves no way to verify. No credentials
    // cross this connection.
    expect(tlsInputArgs({ url: "rtsps://10.0.0.1/a" })).toEqual(["-tls_verify", "0"]);
  });
});

describe("inputArgs", () => {
  it("frames RTSP over TCP", () => {
    // Over UDP a busy console drops packets and the picture tears in a way
    // that reads as a camera fault.
    expect(valueOf(inputArgs({ url: "rtsps://host/a" }), "-rtsp_transport")).toBe("tcp");
  });

  it("puts the URL last, after the input options that apply to it", () => {
    const args = inputArgs({ url: "rtsps://host/a" });
    expect(args.at(-2)).toBe("-i");
    expect(args.at(-1)).toBe("rtsps://host/a");
  });
});

describe("canCopyVideo", () => {
  it("copies only on an exact size match", () => {
    expect(canCopyVideo(channel(1920, 1080), request)).toBe(true);
    expect(canCopyVideo(channel(3840, 2160), request)).toBe(false);
    expect(canCopyVideo(channel(1920, 1088), request)).toBe(false);
  });
});

describe("videoArgs", () => {
  it("copies the camera's stream when the size already matches", () => {
    // A few percent of one core versus most of one, per stream.
    const args = videoArgs({ channel: channel(1920, 1080), request, target, codecs: CODECS });
    expect(valueOf(args, "-codec:v")).toBe("copy");
    expect(args).not.toContain("-filter:v");
    expect(args).not.toContain("-b:v");
  });

  it("does not impose a profile or bitrate on a copied stream", () => {
    // Those flags apply to an encoder; with `copy` there is none, and ffmpeg
    // either ignores them or fails depending on the build.
    const args = videoArgs({ channel: channel(1920, 1080), request, target, codecs: CODECS });
    expect(args).not.toContain("-profile:v");
    expect(args).not.toContain("-level:v");
  });

  it("transcodes when the sizes differ", () => {
    const args = videoArgs({ channel: channel(3840, 2160), request, target, codecs: CODECS });
    expect(valueOf(args, "-codec:v")).toBe("libx264");
    expect(valueOf(args, "-profile:v")).toBe("high");
    expect(valueOf(args, "-level:v")).toBe("4.0");
    expect(valueOf(args, "-b:v")).toBe("2000k");
  });

  it("scales without distorting and rounds to even dimensions", () => {
    // H.264 cannot encode an odd width or height, and ffmpeg fails rather than
    // rounding for you.
    const filter = valueOf(
      videoArgs({ channel: channel(3840, 2160), request, target, codecs: CODECS }),
      "-filter:v",
    );
    expect(filter).toContain("force_original_aspect_ratio=decrease");
    expect(filter).toContain("scale=trunc(iw/2)*2:trunc(ih/2)*2");
  });

  it("passes software presets only to a software encoder", () => {
    // A hardware encoder rejects them outright and the stream never starts.
    const software = videoArgs({ channel: channel(3840, 2160), request, target, codecs: CODECS });
    expect(valueOf(software, "-preset")).toBe("veryfast");

    const hardware = videoArgs({ channel: channel(3840, 2160), request, target, codecs: HARDWARE });
    expect(hardware).not.toContain("-preset");
    expect(valueOf(hardware, "-codec:v")).toBe("h264_videotoolbox");
  });

  it("forces regular keyframes so the picture appears promptly", () => {
    // Protect's own interval runs to five seconds, which reads as a stream
    // that failed to start.
    const args = videoArgs({ channel: channel(3840, 2160), request, target, codecs: CODECS });
    expect(valueOf(args, "-force_key_frames")).toBe("expr:gte(t,n_forced*1)");
  });

  it("sends to HomeKit's port with RTCP multiplexed onto it", () => {
    const url = videoArgs({ channel: channel(1920, 1080), request, target, codecs: CODECS }).at(-1);
    expect(url).toContain("srtp://192.168.1.50:50000");
    expect(url).toContain("rtcpport=50000");
    expect(url).toContain("pkt_size=1378");
  });

  it("sends from the local port it told HomeKit about", () => {
    // Makes the advertisement true, so the controller sees RTP arriving from
    // the port it was told to expect.
    const url = videoArgs({ channel: channel(1920, 1080), request, target, codecs: CODECS }).at(-1);
    expect(url).toContain("localrtpport=60000");
  });

  it("does not pin the local RTCP port to the same value as the RTP one", () => {
    // ffmpeg binds them separately: giving both the same port makes it bind
    // that port twice and the stream fails to open with "Address already in
    // use". Verified against ffmpeg 8.1.
    const url = videoArgs({ channel: channel(1920, 1080), request, target, codecs: CODECS }).at(-1);
    expect(url).not.toContain("localrtcpport");
  });
});

describe("audioArgs", () => {
  const audioRequest = { samplerateKhz: 24, maxBitrateKbps: 24, packetTime: 30 };

  it("encodes the AAC-ELD profile HomeKit negotiates", () => {
    const args = audioArgs({ request: audioRequest, target, codecs: CODECS });
    expect(valueOf(args, "-codec:a")).toBe("libfdk_aac");
    expect(valueOf(args, "-profile:a")).toBe("aac_eld");
    expect(valueOf(args, "-ar")).toBe("24k");
  });

  it("tolerates a camera with its microphone switched off", () => {
    // A hard `0:a` mapping makes ffmpeg fail the whole command rather than
    // send video without sound.
    expect(valueOf(audioArgs({ request: audioRequest, target, codecs: CODECS }), "-map")).toBe(
      "0:a:0?",
    );
  });

  it("produces nothing at all when the host cannot encode AAC-ELD", () => {
    expect(audioArgs({ request: audioRequest, target, codecs: NO_AUDIO })).toEqual([]);
  });

  it("uses a small packet size, not the video MTU", () => {
    // Batching several packet-times into one datagram adds latency for no gain.
    const url = audioArgs({ request: audioRequest, target, codecs: CODECS }).at(-1);
    expect(url).toContain("pkt_size=188");
  });
});

describe("streamArgs", () => {
  it("puts the input first and both outputs after it", () => {
    const args = streamArgs({
      input: { url: "rtsps://10.0.0.1:7441/abc?enableSrtp" },
      channel: channel(1920, 1080),
      video: { request, target },
      audio: { request: { samplerateKhz: 16, maxBitrateKbps: 24, packetTime: 30 }, target },
      codecs: CODECS,
    });

    expect(args.indexOf("-i")).toBeLessThan(args.indexOf("-codec:v"));
    expect(args.indexOf("-codec:v")).toBeLessThan(args.indexOf("-codec:a"));
  });

  it("produces a video-only command when no audio was asked for", () => {
    const args = streamArgs({
      input: { url: "rtsps://10.0.0.1:7441/abc" },
      channel: channel(1920, 1080),
      video: { request, target },
      codecs: CODECS,
    });
    expect(args).not.toContain("-codec:a");
  });
});

describe("snapshotArgs", () => {
  it("asks for exactly one frame as JPEG on stdout", () => {
    const args = snapshotArgs({ input: { url: "rtsps://host/a" }, width: 640, height: 360 });
    expect(valueOf(args, "-frames:v")).toBe("1");
    expect(valueOf(args, "-codec:v")).toBe("mjpeg");
    expect(args.at(-1)).toBe("-");
  });
});
