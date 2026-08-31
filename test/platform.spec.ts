/**
 * The platform: discovery, registration and event routing.
 *
 * The console is replaced by a controllable store double, so the assertions are
 * about which accessories Homebridge is told to add, remove or keep, and where
 * an event lands.
 */
import type { API, PlatformConfig } from "homebridge";
import { describe, expect, it, vi } from "vitest";

import {
  createFakeLog,
  FakeAccessory,
  FakeCameraController,
  nameProxy,
  type FakeLog,
} from "./fake-hap.js";

const protect = vi.hoisted(() => {
  const store = {
    nvr: undefined as unknown,
    cameras: () => [] as unknown[],
    sensors: () => [] as unknown[],
    lights: () => [] as unknown[],
  };
  const captured: { store?: Record<string, (...args: never[]) => void> | undefined } = {};
  return {
    store,
    captured,
    connectProtect: vi.fn<(options: Record<string, unknown>) => Promise<unknown>>(
      async (options) => {
        captured.store = options["store"] as Record<string, (...args: never[]) => void>;
        return {
          store,
          client: { patch: vi.fn<(path: string, body: unknown) => Promise<unknown>>() },
          fingerprint: "AB".repeat(32),
          // Faithful to ProtectConnection: a real one always carries the TLS
          // options the console was reached with.
          tlsOptions: { rejectUnauthorized: true, ca: ["-----BEGIN CERTIFICATE-----"] },
          disconnect: vi.fn<() => Promise<void>>(async () => undefined),
        };
      },
    ),
    reset: () => {
      store.nvr = undefined;
      store.cameras = () => [];
      store.sensors = () => [];
      store.lights = () => [];
      captured.store = undefined;
      protectMockReset();
    },
  };
});

const protectMockReset = (): void => undefined;

// ffmpeg is not what this spec is about, and probing it for real would spawn a
// binary that may not exist and would not settle inside `drain()`.
vi.mock("#media/codecs", async () => {
  const { FAKE_CODECS } = await import("./fake-hap.js");
  return { probeCodecs: async () => FAKE_CODECS };
});

vi.mock("@mgcrea/unifi-protect", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, connectProtect: protect.connectProtect };
});

const { UnifiProtectPlatform } = await import("#platform");
const { parseBootstrap } = await import("@mgcrea/unifi-protect");

const NVR = { id: "nvr-1", name: "Console", version: "7.2.55" };

const camera = (over: Record<string, unknown> = {}) =>
  parseBootstrap({
    nvr: NVR,
    cameras: [
      { id: "cam-1", modelKey: "camera", mac: "AABBCCDDEEFF", name: "Front Door", ...over },
    ],
  }).cameras[0]!;

const sensor = (over: Record<string, unknown> = {}) =>
  parseBootstrap({
    nvr: NVR,
    sensors: [{ id: "s-1", modelKey: "sensor", mac: "112233445566", name: "Back Door", ...over }],
  }).sensors[0]!;

type Calls = { op: string; names: string[] }[];

type FakeApi = {
  api: API;
  calls: Calls;
  /** Every accessory handed to Homebridge, so specs can read what HomeKit sees. */
  registered: Map<string, FakeAccessory>;
  /** The seeds accessory identities were derived from. */
  seeds: string[];
  fire: (event: string) => void;
};

const createFakeApi = (): FakeApi => {
  const calls: Calls = [];
  const registered = new Map<string, FakeAccessory>();
  const seeds: string[] = [];
  const handlers = new Map<string, () => void>();

  const api = {
    hap: {
      Service: nameProxy,
      Characteristic: nameProxy,
      HapStatusError: class extends Error {},
      CameraController: FakeCameraController,
      // A stable, collision-free identity per seed is all the platform needs.
      uuid: {
        generate: (seed: string) => {
          seeds.push(seed);
          return `uuid:${seed}`;
        },
      },
    },
    // Extends the fake rather than copying from one: the accessory's methods
    // live on the prototype, and Object.assign would leave them behind.
    platformAccessory: class extends FakeAccessory {
      constructor(displayName: string, uuid: string) {
        super(uuid);
        this.displayName = displayName;
      }
    },
    user: { storagePath: () => "/tmp/homebridge-unifi-protect-spec" },
    on: (event: string, handler: () => void) => handlers.set(event, handler),
    registerPlatformAccessories: (_p: string, _n: string, accessories: FakeAccessory[]) => {
      for (const accessory of accessories) registered.set(accessory.displayName, accessory);
      return calls.push({ op: "register", names: accessories.map((a) => a.displayName) });
    },
    unregisterPlatformAccessories: (
      _p: string,
      _n: string,
      accessories: { displayName: string }[],
    ) => calls.push({ op: "unregister", names: accessories.map((a) => a.displayName) }),
    updatePlatformAccessories: (accessories: { displayName: string }[]) =>
      calls.push({ op: "update", names: accessories.map((a) => a.displayName) }),
  } as unknown as API;

  return { api, calls, registered, seeds, fire: (event) => handlers.get(event)?.() };
};

const CONFIG = {
  platform: "UniFiProtect",
  host: "10.0.0.1",
  username: "bridge",
  password: "secret",
} as unknown as PlatformConfig;

/** Settle the fire-and-forget chains the lifecycle hooks start. */
const drain = async (): Promise<void> => {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
};

const start = async (
  config: PlatformConfig = CONFIG,
  log: FakeLog = createFakeLog(),
): Promise<Omit<FakeApi, "api"> & { log: FakeLog }> => {
  const { api, calls, registered, seeds, fire } = createFakeApi();
  void new UnifiProtectPlatform(log as never, config, api);
  fire("didFinishLaunching");
  await drain();
  return { calls, registered, seeds, fire, log };
};

/** Read a characteristic the way HomeKit would, off a registered accessory. */
const read = (
  accessory: FakeAccessory | undefined,
  type: string,
  characteristic: string,
  subtype?: string,
): unknown => {
  const service = subtype ? accessory?.getServiceById(type, subtype) : accessory?.getService(type);
  return service?.read(characteristic);
};

describe("UnifiProtectPlatform", () => {
  it("stays dormant rather than taking the bridge down when misconfigured", async () => {
    protect.reset();
    const log = createFakeLog();
    await start({ platform: "UniFiProtect" } as PlatformConfig, log);

    expect(log.error).toHaveBeenCalledOnce();
    expect(protect.connectProtect).not.toHaveBeenCalled();
  });

  it("registers an accessory per device the console reports", async () => {
    protect.reset();
    protect.store.nvr = NVR;
    protect.store.cameras = () => [camera()];
    protect.store.sensors = () => [sensor()];

    const { calls } = await start();
    const registered = calls.filter((c) => c.op === "register").flatMap((c) => c.names);
    expect(registered).toEqual(["Front Door", "Back Door"]);
  });

  it("leaves the console's own diagnostics out unless asked for", async () => {
    protect.reset();
    protect.store.nvr = NVR;

    const { calls } = await start();
    expect(calls.filter((c) => c.op === "register")).toHaveLength(0);
  });

  it("honours a camera excluded in the config", async () => {
    protect.reset();
    protect.store.nvr = NVR;
    protect.store.cameras = () => [camera()];

    const { calls } = await start({
      ...CONFIG,
      cameras: [{ mac: "aa:bb:cc:dd:ee:ff", exclude: true }],
    } as unknown as PlatformConfig);

    expect(calls.filter((c) => c.op === "register")).toHaveLength(0);
  });

  it("seeds the accessory identity from the MAC, which survives re-adoption", async () => {
    // Protect issues a new `id` when a camera is removed and re-adopted; keying
    // off it would bring the camera back as a brand new accessory with its
    // automations detached.
    protect.reset();
    protect.store.nvr = NVR;
    protect.store.cameras = () => [camera({ id: "cam-original" })];
    const first = await start();

    protect.store.cameras = () => [camera({ id: "cam-readopted" })];
    const second = await start();

    expect(first.seeds).toEqual(["camera:AABBCCDDEEFF"]);
    expect(second.seeds).toEqual(first.seeds);
  });

  it("removes an accessory for a device the console no longer has", async () => {
    protect.reset();
    protect.store.nvr = NVR;
    protect.store.cameras = () => [camera()];
    const { calls } = await start();

    protect.store.cameras = () => [];
    protect.captured.store?.["onResync"]?.();
    await drain();

    expect(calls.filter((c) => c.op === "unregister").flatMap((c) => c.names)).toEqual([
      "Front Door",
    ]);
  });

  it("routes a motion event to the camera it names", async () => {
    protect.reset();
    protect.store.nvr = NVR;
    protect.store.cameras = () => [camera()];
    const { registered } = await start();
    const accessory = registered.get("Front Door");

    expect(read(accessory, "MotionSensor", "MotionDetected")).toBe(false);

    protect.captured.store?.["onEvent"]?.({
      id: "e1",
      type: "motion",
      camera: "cam-1",
      start: 1,
      smartDetectTypes: [],
    } as never);

    expect(read(accessory, "MotionSensor", "MotionDetected")).toBe(true);
  });

  it("fires the doorbell button on a ring, and not on motion", async () => {
    protect.reset();
    protect.store.nvr = NVR;
    protect.store.cameras = () => [camera({ featureFlags: { isDoorbell: true } })];
    const { registered } = await start();
    const accessory = registered.get("Front Door");

    protect.captured.store?.["onEvent"]?.({
      id: "e1",
      type: "ring",
      camera: "cam-1",
      start: 1,
      smartDetectTypes: [],
    } as never);

    // 0 is SINGLE_PRESS.
    expect(read(accessory, "Doorbell", "ProgrammableSwitchEvent", "doorbell")).toBe(0);
  });

  it("treats a smart detection as motion", async () => {
    protect.reset();
    protect.store.nvr = NVR;
    protect.store.cameras = () => [camera()];
    const { registered } = await start();

    protect.captured.store?.["onEvent"]?.({
      id: "e1",
      type: "smartDetectZone",
      camera: "cam-1",
      start: 1,
      smartDetectTypes: ["person"],
    } as never);

    expect(read(registered.get("Front Door"), "MotionSensor", "MotionDetected")).toBe(true);
  });

  it("ignores the closing half of an event, so motion does not re-trip as it ends", async () => {
    // Protect reports an event twice: once when it starts, once with `end`
    // filled in. Acting on both re-trips the sensor exactly as movement stopped.
    protect.reset();
    protect.store.nvr = NVR;
    protect.store.cameras = () => [camera()];
    const { registered } = await start();

    protect.captured.store?.["onEvent"]?.({
      id: "e1",
      type: "motion",
      camera: "cam-1",
      start: 1,
      end: 2,
      smartDetectTypes: [],
    } as never);

    expect(read(registered.get("Front Door"), "MotionSensor", "MotionDetected")).toBe(false);
  });

  it("ignores an event for a device it never registered", async () => {
    protect.reset();
    protect.store.nvr = NVR;
    await start();

    expect(() =>
      protect.captured.store?.["onEvent"]?.({
        id: "e1",
        type: "motion",
        camera: "unknown",
        start: 1,
        smartDetectTypes: [],
      } as never),
    ).not.toThrow();
  });

  it("says the certificate fingerprint once, so the trust can be made explicit", async () => {
    protect.reset();
    protect.store.nvr = NVR;
    const { log } = await start();

    expect(log.info.mock.calls.some((call) => String(call[0]).includes("fingerprint"))).toBe(true);
  });

  it("shows its own debug output when the plugin's debug box is ticked", async () => {
    // Homebridge hides `log.debug` unless the WHOLE bridge runs with -D, so a
    // per-plugin debug option that only reached that channel would look broken:
    // the client's output would appear and the plugin's own would not.
    protect.reset();
    protect.store.nvr = NVR;
    protect.store.cameras = () => [camera()];
    const { log } = await start({ ...CONFIG, debug: true } as unknown as PlatformConfig);

    protect.captured.store?.["onEvent"]?.({
      id: "e1",
      type: "motion",
      camera: "cam-1",
      start: 1,
      smartDetectTypes: [],
    } as never);

    expect(log.info.mock.calls.some((call) => String(call[0]).includes("Front Door: motion"))).toBe(
      true,
    );
  });

  it("keeps its debug output off the info channel when the box is not ticked", async () => {
    protect.reset();
    protect.store.nvr = NVR;
    protect.store.cameras = () => [camera()];
    const { log } = await start();

    protect.captured.store?.["onEvent"]?.({
      id: "e1",
      type: "motion",
      camera: "cam-1",
      start: 1,
      smartDetectTypes: [],
    } as never);

    expect(log.info.mock.calls.some((call) => String(call[0]).includes("Front Door: motion"))).toBe(
      false,
    );
    expect(
      log.debug.mock.calls.some((call) => String(call[0]).includes("Front Door: motion")),
    ).toBe(true);
  });

  it("reports a console it cannot reach instead of throwing into the bridge", async () => {
    protect.reset();
    protect.connectProtect.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { log } = await start();

    expect(log.error.mock.calls.some((call) => String(call[0]).includes("ECONNREFUSED"))).toBe(
      true,
    );
  });
});
