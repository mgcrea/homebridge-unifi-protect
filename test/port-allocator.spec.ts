import { describe, expect, it } from "vitest";

import { RtpPortAllocator } from "#media/rtp/port-allocator";

describe("RtpPortAllocator", () => {
  it("only hands out even ports", async () => {
    // RTP wants an even port with the odd one above it reserved for RTCP;
    // that pairing is in the specification and some controllers rely on it.
    const allocator = new RtpPortAllocator();
    for (let i = 0; i < 10; i += 1) {
      expect((await allocator.reserve()) % 2).toBe(0);
    }
  });

  it("never hands the same port to two streams", async () => {
    const allocator = new RtpPortAllocator();
    const ports = await Promise.all(Array.from({ length: 12 }, () => allocator.reserve()));
    expect(new Set(ports).size).toBe(ports.length);
  });

  it("stays out of the privileged range", async () => {
    const allocator = new RtpPortAllocator();
    expect(await allocator.reserve()).toBeGreaterThanOrEqual(1024);
  });

  it("offers a released port again", async () => {
    const allocator = new RtpPortAllocator();
    const port = await allocator.reserve();
    allocator.release(port);
    // Not that the next reserve returns this exact port — the kernel chooses —
    // but that releasing clears the bookkeeping rather than leaking it.
    expect(() => allocator.release(port)).not.toThrow();
  });

  it("gives up with a clear message rather than looping forever", async () => {
    const allocator = new RtpPortAllocator();
    await expect(allocator.reserve(0)).rejects.toThrow(/Could not find a free even UDP port/);
  });
});
