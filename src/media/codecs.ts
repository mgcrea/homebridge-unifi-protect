import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Logger } from "@mgcrea/unifi-protect";

const run = promisify(execFile);

/**
 * What the host's ffmpeg can actually do.
 *
 * Probed once at start-up rather than assumed. The alternative — picking an
 * encoder by platform and finding out it is missing when someone opens a camera
 * — fails at the worst moment and produces an ffmpeg error nobody can read.
 */
export type CodecSupport = {
  version: string | undefined;
  encoders: ReadonlySet<string>;
  decoders: ReadonlySet<string>;
  /** The H.264 encoder to transcode with. Always present: libx264 is the floor. */
  videoEncoder: string;
  /** Whether `videoEncoder` is hardware-backed, which decides the preset flags. */
  hardware: boolean;
  /**
   * HomeKit wants AAC-ELD, which only libfdk_aac produces. Without it the
   * plugin advertises no audio at all rather than negotiating a codec it cannot
   * deliver and leaving the viewer with a silent stream and no explanation.
   */
  audioEncoder: string | undefined;
};

/**
 * Encoder and decoder listings look like:
 *
 * ```
 *  V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)
 *  A....D aac                  AAC (Advanced Audio Coding)
 * ```
 *
 * The six flag characters are fixed-width, so the name follows them. Matching
 * the name as a codec-shaped identifier rather than as "the next token" matters:
 * the legend above the table (` V..... = Video`) has the same six-character
 * shape, and a looser pattern collects `=` as though it were an encoder.
 */
export const parseCodecList = (output: string): Set<string> => {
  const names = new Set<string>();
  for (const line of output.split("\n")) {
    const match = /^\s*[A-Z.]{6}\s+([A-Za-z0-9][\w-]*)/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
};

export const parseVersion = (output: string): string | undefined =>
  /^ffmpeg version (\S+)/m.exec(output)?.[1];

/**
 * Hardware H.264 encoders worth preferring, in the order they are tried.
 *
 * Ordered by how likely each is to be the RIGHT answer on a host that has it,
 * not by raw speed: VideoToolbox is the only option that matters on a Mac, and
 * on Linux a box with an NVIDIA card or Intel QuickSync almost certainly wants
 * those over the Raspberry Pi's v4l2m2m, which also appears on some desktop
 * kernels and is slow there.
 */
const HARDWARE_ENCODERS: Record<string, string[]> = {
  darwin: ["h264_videotoolbox"],
  linux: ["h264_nvenc", "h264_qsv", "h264_rkmpp", "h264_vaapi", "h264_v4l2m2m"],
  win32: ["h264_nvenc", "h264_qsv", "h264_amf"],
};

/** The best available H.264 encoder, falling back to software. */
export const selectVideoEncoder = (
  encoders: ReadonlySet<string>,
  platform: string = process.platform,
): { encoder: string; hardware: boolean } => {
  for (const candidate of HARDWARE_ENCODERS[platform] ?? []) {
    if (encoders.has(candidate)) return { encoder: candidate, hardware: true };
  }
  // libx264 is what every distribution ships; `h264` is the built-in fallback
  // name on a stripped build.
  if (encoders.has("libx264")) return { encoder: "libx264", hardware: false };
  return { encoder: "h264", hardware: false };
};

/**
 * HomeKit negotiates AAC-ELD, which ffmpeg only produces through libfdk_aac.
 * The built-in `aac` encoder cannot do the ELD profile, so a build without
 * libfdk_aac has no usable audio path at all.
 */
export const selectAudioEncoder = (encoders: ReadonlySet<string>): string | undefined =>
  encoders.has("libfdk_aac") ? "libfdk_aac" : undefined;

export const probeCodecs = async (
  videoProcessor: string,
  logger?: Logger,
): Promise<CodecSupport> => {
  const ask = async (flag: string): Promise<string> => {
    const { stdout, stderr } = await run(videoProcessor, ["-hide_banner", flag], {
      maxBuffer: 8 * 1024 * 1024,
    });
    // `-version` writes to stdout; the codec listings write there too, but a
    // few builds split the banner across both.
    return stdout + stderr;
  };

  const [version, encoderList, decoderList] = await Promise.all([
    ask("-version"),
    ask("-encoders"),
    ask("-decoders"),
  ]);

  const encoders = parseCodecList(encoderList);
  const decoders = parseCodecList(decoderList);
  const { encoder, hardware } = selectVideoEncoder(encoders);
  const audioEncoder = selectAudioEncoder(encoders);

  logger?.info?.(
    `ffmpeg ${parseVersion(version) ?? "(unknown version)"}: encoding with ${encoder}` +
      `${hardware ? " (hardware)" : " (software)"}, audio ${audioEncoder ?? "unavailable"}.`,
  );
  if (!audioEncoder) {
    logger?.warn?.(
      "This ffmpeg has no libfdk_aac, so camera audio cannot be encoded in the AAC-ELD profile " +
        "HomeKit requires. Streams will be video-only. Install an ffmpeg built with libfdk_aac " +
        "to get sound.",
    );
  }

  return {
    version: parseVersion(version),
    encoders,
    decoders,
    videoEncoder: encoder,
    hardware,
    audioEncoder,
  };
};
