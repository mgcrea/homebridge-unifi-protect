import { describe, expect, it } from "vitest";

import { AudioRecordingCodec, H264Level, H264Profile } from "#media/hap";
import {
  canCopyRecording,
  containerArgs,
  idrMatches,
  recordingArgs,
  recordingAudioArgs,
  recordingVideoArgs,
  type RecordingRequest,
} from "#media/recording-args";
import { FAKE_CODECS } from "./fake-hap.js";

const CODECS = FAKE_CODECS as never;
const NO_FDK = { ...FAKE_CODECS, audioEncoder: undefined } as never;

const channel = (over: Record<string, unknown> = {}) => ({
  id: 0,
  name: "high",
  width: 1920,
  height: 1080,
  fps: 30,
  idrInterval: 4,
  isRtspEnabled: true,
  rtspAlias: "abc",
  ...over,
});

const request: RecordingRequest = {
  width: 1920,
  height: 1080,
  fps: 30,
  profile: H264Profile.HIGH,
  level: H264Level.LEVEL4_0,
  bitrateKbps: 2000,
  fragmentLengthMs: 4000,
  iFrameIntervalMs: 4000,
  audio: { codec: AudioRecordingCodec.AAC_LC, samplerate: 3, bitrateKbps: 32 },
};

const valueOf = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

describe("idrMatches", () => {
  it("accepts an interval that divides the fragment length", () => {
    // A 2s interval puts a keyframe at 0s, 2s, 4s… so every 4s boundary is one.
    // Measured: a 2s source with -min_frag_duration yields exactly 4.00s
    // fragments. This is why Protect's stock medium channels record by copying
    // with nothing changed on the console.
    expect(idrMatches(channel({ idrInterval: 4 }), request)).toBe(true);
    expect(idrMatches(channel({ idrInterval: 2 }), request)).toBe(true);
    expect(idrMatches(channel({ idrInterval: 1 }), request)).toBe(true);
  });

  it("rejects one that does not divide it", () => {
    // Measured: a 5s source yields 5.00s fragments where 4s was negotiated, so
    // that channel has to be re-encoded rather than copied.
    expect(idrMatches(channel({ idrInterval: 5 }), request)).toBe(false);
    expect(idrMatches(channel({ idrInterval: 3 }), request)).toBe(false);
  });

  it("rejects a camera that reports no interval at all", () => {
    expect(idrMatches(channel({ idrInterval: undefined }), request)).toBe(false);
    expect(idrMatches(channel({ idrInterval: 0 }), request)).toBe(false);
  });
});

describe("canCopyRecording", () => {
  it("copies when both the size and the keyframe interval line up", () => {
    expect(canCopyRecording(channel(), request)).toBe(true);
  });

  it("re-encodes when the size differs", () => {
    expect(canCopyRecording(channel({ width: 3840, height: 2160 }), request)).toBe(false);
  });

  it("re-encodes when the keyframes fall in the wrong places", () => {
    // The trap: the picture is the right size, so a size-only check would copy
    // and hand HomeKit fragments of a length it never asked for.
    expect(canCopyRecording(channel({ idrInterval: 5 }), request)).toBe(false);
  });

  it("copies a stock Protect medium channel without anything being changed", () => {
    // The case that matters in practice: 2s is what Protect ships, and it
    // divides the 4s HomeKit asks for.
    expect(canCopyRecording(channel({ idrInterval: 2 }), request)).toBe(true);
  });
});

describe("containerArgs", () => {
  it("spells the fragment flag the way ffmpeg accepts", () => {
    // `default_base_is_moof` is what circulates and ffmpeg rejects it outright,
    // with an error naming an expression parser rather than the flag.
    const flags = valueOf(containerArgs(request), "-movflags");
    expect(flags).toContain("default_base_moof");
    expect(flags).not.toContain("default_base_is_moof");
  });

  it("puts the initialisation segment up front, where a live pipe can reach it", () => {
    expect(valueOf(containerArgs(request), "-movflags")).toContain("empty_moov");
  });

  it("cuts fragments at keyframes", () => {
    expect(valueOf(containerArgs(request), "-movflags")).toContain("frag_keyframe");
  });

  it("suppresses the index, which is meaningless in a stream that never ends", () => {
    expect(valueOf(containerArgs(request), "-movflags")).toContain("skip_trailer");
  });

  it("sets a MINIMUM fragment duration, not a target", () => {
    // The distinction decides whether the plugin has to reconfigure somebody's
    // cameras. `frag_keyframe` alone cuts at every keyframe, so a 2s camera
    // gives 2s fragments however long a `-frag_duration` asks for;
    // `-min_frag_duration` cuts at the first keyframe at or after the target and
    // turns the same camera into exact 4.00s fragments.
    expect(valueOf(containerArgs(request), "-min_frag_duration")).toBe("4000000");
    expect(containerArgs(request)).not.toContain("-frag_duration");
  });

  it("writes to stdout", () => {
    expect(containerArgs(request).at(-1)).toBe("pipe:1");
  });
});

describe("recordingVideoArgs", () => {
  it("copies when it can", () => {
    const args = recordingVideoArgs({ channel: channel(), request, codecs: CODECS });
    expect(valueOf(args, "-codec:v")).toBe("copy");
    expect(args).not.toContain("-force_key_frames");
  });

  it("forces keyframes onto the fragment boundary when re-encoding", () => {
    // Otherwise ffmpeg cuts wherever the encoder put one, and the clips come
    // out a length HomeKit did not ask for.
    const args = recordingVideoArgs({
      channel: channel({ width: 3840, height: 2160 }),
      request,
      codecs: CODECS,
    });
    expect(valueOf(args, "-force_key_frames")).toBe("expr:gte(t,n_forced*4)");
  });
});

describe("recordingAudioArgs", () => {
  it("records AAC-LC with the built-in encoder when libfdk_aac is absent", () => {
    // The find that matters for a plain ffmpeg build: HKSV accepts AAC-LC,
    // where live streaming only ever negotiates AAC-ELD. So a host that
    // streams silently still records with sound.
    const args = recordingAudioArgs({ request, codecs: NO_FDK });
    expect(valueOf(args, "-codec:a")).toBe("aac");
    expect(valueOf(args, "-profile:a")).toBe("aac_low");
  });

  it("produces nothing for AAC-ELD without libfdk_aac, rather than a stream nobody can play", () => {
    const eld = { ...request, audio: { ...request.audio, codec: AudioRecordingCodec.AAC_ELD } };
    expect(recordingAudioArgs({ request: eld, codecs: NO_FDK })).toEqual([]);
  });

  it("turns the samplerate index into an actual rate", () => {
    // HomeKit sends an enum index, not hertz; sending `3` to ffmpeg would be a
    // 3 Hz stream.
    expect(valueOf(recordingAudioArgs({ request, codecs: CODECS }), "-ar")).toBe("32000");
  });

  it("tolerates a camera whose microphone is off", () => {
    expect(valueOf(recordingAudioArgs({ request, codecs: CODECS }), "-map")).toBe("0:a:0?");
  });
});

describe("recordingArgs", () => {
  it("orders input, video, audio, container", () => {
    const args = recordingArgs({
      input: { url: "rtsps://10.0.0.1:7441/abc" },
      channel: channel(),
      request,
      codecs: CODECS,
    });
    expect(args.indexOf("-i")).toBeLessThan(args.indexOf("-codec:v"));
    expect(args.indexOf("-codec:v")).toBeLessThan(args.indexOf("-codec:a"));
    expect(args.at(-1)).toBe("pipe:1");
  });

  it("records silently for a camera with no microphone", () => {
    const args = recordingArgs({
      input: { url: "rtsps://10.0.0.1:7441/abc" },
      channel: channel(),
      request,
      codecs: CODECS,
      withoutAudio: true,
    });
    expect(args).toContain("-an");
    expect(args).not.toContain("-codec:a");
  });
});
