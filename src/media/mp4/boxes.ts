/**
 * Just enough MP4 to slice ffmpeg's output into the pieces HomeKit wants.
 *
 * This is the whole reason the plugin needs no muxing library. An MP4 is a flat
 * sequence of length-prefixed boxes, and a fragmented one produced for HomeKit
 * Secure Video is exactly:
 *
 *   ftyp moov | moof mdat | moof mdat | …
 *
 * where `ftyp moov` is the initialisation segment and each `moof mdat` pair is
 * one fragment. Recognising those boundaries is a matter of reading a 4-byte
 * length and a 4-byte type, so it is ninety lines of arithmetic rather than a
 * dependency — and unlike a dependency it can be tested against bytes.
 */

/** Every box begins with a 32-bit size and a four-character type. */
const HEADER_SIZE = 8;
/** A size of 1 means the real, 64-bit size follows the type. */
const LARGE_SIZE_MARKER = 1;
const LARGE_HEADER_SIZE = 16;

export type Mp4Box = {
  type: string;
  /** The complete box, header included, ready to hand to HomeKit as-is. */
  data: Buffer;
};

/**
 * Reassembles boxes from a byte stream that arrives in arbitrary chunks.
 *
 * ffmpeg writes to a pipe, so a chunk boundary lands wherever the kernel put it
 * — routinely in the middle of a box header, and for an `mdat` almost always
 * mid-payload. Anything that assumed a chunk was a box would work on small test
 * clips and corrupt every real recording.
 */
export class Mp4BoxReader {
  #buffer: Buffer = Buffer.alloc(0);

  /** Feed a chunk; get back whatever boxes are now complete. */
  push(chunk: Buffer): Mp4Box[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);

    const boxes: Mp4Box[] = [];
    for (;;) {
      const box = this.#shift();
      if (!box) break;
      boxes.push(box);
    }
    return boxes;
  }

  /** Bytes held back waiting for the rest of their box. */
  get pending(): number {
    return this.#buffer.length;
  }

  #shift(): Mp4Box | undefined {
    if (this.#buffer.length < HEADER_SIZE) return undefined;

    const declared = this.#buffer.readUInt32BE(0);
    const type = this.#buffer.toString("latin1", 4, 8);

    let size = declared;
    if (declared === LARGE_SIZE_MARKER) {
      if (this.#buffer.length < LARGE_HEADER_SIZE) return undefined;
      // A 64-bit length. Node cannot index a buffer past 2^53, and a fragment
      // that large is not something we could hold anyway, so read it as a
      // Number and let the guard below reject anything absurd.
      size = Number(this.#buffer.readBigUInt64BE(8));
    } else if (declared === 0) {
      // Size 0 means "to end of file", which a live pipe never resolves.
      // Treating it as complete would emit a truncated box on every flush.
      return undefined;
    }

    if (!Number.isSafeInteger(size) || size < HEADER_SIZE) {
      throw new Error(`Malformed MP4: box "${type}" declares an impossible size of ${size}.`);
    }
    if (this.#buffer.length < size) return undefined;

    const data = this.#buffer.subarray(0, size);
    this.#buffer = this.#buffer.subarray(size);
    return { type, data };
  }
}

/** `ftyp` and `moov` together form the initialisation segment. */
export const isInitBox = (type: string): boolean => type === "ftyp" || type === "moov";

/**
 * One fragment: the `moof` describing it and the `mdat` holding its samples.
 * They are always adjacent and always in that order.
 */
export type Mp4Fragment = {
  data: Buffer;
  /** Wall-clock time the fragment was completed, for prebuffer ageing. */
  at: number;
};

/**
 * Groups boxes into an initialisation segment and a stream of fragments.
 *
 * A fragment is only emitted once its `mdat` has arrived, never on the `moof`
 * alone — HomeKit rejects a fragment whose samples are missing, and a `moof`
 * is small enough that it very often arrives in a chunk of its own.
 */
export class Mp4Fragmenter {
  readonly #reader = new Mp4BoxReader();
  readonly #initBoxes: Buffer[] = [];
  #pendingMoof: Buffer | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** The `ftyp moov` pair, once both have been seen. */
  get initSegment(): Buffer | undefined {
    return this.#initBoxes.length >= 2 ? Buffer.concat(this.#initBoxes) : undefined;
  }

  push(chunk: Buffer): Mp4Fragment[] {
    const fragments: Mp4Fragment[] = [];

    for (const box of this.#reader.push(chunk)) {
      if (isInitBox(box.type)) {
        this.#initBoxes.push(box.data);
        continue;
      }

      if (box.type === "moof") {
        this.#pendingMoof = box.data;
        continue;
      }

      if (box.type === "mdat" && this.#pendingMoof) {
        fragments.push({
          data: Buffer.concat([this.#pendingMoof, box.data]),
          at: this.now(),
        });
        this.#pendingMoof = undefined;
        continue;
      }

      // Anything else — a stray `mfra` from a build that ignores skip_trailer,
      // `free` padding — is not part of the fragment stream and is dropped.
    }

    return fragments;
  }
}
