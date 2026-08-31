import type { CameraController, PlatformAccessory, Service } from "homebridge";
import {
  cameraAmbientLux,
  hasAmbientLightSensor,
  isDoorbell,
  smartDetectGate,
  type Camera,
} from "@mgcrea/unifi-protect";

import { BaseAccessory } from "#accessories/base-accessory";
import {
  AudioBitrate,
  AudioCodec,
  AudioRecordingCodec,
  AudioRecordingSamplerate,
  AudioSamplerate,
  H264Level,
  H264Profile,
  SrtpCryptoSuite,
} from "#media/hap";
import { RecordingDelegate } from "#media/recording-delegate";
import { advertisedResolutions, recordingResolutions } from "#media/rtsp";
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
  readonly #lightSensor: Service | undefined;
  readonly #streaming: StreamingDelegate | undefined;
  readonly #recording: RecordingDelegate | undefined;
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

    // Only the models with the hardware for it. Protect exposes no lux reading
    // at all, so this is `isDark` in the clothes of a light sensor — see
    // `cameraAmbientLux`, which is explicit about the two values being an
    // encoding rather than a measurement.
    this.#lightSensor = this.optionalService(
      hasAmbientLightSensor(device),
      Service.LightSensor,
      `${this.displayName} Light`,
      "light",
    );
    this.#lightSensor?.setCharacteristic(
      Characteristic.ConfiguredName,
      `${this.displayName} Light`,
    );
    this.#lightSensor?.getCharacteristic(Characteristic.CurrentAmbientLightLevel).onGet(() => {
      const lux = cameraAmbientLux(this.device);
      this.assertReadable();
      if (lux === undefined) throw new this.platform.api.hap.HapStatusError(-70402);
      return lux;
    });

    this.#warnAboutBlockedSmartDetection();

    if (platform.options.enableStreaming && platform.hasCodecs) {
      this.#streaming = new StreamingDelegate(platform, () => this.device);
      this.#recording = platform.options.enableRecording
        ? new RecordingDelegate(
            platform,
            () => this.device,
            (channel) => this.#streaming!.inputFor(channel),
          )
        : undefined;
      this.#controller = this.#buildController(this.#streaming, this.#recording);
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
  #buildController(
    delegate: StreamingDelegate,
    recording: RecordingDelegate | undefined,
  ): CameraController {
    const { codecs } = this.platform;

    return new this.platform.api.hap.CameraController({
      // Each concurrent viewer costs one ffmpeg — a few percent of a core on
      // the copy path, a whole one if it has to transcode. Ten is what the
      // plugin this replaces advertises, and HomeKit rarely opens more than
      // two or three.
      cameraStreamCount: 10,
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
      ...(recording
        ? {
            recording: {
              delegate: recording,
              options: {
                // Four seconds of history before the trigger, which is what
                // HomeKit cameras conventionally offer and what makes a clip
                // start with someone approaching rather than already at the door.
                prebufferLength: 4000,
                mediaContainerConfiguration: {
                  type: 0, // MediaContainerType.FRAGMENTED_MP4
                  fragmentLength: 4000,
                },
                video: {
                  type: 0, // VideoCodecType.H264
                  parameters: {
                    profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
                    levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
                  },
                  // Native sizes only. See `recordingResolutions`: a prebuffer
                  // runs for as long as recording is armed, so a size no
                  // channel provides costs a permanently re-encoding ffmpeg.
                  resolutions: recordingResolutions(this.device),
                },
                audio: {
                  codecs: [
                    {
                      // AAC-LC, which ffmpeg's built-in encoder produces. Live
                      // streaming needs AAC-ELD and therefore libfdk_aac; a
                      // recording does not, so a host without it still records
                      // with sound even though it streams silently.
                      type: AudioRecordingCodec.AAC_LC,
                      audioChannels: 1,
                      bitrateMode: AudioBitrate.VARIABLE,
                      samplerate: [
                        AudioRecordingSamplerate.KHZ_24,
                        AudioRecordingSamplerate.KHZ_32,
                      ],
                    },
                  ],
                },
              },
            },
          }
        : {}),
      // The controller takes over the motion service the accessory already
      // built, rather than adding a second one beside it. Secure Video uses it
      // as the recording trigger.
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
      this.platform.debug(`${this.displayName}: motion`);
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

    const lux = cameraAmbientLux(device);
    if (this.#lightSensor && lux !== undefined) {
      this.#lightSensor.updateCharacteristic(
        this.platform.Characteristic.CurrentAmbientLightLevel,
        lux,
      );
    }
  }

  override dispose(): void {
    super.dispose();
    this.#streaming?.dispose();
    this.#recording?.dispose();
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
