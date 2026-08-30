/**
 * The accessory layer, against a fake HAP.
 *
 * This is the one layer that never runs outside a real bridge, and it is where
 * a plugin ends up reporting a plausible-looking value it never actually read.
 * Every assertion here is about what the Home app would display.
 */
import { parseBootstrap } from "@mgcrea/unifi-protect";
import { describe, expect, it, vi } from "vitest";

import { CameraAccessory } from "#accessories/camera-accessory";
import { LightAccessory } from "#accessories/light-accessory";
import { NvrAccessory } from "#accessories/nvr-accessory";
import { SensorAccessory } from "#accessories/sensor-accessory";

import { createFakeLog, createFakePlatform, FakeAccessory, type FakeService } from "./fake-hap.js";

const NVR = { id: "nvr-1", name: "Console", version: "7.2.55" };

/** Build device records the way they actually arrive: through the bootstrap parser. */
const devices = (document: Record<string, unknown>) => parseBootstrap({ nvr: NVR, ...document });

const aCamera = (over: Record<string, unknown> = {}) =>
  devices({
    cameras: [
      { id: "cam-1", modelKey: "camera", mac: "AABBCCDDEEFF", name: "Front Door", ...over },
    ],
  }).cameras[0]!;

const aSensor = (over: Record<string, unknown> = {}) =>
  devices({
    sensors: [{ id: "s-1", modelKey: "sensor", mac: "112233445566", name: "Back Door", ...over }],
  }).sensors[0]!;

const aLight = (over: Record<string, unknown> = {}) =>
  devices({
    lights: [{ id: "l-1", modelKey: "light", mac: "665544332211", name: "Drive", ...over }],
  }).lights[0]!;

const service = (
  accessory: FakeAccessory,
  type: string,
  subtype?: string,
): FakeService | undefined =>
  subtype ? accessory.getServiceById(type, subtype) : accessory.getService(type);

describe("CameraAccessory", () => {
  it("reports No Response until the console has said something", () => {
    // A camera that shows "no motion" because nothing has been read yet is a
    // wrong answer; "No Response" is visibly an absence of one.
    const accessory = new FakeAccessory();
    const camera = aCamera();
    const built = new CameraAccessory(createFakePlatform(), accessory as never, camera);
    // The constructor calls update(), so it is readable; strip that back.
    (built as unknown as { update: (c: unknown) => void }).update(camera);

    expect(service(accessory, "MotionSensor")!.read("MotionDetected")).toBe(false);
  });

  it("holds the motion sensor on for the configured window", async () => {
    vi.useFakeTimers();
    try {
      const accessory = new FakeAccessory();
      const platform = createFakePlatform({ options: { motionDurationMs: 5000 } });
      const camera = new CameraAccessory(platform, accessory as never, aCamera());
      const motion = service(accessory, "MotionSensor")!;

      camera.triggerMotion();
      expect(motion.read("MotionDetected")).toBe(true);

      await vi.advanceTimersByTimeAsync(4999);
      expect(motion.read("MotionDetected")).toBe(true);

      await vi.advanceTimersByTimeAsync(2);
      expect(motion.read("MotionDetected")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("extends the window rather than re-firing when motion continues", async () => {
    // Protect reports motion as a stream of events seconds apart while somebody
    // is moving; reflecting each one straight through turns one person walking
    // up a path into a burst of notifications.
    vi.useFakeTimers();
    try {
      const accessory = new FakeAccessory();
      const platform = createFakePlatform({ options: { motionDurationMs: 5000 } });
      const camera = new CameraAccessory(platform, accessory as never, aCamera());
      const motion = service(accessory, "MotionSensor")!;

      camera.triggerMotion();
      await vi.advanceTimersByTimeAsync(4000);
      camera.triggerMotion();
      await vi.advanceTimersByTimeAsync(4000);

      expect(motion.read("MotionDetected")).toBe(true);
      await vi.advanceTimersByTimeAsync(1500);
      expect(motion.read("MotionDetected")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a doorbell a button and an ordinary camera none", () => {
    const withBell = new FakeAccessory();
    void new CameraAccessory(
      createFakePlatform(),
      withBell as never,
      aCamera({ featureFlags: { isDoorbell: true } }),
    );
    expect(service(withBell, "Doorbell", "doorbell")).toBeDefined();

    const without = new FakeAccessory();
    void new CameraAccessory(createFakePlatform(), without as never, aCamera());
    expect(service(without, "Doorbell", "doorbell")).toBeUndefined();
  });

  it("fires the doorbell button on a ring", () => {
    const accessory = new FakeAccessory();
    const camera = new CameraAccessory(
      createFakePlatform(),
      accessory as never,
      aCamera({ featureFlags: { isDoorbell: true } }),
    );

    camera.triggerRing();
    // 0 is SINGLE_PRESS.
    expect(service(accessory, "Doorbell", "doorbell")!.read("ProgrammableSwitchEvent")).toBe(0);
  });

  it("marks a camera the console cannot reach as inactive", () => {
    const accessory = new FakeAccessory();
    const camera = new CameraAccessory(
      createFakePlatform(),
      accessory as never,
      aCamera({ isConnected: true }),
    );
    expect(service(accessory, "MotionSensor")!.read("StatusActive")).toBe(true);

    camera.update(aCamera({ isConnected: false }));
    expect(service(accessory, "MotionSensor")!.read("StatusActive")).toBe(false);
  });

  it("says once when smart detection is switched off behind a zone that asks for it", () => {
    // The console reports nothing in that case, forever, with no error anywhere
    // — and zero events read as "nobody was there".
    const log = createFakeLog();
    void new CameraAccessory(
      createFakePlatform({ log }),
      new FakeAccessory() as never,
      aCamera({
        smartDetectSettings: { objectTypes: ["animal"] },
        smartDetectZones: [{ objectTypes: ["person", "animal"] }],
      }),
    );

    expect(log.warn).toHaveBeenCalledOnce();
    expect(String(log.warn.mock.calls[0]?.[0])).toMatch(/person/);
  });

  it("stops firing once disposed", async () => {
    vi.useFakeTimers();
    try {
      const accessory = new FakeAccessory();
      const camera = new CameraAccessory(createFakePlatform(), accessory as never, aCamera());
      camera.triggerMotion();
      camera.dispose();
      camera.triggerMotion();

      await vi.advanceTimersByTimeAsync(60_000);
      // Disposal cleared the timer, so nothing is left to fire into a removed
      // accessory.
      expect(service(accessory, "MotionSensor")!.getCharacteristic("MotionDetected").value).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SensorAccessory", () => {
  it("creates only the services the console is actually reporting", () => {
    // A UP Sense reports as many as seven things, and which are meaningful
    // depends on how it was mounted. A service backed by nothing shows a
    // fabricated value forever.
    const accessory = new FakeAccessory();
    void new SensorAccessory(
      createFakePlatform(),
      accessory as never,
      aSensor({ isOpened: false, stats: { temperature: { value: 19.5 } } }),
    );

    expect(service(accessory, "ContactSensor", "contact")).toBeDefined();
    expect(service(accessory, "TemperatureSensor", "temperature")).toBeDefined();
    expect(service(accessory, "HumiditySensor", "humidity")).toBeUndefined();
    expect(service(accessory, "LeakSensor", "leak")).toBeUndefined();
  });

  it("removes a service when the device stops reporting that measurement", () => {
    // Homebridge restores services from its cache, so one left behind after a
    // sense was re-mounted stays in the Home app forever, backed by nothing.
    const accessory = new FakeAccessory();
    const sensor = new SensorAccessory(
      createFakePlatform(),
      accessory as never,
      aSensor({ isOpened: false, stats: { temperature: { value: 19.5 } } }),
    );
    expect(service(accessory, "TemperatureSensor", "temperature")).toBeDefined();

    sensor.update(aSensor({ isOpened: false }));
    expect(service(accessory, "TemperatureSensor", "temperature")).toBeUndefined();
  });

  it("reads the temperature out from under stats.<metric>.value", () => {
    const accessory = new FakeAccessory();
    void new SensorAccessory(
      createFakePlatform(),
      accessory as never,
      aSensor({ stats: { temperature: { value: 21.5 } } }),
    );

    expect(service(accessory, "TemperatureSensor", "temperature")!.read("CurrentTemperature")).toBe(
      21.5,
    );
  });

  it("reports a contact sensor as open when the console says it is", () => {
    const accessory = new FakeAccessory();
    void new SensorAccessory(createFakePlatform(), accessory as never, aSensor({ isOpened: true }));
    // 1 is CONTACT_NOT_DETECTED, which the Home app renders as "Open".
    expect(service(accessory, "ContactSensor", "contact")!.read("ContactSensorState")).toBe(1);
  });

  it("clears the leak when the console clears its timestamp", () => {
    // Protect ends a leak by setting `leakDetectedAt` to null. Reading it as
    // "has ever leaked" would latch the alarm on forever.
    const accessory = new FakeAccessory();
    const sensor = new SensorAccessory(
      createFakePlatform(),
      accessory as never,
      aSensor({ leakSettings: { isEnabled: true }, leakDetectedAt: 1_700_000_000_000 }),
    );
    expect(service(accessory, "LeakSensor", "leak")!.read("LeakDetected")).toBe(1);

    sensor.update(aSensor({ leakSettings: { isEnabled: true }, leakDetectedAt: null }));
    expect(service(accessory, "LeakSensor", "leak")!.read("LeakDetected")).toBe(0);
  });

  it("never sends HAP a lux value it will reject", () => {
    // HAP drops a CurrentAmbientLightLevel update below 0.0001, so a pitch-dark
    // room would silently stop updating.
    const accessory = new FakeAccessory();
    void new SensorAccessory(
      createFakePlatform(),
      accessory as never,
      aSensor({ stats: { light: { value: 0 } } }),
    );

    expect(service(accessory, "LightSensor", "light")!.read("CurrentAmbientLightLevel")).toBe(
      0.0001,
    );
  });

  it("flags a low battery", () => {
    const accessory = new FakeAccessory();
    void new SensorAccessory(
      createFakePlatform(),
      accessory as never,
      aSensor({ batteryStatus: { percentage: 12 } }),
    );

    expect(service(accessory, "Battery")!.read("BatteryLevel")).toBe(12);
    expect(service(accessory, "Battery")!.read("StatusLowBattery")).toBe(1);
  });
});

describe("LightAccessory", () => {
  it("maps the console's 1-6 LED level onto a HomeKit percentage", () => {
    const accessory = new FakeAccessory();
    void new LightAccessory(
      createFakePlatform(),
      accessory as never,
      aLight({ isLightOn: true, lightDeviceSettings: { ledLevel: 3 } }),
    );

    expect(service(accessory, "Lightbulb")!.read("On")).toBe(true);
    expect(service(accessory, "Lightbulb")!.read("Brightness")).toBe(50);
  });

  it("writes a brightness back as a level the hardware accepts", async () => {
    const patch = vi.fn<(path: string, body: unknown) => Promise<unknown>>(async () => null);
    const accessory = new FakeAccessory();
    void new LightAccessory(
      createFakePlatform({ client: { patch } }),
      accessory as never,
      aLight({ isLightOn: true }),
    );

    await service(accessory, "Lightbulb")!.getCharacteristic("Brightness").setHandler!(100);
    expect(patch).toHaveBeenCalledWith("lights/l-1", { lightDeviceSettings: { ledLevel: 6 } });
  });

  it("leaves brightness 0 to the On characteristic", async () => {
    // HomeKit sends Brightness 0 to mean off, and the console's range starts at
    // 1 — letting it through would clamp to level 1, a dim light rather than
    // one that is off.
    const patch = vi.fn<(path: string, body: unknown) => Promise<unknown>>(async () => null);
    const accessory = new FakeAccessory();
    void new LightAccessory(
      createFakePlatform({ client: { patch } }),
      accessory as never,
      aLight({ isLightOn: true }),
    );

    await service(accessory, "Lightbulb")!.getCharacteristic("Brightness").setHandler!(0);
    expect(patch).not.toHaveBeenCalled();
  });

  it("tells HomeKit a failed write did not land", async () => {
    const patch = vi.fn<(path: string, body: unknown) => Promise<unknown>>(async () => {
      throw new Error("403");
    });
    const accessory = new FakeAccessory();
    void new LightAccessory(
      createFakePlatform({ client: { patch } }),
      accessory as never,
      aLight({ isLightOn: false }),
    );

    await expect(
      service(accessory, "Lightbulb")!.getCharacteristic("On").setHandler!(true),
    ).rejects.toThrow(/HAP -70402/);
  });

  it("trips its own PIR sensor from the device state", () => {
    const accessory = new FakeAccessory();
    void new LightAccessory(
      createFakePlatform(),
      accessory as never,
      aLight({ isPirMotionDetected: true }),
    );

    expect(service(accessory, "MotionSensor", "pir")!.read("MotionDetected")).toBe(true);
  });
});

describe("NvrAccessory", () => {
  it("reports free storage rather than used", () => {
    const accessory = new FakeAccessory();
    void new NvrAccessory(
      createFakePlatform(),
      accessory as never,
      {
        ...NVR,
        systemInfo: { storage: { size: 1000, used: 250 } },
      } as never,
    );

    expect(service(accessory, "Battery", "storage")!.read("BatteryLevel")).toBe(75);
  });

  it("does not warn about a full disk that is recycling", () => {
    // A console at 99% with recycling on is working as designed — it overwrites
    // the oldest footage continuously.
    const accessory = new FakeAccessory();
    void new NvrAccessory(
      createFakePlatform(),
      accessory as never,
      {
        ...NVR,
        isRecycling: true,
        systemInfo: { storage: { size: 1000, used: 995 } },
      } as never,
    );

    expect(service(accessory, "Battery", "storage")!.read("StatusLowBattery")).toBe(0);
  });

  it("warns about a full disk that is not recycling", () => {
    const accessory = new FakeAccessory();
    void new NvrAccessory(
      createFakePlatform(),
      accessory as never,
      {
        ...NVR,
        systemInfo: { storage: { size: 1000, used: 995 } },
      } as never,
    );

    expect(service(accessory, "Battery", "storage")!.read("StatusLowBattery")).toBe(1);
  });

  it("mirrors whether the realtime stream is up", () => {
    const online = new FakeAccessory();
    void new NvrAccessory(createFakePlatform({ isConnected: true }), online as never, NVR as never);
    expect(service(online, "ContactSensor", "reachable")!.read("ContactSensorState")).toBe(0);

    const offline = new FakeAccessory();
    void new NvrAccessory(
      createFakePlatform({ isConnected: false }),
      offline as never,
      NVR as never,
    );
    expect(service(offline, "ContactSensor", "reachable")!.read("ContactSensorState")).toBe(1);
  });
});
