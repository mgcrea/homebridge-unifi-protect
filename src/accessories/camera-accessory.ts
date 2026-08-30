import type { PlatformAccessory, Service } from "homebridge";
import { isDoorbell, smartDetectGate, type Camera } from "@mgcrea/unifi-protect";

import { BaseAccessory } from "#accessories/base-accessory";
import type { UnifiProtectPlatform } from "#platform";

/**
 * A Protect camera in HomeKit.
 *
 * At this stage it carries the two services that drive automations — motion and
 * the doorbell button — and no video. Streaming and HomeKit Secure Video attach
 * a CameraController to this same accessory later; keeping the sensor half
 * complete and correct first means the automation value lands without waiting
 * on the media stack.
 */
export class CameraAccessory extends BaseAccessory<Camera> {
  readonly #motion: Service;
  readonly #doorbell: Service | undefined;

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
    this.update(device);
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
