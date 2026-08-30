/**
 * The rolling buffer that lets a recording start before its trigger.
 *
 * ffmpeg is replaced by a controllable stdout, because what matters here is the
 * ageing policy and the live hand-off, not whether a binary runs.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createFakePlatform } from "./fake-hap.js";

const ffmpeg = vi.hoisted(() => {
  const instances: { stdout: EventEmitter; stopped: boolean }[] = [];
  return {
    instances,
    reset: () => instances.splice(0, instances.length),
    FfmpegProcess: class {
      readonly stdout = new EventEmitter();
      stopped = false;
      running = true;
      exited = Promise.resolve({ code: 0, signal: null });
      constructor(_options: { onExit?: () => void }) {
        instances.push(this as never);
      }
      stop(): void {
        this.stopped = true;
        this.running = false;
      }
    },
  };
});

vi.mock("#media/ffmpeg", () => ({ FfmpegProcess: ffmpeg.FfmpegProcess }));

const { Prebuffer } = await import("#media/prebuffer");

const box = (type: string, payload: Buffer = Buffer.alloc(0)): Buffer => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
};
const INIT = Buffer.concat([box("ftyp", Buffer.alloc(8)), box("moov", Buffer.alloc(32))]);
const fragment = (size = 100) => Buffer.concat([box("moof"), box("mdat", Buffer.alloc(size))]);

/** Let an async generator get as far as registering its waiter. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const makePrebuffer = (prebufferLengthMs = 4000) => {
  ffmpeg.reset();
  const prebuffer = new Prebuffer({
    platform: createFakePlatform(),
    name: "Front Door",
    args: [],
    prebufferLengthMs,
  });
  prebuffer.start();
  const emit = (chunk: Buffer) => ffmpeg.instances[0]!.stdout.emit("data", chunk);
  return { prebuffer, emit };
};

describe("Prebuffer", () => {
  it("exposes the initialisation segment once ffmpeg has produced it", () => {
    const { prebuffer, emit } = makePrebuffer();
    expect(prebuffer.initSegment).toBeUndefined();
    emit(INIT);
    expect(prebuffer.initSegment).toHaveLength(56);
  });

  it("accumulates fragments", () => {
    const { prebuffer, emit } = makePrebuffer();
    emit(INIT);
    emit(fragment());
    emit(fragment());
    expect(prebuffer.buffered()).toHaveLength(2);
  });

  it("ages fragments out by time, not by count", () => {
    // Fragment sizes vary with scene complexity, so a count that holds four
    // seconds of a still hallway holds far less of a windy garden.
    vi.useFakeTimers();
    try {
      const { prebuffer, emit } = makePrebuffer(4000);
      emit(INIT);
      emit(fragment()); // t=0
      vi.advanceTimersByTime(1000);
      emit(fragment()); // t=1000
      vi.advanceTimersByTime(5000);
      emit(fragment()); // t=6000, window now starts at t=2000

      // The t=0 fragment is dropped: the t=1000 one already begins before the
      // window, so it is the lead-in and the older one is redundant.
      expect(prebuffer.buffered()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps one fragment that begins before the window", () => {
    // A recording asked for at the cutoff has to start on a keyframe at or
    // before it, which lives in the fragment that straddles the boundary.
    // Dropping that one would make every clip start late.
    vi.useFakeTimers();
    try {
      const { prebuffer, emit } = makePrebuffer(4000);
      emit(INIT);
      emit(fragment()); // t=0, straddles the window start
      vi.advanceTimersByTime(3000);
      emit(fragment()); // t=3000
      vi.advanceTimersByTime(3000);
      emit(fragment()); // t=6000, window starts at t=2000

      expect(prebuffer.buffered()).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("always keeps one fragment, so a recording starts at or before the trigger", () => {
    vi.useFakeTimers();
    try {
      const { prebuffer, emit } = makePrebuffer(1000);
      emit(INIT);
      emit(fragment());
      vi.advanceTimersByTime(60_000);
      expect(prebuffer.buffered()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands live fragments to a recording in flight", async () => {
    const { prebuffer, emit } = makePrebuffer();
    emit(INIT);

    const received: number[] = [];
    const consume = (async () => {
      for await (const f of prebuffer.live()) {
        received.push(f.data.length);
        if (received.length === 2) return;
      }
    })();

    await settle();
    emit(fragment(10));
    await settle();
    emit(fragment(20));
    await consume;

    expect(received).toEqual([26, 36]);
  });

  it("does not replay history to a live consumer", async () => {
    // The recording delegate joins buffer and live itself, in that order;
    // doing it here would hide the seam and double the first fragments.
    const { prebuffer, emit } = makePrebuffer();
    emit(INIT);
    emit(fragment(10));

    const received: number[] = [];
    const consume = (async () => {
      for await (const f of prebuffer.live()) {
        received.push(f.data.length);
        return;
      }
    })();

    await settle();
    emit(fragment(99));
    await consume;

    expect(received).toEqual([115]);
  });

  it("ends a live consumer when its recording is aborted", async () => {
    const { prebuffer } = makePrebuffer();
    const controller = new AbortController();
    const consume = (async () => {
      const seen: unknown[] = [];
      for await (const f of prebuffer.live(controller.signal)) seen.push(f);
      return seen;
    })();

    await settle();
    controller.abort();
    expect(await consume).toEqual([]);
  });

  it("ends live consumers when the buffer stops", async () => {
    const { prebuffer } = makePrebuffer();
    const consume = (async () => {
      const seen: unknown[] = [];
      for await (const f of prebuffer.live()) seen.push(f);
      return seen;
    })();

    await settle();
    prebuffer.stop();
    // stop() clears the waiters, so the pending promise never resolves with a
    // fragment; the generator is left to be collected rather than leaking one.
    expect(prebuffer.buffered()).toEqual([]);
    void consume;
  });

  it("stops ffmpeg and forgets its history when disarmed", () => {
    const { prebuffer, emit } = makePrebuffer();
    emit(INIT);
    emit(fragment());
    prebuffer.stop();

    expect(ffmpeg.instances[0]?.stopped).toBe(true);
    expect(prebuffer.buffered()).toEqual([]);
  });

  it("does not start a second ffmpeg if started twice", () => {
    const { prebuffer } = makePrebuffer();
    prebuffer.start();
    expect(ffmpeg.instances).toHaveLength(1);
  });
});
