/**
 * The MP4 slicing.
 *
 * This is the code that lets the plugin carry no muxing library, so it has to
 * be right about the one thing that actually bites: ffmpeg writes to a pipe and
 * chunk boundaries land wherever the kernel put them — mid-header, mid-payload.
 * Anything that assumed a chunk was a box would pass a naive test and corrupt
 * every real recording.
 */
import { describe, expect, it } from "vitest";

import { isInitBox, Mp4BoxReader, Mp4Fragmenter } from "#media/mp4/boxes";

/** Build a box the way an MP4 actually lays one out. */
const box = (type: string, payload: Buffer = Buffer.alloc(0)): Buffer => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
};

/** A 64-bit-length box, which is how an oversized mdat is written. */
const largeBox = (type: string, payload: Buffer): Buffer => {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, "latin1");
  header.writeBigUInt64BE(BigInt(16 + payload.length), 8);
  return Buffer.concat([header, payload]);
};

/** Feed a buffer through in fixed-size chunks, as a pipe would. */
const feed = <T>(sink: { push: (chunk: Buffer) => T[] }, data: Buffer, chunkSize: number): T[] => {
  const out: T[] = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    out.push(...sink.push(data.subarray(offset, offset + chunkSize)));
  }
  return out;
};

describe("Mp4BoxReader", () => {
  it("reads consecutive boxes out of one chunk", () => {
    const reader = new Mp4BoxReader();
    const boxes = reader.push(
      Buffer.concat([box("ftyp", Buffer.alloc(4)), box("moov", Buffer.alloc(8))]),
    );
    expect(boxes.map((b) => b.type)).toEqual(["ftyp", "moov"]);
    expect(boxes[0]?.data).toHaveLength(12);
  });

  it("reassembles a box split across chunks", () => {
    const data = Buffer.concat([box("moof", Buffer.alloc(40)), box("mdat", Buffer.alloc(200))]);
    for (const chunkSize of [1, 3, 7, 8, 9, 64, 1024]) {
      const reader = new Mp4BoxReader();
      const boxes = feed(reader, data, chunkSize);
      expect(
        boxes.map((b) => b.type),
        `chunk size ${chunkSize}`,
      ).toEqual(["moof", "mdat"]);
      expect(reader.pending).toBe(0);
    }
  });

  it("holds back a header that arrived only partly", () => {
    // Four bytes is a length with no type yet; guessing here is how a reader
    // emits a box that does not exist.
    const reader = new Mp4BoxReader();
    expect(reader.push(Buffer.from([0, 0, 0, 16]))).toEqual([]);
    expect(reader.pending).toBe(4);
  });

  it("holds back a box whose payload has not all arrived", () => {
    const reader = new Mp4BoxReader();
    expect(reader.push(box("mdat", Buffer.alloc(100)).subarray(0, 50))).toEqual([]);
    expect(reader.pending).toBe(50);
  });

  it("reads a 64-bit length, which is how a large mdat is written", () => {
    const reader = new Mp4BoxReader();
    const boxes = reader.push(largeBox("mdat", Buffer.alloc(32)));
    expect(boxes.map((b) => b.type)).toEqual(["mdat"]);
    expect(boxes[0]?.data).toHaveLength(48);
  });

  it("waits rather than guessing when a 64-bit header is incomplete", () => {
    const reader = new Mp4BoxReader();
    expect(reader.push(largeBox("mdat", Buffer.alloc(32)).subarray(0, 12))).toEqual([]);
  });

  it("never completes a size-0 box, which means 'to end of file'", () => {
    // A live pipe never reaches an end of file, so treating it as complete
    // would emit a truncated box on every flush.
    const header = Buffer.alloc(8);
    header.writeUInt32BE(0, 0);
    header.write("mdat", 4, "latin1");
    const reader = new Mp4BoxReader();
    expect(reader.push(Buffer.concat([header, Buffer.alloc(64)]))).toEqual([]);
  });

  it("refuses a box that declares an impossible size", () => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(4, 0);
    header.write("junk", 4, "latin1");
    expect(() => new Mp4BoxReader().push(Buffer.concat([header, Buffer.alloc(8)]))).toThrow(
      /impossible size/,
    );
  });
});

describe("isInitBox", () => {
  it("recognises the two boxes that form the initialisation segment", () => {
    expect(isInitBox("ftyp")).toBe(true);
    expect(isInitBox("moov")).toBe(true);
    expect(isInitBox("moof")).toBe(false);
    expect(isInitBox("mdat")).toBe(false);
  });
});

describe("Mp4Fragmenter", () => {
  const stream = Buffer.concat([
    box("ftyp", Buffer.alloc(8)),
    box("moov", Buffer.alloc(64)),
    box("moof", Buffer.alloc(32)),
    box("mdat", Buffer.alloc(500)),
    box("moof", Buffer.alloc(32)),
    box("mdat", Buffer.alloc(600)),
  ]);

  it("collects ftyp and moov into an initialisation segment", () => {
    const fragmenter = new Mp4Fragmenter();
    fragmenter.push(stream);
    expect(fragmenter.initSegment).toHaveLength(16 + 72);
  });

  it("has no initialisation segment until both boxes have arrived", () => {
    const fragmenter = new Mp4Fragmenter();
    fragmenter.push(box("ftyp", Buffer.alloc(8)));
    expect(fragmenter.initSegment).toBeUndefined();
  });

  it("emits a fragment as one moof+mdat pair", () => {
    const fragments = new Mp4Fragmenter().push(stream);
    expect(fragments).toHaveLength(2);
    expect(fragments[0]?.data).toHaveLength(40 + 508);
    expect(fragments[0]?.data.toString("latin1", 4, 8)).toBe("moof");
  });

  it("does not emit on a moof whose samples have not arrived", () => {
    // HomeKit rejects a fragment with no samples, and a moof is small enough
    // that it very often lands in a chunk of its own.
    const fragmenter = new Mp4Fragmenter();
    fragmenter.push(box("ftyp"));
    fragmenter.push(box("moov"));
    expect(fragmenter.push(box("moof", Buffer.alloc(32)))).toEqual([]);
  });

  it("produces identical output however the stream is chunked", () => {
    const reference = new Mp4Fragmenter().push(stream).map((f) => f.data.toString("base64"));

    for (const chunkSize of [1, 5, 8, 13, 97, 4096]) {
      const fragmenter = new Mp4Fragmenter();
      const fragments = feed(fragmenter, stream, chunkSize);
      expect(
        fragments.map((f) => f.data.toString("base64")),
        `chunk size ${chunkSize}`,
      ).toEqual(reference);
      expect(fragmenter.initSegment, `chunk size ${chunkSize}`).toHaveLength(88);
    }
  });

  it("drops boxes that are not part of the fragment stream", () => {
    // A stray mfra from a build that ignores skip_trailer, or free padding.
    const fragmenter = new Mp4Fragmenter();
    const fragments = fragmenter.push(
      Buffer.concat([stream, box("free", Buffer.alloc(16)), box("mfra", Buffer.alloc(48))]),
    );
    expect(fragments).toHaveLength(2);
  });

  it("stamps each fragment so the prebuffer can age it out", () => {
    let clock = 1000;
    const fragmenter = new Mp4Fragmenter(() => clock);
    fragmenter.push(Buffer.concat([box("ftyp"), box("moov")]));
    const first = fragmenter.push(Buffer.concat([box("moof"), box("mdat", Buffer.alloc(10))]));
    clock = 5000;
    const second = fragmenter.push(Buffer.concat([box("moof"), box("mdat", Buffer.alloc(10))]));

    expect(first[0]?.at).toBe(1000);
    expect(second[0]?.at).toBe(5000);
  });
});
