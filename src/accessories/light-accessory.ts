import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import {
  brightnessToLedLevel,
  ledLevelToBrightness,
  type Light,
  type ProtectClient,
} from "@mgcrea/unifi-protect";

import { BaseAccessory } from "#accessories/base-accessory";
import { describe } from "#util/describe";
import type { UnifiProtectPlatform } from "#platform";

/** A UP FloodLight: a dimmable lamp with its own PIR sensor. */
export class LightAccessory extends BaseAccessory<Light> {
  readonly #lightbulb: Service;
  readonly #motion: Service;
  readonly #client: ProtectClient;

  #motionTimer: NodeJS.Timeout | undefined;
  #motionActive = false;
  #seenState = false;

  constructor(platform: UnifiProtectPlatform, accessory: PlatformAccessory, device: Light) {
    super(platform, accessory, device);
    const { Service, Characteristic } = platform;

    this.#client = platform.client;
    this.configureInformation(
      device.marketName ?? device.type ?? "FloodLight",
      device.firmwareVersion,
      device.mac ?? device.id,
    );

    this.#lightbulb =
      accessory.getService(Service.Lightbulb) ??
      accessory.addService(Service.Lightbulb, this.displayName);
    this.#lightbulb.setPrimaryService(true);
    this.#lightbulb.setCharacteristic(Characteristic.ConfiguredName, this.displayName);

    this.#motion =
      accessory.getServiceById(Service.MotionSensor, "pir") ??
      accessory.addService(Service.MotionSensor, `${this.displayName} Motion`, "pir");

    this.#lightbulb
      .getCharacteristic(Characteristic.On)
      .onGet(() => {
        this.assertReadable();
        return this.device.isLightOn === true;
      })
      .onSet((value) => this.#setOn(value));

    this.#lightbulb
      .getCharacteristic(Characteristic.Brightness)
      .onGet(() => {
        this.assertReadable();
        return ledLevelToBrightness(this.device.lightDeviceSettings.ledLevel) ?? 100;
      })
      .onSet((value) => this.#setBrightness(value));

    this.#motion.getCharacteristic(Characteristic.MotionDetected).onGet(() => {
      this.assertReadable();
      return this.#motionActive;
    });

    this.update(device);
  }

  protected get isReadable(): boolean {
    return this.#seenState;
  }

  triggerMotion(): void {
    if (this.disposed) return;
    this.#motionActive = true;
    this.#motion.updateCharacteristic(this.platform.Characteristic.MotionDetected, true);

    this.clearTimer(this.#motionTimer);
    this.#motionTimer = this.setTimer(() => {
      this.#motionActive = false;
      this.#motionTimer = undefined;
      this.#motion.updateCharacteristic(this.platform.Characteristic.MotionDetected, false);
    }, this.platform.options.motionDurationMs);
  }

  update(device: Light): void {
    this.device = device;
    this.#seenState = true;
    const { Characteristic } = this.platform;

    this.#lightbulb.updateCharacteristic(Characteristic.On, device.isLightOn === true);

    const brightness = ledLevelToBrightness(device.lightDeviceSettings.ledLevel);
    if (brightness !== undefined) {
      this.#lightbulb.updateCharacteristic(Characteristic.Brightness, brightness);
    }

    // The console reports PIR state directly as well as through events; either
    // is enough to trip the sensor, and the timer keeps them from fighting.
    if (device.isPirMotionDetected === true && !this.#motionActive) {
      this.triggerMotion();
    }
  }

  async #setOn(value: CharacteristicValue): Promise<void> {
    await this.#write(
      { lightOnSettings: { isLedForceOn: value === true } },
      `turn ${value ? "on" : "off"}`,
    );
  }

  async #setBrightness(value: CharacteristicValue): Promise<void> {
    // HomeKit sends Brightness 0 to mean off, and the console has no level 0 —
    // its range is 1-6. Letting the On characteristic own off/on and clamping
    // here keeps the two from disagreeing about what 0 means.
    if (typeof value !== "number" || value <= 0) return;
    await this.#write(
      { lightDeviceSettings: { ledLevel: brightnessToLedLevel(value) } },
      `set brightness to ${value}%`,
    );
  }

  async #write(body: Record<string, unknown>, what: string): Promise<void> {
    try {
      await this.#client.patch(`lights/${this.device.id}`, body);
    } catch (error) {
      this.platform.log.warn(`${this.displayName}: could not ${what} — ${describe(error)}`);
      // Tell HomeKit the write did not land, rather than leaving the tile
      // showing a state the light is not in.
      throw new this.platform.api.hap.HapStatusError(-70402);
    }
  }
}
