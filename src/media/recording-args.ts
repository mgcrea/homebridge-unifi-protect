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
 * achievable rather than lucky. See `needsIdrAlignment`.
 */
export const canCopyRecording = (channel: CameraChannel, request: RecordingRequest): boolean =>
  channel.width === request.width &&
  channel.height === request.height &&
  idrMatches(channel, request);

/**
 * Whether the camera's keyframes fall exactly on HomeKit's fragment boundaries.
 *
 * **Equality, not divisibility.** `frag_keyframe` makes ffmpeg cut a fragment at
 * *every* keyframe, so a camera with a 2s interval produces 2s fragments even
 * when `-frag_duration` asks for 4s — measured against a real G4 Bullet, whose
 * medium channel ships at 2s and yielded seven fragments where four were
 * negotiated. Divisibility looks like the right test and quietly delivers
 * fragments of a length HomeKit never agreed to.
 *
 * Protect states `idrInterval` in seconds; HomeKit states fragments in
 * milliseconds.
 */
export const idrMatches = (channel: CameraChannel, request: RecordingRequest): boolean => {
  const idrMs = (channel.idrInterval ?? 0) * 1000;
  if (idrMs <= 0) return false;
  return idrMs === request.fragmentLengthMs;
};

/** The `idrInterval`, in seconds, a channel needs for fragments to come out right. */
export const desiredIdrInterval = (request: RecordingRequest): number =>
  Math.max(1, Math.round(request.fragmentLengthMs / 1000));

export const needsIdrAlignment = (channel: CameraChannel, request: RecordingRequest): boolean =>
  !idrMatches(channel, request);

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
 */
export const containerArgs = (request: RecordingRequest): string[] => [
  "-f",
  "mp4",
  "-movflags",
  "frag_keyframe+empty_moov+default_base_moof+skip_trailer",
  // ffmpeg counts fragment duration in microseconds.
  "-frag_duration",
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
