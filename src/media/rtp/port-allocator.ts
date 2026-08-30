import { createSocket } from "node:dgram";

/**
 * Hands out UDP ports for RTP.
 *
 * Two things make this more than `Math.random()`. RTP wants an **even** port,
 * with the odd one above it reserved for RTCP — that pairing is in the RTP
 * specification and some controllers rely on it. And a port has to be actually
 * free: asking the kernel for one by binding port 0 is the only way to know,
 * since anything else races with every other process on the host.
 *
 * Ports are released as soon as they are found, so there is a window in which
 * something else could take one. That window is microseconds and the
 * alternative — holding the socket open and passing the descriptor to ffmpeg —
 * is not something ffmpeg accepts.
 */

/** Ask the kernel for a free UDP port and immediately give it back. */
const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", (error) => {
      socket.close();
      reject(error);
    });
    socket.bind(0, () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });

export class RtpPortAllocator {
  /** Ports handed out and not yet returned, so two streams cannot collide. */
  readonly #inUse = new Set<number>();

  /**
   * Reserve an even RTP port whose odd neighbour is also free.
   *
   * Retries rather than searching linearly: the kernel's own choice is far more
   * likely to be free than the next number up, and a linear walk through a busy
   * range is how this ends up scanning hundreds of ports.
   */
  async reserve(attempts = 100): Promise<number> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const candidate = await freePort();
      // An odd port is not usable as RTP; take the one below it, which the
      // kernel did not just confirm, so verify it separately.
      const rtp = candidate % 2 === 0 ? candidate : candidate - 1;
      if (rtp < 1024 || this.#inUse.has(rtp)) continue;

      if (candidate % 2 === 0) {
        this.#inUse.add(rtp);
        return rtp;
      }
      // We were handed the RTCP half; the RTP half below it is unverified, so
      // try again rather than assume.
    }
    throw new Error(`Could not find a free even UDP port after ${attempts} attempts.`);
  }

  release(port: number): void {
    this.#inUse.delete(port);
  }
}
