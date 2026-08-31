/**
 * What the console is asked to do when the Home app opens.
 *
 * This exists because of a real failure: every snapshot was fetched with
 * `force=true`, which makes the console pull a fresh frame off the camera, and
 * the Home app asks for every tile at once. Thirteen forced grabs back to back
 * on a console already recording twelve streams, and an RTSPS handshake
 * attempted during the burst failed with a bare `[tls] Unknown error`.
 */
import { parseBootstrap } from "@mgcrea/unifi-protect";
import { describe, expect, it, vi } from "vitest";

import { fetchConsoleSnapshot } from "#media/snapshot";
import { StreamingDelegate } from "#media/streaming-delegate";

import { createFakePlatform } from "./fake-hap.js";

const NVR = { id: "nvr-1", name: "Console", version: "7.2.55" };

const aCamera = () =>
  parseBootstrap({
    nvr: NVR,
    cameras: [
      {
        id: "cam-1",
        modelKey: "camera",
        mac: "AABBCCDDEEFF",
        name: "Front Door",
        channels: [
          {
            id: 1,
            name: "Medium",
            width: 1280,
            height: 720,
            fps: 30,
            isRtspEnabled: true,
            rtspAlias: "alias",
          },
        ],
      },
    ],
  }).cameras[0]!;

/** A camera the console knows about but which has no streamable channel. */
const noChannels = () =>
  parseBootstrap({
    nvr: NVR,
    cameras: [{ id: "cam-2", modelKey: "camera", mac: "112233445566", name: "Dark", channels: [] }],
  }).cameras[0]!;

describe("fetchConsoleSnapshot", () => {
  it("does not force the console to grab a fresh frame", async () => {
    const requestBytes = vi.fn<(path: string, opts: Record<string, unknown>) => Promise<unknown>>(
      async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" }),
    );

    await fetchConsoleSnapshot({ requestBytes } as never, aCamera(), { width: 640, height: 360 });

    const query = (requestBytes.mock.calls[0]![1] as { query: Record<string, unknown> }).query;
    expect(query["force"]).toBeUndefined();
    // The changing timestamp is what defeats Protect's cache; `force` was only
    // ever belt and braces on top of it.
    expect(query["ts"]).toEqual(expect.any(Number));
    expect(query["w"]).toBe(640);
  });
});

const ask = (delegate: StreamingDelegate, width = 640, height = 360): Promise<Buffer> =>
  new Promise<Buffer>((resolve, reject) => {
    delegate.handleSnapshotRequest(
      { width, height } as never,
      ((error: Error | undefined, image: Buffer) =>
        error ? reject(error) : resolve(image)) as never,
    );
  });

describe("StreamingDelegate snapshots", () => {
  const build = () => {
    const requestBytes = vi.fn<() => Promise<unknown>>(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/jpeg",
    }));
    const platform = createFakePlatform({ client: { requestBytes } });
    return { delegate: new StreamingDelegate(platform, () => aCamera()), requestBytes };
  };

  it("asks the console once however many times HomeKit asks it", async () => {
    // Four requests for one camera in twelve seconds is what the Home app
    // actually does; each one used to be a fresh grab off the camera.
    const { delegate, requestBytes } = build();

    const images = await Promise.all([ask(delegate), ask(delegate), ask(delegate)]);

    expect(requestBytes).toHaveBeenCalledOnce();
    expect(images[0]).toEqual(images[1]);
  });

  it("fetches again for a different size, which is a different picture", async () => {
    const { delegate, requestBytes } = build();

    await ask(delegate, 640, 360);
    await ask(delegate, 1280, 720);

    expect(requestBytes).toHaveBeenCalledTimes(2);
  });

  it("does not serve a failure to the next caller", async () => {
    // Caching a rejection for the reuse window would turn one bad moment on
    // the console into several seconds of broken tiles.
    //
    // The camera here has no RTSP-enabled channel, so the ffmpeg fallback is
    // not available and the console's failure is the whole answer.
    let attempt = 0;
    const requestBytes = vi.fn<() => Promise<unknown>>(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("console busy");
      return { bytes: new Uint8Array([9]), contentType: "image/jpeg" };
    });
    const platform = createFakePlatform({ client: { requestBytes } });
    const delegate = new StreamingDelegate(platform, () => noChannels());

    await expect(ask(delegate)).rejects.toThrow("no RTSP channel");
    // The second attempt goes to the console rather than replaying the failure.
    await expect(ask(delegate)).resolves.toBeInstanceOf(Buffer);
    expect(requestBytes).toHaveBeenCalledTimes(2);
  });
});
