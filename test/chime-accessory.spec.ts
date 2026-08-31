/**
 * The UP Chime, against a fake HAP.
 *
 * HomeKit has no "pick one of these" primitive, so a tone becomes one switch
 * per tone with exactly one on. The assertions are about what the Home app
 * would show, and about the one place this plugin writes to the console.
 */
import { parseBootstrap } from "@mgcrea/unifi-protect";
import { describe, expect, it, vi } from "vitest";

import { ChimeAccessory } from "#accessories/chime-accessory";

import { createFakePlatform, FakeAccessory, type FakeService } from "./fake-hap.js";

const NVR = { id: "nvr-1", name: "Console", version: "7.2.55" };

const TONES = [
  { id: "tone-default", name: "Default", isDefault: true },
  { id: "tone-traditional", name: "Traditional", isDefault: true },
  { id: "tone-sundrops", name: "Sundrops", isDefault: true },
];

const aChime = (over: Record<string, unknown> = {}) =>
  parseBootstrap({
    nvr: NVR,
    chimes: [
      {
        id: "chime-1",
        modelKey: "chime",
        mac: "F4E2C60CFAE3",
        name: "Chime",
        volume: 100,
        ringSettings: [{ cameraId: "doorbell-1", ringtoneId: "tone-traditional", volume: 40 }],
        ...over,
      },
    ],
    ringtones: TONES,
  }).chimes[0]!;

const build = (over: Record<string, unknown> = {}, client?: unknown) => {
  const accessory = new FakeAccessory();
  const platform = createFakePlatform(client ? { client } : {});
  const chime = new ChimeAccessory(platform, accessory as never, aChime(over), TONES);
  return { accessory, platform, chime };
};

const toneSwitch = (accessory: FakeAccessory, id: string): FakeService | undefined =>
  accessory.getServiceById("Switch", `tone-${id}`);

describe("ChimeAccessory", () => {
  it("offers one switch per tone the console holds", () => {
    const { accessory } = build();
    for (const tone of TONES) expect(toneSwitch(accessory, tone.id)).toBeDefined();
  });

  it("shows exactly the selected tone as on", () => {
    const { accessory } = build();
    expect(toneSwitch(accessory, "tone-traditional")!.read("On")).toBe(true);
    expect(toneSwitch(accessory, "tone-default")!.read("On")).toBe(false);
    expect(toneSwitch(accessory, "tone-sundrops")!.read("On")).toBe(false);
  });

  it("writes the chosen tone to the console and moves the switches together", async () => {
    const patch = vi.fn<(path: string, body: unknown) => Promise<unknown>>(async () => undefined);
    const { accessory } = build({}, { patch });

    await toneSwitch(accessory, "tone-sundrops")!.getCharacteristic("On").setHandler!(true);

    expect(patch).toHaveBeenCalledWith("chimes/chime-1", {
      ringSettings: [{ cameraId: "doorbell-1", ringtoneId: "tone-sundrops", volume: 40 }],
    });
    expect(toneSwitch(accessory, "tone-sundrops")!.read("On")).toBe(true);
    expect(toneSwitch(accessory, "tone-traditional")!.read("On")).toBe(false);
  });

  it("leaves the console alone when a switch is turned off", async () => {
    // A chime always plays something, so "off" has no meaning. Accepting it
    // would leave every switch dark with the chime still ringing.
    const patch = vi.fn<(path: string, body: unknown) => Promise<unknown>>(async () => undefined);
    const { accessory } = build({}, { patch });

    await toneSwitch(accessory, "tone-traditional")!.getCharacteristic("On").setHandler!(false);

    expect(patch).not.toHaveBeenCalled();
  });

  it("tells HomeKit the write failed rather than leaving a tile that lies", async () => {
    const patch = vi.fn<(path: string, body: unknown) => Promise<unknown>>(async () => {
      throw new Error("console refused");
    });
    const { accessory } = build({}, { patch });

    await expect(
      toneSwitch(accessory, "tone-default")!.getCharacteristic("On").setHandler!(true),
    ).rejects.toThrow("HAP -70402");
  });

  it("refuses to set a tone for a chime no doorbell is paired with", async () => {
    const patch = vi.fn<(path: string, body: unknown) => Promise<unknown>>(async () => undefined);
    const { accessory, platform } = build({ ringSettings: [] }, { patch });

    await expect(
      toneSwitch(accessory, "tone-default")!.getCharacteristic("On").setHandler!(true),
    ).rejects.toThrow("HAP -70402");
    expect(patch).not.toHaveBeenCalled();
    expect(platform.log.warn).toHaveBeenCalled();
  });

  it("drops a switch for a tone the console no longer has", () => {
    // Homebridge restores services from its cache, so a switch left behind
    // would sit in the Home app wired to an id that is gone.
    const { accessory, chime } = build();
    expect(toneSwitch(accessory, "tone-sundrops")).toBeDefined();

    chime.setRingtones(TONES.slice(0, 2));
    expect(toneSwitch(accessory, "tone-sundrops")).toBeUndefined();
    expect(toneSwitch(accessory, "tone-default")).toBeDefined();
  });

  it("reports the per-camera volume, which is what actually plays", () => {
    expect(build().chime.volume).toBe(40);
  });
});
