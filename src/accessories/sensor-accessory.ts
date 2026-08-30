import type { PlatformAccessory, Service } from "homebridge";
import {
  sensorHumidity,
  sensorIsLeaking,
  sensorIsTampered,
  sensorLight,
  sensorTemperature,
  type Sensor,
} from "@mgcrea/unifi-protect";

import { BaseAccessory } from "#accessories/base-accessory";
import type { UnifiProtectPlatform } from "#platform";

/**
 * A UP Sense.
 *
 * One physical device reports as many as seven distinct things, and which of
 * them are meaningful depends on how it was mounted — a door-mounted sense
 * reports contact, a leak-mounted one reports water and its contact state means
 * nothing. Rather than guess from `mountType`, each service is created only
 * when the console is actually reporting that measurement, and removed when it
 * stops: a service backed by nothing shows a plausible fabricated value
 * forever, which on a door sensor is a wrong answer about a door.
 */
export class SensorAccessory extends BaseAccessory<Sensor> {
  readonly #battery: Service;
  #contact: Service | undefined;
  #motion: Service | undefined;
  #temperature: Service | undefined;
  #humidity: Service | undefined;
  #ambientLight: Service | undefined;
  #leak: Service | undefined;

  #motionTimer: NodeJS.Timeout | undefined;
  #motionActive = false;
  #seenState = false;

  constructor(platform: UnifiProtectPlatform, accessory: PlatformAccessory, device: Sensor) {
    super(platform, accessory, device);
    const { Service, Characteristic } = platform;

    this.configureInformation(
      device.marketName ?? device.type ?? "UP Sense",
      device.firmwareVersion,
      device.mac ?? device.id,
    );

    this.#battery =
      accessory.getService(Service.Battery) ?? accessory.addService(Service.Battery, "Battery");
    this.#battery.getCharacteristic(Characteristic.BatteryLevel).onGet(() => {
      this.assertReadable();
      return this.#batteryLevel();
    });
    this.#battery.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => {
      this.assertReadable();
      return this.#batteryLevel() < 20 ? 1 : 0;
    });

    this.#reconcileServices(device);
    this.update(device);
  }

  protected get isReadable(): boolean {
    return this.#seenState;
  }

  triggerMotion(): void {
    if (this.disposed || !this.#motion) return;
    this.#motionActive = true;
    this.#motion.updateCharacteristic(this.platform.Characteristic.MotionDetected, true);

    this.clearTimer(this.#motionTimer);
    this.#motionTimer = this.setTimer(() => {
      this.#motionActive = false;
      this.#motionTimer = undefined;
      this.#motion?.updateCharacteristic(this.platform.Characteristic.MotionDetected, false);
    }, this.platform.options.motionDurationMs);
  }

  update(device: Sensor): void {
    this.device = device;
    this.#seenState = true;
    this.#reconcileServices(device);

    const { Characteristic } = this.platform;

    this.#battery.updateCharacteristic(Characteristic.BatteryLevel, this.#batteryLevel());
    this.#battery.updateCharacteristic(
      Characteristic.StatusLowBattery,
      this.#batteryLevel() < 20 ? 1 : 0,
    );

    if (this.#contact) {
      this.#contact.updateCharacteristic(
        Characteristic.ContactSensorState,
        device.isOpened === true ? 1 : 0,
      );
      // Tamper is reported on whichever services the device exposes; the
      // contact one is where a person looks first.
      this.#contact.updateCharacteristic(
        Characteristic.StatusTampered,
        sensorIsTampered(device) ? 1 : 0,
      );
    }

    const temperature = sensorTemperature(device);
    if (this.#temperature && temperature !== undefined) {
      this.#temperature.updateCharacteristic(Characteristic.CurrentTemperature, temperature);
    }

    const humidity = sensorHumidity(device);
    if (this.#humidity && humidity !== undefined) {
      this.#humidity.updateCharacteristic(
        Characteristic.CurrentRelativeHumidity,
        Math.min(Math.max(humidity, 0), 100),
      );
    }

    const light = sensorLight(device);
    if (this.#ambientLight && light !== undefined) {
      // HAP rejects a lux value below 0.0001 and drops the update.
      this.#ambientLight.updateCharacteristic(
        Characteristic.CurrentAmbientLightLevel,
        Math.max(light, 0.0001),
      );
    }

    if (this.#leak) {
      this.#leak.updateCharacteristic(Characteristic.LeakDetected, sensorIsLeaking(device) ? 1 : 0);
    }

    if (device.isMotionDetected === true && !this.#motionActive) {
      this.triggerMotion();
    }
  }

  /**
   * Create or remove services to match what the console is reporting now.
   *
   * Run on every update, not only at construction: a sense re-mounted from a
   * door to a water tray starts reporting leaks and stops reporting contact,
   * and Homebridge would otherwise restore the old service from its cache.
   */
  #reconcileServices(device: Sensor): void {
    const { Service } = this.platform;

    this.#contact = this.optionalService(
      device.isOpened !== undefined,
      Service.ContactSensor,
      `${this.displayName} Contact`,
      "contact",
    );
    this.#motion = this.optionalService(
      device.motionSettings.isEnabled !== false && device.isMotionDetected !== undefined,
      Service.MotionSensor,
      `${this.displayName} Motion`,
      "motion",
    );
    this.#temperature = this.optionalService(
      sensorTemperature(device) !== undefined,
      Service.TemperatureSensor,
      `${this.displayName} Temperature`,
      "temperature",
    );
    this.#humidity = this.optionalService(
      sensorHumidity(device) !== undefined,
      Service.HumiditySensor,
      `${this.displayName} Humidity`,
      "humidity",
    );
    this.#ambientLight = this.optionalService(
      sensorLight(device) !== undefined,
      Service.LightSensor,
      `${this.displayName} Light`,
      "light",
    );
    this.#leak = this.optionalService(
      device.leakSettings.isEnabled === true || sensorIsLeaking(device),
      Service.LeakSensor,
      `${this.displayName} Leak`,
      "leak",
    );
  }

  #batteryLevel(): number {
    const percentage = this.device.batteryStatus?.percentage;
    return typeof percentage === "number"
      ? Math.min(Math.max(Math.round(percentage), 0), 100)
      : 100;
  }
}
