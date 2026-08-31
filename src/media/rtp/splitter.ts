import { createSocket, type Socket } from "node:dgram";

/**
 * One UDP port, two consumers.
 *
 * HomeKit is told a single port for audio and uses it for everything: the RTCP
 * it sends about the stream we are pushing to it, and — when two-way audio is
 * on — the voice of whoever is holding the phone. Both arrive at the port the
 * outgoing ffmpeg would otherwise want to bind, and two processes cannot bind
 * the same UDP port.
 *
 * So this binds it instead and fans out by packet type: RTCP goes back to the
 * outgoing ffmpeg, which stalls if its control channel goes quiet, and
 * everything else goes to the talkback ffmpeg. Without the RTCP leg the picture
 * survives but the audio stops after a few seconds, which is a maddening
 * symptom to chase.
 */
export class RtpSplitter {
  readonly #socket: Socket;
  readonly #port: number;

  #rtcpPort: number | undefined;
  #audioPort: number | undefined;
  #closed = false;

  private constructor(socket: Socket, port: number) {
    this.#socket = socket;
    this.#port = port;

    this.#socket.on("message", (message) => this.#dispatch(message));
    // A splitter whose socket errors must not take the bridge down with it; the
    // stream is lost either way and HomeKit will retry.
    this.#socket.on("error", () => this.close());
  }

  static async bind(port: number): Promise<RtpSplitter> {
    const socket = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(port, () => {
        socket.removeListener("error", reject);
        resolve();
      });
    });
    // The port the socket actually got, not the one asked for: port 0 means
    // "any", and reporting the request back would hand callers a zero.
    return new RtpSplitter(socket, socket.address().port);
  }

  get port(): number {
    return this.#port;
  }

  /** Where the outgoing ffmpeg listens for the RTCP HomeKit sends us. */
  forwardRtcpTo(port: number): void {
    this.#rtcpPort = port;
  }

  /** Where the talkback ffmpeg listens for HomeKit's voice. */
  forwardAudioTo(port: number): void {
    this.#audioPort = port;
  }

  /**
   * Tell RTCP from RTP on a multiplexed port, the RFC 5761 way.
   *
   * The second byte holds RTCP's packet type (200-204) or RTP's payload type
   * with the marker bit above it. Masking that bit off maps RTCP's 200-204
   * onto 72-76 — hence the range here, which looks wrong until you follow the
   * arithmetic. Comparing against 200-204 after masking, which is the obvious
   * reading, matches nothing at all and silently sends every RTCP packet down
   * the audio path.
   *
   * The mapping is only unambiguous because RFC 5761 reserves RTP payload
   * types 64-95 for exactly this; HomeKit's audio is 110, well clear of it.
   */
  static isRtcp(message: Buffer): boolean {
    if (message.length < 2) return false;
    const type = message[1]! & 0x7f;
    return type >= 72 && type <= 76;
  }

  #dispatch(message: Buffer): void {
    if (this.#closed) return;

    const port = RtpSplitter.isRtcp(message) ? this.#rtcpPort : this.#audioPort;
    if (port === undefined) return;

    // Errors are swallowed: a send that fails because the far ffmpeg has just
    // exited is the normal way a stream ends, not something to report.
    this.#socket.send(message, port, "127.0.0.1", () => undefined);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#socket.close();
    } catch {
      // Already closed, which is the only way this throws.
    }
  }
}
