import { FfmpegProcess } from "#media/ffmpeg";
import { Mp4Fragmenter, type Mp4Fragment } from "#media/mp4/boxes";
import type { UnifiProtectPlatform } from "#platform";

/**
 * A rolling window of recent video, so a recording can begin before its trigger.
 *
 * This is what HomeKit Secure Video actually needs and the only reason a
 * process runs when nobody is watching: by the time motion is reported, the
 * seconds that matter — someone walking up to the door — have already happened.
 * The buffer holds them.
 *
 * It runs **only while HomeKit says recording is armed** for this camera, which
 * the HAP delegate reports through `updateRecordingActive`. That is the
 * difference between one ffmpeg per camera in the house and one per camera the
 * user actually turned Secure Video on for — usually one or two.
 */

export type PrebufferOptions = {
  platform: UnifiProtectPlatform;
  name: string;
  args: string[];
  /** How much history to keep, in milliseconds. HomeKit asks for this. */
  prebufferLengthMs: number;
  verbose?: boolean;
};

/** A consumer waiting on the next fragment. */
type Waiter = (fragment: Mp4Fragment) => void;

export class Prebuffer {
  readonly #options: PrebufferOptions;
  readonly #fragmenter = new Mp4Fragmenter();
  readonly #fragments: Mp4Fragment[] = [];
  readonly #waiters = new Set<Waiter>();

  #process: FfmpegProcess | undefined;
  #stopped = false;

  constructor(options: PrebufferOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#process?.running === true;
  }

  /** The `ftyp moov` pair. Every recording must begin with it. */
  get initSegment(): Buffer | undefined {
    return this.#fragmenter.initSegment;
  }

  start(): void {
    if (this.#process) return;
    this.#stopped = false;

    this.#process = new FfmpegProcess({
      platform: this.#options.platform,
      name: `${this.#options.name} (prebuffer)`,
      args: this.#options.args,
      verbose: this.#options.verbose ?? false,
      onExit: () => {
        this.#process = undefined;
        // A prebuffer that died while still armed is a camera that has silently
        // stopped being able to record. Restart it, unless we are the ones who
        // stopped it.
        if (!this.#stopped) {
          this.#options.platform.log.debug(
            `${this.#options.name}: prebuffer ended unexpectedly; restarting it.`,
          );
          setTimeout(() => {
            if (!this.#stopped) this.start();
          }, 2000).unref?.();
        }
      },
    });

    this.#process.stdout.on("data", (chunk: Buffer) => this.#ingest(chunk));
  }

  stop(): void {
    this.#stopped = true;
    this.#process?.stop();
    this.#process = undefined;
    this.#fragments.length = 0;
    this.#waiters.clear();
  }

  #ingest(chunk: Buffer): void {
    for (const fragment of this.#fragmenter.push(chunk)) {
      this.#fragments.push(fragment);
      this.#trim();

      // Drained into a local list before any of them run: a consumer that
      // resolves goes straight back round and registers again, so iterating the
      // live set would hand the same fragment to the same consumer forever.
      const waiting = Array.from(this.#waiters);
      this.#waiters.clear();
      for (const waiter of waiting) waiter(fragment);
    }
  }

  /**
   * Drop anything older than the window HomeKit asked for.
   *
   * Trimmed by age rather than by count: fragment sizes vary with scene
   * complexity, and a count that holds four seconds of a still hallway holds
   * far less of a windy garden. One extra fragment is kept beyond the window so
   * a recording always starts on a keyframe at or before the trigger, never
   * just after it.
   */
  #trim(): void {
    const cutoff = Date.now() - this.#options.prebufferLengthMs;
    while (this.#fragments.length > 1 && (this.#fragments[1]?.at ?? 0) < cutoff) {
      this.#fragments.shift();
    }
  }

  /** What has been buffered so far, oldest first. */
  buffered(): Mp4Fragment[] {
    return [...this.#fragments];
  }

  /**
   * Fragments produced from now on.
   *
   * Deliberately does not replay the buffer — a caller wants the history and
   * the live feed joined in that order, and doing the join here would hide the
   * seam where a recording switches from one to the other.
   */
  async *live(signal?: AbortSignal): AsyncGenerator<Mp4Fragment> {
    for (;;) {
      if (this.#stopped || signal?.aborted) return;

      const next = await new Promise<Mp4Fragment | undefined>((resolve) => {
        const waiter: Waiter = (fragment) => resolve(fragment);
        this.#waiters.add(waiter);

        const abort = (): void => {
          this.#waiters.delete(waiter);
          resolve(undefined);
        };
        signal?.addEventListener("abort", abort, { once: true });
      });

      if (!next) return;
      yield next;
    }
  }
}
