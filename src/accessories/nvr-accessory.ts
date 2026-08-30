import type { PlatformAccessory, Service } from "homebridge";
import { nvrStorage, nvrUptimeSeconds, type Nvr } from "@mgcrea/unifi-protect";

import { BaseAccessory } from "#accessories/base-accessory";
import type { UnifiProtectPlatform } from "#platform";

/**
 * The console itself, as a set of diagnostic tiles.
 *
 * Opt-in, because these are diagnostics rather than home automation and would
 * otherwise clutter the Home app for everyone. Two things are surfaced: whether
 * the console is reachable, and how full its storage is — mapped onto a battery
 * service, which is the only HomeKit primitive that expresses "a percentage,
 * and a warning when it gets low".
 */
export class NvrAccessory extends BaseAccessory<Nvr & { id: string }> {
  readonly #reachability: Service;
  readonly #storage: Service;
  #seenState = false;

  constructor(platform: UnifiProtectPlatform, accessory: PlatformAccessory, device: Nvr) {
    super(platform, accessory, device as Nvr & { id: string });
    const { Service, Characteristic } = platform;

    this.configureInformation(
      device.marketName ?? device.type ?? "UniFi Console",
      device.firmwareVersion ?? device.version,
      device.mac ?? device.id,
    );

    // A contact sensor reads as Open/Closed, which is the plainest rendering of
    // "the bridge is talking to the console" the Home app offers.
    this.#reachability =
      accessory.getServiceById(Service.ContactSensor, "reachable") ??
      accessory.addService(Service.ContactSensor, `${this.displayName} Online`, "reachable");

    this.#storage =
      accessory.getServiceById(Service.Battery, "storage") ??
      accessory.addService(Service.Battery, `${this.displayName} Storage`, "storage");

    this.#reachability.getCharacteristic(Characteristic.ContactSensorState).onGet(() => {
      this.assertReadable();
      return this.platform.isConnected ? 0 : 1;
    });

    this.#storage.getCharacteristic(Characteristic.BatteryLevel).onGet(() => {
      this.assertReadable();
      return this.#freePercent();
    });

    this.update(device);
  }

  protected get isReadable(): boolean {
    return this.#seenState;
  }

  update(device: Nvr): void {
    this.device = device as Nvr & { id: string };
    this.#seenState = true;
    const { Characteristic } = this.platform;

    this.#reachability.updateCharacteristic(
      Characteristic.ContactSensorState,
      this.platform.isConnected ? 0 : 1,
    );

    const free = this.#freePercent();
    this.#storage.updateCharacteristic(Characteristic.BatteryLevel, free);
    // A console at 99% used with recycling on is working AS DESIGNED — it
    // overwrites the oldest footage continuously — so it must not raise a low
    // "battery" warning that reads as a fault.
    this.#storage.updateCharacteristic(
      Characteristic.StatusLowBattery,
      !nvrStorage(device).isRecycling && free < 10 ? 1 : 0,
    );

    this.platform.log.debug(
      `${this.displayName}: up ${nvrUptimeSeconds(device) ?? "?"}s, ${free}% storage free`,
    );
  }

  /** Free storage as a percentage. Unknown reads as full rather than as empty. */
  #freePercent(): number {
    const { totalBytes, usedBytes } = nvrStorage(this.device);
    if (!totalBytes || usedBytes === undefined) return 100;
    return Math.min(Math.max(Math.round(((totalBytes - usedBytes) / totalBytes) * 100), 0), 100);
  }
}
