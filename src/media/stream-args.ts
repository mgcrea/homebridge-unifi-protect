import type { CameraChannel } from "@mgcrea/unifi-protect";

import { ffmpegLevel, ffmpegProfile, type H264Level, type H264Profile } from "#media/hap";
import type { CodecSupport } from "#media/codecs";

/**
 * Every ffmpeg command line the plugin produces.
 *
 * Pure on purpose. Argument construction is where the real decisions live —
 * whether to copy or transcode, which filters to apply, what to tell ffmpeg
 * about SRTP — and none of it can be tested if it only exists inside a call to
 * `spawn`. Spawning lives in `ffmpeg.ts` and does no thinking.
 */

export type StreamTarget = {
  address: string;
  port: number;
  /** HomeKit's key and salt, which ffmpeg wants as one base64 blob. */
  srtpKey: Buffer;
  srtpSalt: Buffer;
  ssrc: number;
  payloadType: number;
  /** HomeKit's negotiated MTU. Oversized packets are dropped, not fragmented. */
  mtu: number;
  /**
   * The port on this host that ffmpeg sends RTP from.
   *
   * It is the port advertised to HomeKit during preparation, so pinning it
   * makes that advertisement true: the controller sees RTP arriving from the
   * address and port it was told to expect, which is what lets it work through
   * NAT and what stricter controllers check.
   *
   * Only the RTP port is pinned. ffmpeg binds RTCP to the next port up, so
   * setting both to one value makes it bind the same port twice and the stream
   * fails to open with "Address already in use" — which is why the allocator
   * hands out even ports and treats the odd neighbour as spoken for.
   *
   * The consequence, and the reason this is acceptable for one-way video: the
   * controller's RTCP receiver reports land on the RTP socket and are ignored.
   * Consuming them needs a socket of our own between ffmpeg and HomeKit, which
   * is work that only pays for itself alongside two-way audio.
   */
  localPort: number;
};

export type VideoRequest = {
  width: number;
  height: number;
  fps: number;
  maxBitrateKbps: number;
  profile: H264Profile;
  level: H264Level;
};

export type AudioRequest = {
  /** Sample rate in kHz, as HomeKit expresses it. */
  samplerateKhz: number;
  maxBitrateKbps: number;
  packetTime: number;
};

/** ffmpeg takes the SRTP key and salt concatenated and base64-encoded. */
export const srtpParams = (key: Buffer, salt: Buffer): string =>
  Buffer.concat([key, salt]).toString("base64");

/**
 * Whether the channel can be sent to HomeKit untouched.
 *
 * Copying is worth a great deal of care: it is a few percent of one core versus
 * most of one per stream, and on a Raspberry Pi it is the difference between
 * two cameras working and none. The condition is exact-size only — HomeKit
 * negotiated a resolution from a list that already contains the camera's own
 * channel sizes, so an exact match is the common case rather than a lucky one.
 */
export const canCopyVideo = (channel: CameraChannel, request: VideoRequest): boolean =>
  channel.width === request.width && channel.height === request.height;

export type InputOptions = {
  url: string;
  /**
   * A PEM to verify the console's RTSPS certificate against, when verification
   * is possible at all. See `tlsInputArgs`.
   */
  caFile?: string | undefined;
};

/**
 * How ffmpeg is told to trust the console's media connection.
 *
 * This is the one place the plugin's certificate pinning cannot reach. The
 * console's certificate has no IP SAN, and ffmpeg offers no way to pin by
 * fingerprint — only `-ca_file`, which still runs the host name check. So when
 * the console is addressed by name, the pinned certificate is handed to ffmpeg
 * as its trust anchor and verification is real; when it is addressed by IP, as
 * most installs do, the name check cannot pass and verification has to be off.
 *
 * What that does and does not cost is worth being precise about: no credentials
 * cross this connection. The RTSP alias in the URL is a per-channel bearer
 * token, and the media itself is separately encrypted by `enableSrtp`. It is
 * still weaker than the API path, and the way to close it is to address the
 * console by a host name that resolves to it.
 */
export const tlsInputArgs = (options: InputOptions): string[] =>
  options.caFile ? ["-ca_file", options.caFile] : ["-tls_verify", "0"];

export const inputArgs = (options: InputOptions): string[] => [
  "-hide_banner",
  "-nostats",
  "-loglevel",
  "error",
  // Protect's RTSPS is TCP-framed. Over UDP a busy console drops packets and
  // the picture tears in a way that reads as a camera fault.
  "-rtsp_transport",
  "tcp",
  ...tlsInputArgs(options),
  "-i",
  options.url,
];

const targetArgs = (target: StreamTarget, pktSize: number): string[] => [
  "-payload_type",
  String(target.payloadType),
  "-ssrc",
  String(target.ssrc),
  "-f",
  "rtp",
  "-srtp_out_suite",
  "AES_CM_128_HMAC_SHA1_80",
  "-srtp_out_params",
  srtpParams(target.srtpKey, target.srtpSalt),
  // HomeKit multiplexes RTCP onto its RTP port, so `rtcpport` matches. On this
  // side only the RTP port is pinned; see the note on `localPort`.
  `srtp://${target.address}:${target.port}?rtcpport=${target.port}` +
    `&localrtpport=${target.localPort}&pkt_size=${pktSize}`,
];

export const videoArgs = (options: {
  channel: CameraChannel;
  request: VideoRequest;
  target: StreamTarget;
  codecs: CodecSupport;
}): string[] => {
  const { request, target, codecs } = options;
  const head = ["-map", "0:v:0", "-an", "-sn", "-dn"];

  if (canCopyVideo(options.channel, request)) {
    return [...head, "-codec:v", "copy", ...targetArgs(target, target.mtu)];
  }

  return [
    ...head,
    "-codec:v",
    codecs.videoEncoder,
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    ffmpegProfile(request.profile),
    "-level:v",
    ffmpegLevel(request.level),
    // A hardware encoder rejects the software presets outright; a software one
    // needs to be told to favour latency over ratio or it buffers seconds of
    // video before emitting anything.
    ...(codecs.hardware ? [] : ["-preset", "veryfast", "-tune", "zerolatency"]),
    "-filter:v",
    // Fit inside the requested box without distorting, then round to even
    // dimensions — H.264 cannot encode an odd width or height, and ffmpeg fails
    // rather than rounding for you.
    `scale=${request.width}:${request.height}:force_original_aspect_ratio=decrease,` +
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-r",
    String(request.fps),
    "-b:v",
    `${request.maxBitrateKbps}k`,
    "-maxrate",
    `${request.maxBitrateKbps}k`,
    "-bufsize",
    `${request.maxBitrateKbps * 2}k`,
    // Without a forced keyframe interval the viewer waits for the camera's own
    // — up to five seconds on Protect — before the first frame appears, which
    // reads as a stream that failed to start.
    "-force_key_frames",
    "expr:gte(t,n_forced*1)",
    ...targetArgs(target, target.mtu),
  ];
};

export const audioArgs = (options: {
  request: AudioRequest;
  target: StreamTarget;
  codecs: CodecSupport;
}): string[] => {
  const { request, target, codecs } = options;
  if (!codecs.audioEncoder) return [];

  return [
    // `0:a?` rather than `0:a`: a camera with its microphone switched off has no
    // audio stream at all, and a hard mapping makes ffmpeg fail the whole
    // command rather than send video without sound.
    "-map",
    "0:a:0?",
    "-vn",
    "-sn",
    "-dn",
    "-codec:a",
    codecs.audioEncoder,
    "-profile:a",
    "aac_eld",
    "-ac",
    "1",
    "-ar",
    `${request.samplerateKhz}k`,
    "-b:a",
    `${request.maxBitrateKbps}k`,
    "-flags",
    "+global_header",
    // RTP audio packets are small; the video MTU would let ffmpeg batch several
    // packet-times into one datagram and add latency to the talk path.
    ...targetArgs(target, 188),
  ];
};

/** The whole live-stream command. */
export const streamArgs = (options: {
  input: InputOptions;
  channel: CameraChannel;
  video: { request: VideoRequest; target: StreamTarget };
  audio?: { request: AudioRequest; target: StreamTarget } | undefined;
  codecs: CodecSupport;
}): string[] => [
  ...inputArgs(options.input),
  ...videoArgs({
    channel: options.channel,
    request: options.video.request,
    target: options.video.target,
    codecs: options.codecs,
  }),
  ...(options.audio
    ? audioArgs({
        request: options.audio.request,
        target: options.audio.target,
        codecs: options.codecs,
      })
    : []),
];

/** Pull a single JPEG frame from the live stream. */
export const snapshotArgs = (options: {
  input: InputOptions;
  width: number;
  height: number;
}): string[] => [
  ...inputArgs(options.input),
  "-frames:v",
  "1",
  "-filter:v",
  `scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease`,
  "-f",
  "image2",
  "-codec:v",
  "mjpeg",
  "-",
];
