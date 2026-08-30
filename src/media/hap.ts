/**
 * Local mirrors of HAP's camera enums.
 *
 * Every one of these is declared in hap-nodejs as an ambient `const enum`, which
 * `verbatimModuleSyntax` forbids reaching into at runtime — importing them
 * type-checks and then throws at load. They are re-declared here as `as const`
 * objects, with the HAP name each one mirrors, so the values used in argument
 * construction and stream negotiation are named rather than scattered as bare
 * integers.
 *
 * These values are fixed by the HomeKit protocol; they do not drift.
 */

/** `SRTPCryptoSuites` */
export const SrtpCryptoSuite = {
  AES_CM_128_HMAC_SHA1_80: 0,
  AES_CM_256_HMAC_SHA1_80: 1,
  NONE: 2,
} as const;
export type SrtpCryptoSuite = (typeof SrtpCryptoSuite)[keyof typeof SrtpCryptoSuite];

/** `H264Profile` */
export const H264Profile = {
  BASELINE: 0,
  MAIN: 1,
  HIGH: 2,
} as const;
export type H264Profile = (typeof H264Profile)[keyof typeof H264Profile];

/** `H264Level` */
export const H264Level = {
  LEVEL3_1: 0,
  LEVEL3_2: 1,
  LEVEL4_0: 2,
} as const;
export type H264Level = (typeof H264Level)[keyof typeof H264Level];

/** `AudioStreamingCodecType` */
export const AudioCodec = {
  PCMU: "PCMU",
  PCMA: "PCMA",
  AAC_ELD: "AAC-eld",
  OPUS: "OPUS",
} as const;

/** `AudioStreamingSamplerate` — the value is the rate in kHz. */
export const AudioSamplerate = {
  KHZ_8: 8,
  KHZ_16: 16,
  KHZ_24: 24,
} as const;

/** `AudioBitrate` */
export const AudioBitrate = {
  VARIABLE: 0,
  CONSTANT: 1,
} as const;

/** `StreamRequestTypes` */
export const StreamRequestType = {
  RECONFIGURE: "reconfigure",
  START: "start",
  STOP: "stop",
} as const;

/** `AudioRecordingCodecType` — what HKSV accepts, which is not what live streaming accepts. */
export const AudioRecordingCodec = {
  AAC_LC: 0,
  AAC_ELD: 1,
} as const;
export type AudioRecordingCodec = (typeof AudioRecordingCodec)[keyof typeof AudioRecordingCodec];

/** `AudioRecordingSamplerate` — an index, not a rate. */
export const AudioRecordingSamplerate = {
  KHZ_8: 0,
  KHZ_16: 1,
  KHZ_24: 2,
  KHZ_32: 3,
  KHZ_44_1: 4,
  KHZ_48: 5,
} as const;

/** The rate in Hz that a `AudioRecordingSamplerate` index stands for. */
export const recordingSamplerateHz = (value: number): number =>
  [8000, 16000, 24000, 32000, 44100, 48000][value] ?? 32000;

/** The ffmpeg `-profile:a` value for a recording codec HomeKit selected. */
export const ffmpegAudioProfile = (codec: number): string =>
  codec === AudioRecordingCodec.AAC_ELD ? "aac_eld" : "aac_low";

/** The ffmpeg `-profile:v` value for a profile HomeKit asked for. */
export const ffmpegProfile = (profile: H264Profile): string => {
  switch (profile) {
    case H264Profile.BASELINE:
      return "baseline";
    case H264Profile.MAIN:
      return "main";
    default:
      return "high";
  }
};

/** The ffmpeg `-level:v` value for a level HomeKit asked for. */
export const ffmpegLevel = (level: H264Level): string => {
  switch (level) {
    case H264Level.LEVEL3_1:
      return "3.1";
    case H264Level.LEVEL3_2:
      return "3.2";
    default:
      return "4.0";
  }
};
