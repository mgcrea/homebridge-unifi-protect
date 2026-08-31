/**
 * Two-way audio: the SDP handed to ffmpeg, the arguments it runs with, and the
 * splitter that lets two processes share one UDP port.
 */
import { createSocket } from "node:dgram";
import { describe, expect, it } from "vitest";

import { RtpSplitter } from "#media/rtp/splitter";
import { eldConfig, talkbackArgs, talkbackSdp } from "#media/talkback-args";
import { hasTwoWayAudio, talkbackTarget, zCamera } from "@mgcrea/unifi-protect";

const STREAM = {
  localPort: 5000,
  payloadType: 110,
  samplerateKhz: 16,
  srtpKey: Buffer.alloc(16, 1),
  srtpSalt: Buffer.alloc(14, 2),
};

const TARGET = {
  host: "192.168.6.27",
  port: 7004,
  format: "aac",
  sampleRate: 22050,
  channels: 1,
};

describe("talkbackSdp", () => {
  it("describes the stream on the port the splitter forwards to", () => {
    expect(talkbackSdp(STREAM)).toContain("m=audio 5000 RTP/AVP 110");
  });

  it("carries the SRTP key as one base64 blob of key and salt", () => {
    // ffmpeg wants them concatenated, not as two fields; splitting them gets a
    // stream that decrypts to noise.
    const key = Buffer.concat([STREAM.srtpKey, STREAM.srtpSalt]).toString("base64");
    expect(talkbackSdp(STREAM)).toContain(`inline:${key}`);
  });

  it("states the AAC-ELD configuration, which ffmpeg cannot infer", () => {
    expect(talkbackSdp(STREAM)).toContain("config=F8F0212C00BC00");
    expect(talkbackSdp({ ...STREAM, samplerateKhz: 24 })).toContain("config=F8F8212C00BC00");
  });

  it("falls back to the 16kHz configuration for a rate HomeKit has never sent", () => {
    expect(eldConfig(48)).toBe(eldConfig(16));
  });

  it("uses the negotiated rate in the rtpmap", () => {
    expect(talkbackSdp({ ...STREAM, samplerateKhz: 24 })).toContain(
      "a=rtpmap:110 MPEG4-GENERIC/24000/1",
    );
  });

  it("ends every line the way SDP requires", () => {
    // A bare \n is accepted by some parsers and not by ffmpeg's.
    const lines = talkbackSdp(STREAM).split("\r\n");
    expect(lines.length).toBeGreaterThan(8);
    expect(talkbackSdp(STREAM)).not.toMatch(/[^\r]\n/);
  });
});

describe("talkbackArgs", () => {
  const args = talkbackArgs({
    stream: STREAM,
    target: TARGET,
    audioDecoder: "libfdk_aac",
    audioEncoder: "aac",
  });

  it("reads the SDP from stdin, so the SRTP key never reaches disk or the process list", () => {
    expect(args).toContain("pipe:0");
    expect(args.join(" ")).not.toContain("inline:");
  });

  it("decodes with libfdk_aac, the only thing that reads HomeKit's ELD", () => {
    // ffmpeg's native AAC decoder fails on the ELD profile with "Not yet
    // implemented in FFmpeg, patches welcome" — verified against ffmpeg 8,
    // and it reads like a plugin bug rather than a missing codec.
    expect(args[args.indexOf("-acodec") + 1]).toBe("libfdk_aac");
    expect(args.indexOf("-acodec")).toBeLessThan(args.indexOf("-i"));
  });

  it("whitelists the protocols the SDP names", () => {
    // Without it ffmpeg refuses with "Protocol not on whitelist" and does not
    // say which protocol it meant.
    const whitelist = args[args.indexOf("-protocol_whitelist") + 1]!;
    for (const protocol of ["pipe", "udp", "rtp", "crypto"]) {
      expect(whitelist).toContain(protocol);
    }
  });

  it("resamples to what the camera asked for, not what HomeKit sent", () => {
    // Sending 16kHz audio to a speaker expecting 22050 plays it at the wrong
    // pitch rather than failing, which is a confusing way to be wrong.
    expect(args[args.indexOf("-ar") + 1]).toBe("22050");
  });

  it("sends a bare ADTS stream to the camera over UDP", () => {
    expect(args[args.indexOf("-f", args.indexOf("-codec:a")) + 1]).toBe("adts");
    expect(args.at(-1)).toBe("udp://192.168.6.27:7004");
  });
});

const rtcp = (): Buffer => Buffer.from([0x80, 200, 0, 0]);
const audio = (): Buffer => Buffer.from([0x80, 110, 0, 0, 1, 2, 3, 4]);

/** A socket bound to an ephemeral port, plus a promise for its first packet. */
const receiver = async (): Promise<{ port: number; next: Promise<Buffer>; close: () => void }> => {
  const socket = createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, resolve));
  const next = new Promise<Buffer>((resolve) => socket.once("message", resolve));
  return {
    port: (socket.address() as { port: number }).port,
    next,
    close: () => socket.close(),
  };
};

describe("RtpSplitter", () => {
  it("tells RTCP from audio by payload type", () => {
    expect(RtpSplitter.isRtcp(rtcp())).toBe(true);
    expect(RtpSplitter.isRtcp(Buffer.from([0x80, 204, 0, 0]))).toBe(true);
    expect(RtpSplitter.isRtcp(audio())).toBe(false);
  });

  it("ignores a packet too short to classify", () => {
    expect(RtpSplitter.isRtcp(Buffer.from([0x80]))).toBe(false);
  });

  it("sends RTCP one way and audio the other", async () => {
    const control = await receiver();
    const voice = await receiver();
    const splitter = await RtpSplitter.bind(0);
    splitter.forwardRtcpTo(control.port);
    splitter.forwardAudioTo(voice.port);

    const sender = createSocket("udp4");
    sender.send(rtcp(), splitter.port, "127.0.0.1");
    sender.send(audio(), splitter.port, "127.0.0.1");

    expect(await control.next).toEqual(rtcp());
    expect(await voice.next).toEqual(audio());

    splitter.close();
    sender.close();
    control.close();
    voice.close();
  });

  it("drops what it has nowhere to send, rather than throwing", async () => {
    // A stream with no talkback leg still gets RTCP, and vice versa. The
    // splitter must not fall over on a packet it has no destination for.
    const splitter = await RtpSplitter.bind(0);
    const sender = createSocket("udp4");
    sender.send(audio(), splitter.port, "127.0.0.1");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(splitter.port).toBeGreaterThan(0);

    splitter.close();
    sender.close();
  });

  it("can be closed twice", async () => {
    const splitter = await RtpSplitter.bind(0);
    splitter.close();
    expect(() => splitter.close()).not.toThrow();
  });
});

describe("who gets a talkback leg", () => {
  it("is decided by the speaker flag, not by talkbackSettings alone", () => {
    // Every camera carries talkbackSettings, speaker or not — a UVC G3 reports
    // typeIn "serverudp" and a bindPort exactly like a G4 Instant does. Reading
    // only those put a splitter on the audio port of every camera in the house,
    // moved the outgoing audio to a different local port, and killed the live
    // stream two seconds in on cameras that never did two-way audio.
    const SETTINGS = { typeFmt: "aac", typeIn: "serverudp", bindPort: 7004, samplingRate: 22050 };

    const speaker = zCamera.parse({
      id: "a",
      modelKey: "camera",
      mac: "AA",
      host: "192.168.6.27",
      featureFlags: { hasSpeaker: true },
      talkbackSettings: SETTINGS,
    });
    const noSpeaker = zCamera.parse({
      id: "b",
      modelKey: "camera",
      mac: "BB",
      host: "192.168.6.92",
      featureFlags: { hasSpeaker: false },
      talkbackSettings: SETTINGS,
    });

    // talkbackTarget answers "where would it go", which is not the same
    // question as "does anything there play it".
    expect(talkbackTarget(noSpeaker)).toBeDefined();
    expect(hasTwoWayAudio(noSpeaker)).toBe(false);
    expect(hasTwoWayAudio(speaker)).toBe(true);
  });
});
