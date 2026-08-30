import { writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from "homebridge";
import {
  connectProtect,
  EventType,
  isEventInProgress,
  type Camera,
  type Light,
  type Logger,
  type ProtectClient,
  type ProtectConnection,
  type ProtectEvent,
  type Sensor,
} from "@mgcrea/unifi-protect";

import type { ProtectDeviceLike } from "#accessories/base-accessory";
import { CameraAccessory } from "#accessories/camera-accessory";
import { LightAccessory } from "#accessories/light-accessory";
import { NvrAccessory } from "#accessories/nvr-accessory";
import { SensorAccessory } from "#accessories/sensor-accessory";
import {
  cameraOverrideFor,
  ConfigError,
  normalizeMac,
  parseConfig,
  type UnifiProtectConfig,
} from "#config";
import { probeCodecs, type CodecSupport } from "#media/codecs";
import { PLATFORM_NAME, PLUGIN_NAME } from "#settings";
import { describe } from "#util/describe";

type AnyAccessory = CameraAccessory | LightAccessory | SensorAccessory | NvrAccessory;

/**
 * Dynamic platform: connects to one UniFi Protect console, mirrors its devices
 * into HomeKit, and keeps them in step from the console's realtime update
 * stream. There is no poll loop — the client's store owns reconnection and
 * re-reads the console itself whenever the stream drops.
 */
export class UnifiProtectPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;

  readonly #config: UnifiProtectConfig | undefined;
  readonly #cached = new Map<string, PlatformAccessory>();
  readonly #accessories = new Map<string, AnyAccessory>();
  /** Console device id to accessory UUID, so an event can be routed in one hop. */
  readonly #byDeviceId = new Map<string, string>();

  #connection: ProtectConnection | undefined;
  #codecs: CodecSupport | undefined;
  #consoleCaFile: string | undefined;
  #shuttingDown = false;
  #connected = false;
  /** The discovery run in flight, and whether another was asked for meanwhile. */
  #discovering: Promise<void> | undefined;
  #rediscover = false;

  constructor(
    readonly log: Logging,
    config: PlatformConfig,
    readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    try {
      this.#config = parseConfig(config);
    } catch (error) {
      // A misconfigured platform must not take Homebridge down with it; log
      // clearly and stay dormant so the rest of the bridge keeps working.
      this.log.error(
        error instanceof ConfigError ? error.message : `Invalid configuration: ${describe(error)}`,
      );
      return;
    }

    this.api.on("didFinishLaunching", () => {
      void this.#start();
    });
    this.api.on("shutdown", () => {
      void this.#stop();
    });
  }

  /** Homebridge replays every cached accessory here before launch completes. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.#cached.set(accessory.UUID, accessory);
  }

  get options(): UnifiProtectConfig {
    if (!this.#config) throw new Error("Platform is not configured");
    return this.#config;
  }

  get client(): ProtectClient {
    if (!this.#connection) throw new Error("Platform is not initialised");
    return this.#connection.client;
  }

  /** Whether the realtime stream is currently up. */
  get isConnected(): boolean {
    return this.#connected;
  }

  /**
   * What this host's ffmpeg can do. Probed once, before any camera is built, so
   * it is always present by the time a stream is asked for.
   */
  get codecs(): CodecSupport {
    if (!this.#codecs) throw new Error("ffmpeg has not been probed yet");
    return this.#codecs;
  }

  /**
   * Whether video is available at all. Separate from `codecs` so a camera can
   * ask without having to catch: an ffmpeg that would not run is a normal
   * outcome, not an exceptional one.
   */
  get hasCodecs(): boolean {
    return this.#codecs !== undefined;
  }

  /**
   * A PEM for ffmpeg to verify the console's RTSPS certificate against, or
   * undefined when verification is not possible. See `tlsInputArgs`.
   */
  get consoleCaFile(): string | undefined {
    return this.#consoleCaFile;
  }

  async #start(): Promise<void> {
    const config = this.#config;
    if (!config) return;

    try {
      this.#connection = await connectProtect({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        stateDir: this.api.user.storagePath(),
        fingerprint: config.fingerprint,
        insecureTls: config.insecureTls,
        userAgent: PLUGIN_NAME,
        logger: this.#logger(config.debug),
        store: {
          onEvent: (event) => this.#onEvent(event),
          onDeviceChanged: (_kind, device) => this.#onDeviceChanged(device),
          onDeviceAdded: () => void this.#discover(),
          onDeviceRemoved: () => void this.#discover(),
          onNvrChanged: (nvr) => this.#onDeviceChanged(nvr as never),
          onConnectionState: (state) => {
            this.#connected = state === "connected";
            if (state === "connected") this.log.debug("Realtime stream connected.");
            if (state === "disconnected") this.log.warn("Lost the console's realtime stream.");
          },
          // A resync means the console's state was re-read wholesale, so
          // reconcile rather than trusting the accessories we already built.
          onResync: () => void this.#discover(),
        },
      });
    } catch (error) {
      this.log.error(`Could not connect to the UniFi Protect console: ${describe(error)}`);
      return;
    }

    if (config.enableStreaming) {
      try {
        this.#codecs = await probeCodecs(config.videoProcessor, this.#logger(config.debug));
      } catch (error) {
        // Video is the one part that depends on something outside the plugin.
        // Losing it should cost the cameras their picture, not the whole
        // platform its sensors.
        this.log.error(
          `Could not run ${config.videoProcessor}: ${describe(error)}. ` +
            `Live video is disabled; motion and doorbell events still work. ` +
            `Install ffmpeg, or point \`videoProcessor\` at it.`,
        );
      }
      this.#consoleCaFile = await this.#writeConsoleCertificate();
    }

    const nvr = this.#connection.store.nvr;
    this.log.info(
      `Connected to ${nvr?.name ?? config.host} running Protect ${nvr?.version ?? "(unknown)"}.`,
    );
    if (this.#connection.fingerprint) {
      this.log.info(
        `Console certificate fingerprint: ${this.#connection.fingerprint}. ` +
          `Set it as \`fingerprint\` in the plugin config to make the trust explicit.`,
      );
    }

    await this.#discover();
  }

  /**
   * Write the pinned console certificate where ffmpeg can read it.
   *
   * Only worth doing when the console is addressed by host name. ffmpeg can be
   * given a trust anchor but not a fingerprint, so it still runs the host name
   * check — and the console's certificate carries no IP SAN, so by IP that
   * check can never pass and verification has to be off regardless.
   */
  async #writeConsoleCertificate(): Promise<string | undefined> {
    const pem = this.#connection?.tlsOptions.ca?.[0];
    if (!pem || isIP(this.options.host)) {
      if (pem) {
        this.log.debug(
          "The console is addressed by IP, so ffmpeg cannot verify its certificate for RTSPS — " +
            "the certificate carries no IP SAN. No credentials cross that connection.",
        );
      }
      return undefined;
    }

    const path = join(this.api.user.storagePath(), "unifi-protect-console.pem");
    try {
      await writeFile(path, pem, { mode: 0o600 });
      return path;
    } catch (error) {
      this.log.debug(`Could not write the console certificate for ffmpeg: ${describe(error)}`);
      return undefined;
    }
  }

  async #stop(): Promise<void> {
    this.#shuttingDown = true;
    for (const accessory of this.#accessories.values()) accessory.dispose();
    await this.#connection?.disconnect().catch(() => undefined);
    this.#connection = undefined;
  }

  /**
   * Reconcile the console's devices against the accessories we have registered.
   *
   * Serialised the same way as the other plugins in this family: a resync and a
   * device-added callback can both land here, and overlapping runs each sweep
   * against their own snapshot. Whichever resumes last wins, so a run that
   * started before a camera was adopted would unregister the accessory a newer
   * run just registered, and the camera flaps out of HomeKit. One queued re-run
   * is enough to see the change without piling up a pass per caller.
   */
  async #discover(): Promise<void> {
    if (this.#shuttingDown) return;
    if (this.#discovering) {
      this.#rediscover = true;
      return this.#discovering;
    }
    const run = (async () => {
      do {
        this.#rediscover = false;
        this.#runDiscovery();
        await Promise.resolve();
      } while (this.#rediscover);
    })();
    this.#discovering = run;
    try {
      await run;
    } finally {
      this.#discovering = undefined;
      this.#rediscover = false;
    }
  }

  #runDiscovery(): void {
    const connection = this.#connection;
    const config = this.#config;
    if (!connection || !config) return;

    const { store } = connection;
    const seen = new Set<string>();

    if (config.exposeCameras) {
      for (const camera of store.cameras()) {
        if (cameraOverrideFor(config, camera.mac)?.exclude) continue;
        seen.add(
          this.#register(
            camera,
            "camera",
            (accessory) => new CameraAccessory(this, accessory, camera),
          ),
        );
      }
    }
    if (config.exposeSensors) {
      for (const sensor of store.sensors()) {
        seen.add(
          this.#register(
            sensor,
            "sensor",
            (accessory) => new SensorAccessory(this, accessory, sensor),
          ),
        );
      }
    }
    if (config.exposeLights) {
      for (const light of store.lights()) {
        seen.add(
          this.#register(light, "light", (accessory) => new LightAccessory(this, accessory, light)),
        );
      }
    }
    if (config.exposeNvr && store.nvr) {
      const nvr = store.nvr;
      seen.add(this.#register(nvr, "nvr", (accessory) => new NvrAccessory(this, accessory, nvr)));
    }

    for (const [uuid, accessory] of this.#cached) {
      if (seen.has(uuid)) continue;
      this.log.info(`Removing stale accessory: ${accessory.displayName}`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.#cached.delete(uuid);
      // Drop the live wrapper too. Leaving it behind would let a device that
      // comes back push values into a handler bound to an accessory Homebridge
      // no longer knows about, and its timers would stay alive.
      const live = this.#accessories.get(uuid);
      live?.dispose();
      this.#accessories.delete(uuid);
      for (const [id, mapped] of this.#byDeviceId) {
        if (mapped === uuid) this.#byDeviceId.delete(id);
      }
    }
  }

  #register<T extends ProtectDeviceLike>(
    device: T,
    kind: string,
    build: (accessory: PlatformAccessory) => AnyAccessory,
  ): string {
    // Seeded from the MAC, which survives a device being removed and re-adopted
    // in Protect; `id` does not, and a re-adopted camera would arrive in
    // HomeKit as a brand new accessory with its automations detached.
    const uuid = this.api.hap.uuid.generate(`${kind}:${normalizeMac(device.mac ?? device.id)}`);
    this.#byDeviceId.set(device.id, uuid);

    const live = this.#accessories.get(uuid);
    if (live) {
      live.update(device as never);
      return uuid;
    }

    const name = device.name ?? device.id;
    const cached = this.#cached.get(uuid);
    if (cached) {
      cached.displayName = name;
      this.#accessories.set(uuid, build(cached));
      this.api.updatePlatformAccessories([cached]);
      return uuid;
    }

    this.log.info(`Adding ${kind}: ${name}`);
    const accessory = new this.api.platformAccessory(name, uuid);
    this.#accessories.set(uuid, build(accessory));
    this.#cached.set(uuid, accessory);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    return uuid;
  }

  #accessoryFor(deviceId: string | null | undefined): AnyAccessory | undefined {
    if (!deviceId) return undefined;
    const uuid = this.#byDeviceId.get(deviceId);
    return uuid ? this.#accessories.get(uuid) : undefined;
  }

  #onDeviceChanged(device: { id: string }): void {
    this.#accessoryFor(device.id)?.update(device as never);
  }

  /**
   * Route one console event to the accessory it belongs to.
   *
   * Protect reports an event twice — once when it starts, once with `end` filled
   * in when it finishes. Acting on both would re-trip a motion sensor just as
   * the movement stopped, so only the in-progress form fires anything.
   */
  #onEvent(event: ProtectEvent): void {
    if (!isEventInProgress(event)) return;

    const target = this.#accessoryFor(event.camera ?? event.sensor ?? event.light);
    if (!target) return;

    switch (event.type) {
      case EventType.MOTION:
      case EventType.SMART_DETECT:
      case EventType.SMART_DETECT_LINE:
      case EventType.SENSOR_MOTION:
        if (target instanceof CameraAccessory) target.triggerMotion();
        else if (target instanceof SensorAccessory) target.triggerMotion();
        else if (target instanceof LightAccessory) target.triggerMotion();
        break;

      case EventType.RING:
        if (target instanceof CameraAccessory) target.triggerRing();
        break;

      default:
        // Protect emits far more event types than the plugin acts on.
        break;
    }
  }

  /**
   * The client's logger. `debug` is promoted to `info` when the user asked for
   * it, because Homebridge hides debug output unless the whole bridge is in
   * debug mode — which is not what someone ticking a per-plugin box expects.
   */
  #logger(debug: boolean): Logger {
    return {
      debug: (message, ...rest) =>
        debug
          ? this.log.info(`[debug] ${String(message)}`, ...rest)
          : this.log.debug(String(message), ...rest),
      info: (message, ...rest) => this.log.info(String(message), ...rest),
      warn: (message, ...rest) => this.log.warn(String(message), ...rest),
      error: (message, ...rest) => this.log.error(String(message), ...rest),
    };
  }
}

export type { Camera, Light, Sensor };
