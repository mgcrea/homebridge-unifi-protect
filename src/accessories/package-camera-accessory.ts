import type { CameraController, PlatformAccessory, Service } from "homebridge";
import { packageChannel, type Camera } from "@mgcrea/unifi-protect";

import { BaseAccessory } from "#accessories/base-accessory";
import {
  AudioBitrate,
  AudioCodec,
  AudioSamplerate,
  H264Level,
  H264Profile,
  SrtpCryptoSuite,
} from "#media/hap";
import { advertisedResolutions, lensView } from "#media/rtsp";
import { StreamingDelegate } from "#media/streaming-delegate";
import type { UnifiProtectPlatform } from "#platform";

/**
 * The doorbell's second lens, as its own camera.
 *
 * It is a separate accessory rather than a second stream on the doorbell
 * because HomeKit has no concept of one camera with two views — which is also
 * why the plugin this replaces does the same thing.
 *
 * No Secure Video here, and that is not an omission: the package lens runs at
 * 2fps with a keyframe every five seconds, so no fragment length HomeKit asks
 * for divides its keyframe interval and every recording would be a permanent
 * re-encode of a slideshow. Live view and snapshots are what the lens is for.
 */
export class PackageCameraAccessory extends BaseAccessory<Camera> {
  readonly #motion: Service;
  readonly #streaming: StreamingDelegate | undefined;
  readonly #controller: CameraController | undefined;

  #motionTimer: NodeJS.Timeout | undefined;
  #motionActive = false;
  #seenState = false;

  constructor(platform: UnifiProtectPlatform, accessory: PlatformAccessory, device: Camera) {
    super(platform, accessory, device);
    const { Service, Characteristic } = platform;

    this.configureInformation(
      `${device.marketName ?? device.type ?? "Camera"} Package Camera`,
      device.firmwareVersion,
      // Suffixed so HomeKit sees a different device from the doorbell itself;
      // two accessories sharing a serial number confuse the Home app.
      `${device.mac ?? device.id}-pkg`,
    );

    this.#motion =
      accessory.getService(Service.MotionSensor) ??
      accessory.addService(Service.MotionSensor, this.displayName);
    this.#motion.setPrimaryService(true);
    this.#motion.setCharacteristic(Characteristic.ConfiguredName, this.displayName);
    this.#motion.getCharacteristic(Characteristic.MotionDetected).onGet(() => {
      this.assertReadable();
      return this.#motionActive;
    });
    this.#motion
      .getCharacteristic(Characteristic.StatusActive)
      .onGet(() => this.device.isConnected === true);

    if (platform.options.enableStreaming && platform.hasCodecs) {
      this.#streaming = new StreamingDelegate(platform, () => this.#lens());
      this.#controller = new platform.api.hap.CameraController({
        cameraStreamCount: 2,
        delegate: this.#streaming,
        streamingOptions: {
          supportedCryptoSuites: [SrtpCryptoSuite.AES_CM_128_HMAC_SHA1_80],
          video: {
            resolutions: advertisedResolutions(this.#lens()),
            codec: {
              profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
              levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
            },
          },
          ...(platform.codecs.audioEncoder
            ? {
                audio: {
                  codecs: [
                    {
                      type: AudioCodec.AAC_ELD,
                      audioChannels: 1,
                      bitrate: AudioBitrate.VARIABLE,
                      samplerate: [AudioSamplerate.KHZ_16, AudioSamplerate.KHZ_24],
                    },
                  ],
                  twoWayAudio: false,
                },
              }
            : {}),
        },
        sensors: { motion: this.#motion },
      });
      accessory.configureController(this.#controller);
    }

    this.update(device);
  }

  /** The doorbell record narrowed to its package lens. */
  #lens(): Camera {
    const channel = packageChannel(this.device);
    return channel ? lensView(this.device, channel) : this.device;
  }

  protected get isReadable(): boolean {
    return this.#seenState;
  }

  /** Fired by a package smart-detection on the parent doorbell. */
  triggerMotion(): void {
    if (this.disposed) return;

    this.#seenState = true;
    if (!this.#motionActive) {
      this.#motionActive = true;
      this.#motion.updateCharacteristic(this.platform.Characteristic.MotionDetected, true);
      this.platform.debug(`${this.displayName}: package detected`);
    }

    this.clearTimer(this.#motionTimer);
    this.#motionTimer = this.setTimer(() => {
      this.#motionActive = false;
      this.#motionTimer = undefined;
      this.#motion.updateCharacteristic(this.platform.Characteristic.MotionDetected, false);
    }, this.platform.options.motionDurationMs);
  }

  update(device: Camera): void {
    this.device = device;
    this.#seenState = true;
    this.#motion.updateCharacteristic(
      this.platform.Characteristic.StatusActive,
      device.isConnected === true,
    );
  }

  override dispose(): void {
    super.dispose();
    this.#streaming?.dispose();
    this.#motionTimer = undefined;
  }
}
