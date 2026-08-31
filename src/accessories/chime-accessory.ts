import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import {
  chimeRingtoneFor,
  chimeVolume,
  type Chime,
  type ProtectClient,
  type Ringtone,
} from "@mgcrea/unifi-protect";

import { BaseAccessory } from "#accessories/base-accessory";
import { describe } from "#util/describe";
import type { UnifiProtectPlatform } from "#platform";

/**
 * A UP Chime: the PoE speaker that rings when a doorbell is pressed.
 *
 * HomeKit has no "pick one of these tones" primitive, so the tone becomes one
 * stateless-looking switch per tone, of which exactly one reads as on. That is
 * the shape the plugin this replaces uses, and it is the only arrangement the
 * Home app can express — a radio group is not something HAP offers.
 *
 * The switches are the one place in this plugin that writes to the console.
 * Everything else reads: picking a tone genuinely changes the chime's
 * configuration in Protect, exactly as the Protect app would, and there is no
 * way to offer the control without that.
 */
export class ChimeAccessory extends BaseAccessory<Chime> {
  readonly #client: ProtectClient;
  readonly #switches = new Map<string, Service>();

  #seenState = false;
  #ringtones: Ringtone[] = [];

  constructor(
    platform: UnifiProtectPlatform,
    accessory: PlatformAccessory,
    device: Chime,
    ringtones: Ringtone[],
  ) {
    super(platform, accessory, device);

    this.#client = platform.client;
    this.#ringtones = ringtones;

    this.configureInformation(
      device.marketName ?? device.type ?? "Chime",
      device.firmwareVersion,
      device.mac ?? device.id,
    );

    this.#buildSwitches();
    this.update(device);
  }

  protected get isReadable(): boolean {
    return this.#seenState;
  }

  /**
   * The doorbell this chime answers.
   *
   * A chime can be paired with several, but `ringSettings` is the only place
   * that says which — and a tone is set per doorbell, not per chime. The first
   * entry is used, because a HomeKit switch has nowhere to say "for which
   * doorbell" and inventing a switch per pair would multiply the tiles.
   */
  get #cameraId(): string | undefined {
    return this.device.ringSettings[0]?.cameraId ?? this.device.cameraIds[0];
  }

  #buildSwitches(): void {
    const { Service, Characteristic } = this.platform;

    // Rebuild from the tone library every time, so a tone added or removed on
    // the console does not leave a switch behind wired to an id that is gone.
    const wanted = new Set(this.#ringtones.map((tone) => `tone-${tone.id}`));
    // Collected before removing: mutating the service list while walking it
    // would skip entries.
    const stale = this.accessory.services.filter(
      (service) => service.subtype?.startsWith("tone-") === true && !wanted.has(service.subtype),
    );
    for (const service of stale) this.accessory.removeService(service);

    for (const tone of this.#ringtones) {
      const subtype = `tone-${tone.id}`;
      const name = tone.name ?? tone.id;
      const service =
        this.accessory.getServiceById(Service.Switch, subtype) ??
        this.accessory.addService(Service.Switch, name, subtype);

      service.setCharacteristic(Characteristic.ConfiguredName, name);
      service
        .getCharacteristic(Characteristic.On)
        .onGet(() => {
          this.assertReadable();
          return chimeRingtoneFor(this.device, this.#cameraId ?? "") === tone.id;
        })
        .onSet((value) => this.#selectTone(tone, value));

      this.#switches.set(tone.id, service);
    }
  }

  update(device: Chime): void {
    this.device = device;
    this.#seenState = true;

    const selected = chimeRingtoneFor(device, this.#cameraId ?? "");
    for (const [id, service] of this.#switches) {
      service.updateCharacteristic(this.platform.Characteristic.On, id === selected);
    }
  }

  /** Keep the tone library in step when a resync brings a different one. */
  setRingtones(ringtones: Ringtone[]): void {
    const changed =
      ringtones.length !== this.#ringtones.length ||
      ringtones.some((tone, i) => tone.id !== this.#ringtones[i]?.id);
    if (!changed) return;

    this.#ringtones = ringtones;
    this.#switches.clear();
    this.#buildSwitches();
    this.update(this.device);
  }

  /**
   * Turning a switch on selects that tone; turning one off is refused.
   *
   * A chime always plays something, so "off" has no meaning here — and letting
   * HomeKit turn the selected tone off would leave every switch dark and the
   * chime still ringing. The switch is put back rather than silently ignored,
   * so the tile matches the hardware.
   */
  async #selectTone(tone: Ringtone, value: CharacteristicValue): Promise<void> {
    const cameraId = this.#cameraId;
    if (!cameraId) {
      this.platform.log.warn(
        `${this.displayName}: no doorbell is paired with this chime, so there is no tone to set.`,
      );
      throw new this.platform.api.hap.HapStatusError(-70402);
    }

    if (value !== true) {
      // Put the tile back the way the hardware is, on the next tick so HomeKit
      // has finished with this write first.
      this.setTimer(() => this.update(this.device), 0);
      return;
    }

    const ringSettings = this.device.ringSettings.map((setting) =>
      setting.cameraId === cameraId ? { ...setting, ringtoneId: tone.id } : setting,
    );
    if (!ringSettings.some((setting) => setting.cameraId === cameraId)) {
      ringSettings.push({ cameraId, ringtoneId: tone.id });
    }

    try {
      await this.#client.patch(`chimes/${this.device.id}`, { ringSettings });
      this.platform.log.info(`${this.displayName}: ringtone set to ${tone.name ?? tone.id}.`);
      this.update({ ...this.device, ringSettings });
    } catch (error) {
      this.platform.log.warn(
        `${this.displayName}: could not set the ringtone — ${describe(error)}`,
      );
      throw new this.platform.api.hap.HapStatusError(-70402);
    }
  }

  /** The chime's volume, for anything that wants to show it. */
  get volume(): number | undefined {
    return chimeVolume(this.device, this.#cameraId);
  }
}
