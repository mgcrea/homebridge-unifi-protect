import type {
  CameraRecordingConfiguration,
  CameraRecordingDelegate,
  RecordingPacket,
} from "homebridge";
import type { Camera, CameraChannel } from "@mgcrea/unifi-protect";

import {
  canCopyRecording,
  desiredIdrInterval,
  needsIdrAlignment,
  recordingArgs,
  type RecordingRequest,
} from "#media/recording-args";
import { alignIdrInterval, selectChannel, usableChannels } from "#media/rtsp";
import { Prebuffer } from "#media/prebuffer";
import { describe } from "#util/describe";
import type { InputOptions } from "#media/stream-args";
import type { UnifiProtectPlatform } from "#platform";

/**
 * HomeKit Secure Video for one camera.
 *
 * The whole design rests on not muxing anything ourselves. ffmpeg's mp4 muxer
 * already emits what HKSV consumes, so this is only three jobs: keep a rolling
 * prebuffer while recording is armed, slice the byte stream into fragments, and
 * hand them over when asked. See `recording-args.ts` for the flags that make
 * ffmpeg produce the right shape, and `mp4/boxes.ts` for the slicing.
 */
export class RecordingDelegate implements CameraRecordingDelegate {
  readonly #platform: UnifiProtectPlatform;
  readonly #camera: () => Camera;
  readonly #input: (channel: CameraChannel) => InputOptions;

  #configuration: CameraRecordingConfiguration | undefined;
  #prebuffer: Prebuffer | undefined;
  #active = false;
  /** Warned once rather than on every trigger, which HomeKit repeats. */
  #warnedNoChannel = false;

  constructor(
    platform: UnifiProtectPlatform,
    camera: () => Camera,
    input: (channel: CameraChannel) => InputOptions,
  ) {
    this.#platform = platform;
    this.#camera = camera;
    this.#input = input;
  }

  get #name(): string {
    return this.#camera().name ?? this.#camera().id;
  }

  /**
   * HomeKit arms and disarms recording here.
   *
   * This is the hook that keeps the plugin cheap: nothing runs for a camera
   * whose Secure Video is switched off, and the prebuffer starts only when the
   * user actually turns it on.
   */
  updateRecordingActive(active: boolean): void {
    if (this.#active === active) return;
    this.#active = active;

    if (!active) {
      this.#platform.log.info(`${this.#name}: HomeKit Secure Video disarmed.`);
      this.#prebuffer?.stop();
      this.#prebuffer = undefined;
      return;
    }

    this.#platform.log.info(`${this.#name}: HomeKit Secure Video armed.`);
    void this.#startPrebuffer();
  }

  updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    this.#configuration = configuration;
    // The negotiated resolution, fragment length or codec may all have changed,
    // and the prebuffer's ffmpeg was started for the previous ones.
    if (this.#active) {
      this.#prebuffer?.stop();
      this.#prebuffer = undefined;
      void this.#startPrebuffer();
    }
  }

  /** Translate HomeKit's selection into the shape the argument builders take. */
  #request(): RecordingRequest | undefined {
    const config = this.#configuration;
    if (!config) return undefined;

    const [width, height, fps] = config.videoCodec.resolution;
    return {
      width,
      height,
      fps,
      profile: config.videoCodec.parameters.profile,
      level: config.videoCodec.parameters.level,
      bitrateKbps: config.videoCodec.parameters.bitRate,
      fragmentLengthMs: config.mediaContainerConfiguration.fragmentLength,
      iFrameIntervalMs: config.videoCodec.parameters.iFrameInterval,
      audio: {
        codec: config.audioCodec.type,
        samplerate: config.audioCodec.samplerate,
        bitrateKbps: config.audioCodec.bitrate,
      },
    };
  }

  async #startPrebuffer(): Promise<void> {
    const request = this.#request();
    if (!request) return;

    const camera = this.#camera();
    const channel = selectChannel(usableChannels(camera), request);
    if (!channel) {
      if (!this.#warnedNoChannel) {
        this.#warnedNoChannel = true;
        this.#platform.log.warn(
          `${this.#name}: no RTSP-enabled channel, so Secure Video cannot record. ` +
            `Enable RTSP for this camera in Protect.`,
        );
      }
      return;
    }

    // Line the camera's keyframe interval up with HomeKit's fragment length.
    // This is what lets the video be copied instead of re-encoded: with
    // `-codec:v copy` ffmpeg can only cut a fragment where the camera already
    // put a keyframe, so without this the fragments come out whatever length
    // the camera happened to choose.
    if (needsIdrAlignment(channel, request)) {
      const seconds = desiredIdrInterval(request);
      try {
        await alignIdrInterval(this.#platform.client, camera, channel.id, seconds);
        this.#platform.log.info(
          `${this.#name}: set the "${channel.name ?? channel.id}" channel's keyframe interval to ` +
            `${seconds}s so recordings can be copied rather than re-encoded.`,
        );
      } catch (error) {
        // Not fatal: the transcode path still produces correct fragments, it
        // just costs a core while recording.
        this.#platform.log.debug(
          `${this.#name}: could not align the keyframe interval (${describe(error)}); ` +
            `recordings will be re-encoded instead.`,
        );
      }
    }

    // Re-read the channel: aligning it above changed the record we are holding.
    const current = selectChannel(usableChannels(this.#camera()), request) ?? channel;
    const copying = canCopyRecording(current, request);

    this.#platform.log.info(
      `${this.#name}: recording ${request.width}x${request.height} in ` +
        `${request.fragmentLengthMs}ms fragments, ` +
        `${copying ? "copying the camera's own stream" : `re-encoding with ${this.#platform.codecs.videoEncoder}`}.`,
    );

    this.#prebuffer = new Prebuffer({
      platform: this.#platform,
      name: this.#name,
      prebufferLengthMs: this.#configuration?.prebufferLength ?? 4000,
      verbose: this.#platform.options.verboseFfmpeg,
      args: recordingArgs({
        input: this.#input(current),
        channel: current,
        request,
        codecs: this.#platform.codecs,
        withoutAudio: this.#camera().isMicEnabled === false,
      }),
    });
    this.#prebuffer.start();
  }

  /**
   * Hand HomeKit a recording: the initialisation segment, the buffered history,
   * then live fragments until it stops asking.
   *
   * The history is what makes a clip start before the motion that triggered it.
   * Everything after is simply the prebuffer's live feed — there is no second
   * ffmpeg and no switch-over, because the recording and the prebuffer are the
   * same stream.
   */
  async *handleRecordingStreamRequest(
    streamId: number,
    signal?: AbortSignal,
  ): AsyncGenerator<RecordingPacket> {
    const prebuffer = this.#prebuffer;
    const init = prebuffer?.initSegment;

    if (!prebuffer || !init) {
      this.#platform.log.warn(
        `${this.#name}: HomeKit asked for a recording before the prebuffer was ready.`,
      );
      // A single zero byte with isLast is how HAP is told a stream is over.
      yield { data: Buffer.alloc(1, 0), isLast: true };
      return;
    }

    this.#platform.log.debug(`${this.#name}: recording stream ${streamId} started.`);

    try {
      yield { data: init, isLast: false };

      for (const fragment of prebuffer.buffered()) {
        if (signal?.aborted) return;
        yield { data: fragment.data, isLast: false };
      }

      for await (const fragment of prebuffer.live(signal)) {
        if (signal?.aborted) return;
        yield { data: fragment.data, isLast: false };
      }
    } finally {
      this.#platform.log.debug(`${this.#name}: recording stream ${streamId} ended.`);
    }
  }

  closeRecordingStream(streamId: number, reason: number | undefined): void {
    this.#platform.log.debug(
      `${this.#name}: HomeKit closed recording stream ${streamId}` +
        (reason === undefined ? "." : ` (reason ${reason}).`),
    );
  }

  dispose(): void {
    this.#prebuffer?.stop();
    this.#prebuffer = undefined;
  }
}
