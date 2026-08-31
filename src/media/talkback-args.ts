import type { TalkbackTarget } from "@mgcrea/unifi-protect";

/**
 * Two-way audio: what HomeKit sends back, and where the camera wants it.
 *
 * The direction that already works is easy — one ffmpeg reads RTSPS and writes
 * SRTP. This is the other one, and it is harder for a reason that is not
 * obvious: HomeKit sends its audio to the SAME UDP port it expects ours to
 * arrive from, so a second ffmpeg cannot simply bind that port and listen.
 * `RtpSplitter` owns the port; this module builds what the receiving ffmpeg is
 * told once the splitter is forwarding to it.
 */

export type TalkbackStream = {
  /** Where the splitter forwards HomeKit's audio to. */
  localPort: number;
  /** The payload type HomeKit negotiated for its return audio. */
  payloadType: number;
  /** 8, 16 or 24, as HomeKit reports it. */
  samplerateKhz: number;
  srtpKey: Buffer;
  srtpSalt: Buffer;
};

/**
 * The AAC-ELD configuration bytes for a sample rate.
 *
 * ffmpeg cannot infer these from the SDP and refuses the stream without them.
 * They are the AudioSpecificConfig for ELD mono at each rate HomeKit offers —
 * the same three values every HomeKit camera implementation carries, because
 * HomeKit only ever negotiates these three.
 */
const ELD_CONFIG: Record<number, string> = {
  8: "F8E0212C00BC00",
  16: "F8F0212C00BC00",
  24: "F8F8212C00BC00",
};

export const eldConfig = (samplerateKhz: number): string =>
  ELD_CONFIG[samplerateKhz] ?? ELD_CONFIG[16]!;

/**
 * The SDP describing HomeKit's return audio, fed to ffmpeg on stdin.
 *
 * It goes in on stdin rather than a file because it carries the session's SRTP
 * key: a file would put the key on disk, and ffmpeg's own `-i` argument would
 * put it in the process list where any user on the box can read it.
 */
export const talkbackSdp = (stream: TalkbackStream): string => {
  const key = Buffer.concat([stream.srtpKey, stream.srtpSalt]).toString("base64");

  return [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=HomeKit Talkback",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    `m=audio ${stream.localPort} RTP/AVP ${stream.payloadType}`,
    "b=AS:24",
    `a=rtpmap:${stream.payloadType} MPEG4-GENERIC/${stream.samplerateKhz * 1000}/1`,
    `a=fmtp:${stream.payloadType} profile-level-id=38; constantDuration=480; streamtype=5; ` +
      `mode=AAC-hbr; config=${eldConfig(stream.samplerateKhz)}`,
    `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${key}`,
    "",
  ].join("\r\n");
};

/**
 * ffmpeg's arguments for the talkback leg.
 *
 * The camera wants a bare ADTS stream over UDP — no RTP, no session, nothing to
 * negotiate — at whatever rate `talkbackSettings` reports, which is 22050 on
 * every model seen so far rather than any rate HomeKit uses. So this always
 * decodes and re-encodes; there is no copy path to take, and both ends of that
 * are constrained: only libfdk_aac reads HomeKit's ELD, and the camera wants
 * plain AAC-LC back.
 */
export const talkbackArgs = (options: {
  stream: TalkbackStream;
  target: TalkbackTarget;
  /**
   * The decoder for HomeKit's side. It has to be `libfdk_aac`: ffmpeg's native
   * AAC decoder cannot read the ELD profile HomeKit sends and fails with
   * "Not yet implemented in FFmpeg, patches welcome", which reads like a bug
   * in the plugin rather than a missing codec. Verified against ffmpeg 8.
   */
  audioDecoder: string;
  /** The encoder for the camera's side, which wants plain AAC-LC. */
  audioEncoder: string;
}): string[] => [
  "-hide_banner",
  "-nostats",
  "-loglevel",
  "error",
  // Without the whitelist ffmpeg refuses an SDP that names udp and srtp, and
  // says only "Protocol not on whitelist" with no hint which one.
  "-protocol_whitelist",
  "pipe,udp,rtp,crypto,data",
  // Before `-i`, so it applies to the input. The SDP names the codec but not
  // which implementation can decode it.
  "-acodec",
  options.audioDecoder,
  "-f",
  "sdp",
  "-i",
  "pipe:0",
  "-map",
  "0:a:0",
  "-vn",
  "-sn",
  "-dn",
  "-codec:a",
  options.audioEncoder,
  // The camera's own speaker settings, not HomeKit's. Sending it 16kHz when it
  // asked for 22050 produces audio at the wrong pitch rather than an error.
  "-ar",
  String(options.target.sampleRate),
  "-ac",
  String(options.target.channels),
  "-b:a",
  "16k",
  "-flags",
  "+global_header",
  "-f",
  "adts",
  `udp://${options.target.host}:${options.target.port}`,
];
