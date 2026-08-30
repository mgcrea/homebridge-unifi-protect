import type { Camera, ProtectClient } from "@mgcrea/unifi-protect";

import { describe } from "#util/describe";
import { FfmpegProcess } from "#media/ffmpeg";
import { snapshotArgs, type InputOptions } from "#media/stream-args";
import type { UnifiProtectPlatform } from "#platform";

/**
 * Getting a still image out of a camera.
 *
 * The console has an endpoint for exactly this, and it is the right first
 * choice: it is one request, it costs the bridge nothing, and it returns the
 * frame Protect itself would show. It also fails more often than you would
 * like — a camera mid-recording, a console under load, or a model that simply
 * does not implement it — so there is a fallback that pulls one frame off the
 * live stream. Without it a camera tile spins forever and says nothing about
 * why.
 */

export const fetchConsoleSnapshot = async (
  client: ProtectClient,
  camera: Camera,
  request: { width: number; height: number },
): Promise<Buffer> => {
  const result = await client.requestBytes(`cameras/${camera.id}/snapshot`, {
    query: {
      // Protect caches snapshots hard; without a changing timestamp every
      // request after the first comes back as the same frame.
      ts: Date.now(),
      force: true,
      w: request.width,
      h: request.height,
    },
    accept: "image/jpeg",
  });
  return Buffer.from(result.bytes);
};

/** Pull a single frame through ffmpeg. Slower, but it works when the console will not. */
export const fetchStreamSnapshot = async (
  platform: UnifiProtectPlatform,
  name: string,
  input: InputOptions,
  request: { width: number; height: number },
  timeoutMs = 10_000,
): Promise<Buffer> => {
  const process = new FfmpegProcess({
    platform,
    name: `${name} (snapshot)`,
    args: snapshotArgs({ input, width: request.width, height: request.height }),
    verbose: platform.options.verboseFfmpeg,
  });

  const chunks: Buffer[] = [];
  process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

  // A camera that has stopped answering leaves ffmpeg waiting on the RTSP
  // handshake indefinitely, and HAP gives up on a snapshot after 15 seconds —
  // so bound it well inside that and report something useful instead.
  const timer = setTimeout(() => process.stop(), timeoutMs);
  timer.unref?.();

  try {
    await process.exited;
  } finally {
    clearTimeout(timer);
  }

  const image = Buffer.concat(chunks);
  if (image.length === 0) {
    throw new Error("ffmpeg produced no image");
  }
  return image;
};

/** The console first, the live stream second, and a clear reason if neither works. */
export const takeSnapshot = async (options: {
  platform: UnifiProtectPlatform;
  client: ProtectClient;
  camera: Camera;
  name: string;
  input: InputOptions | undefined;
  request: { width: number; height: number };
}): Promise<Buffer> => {
  const { platform, name, request } = options;

  try {
    return await fetchConsoleSnapshot(options.client, options.camera, request);
  } catch (error) {
    platform.log.debug(`${name}: the console would not produce a snapshot — ${describe(error)}`);
  }

  if (!options.input) {
    throw new Error(
      "The console would not produce a snapshot and there is no RTSP channel to fall back to.",
    );
  }

  return fetchStreamSnapshot(platform, name, options.input, request);
};
