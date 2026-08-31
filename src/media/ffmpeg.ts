import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { describe } from "#util/describe";
import type { UnifiProtectPlatform } from "#platform";

/**
 * One ffmpeg process.
 *
 * Deliberately thin, and deliberately separate from the code that builds its
 * arguments: the arguments are where the behaviour lives and they are pure and
 * tested, while this is the part that can only be exercised against a real
 * binary.
 *
 * The one piece of judgement here is the stderr handling. ffmpeg says nothing
 * on success and everything on failure, all of it on stderr, and the useful
 * line is usually the last one. Buffering a bounded tail and printing it only
 * when the process fails is the difference between a log that says what went
 * wrong and one that is either silent or unreadable.
 */

/** Enough to carry ffmpeg's real complaint without letting a loop fill memory. */
const STDERR_TAIL_LINES = 20;

export type FfmpegOptions = {
  platform: UnifiProtectPlatform;
  /** Used to prefix log lines: the camera name plus what this process is for. */
  name: string;
  args: string[];
  /** Log every line ffmpeg produces, not just the tail on failure. */
  verbose?: boolean;
  /**
   * Written to the process's stdin and closed.
   *
   * Used for an SDP describing a stream: it carries the session's SRTP key,
   * and a file would leave that key on disk while `-i` would put it in the
   * process list for anyone on the box to read.
   */
  stdin?: string;
  /** Called when the process ends for any reason, including our own stop(). */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
};

export class FfmpegProcess {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #name: string;
  readonly #platform: UnifiProtectPlatform;
  readonly #stderr: string[] = [];

  #stopping = false;
  #ended = false;

  /** Resolves when the process ends. Never rejects — failure is reported, not thrown. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(options: FfmpegOptions) {
    this.#name = options.name;
    this.#platform = options.platform;

    const command = options.platform.options.videoProcessor;
    options.platform.debug(`${this.#name}: ${command} ${options.args.join(" ")}`);

    this.#process = spawn(command, options.args, { env: process.env });

    if (options.stdin !== undefined) {
      // A closed stdin is how ffmpeg knows the SDP is complete. An EPIPE here
      // means the process died before reading it, which its own exit reports.
      this.#process.stdin.on("error", () => undefined);
      this.#process.stdin.end(options.stdin);
    }

    this.#process.stderr.setEncoding("utf8");
    this.#process.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        if (options.verbose) {
          options.platform.log.info(`${this.#name}: ${line}`);
        }
        this.#stderr.push(line);
        if (this.#stderr.length > STDERR_TAIL_LINES) this.#stderr.shift();
      }
    });

    this.exited = new Promise((resolve) => {
      this.#process.on("error", (error) => {
        this.#ended = true;
        // The commonest cause by far is ffmpeg not being installed, or the
        // configured path being wrong; say which binary failed to start.
        options.platform.log.error(
          `${this.#name}: could not run ${command} — ${describe(error)}. ` +
            `Check that ffmpeg is installed and that \`videoProcessor\` points at it.`,
        );
        options.onExit?.(null, null);
        resolve({ code: null, signal: null });
      });

      this.#process.on("close", (code, signal) => {
        this.#ended = true;
        this.#report(code, signal);
        options.onExit?.(code, signal);
        resolve({ code, signal });
      });
    });
  }

  get running(): boolean {
    return !this.#ended;
  }

  get stdin(): NodeJS.WritableStream {
    return this.#process.stdin;
  }

  get stdout(): NodeJS.ReadableStream {
    return this.#process.stdout;
  }

  /**
   * End the process.
   *
   * SIGTERM first so ffmpeg can close its output cleanly, then SIGKILL if it is
   * still there — a process blocked writing to a socket the far end has stopped
   * reading will ignore the first signal, and a stuck ffmpeg per stopped stream
   * accumulates until the host runs out of them.
   */
  stop(): void {
    if (this.#ended || this.#stopping) return;
    this.#stopping = true;

    this.#process.kill("SIGTERM");
    const forced = setTimeout(() => {
      if (!this.#ended) {
        this.#platform.debug(`${this.#name}: did not exit on SIGTERM, killing it.`);
        this.#process.kill("SIGKILL");
      }
    }, 2000);
    forced.unref?.();
  }

  #report(code: number | null, signal: NodeJS.Signals | null): void {
    // 255 is what ffmpeg exits with when it is asked to stop, and our own
    // SIGTERM is not a fault either. Reporting those as errors would put a
    // scary line in the log every time someone closes a camera.
    if (
      this.#stopping ||
      code === 0 ||
      code === 255 ||
      signal === "SIGTERM" ||
      signal === "SIGKILL"
    ) {
      this.#platform.debug(`${this.#name}: ffmpeg ended (code ${code ?? "none"}).`);
      return;
    }

    this.#platform.log.error(
      `${this.#name}: ffmpeg exited unexpectedly with code ${code ?? "none"}.`,
    );
    for (const line of this.#stderr) this.#platform.log.error(`${this.#name}:   ${line}`);
  }
}
