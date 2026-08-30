import type { PlatformAccessory, Service, WithUUID } from "homebridge";

import { MANUFACTURER } from "#settings";
import type { UnifiProtectPlatform } from "#platform";

/** HAP refuses a SerialNumber longer than this, and drops the whole accessory. */
const MAX_SERIAL_LENGTH = 64;

/**
 * The little every Protect record has in common. Written with explicit
 * `| undefined` so an `exactOptionalPropertyTypes` caller can pass one of the
 * client's loose device types straight in.
 */
export type ProtectDeviceLike = {
  id: string;
  mac?: string | undefined;
  name?: string | null | undefined;
};

/**
 * What every Protect device carries, whichever kind it is.
 *
 * There is no class hierarchy below this on purpose — each device type is a
 * hand-written class that owns its own services. This holds only the parts that
 * are genuinely identical: the AccessoryInformation block, the
 * add-or-remove-a-service helper, the "No Response" guard, and disposal.
 */
export abstract class BaseAccessory<TDevice extends ProtectDeviceLike> {
  protected readonly platform: UnifiProtectPlatform;
  protected readonly accessory: PlatformAccessory;
  protected device: TDevice;

  #disposed = false;
  /** Timers this accessory owns, cleared as one on disposal. */
  readonly #timers = new Set<NodeJS.Timeout>();

  constructor(platform: UnifiProtectPlatform, accessory: PlatformAccessory, device: TDevice) {
    this.platform = platform;
    this.accessory = accessory;
    this.device = device;
  }

  get id(): string {
    return this.device.id;
  }

  get displayName(): string {
    return this.device.name ?? this.device.id;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * Whether the console has told us anything about this device yet.
   *
   * Until it has, reads throw rather than reporting a plausible-looking value.
   * A contact sensor that shows "Closed" because nothing has been read yet is
   * worse than one that shows "No Response": the first is a wrong answer about
   * a door, the second is visibly an absence of one.
   */
  protected abstract get isReadable(): boolean;

  protected assertReadable(): void {
    if (!this.isReadable) {
      // -70402 is `HAPStatus.SERVICE_COMMUNICATION_FAILURE`. Spelled numerically
      // because the enum is an ambient const enum, which `verbatimModuleSyntax`
      // forbids reaching into at runtime.
      throw new this.platform.api.hap.HapStatusError(-70402);
    }
  }

  protected configureInformation(
    model: string,
    firmware: string | undefined,
    serial: string,
  ): void {
    const { Service, Characteristic } = this.platform;
    const information =
      this.accessory.getService(Service.AccessoryInformation) ??
      this.accessory.addService(Service.AccessoryInformation);

    information
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, model)
      .setCharacteristic(Characteristic.SerialNumber, usableSerial(serial, this.device.id))
      .setCharacteristic(Characteristic.Name, this.displayName);

    if (firmware) {
      information.setCharacteristic(Characteristic.FirmwareRevision, firmware);
    }
  }

  /**
   * Add a service, or REMOVE it when the option is off.
   *
   * The removal half is what matters: Homebridge restores services from its
   * accessory cache, so a service left behind after its option was turned off
   * stays in the Home app forever, backed by nothing.
   */
  protected optionalService(
    enabled: boolean,
    type: WithUUID<typeof Service>,
    name: string,
    subtype: string,
  ): Service | undefined {
    const existing = this.accessory.getServiceById(type, subtype);
    if (!enabled) {
      if (existing) this.accessory.removeService(existing);
      return undefined;
    }
    return existing ?? this.accessory.addService(type, name, subtype);
  }

  /** A timer that is cleared on disposal and never holds the event loop open. */
  protected setTimer(fn: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      fn();
    }, ms);
    timer.unref?.();
    this.#timers.add(timer);
    return timer;
  }

  protected clearTimer(timer: NodeJS.Timeout | undefined): void {
    if (!timer) return;
    clearTimeout(timer);
    this.#timers.delete(timer);
  }

  /** Called whenever the store reports a new version of this device. */
  abstract update(device: TDevice): void;

  dispose(): void {
    this.#disposed = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }
}

/**
 * HAP silently drops an accessory whose SerialNumber is over 64 characters, so
 * an over-long one is replaced by the console's id rather than risking that.
 */
export const usableSerial = (serial: string | undefined, fallback: string): string =>
  serial && serial.length > 0 && serial.length <= MAX_SERIAL_LENGTH ? serial : fallback;
