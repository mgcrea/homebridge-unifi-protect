import type { CameraController, PlatformAccessory, Service } from "homebridge";
import { isDoorbell, smartDetectGate, type Camera } from "@mgcrea/unifi-protect";

import { BaseAccessory } from "#accessories/base-accessory";
import {
  AudioBitrate,
  AudioCodec,
  AudioSamplerate,
  H264Level,
  H264Profile,
  SrtpCryptoSuite,
} from "#media/hap";
import { advertisedResolutions } from "#media/rtsp";
import { StreamingDelegate } from "#media/streaming-delegate";
import type { UnifiProtectPlatform } from "#platform";

/**
 * A Protect camera in HomeKit: motion, the doorbell button, and live video.
 *
 * The motion sensor is handed to the CameraController rather than left standing
 * on its own, because HomeKit Secure Video uses that service as its recording
 * trigger — wiring it in now means the recording delegate has somewhere to
 * attach without the accessory being rebuilt and its automations detached.
 */
export class CameraAccessory extends BaseAccessory<Camera> {
  readonly #motion: Service;
  readonly #doorbell: Service | undefined;
  readonly #streaming: StreamingDelegate | undefined;
  readonly #controller: CameraController | undefined;

  #motionTimer: NodeJS.Timeout | undefined;
  #motionActive = false;
  #seenState = false;

  constructor(platform: UnifiProtectPlatform, accessory: PlatformAccessory, device: Camera) {
    super(platform, accessory, device);
    const { Service, Characteristic } = platform;

    this.configureInformation(
      device.marketName ?? device.type ?? "Camera",
      device.firmwareVersion,
      device.mac ?? device.id,
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

    // A doorbell is a camera whose hardware reports a ring button; the service
    // is removed if a camera stops reporting one, so a swapped device does not
    // leave a phantom button behind.
    this.#doorbell = this.optionalService(
      isDoorbell(device),
      Service.Doorbell,
      `${this.displayName} Doorbell`,
      "doorbell",
    );
    this.#doorbell?.setCharacteristic(
      Characteristic.ConfiguredName,
      `${this.displayName} Doorbell`,
    );

    this.#warnAboutBlockedSmartDetection();

    if (platform.options.enableStreaming && platform.hasCodecs) {
      this.#streaming = new StreamingDelegate(platform, () => this.device);
      this.#controller = this.#buildController(this.#streaming);
      accessory.configureController(this.#controller);
    }

    this.update(device);
  }

  /**
   * Advertise what this camera can actually deliver.
   *
   * The resolution list leads with the camera's own channel sizes, so the size
   * HomeKit picks is usually one the stream can be copied for rather than
   * transcoded. Audio is advertised only when the host's ffmpeg can produce
   * AAC-ELD: offering a codec that cannot be delivered gets a viewer a silent
   * stream and no explanation, where offering none at all gets them a working
   * picture.
   */
  #buildController(delegate: StreamingDelegate): CameraController {
    const { codecs } = this.platform;

    return new this.platform.api.hap.CameraController({
      // Two is what the HAP specification asks of a camera that is not doing
      // Secure Video; it is what lets a second device watch at the same time.
      cameraStreamCount: 2,
      delegate,
      streamingOptions: {
        supportedCryptoSuites: [SrtpCryptoSuite.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: advertisedResolutions(this.device),
          codec: {
            profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
            levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
          },
        },
        ...(codecs.audioEncoder
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
      // The controller takes over the motion service the accessory already
      // built, rather than adding a second one beside it.
      sensors: { motion: this.#motion },
    });
  }

  protected get isReadable(): boolean {
    return this.#seenState;
  }

  /**
   * Trip the motion sensor, or extend the trip if it is already running.
   *
   * Protect reports motion as a stream of events seconds apart while somebody
   * is moving. Reflecting each one straight into HomeKit turns one person
   * walking up a path into a burst of notifications, so the sensor is held on
   * for a configured window and the window restarts on each new event.
   */
  triggerMotion(): void {
    if (this.disposed) return;

    this.#seenState = true;
    if (!this.#motionActive) {
      this.#motionActive = true;
      this.#motion.updateCharacteristic(this.platform.Characteristic.MotionDetected, true);
      this.platform.log.debug(`${this.displayName}: motion`);
    }

    this.clearTimer(this.#motionTimer);
    this.#motionTimer = this.setTimer(() => {
      this.#motionActive = false;
      this.#motionTimer = undefined;
      this.#motion.updateCharacteristic(this.platform.Characteristic.MotionDetected, false);
    }, this.platform.options.motionDurationMs);
  }

  /** Fire the doorbell button. HomeKit has no "still ringing" state to hold. */
  triggerRing(): void {
    if (this.disposed || !this.#doorbell) return;
    this.platform.log.info(`${this.displayName}: doorbell pressed`);
    this.#doorbell.updateCharacteristic(
      this.platform.Characteristic.ProgrammableSwitchEvent,
      // SINGLE_PRESS. Written numerically for the same reason as HapStatusError:
      // the enum is ambient and `verbatimModuleSyntax` forbids reaching into it.
      0,
    );
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

  /**
   * Say once, at start-up, when a camera's smart-detect zones ask for something
   * the device switch does not allow — the console reports nothing in that case,
   * forever, with no error anywhere, and zero events read as "nobody was there".
   */
  #warnAboutBlockedSmartDetection(): void {
    const gate = smartDetectGate(this.device);
    if (gate.blocked.length === 0) return;

    this.platform.log.warn(
      `${this.displayName}: smart-detect zones ask for [${gate.blocked.join(", ")}] but the ` +
        `camera's own detection switch allows only [${gate.enabled.join(", ") || "nothing"}]. ` +
        `Those detections will never fire — enable them on the camera in Protect.`,
    );
  }
}
