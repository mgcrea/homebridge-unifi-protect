import type { CameraChannel } from "@mgcrea/unifi-protect";

import type { CodecSupport } from "#media/codecs";
import {
  AudioRecordingCodec,
  ffmpegAudioProfile,
  ffmpegLevel,
  ffmpegProfile,
  recordingSamplerateHz,
  type H264Level,
  type H264Profile,
} from "#media/hap";
import { inputArgs, type InputOptions } from "#media/stream-args";

/**
 * The ffmpeg command that feeds HomeKit Secure Video.
 *
 * The shape of the output is the whole design. ffmpeg's mp4 muxer already
 * produces exactly what HKSV consumes — `ftyp moov` then `moof mdat` pairs —
 * so the plugin needs no muxer of its own, only the box splitter in
 * `mp4/boxes.ts`. Getting there needs three flags that are easy to get subtly
 * wrong, and one of them is spelled differently from how it is usually written
 * down; see `containerArgs`.
 */

export type RecordingRequest = {
  width: number;
  height: number;
  fps: number;
  profile: H264Profile;
  level: H264Level;
  bitrateKbps: number;
  /** How long each fragment must be, in milliseconds. Typically 4000. */
  fragmentLengthMs: number;
  /** HomeKit's requested keyframe interval, in milliseconds. */
  iFrameIntervalMs: number;
  audio: {
    /** `AudioRecordingCodecType`: AAC-LC or AAC-ELD. */
    codec: number;
    /** An `AudioRecordingSamplerate` index, not a rate. */
    samplerate: number;
    bitrateKbps: number;
  };
};

/**
 * Whether the camera's own stream can be recorded without re-encoding.
 *
 * Two conditions, and the second is the one that is easy to miss. The size has
 * to match, as it does for live streaming. But the fragments also have to come
 * out the length HomeKit asked for, and with `-codec:v copy` ffmpeg can only
 * cut a fragment at a keyframe the camera already produced — so the camera's
 * keyframe interval has to divide the fragment length. Protect exposes that
 * interval as `idrInterval` and lets it be set, which is what makes copying
 * without anything being changed on the console. See `idrMatches`.
 */
export const canCopyRecording = (channel: CameraChannel, request: RecordingRequest): boolean =>
  channel.width === request.width &&
  channel.height === request.height &&
  idrMatches(channel, request);

/**
 * Whether the camera's keyframes land on HomeKit's fragment boundaries.
 *
 * Divisibility, not equality: a 2s interval puts a keyframe at 0s, 2s, 4s… so
 * every 4s boundary is one. What makes that work is `-min_frag_duration`, which
 * tells ffmpeg to cut at the first keyframe *at or after* the target rather than
 * at every keyframe — see `containerArgs`. Measured: a 2s source yields exactly
 * 4.00s fragments, a 5s source yields 5.00s ones and so has to be re-encoded.
 *
 * This is why the plugin never reconfigures a camera. Protect's medium channels
 * ship at 2s, which divides the 4s HomeKit asks for, so the common case records
 * by copying with nothing on the console changed.
 *
 * Protect states `idrInterval` in seconds; HomeKit states fragments in
 * milliseconds.
 */
export const idrMatches = (channel: CameraChannel, request: RecordingRequest): boolean => {
  const idrMs = (channel.idrInterval ?? 0) * 1000;
  if (idrMs <= 0) return false;
  return request.fragmentLengthMs % idrMs === 0;
};

/**
 * The three flags that turn ffmpeg's mp4 muxer into an HKSV source.
 *
 * `empty_moov` puts the initialisation segment up front instead of at the end,
 * which a live pipe never reaches. `frag_keyframe` cuts fragments at keyframes,
 * so they start where a decoder can begin. `default_base_moof` makes each
 * fragment addressable on its own rather than relative to the file — without it
 * HomeKit cannot play a clip that starts mid-stream.
 *
 * That last flag is **`default_base_moof`**, not the `default_base_is_moof`
 * that circulates widely; ffmpeg rejects the longer spelling outright and the
 * error it gives ("Undefined constant or missing '('") names an expression
 * parser rather than the flag, so it is a genuinely expensive typo.
 *
 * `skip_trailer` suppresses the `mfra` index ffmpeg would otherwise append,
 * which is meaningless in a stream that never ends.
 *
 * The fragment length is set with **`-min_frag_duration`**, not `-frag_duration`.
 * The difference decides whether the plugin has to reconfigure the camera.
 * `frag_keyframe` alone cuts at *every* keyframe, so a 2s camera yields 2s
 * fragments however long a `-frag_duration` is asked for; `-min_frag_duration`
 * cuts at the first keyframe at or after the target, turning the same 2s camera
 * into exact 4.00s fragments. With the wrong one of the two, the only way to get
 * the negotiated length by copying is to change the camera's keyframe interval —
 * which is somebody's security system, not ours to reconfigure.
 */
export const containerArgs = (request: RecordingRequest): string[] => [
  "-f",
  "mp4",
  "-movflags",
  "frag_keyframe+empty_moov+default_base_moof+skip_trailer",
  // ffmpeg counts fragment duration in microseconds.
  "-min_frag_duration",
  String(request.fragmentLengthMs * 1000),
  "pipe:1",
];

export const recordingVideoArgs = (options: {
  channel: CameraChannel;
  request: RecordingRequest;
  codecs: CodecSupport;
}): string[] => {
  const { request, codecs } = options;
  const head = ["-map", "0:v:0"];

  if (canCopyRecording(options.channel, request)) {
    return [...head, "-codec:v", "copy"];
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
    ...(codecs.hardware ? [] : ["-preset", "veryfast"]),
    "-filter:v",
    `scale=${request.width}:${request.height}:force_original_aspect_ratio=decrease,` +
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-r",
    String(request.fps),
    "-b:v",
    `${request.bitrateKbps}k`,
    // Keyframes must land exactly on fragment boundaries, or ffmpeg cuts
    // fragments wherever the encoder happened to put one and HomeKit gets
    // clips whose length it did not ask for.
    "-force_key_frames",
    `expr:gte(t,n_forced*${request.fragmentLengthMs / 1000})`,
  ];
};

/**
 * Audio for a recording.
 *
 * Worth noting how this differs from live streaming: HKSV accepts **AAC-LC**,
 * which ffmpeg's built-in encoder produces, where a live stream only ever
 * negotiates AAC-ELD and needs libfdk_aac. So a host whose ffmpeg lacks
 * libfdk_aac still records with sound even though it streams silently.
 */
export const recordingAudioArgs = (options: {
  request: RecordingRequest;
  codecs: CodecSupport;
}): string[] => {
  const { request, codecs } = options;
  const wantsEld = request.audio.codec === AudioRecordingCodec.AAC_ELD;

  // Only libfdk_aac can produce AAC-ELD; the built-in encoder covers AAC-LC.
  const encoder = wantsEld ? codecs.audioEncoder : (codecs.audioEncoder ?? "aac");
  if (!encoder) return [];

  return [
    "-map",
    "0:a:0?",
    "-codec:a",
    encoder,
    "-profile:a",
    ffmpegAudioProfile(request.audio.codec),
    "-ac",
    "1",
    "-ar",
    String(recordingSamplerateHz(request.audio.samplerate)),
    "-b:a",
    `${request.audio.bitrateKbps}k`,
  ];
};

/** The whole recording command. */
export const recordingArgs = (options: {
  input: InputOptions;
  channel: CameraChannel;
  request: RecordingRequest;
  codecs: CodecSupport;
  /** Record without sound, for a camera whose microphone is off. */
  withoutAudio?: boolean;
}): string[] => [
  ...inputArgs(options.input),
  ...recordingVideoArgs({
    channel: options.channel,
    request: options.request,
    codecs: options.codecs,
  }),
  ...(options.withoutAudio
    ? ["-an"]
    : recordingAudioArgs({ request: options.request, codecs: options.codecs })),
  ...containerArgs(options.request),
];
