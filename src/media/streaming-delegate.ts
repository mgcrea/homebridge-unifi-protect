import { randomInt } from "node:crypto";
import type {
  CameraStreamingDelegate,
  PrepareStreamCallback,
  PrepareStreamRequest,
  SnapshotRequest,
  SnapshotRequestCallback,
  StreamingRequest,
  StreamRequestCallback,
} from "homebridge";
import {
  hasTwoWayAudio,
  talkbackTarget,
  type Camera,
  type CameraChannel,
} from "@mgcrea/unifi-protect";

import { enableRtsp, namedChannel, rtspUrl, selectChannel, usableChannels } from "#media/rtsp";

import { FfmpegProcess } from "#media/ffmpeg";
import { RtpPortAllocator } from "#media/rtp/port-allocator";
import { RtpSplitter } from "#media/rtp/splitter";
import { talkbackArgs, talkbackSdp } from "#media/talkback-args";
import { StreamRequestType } from "#media/hap";
import { canCopyVideo, streamArgs, type InputOptions, type StreamTarget } from "#media/stream-args";
import { takeSnapshot } from "#media/snapshot";
import { cameraOverrideFor } from "#config";
import { describe } from "#util/describe";
import type { UnifiProtectPlatform } from "#platform";

/** A session between `prepareStream` and the `start` that follows it. */
type PreparedSession = {
  targetAddress: string;
  video: { localPort: number; remotePort: number; ssrc: number; key: Buffer; salt: Buffer };
  audio: { localPort: number; remotePort: number; ssrc: number; key: Buffer; salt: Buffer };
  process?: FfmpegProcess;
  /** Two-way audio, present only on cameras that have a speaker. */
  talkback?: {
    /** Owns the audio port so the two ffmpegs can share it. */
    splitter: RtpSplitter;
    /** Where the outgoing ffmpeg sends from, since the splitter has the port. */
    outgoingPort: number;
    /** Where the talkback ffmpeg listens for HomeKit's voice. */
    incomingPort: number;
    process?: FfmpegProcess;
  };
};

/**
 * Live video for one camera.
 *
 * HomeKit drives this in two steps that are easy to conflate: `prepareStream`
 * negotiates addresses, ports and SRTP keys and must answer quickly, and only
 * the `start` that may follow actually spends anything. Keeping them apart
 * matters because HomeKit prepares streams it then abandons — every time
 * someone scrolls past a camera tile — and starting ffmpeg in `prepareStream`
 * would mean a process per glance.
 */
export class StreamingDelegate implements CameraStreamingDelegate {
  readonly #platform: UnifiProtectPlatform;
  readonly #camera: () => Camera;
  readonly #ports = new RtpPortAllocator();
  readonly #sessions = new Map<string, PreparedSession>();

  /** Warned once per camera rather than on every request, which HomeKit repeats. */
  #warnedNoChannel = false;

  constructor(platform: UnifiProtectPlatform, camera: () => Camera) {
    this.#platform = platform;
    this.#camera = camera;
  }

  get #name(): string {
    return this.#camera().name ?? this.#camera().id;
  }

  /**
   * Where this camera accepts talkback, if it accepts any at all.
   *
   * Both the capability flag and the settings have to agree. `talkbackSettings`
   * is populated on every camera including those with no speaker, so it says
   * where audio would go rather than whether anything would play it.
   */
  #talkbackTarget(): ReturnType<typeof talkbackTarget> {
    const camera = this.#camera();
    return hasTwoWayAudio(camera) ? talkbackTarget(camera) : undefined;
  }

  /** How ffmpeg reaches the console's RTSPS. Shared with the recording delegate. */
  inputFor(channel: CameraChannel): InputOptions {
    return this.#input(channel);
  }

  /** How ffmpeg reaches the console's RTSPS, or undefined if nothing is streamable. */
  #input(channel: CameraChannel): InputOptions {
    return {
      url: rtspUrl(this.#platform.options.host, channel, this.#platform.options.rtspPort),
      caFile: this.#platform.consoleCaFile,
    };
  }

  /**
   * The channel to stream, enabling RTSP on one if the camera has none.
   *
   * Protect ships with RTSP switched off on every channel, so a camera nobody
   * has streamed from has no alias and cannot be reached at all. Rather than
   * fail with something opaque, the highest-quality channel is switched on
   * once — the console then reports the new alias through the update stream.
   */
  async #channelFor(request: {
    width: number;
    height: number;
  }): Promise<CameraChannel | undefined> {
    const camera = this.#camera();
    const override = cameraOverrideFor(this.#platform.options, camera.mac)?.channel;

    const named = namedChannel(camera, override);
    if (named) return named;

    const usable = usableChannels(camera);
    if (usable.length > 0) return selectChannel(usable, request);

    const candidate = camera.channels[0];
    if (!candidate) return undefined;

    try {
      this.#platform.log.info(
        `${this.#name}: no RTSP channel is enabled on this camera; enabling "${candidate.name ?? candidate.id}".`,
      );
      await enableRtsp(this.#platform.client, camera, candidate.id);
    } catch (error) {
      this.#platform.log.warn(
        `${this.#name}: could not enable RTSP — ${describe(error)}. ` +
          `The configured account may be view-only; enable RTSP on the camera in Protect instead.`,
      );
      return undefined;
    }

    // The console answers the write before the alias appears on the device
    // record, so this attempt still has nothing to stream. The next one will.
    return undefined;
  }

  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    void (async () => {
      const camera = this.#camera();
      const channel = selectChannel(usableChannels(camera), request);

      try {
        const image = await takeSnapshot({
          platform: this.#platform,
          client: this.#platform.client,
          camera,
          name: this.#name,
          input: channel ? this.#input(channel) : undefined,
          request,
        });
        callback(undefined, image);
      } catch (error) {
        this.#platform.log.warn(`${this.#name}: snapshot failed — ${describe(error)}`);
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  }

  prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    void (async () => {
      try {
        const [videoPort, audioPort] = await Promise.all([
          this.#ports.reserve(),
          this.#ports.reserve(),
        ]);

        // Two-way audio changes who owns the audio port. HomeKit sends its
        // voice to the same port it expects ours to arrive from, so the
        // splitter binds it and the outgoing ffmpeg gets one of its own.
        //
        // Gated on the same capability the accessory advertises, not on
        // talkbackSettings alone: every camera carries those settings,
        // speaker or not. Rearranging the audio ports for a camera HomeKit
        // never negotiated two-way audio with kills the stream outright.
        const target = this.#talkbackTarget();
        let talkback: PreparedSession["talkback"];
        if (target && this.#platform.codecs.audioEncoder) {
          const [outgoingPort, incomingPort] = await Promise.all([
            this.#ports.reserve(),
            this.#ports.reserve(),
          ]);
          const splitter = await RtpSplitter.bind(audioPort);
          splitter.forwardRtcpTo(outgoingPort);
          splitter.forwardAudioTo(incomingPort);
          talkback = { splitter, outgoingPort, incomingPort };
        }

        const session: PreparedSession = {
          targetAddress: request.targetAddress,
          video: {
            localPort: videoPort,
            remotePort: request.video.port,
            // The SSRC identifies our stream to the controller. It must not be
            // zero and must not collide with the audio stream's.
            ssrc: randomInt(1, 0x7fff_ffff),
            key: request.video.srtp_key,
            salt: request.video.srtp_salt,
          },
          audio: {
            localPort: audioPort,
            remotePort: request.audio.port,
            ssrc: randomInt(1, 0x7fff_ffff),
            key: request.audio.srtp_key,
            salt: request.audio.srtp_salt,
          },
        };
        if (talkback) session.talkback = talkback;
        this.#sessions.set(request.sessionID, session);

        callback(undefined, {
          video: {
            port: videoPort,
            ssrc: session.video.ssrc,
            // Echoed back deliberately: these identify the keys the controller
            // should expect on the stream we send, which are the ones it just
            // gave us.
            srtp_key: request.video.srtp_key,
            srtp_salt: request.video.srtp_salt,
          },
          audio: {
            port: audioPort,
            ssrc: session.audio.ssrc,
            srtp_key: request.audio.srtp_key,
            srtp_salt: request.audio.srtp_salt,
          },
        });
      } catch (error) {
        this.#platform.log.error(`${this.#name}: could not prepare a stream — ${describe(error)}`);
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    switch (request.type) {
      case StreamRequestType.START:
        void this.#start(request, callback);
        return;

      case StreamRequestType.RECONFIGURE:
        // HomeKit asks for this whenever its estimate of the link changes, which
        // on a phone moving between WiFi and cellular is often. Restarting
        // ffmpeg to honour it would black the picture out for a second every
        // time; acknowledging and carrying on is what viewers actually want.
        this.#platform.debug(`${this.#name}: ignoring a mid-stream reconfigure request.`);
        callback();
        return;

      case StreamRequestType.STOP:
        this.#stop(request.sessionID);
        callback();
        return;
    }
  }

  async #start(
    request: Extract<StreamingRequest, { type: typeof StreamRequestType.START }>,
    callback: StreamRequestCallback,
  ): Promise<void> {
    const session = this.#sessions.get(request.sessionID);
    if (!session) {
      callback(new Error("HomeKit asked to start a stream that was never prepared."));
      return;
    }

    const channel = await this.#channelFor(request.video);
    if (!channel) {
      if (!this.#warnedNoChannel) {
        this.#warnedNoChannel = true;
        this.#platform.log.warn(
          `${this.#name}: no RTSP-enabled channel is available, so live video cannot start. ` +
            `Enable RTSP for this camera in Protect, or run \`pnpm diagnose\` to see its channels.`,
        );
      }
      this.#release(request.sessionID);
      callback(new Error("No RTSP-enabled channel is available for this camera."));
      return;
    }

    const video: StreamTarget = {
      address: session.targetAddress,
      port: session.video.remotePort,
      localPort: session.video.localPort,
      srtpKey: session.video.key,
      srtpSalt: session.video.salt,
      ssrc: session.video.ssrc,
      payloadType: request.video.pt,
      mtu: request.video.mtu,
    };

    const codecs = this.#platform.codecs;
    const audio = codecs.audioEncoder
      ? {
          request: {
            samplerateKhz: request.audio.sample_rate,
            maxBitrateKbps: request.audio.max_bit_rate,
            packetTime: request.audio.packet_time,
          },
          target: {
            address: session.targetAddress,
            port: session.audio.remotePort,
            // With two-way audio the splitter has the negotiated port, so the
            // outgoing leg sends from its own. HomeKit matches the stream by
            // SSRC rather than source port, so it does not mind.
            localPort: session.talkback?.outgoingPort ?? session.audio.localPort,
            srtpKey: session.audio.key,
            srtpSalt: session.audio.salt,
            ssrc: session.audio.ssrc,
            payloadType: request.audio.pt,
            mtu: request.video.mtu,
          } satisfies StreamTarget,
        }
      : undefined;

    const videoRequest = {
      width: request.video.width,
      height: request.video.height,
      fps: request.video.fps,
      maxBitrateKbps: request.video.max_bit_rate,
      profile: request.video.profile,
      level: request.video.level,
    };

    const copying = canCopyVideo(channel, videoRequest);
    this.#platform.log.info(
      `${this.#name}: streaming ${request.video.width}x${request.video.height} at ` +
        `${request.video.fps}fps from the "${channel.name ?? channel.id}" channel, ` +
        `${copying ? "copying the camera's own stream" : `transcoding with ${codecs.videoEncoder}`}.`,
    );

    session.process = new FfmpegProcess({
      platform: this.#platform,
      name: this.#name,
      args: streamArgs({
        input: this.#input(channel),
        channel,
        video: { request: videoRequest, target: video },
        audio,
        codecs,
      }),
      verbose: this.#platform.options.verboseFfmpeg,
      // ffmpeg ending on its own means the stream died — the camera dropped,
      // the console restarted. HomeKit is not told, and would sit on a frozen
      // picture, so the session is cleaned up and its ports returned.
      onExit: () => this.#release(request.sessionID),
    });

    this.#startTalkback(session, request);

    callback();
  }

  /**
   * The return leg: HomeKit's voice, re-encoded for the camera's own speaker.
   *
   * Failures here are logged and swallowed. A camera whose talkback will not
   * start is still a camera worth watching, and taking the whole session down
   * would cost the picture as well as the voice.
   */
  #startTalkback(
    session: PreparedSession,
    request: Extract<StreamingRequest, { type: typeof StreamRequestType.START }>,
  ): void {
    const talkback = session.talkback;
    const target = this.#talkbackTarget();
    const encoder = this.#platform.codecs.audioEncoder;
    if (!talkback || !target || !encoder) return;

    const stream = {
      localPort: talkback.incomingPort,
      payloadType: request.audio.pt,
      samplerateKhz: request.audio.sample_rate,
      srtpKey: session.audio.key,
      srtpSalt: session.audio.salt,
    };

    try {
      talkback.process = new FfmpegProcess({
        platform: this.#platform,
        name: `${this.#name} (talkback)`,
        args: talkbackArgs({
          stream,
          target,
          // The encoder probe only ever returns libfdk_aac, which is the one
          // decoder that reads HomeKit's ELD; the camera wants plain AAC-LC
          // back, which ffmpeg's built-in encoder produces.
          audioDecoder: encoder,
          audioEncoder: "aac",
        }),
        verbose: this.#platform.options.verboseFfmpeg,
        // The SDP carries the session's SRTP key, so it goes in on stdin
        // rather than as a file or an argument, where it would be readable by
        // anyone who can list processes.
        stdin: talkbackSdp(stream),
      });
      this.#platform.debug(`${this.#name}: talkback open to ${target.host}:${target.port}.`);
    } catch (error) {
      this.#platform.log.warn(`${this.#name}: two-way audio failed to start — ${describe(error)}`);
    }
  }

  #stop(sessionID: string): void {
    const session = this.#sessions.get(sessionID);
    session?.process?.stop();
    session?.talkback?.process?.stop();
    this.#release(sessionID);
  }

  #release(sessionID: string): void {
    const session = this.#sessions.get(sessionID);
    if (!session) return;
    this.#ports.release(session.video.localPort);
    this.#ports.release(session.audio.localPort);
    if (session.talkback) {
      session.talkback.splitter.close();
      this.#ports.release(session.talkback.outgoingPort);
      this.#ports.release(session.talkback.incomingPort);
    }
    this.#sessions.delete(sessionID);
  }

  /** Tear every session down, for accessory disposal and bridge shutdown. */
  dispose(): void {
    // Stop and release in one pass, then clear, rather than deleting from the
    // map while iterating it.
    for (const session of this.#sessions.values()) {
      session.process?.stop();
      session.talkback?.process?.stop();
      session.talkback?.splitter.close();
      this.#ports.release(session.video.localPort);
      this.#ports.release(session.audio.localPort);
      if (session.talkback) {
        this.#ports.release(session.talkback.outgoingPort);
        this.#ports.release(session.talkback.incomingPort);
      }
    }
    this.#sessions.clear();
  }
}
