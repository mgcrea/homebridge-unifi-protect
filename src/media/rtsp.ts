import {
  RTSPS_PORT,
  type Camera,
  type CameraChannel,
  type ProtectClient,
} from "@mgcrea/unifi-protect";

/**
 * Choosing what to stream from, and where to find it.
 *
 * Everything here is pure except `enableRtsp`, which is the one call that
 * changes the console's configuration. Keeping the selection rules separate
 * from the request that acts on them is what makes them testable.
 */

/** A channel can only be streamed once RTSP is switched on and an alias exists. */
export const isChannelUsable = (channel: CameraChannel): boolean =>
  channel.isRtspEnabled === true &&
  typeof channel.rtspAlias === "string" &&
  channel.rtspAlias.length > 0;

export const usableChannels = (camera: Camera): CameraChannel[] =>
  camera.channels.filter((channel) => isChannelUsable(channel));

/** Channel names as Protect uses them, best quality first. */
export const CHANNEL_NAMES = ["high", "medium", "low"] as const;
export type ChannelName = (typeof CHANNEL_NAMES)[number];

const area = (channel: CameraChannel): number => (channel.width ?? 0) * (channel.height ?? 0);

/** HomeKit will not accept a stream above 30fps, whatever the camera reports. */
const advertisedFps = (channel: CameraChannel): number => Math.min(channel.fps ?? 30, 30);

/**
 * Pick the channel to stream for a requested resolution.
 *
 * The rule is "the smallest channel that is still big enough", not "the best
 * channel available". HomeKit asks for a specific size, and sending it a 4K
 * stream to be scaled down on a phone wastes the console's uplink, the bridge's
 * CPU and the viewer's battery for a picture that ends up the same size. When
 * nothing is big enough, the largest is used and scaled up rather than
 * refusing to stream.
 *
 * An exact match wins outright, because that is the case that can be copied
 * rather than transcoded.
 */
export const selectChannel = (
  channels: CameraChannel[],
  request: { width: number; height: number },
): CameraChannel | undefined => {
  const usable = channels.filter((channel) => isChannelUsable(channel));
  if (usable.length === 0) return undefined;

  const exact = usable.find(
    (channel) => channel.width === request.width && channel.height === request.height,
  );
  if (exact) return exact;

  const big = usable
    .filter((channel) => (channel.height ?? 0) >= request.height)
    .toSorted((a, b) => area(a) - area(b));
  if (big[0]) return big[0];

  return usable.toSorted((a, b) => area(b) - area(a))[0];
};

/** The channel a per-camera `channel` setting names, if it is usable. */
export const namedChannel = (
  camera: Camera,
  name: ChannelName | undefined,
): CameraChannel | undefined => {
  if (!name) return undefined;
  const match = camera.channels.find(
    (channel) => channel.name?.toLowerCase() === name && isChannelUsable(channel),
  );
  return match;
};

/**
 * The RTSPS URL for a channel.
 *
 * `enableSrtp` is what makes the console encrypt the media itself rather than
 * only the control channel.
 */
export const rtspUrl = (host: string, channel: CameraChannel, port = RTSPS_PORT): string =>
  `rtsps://${host}:${port}/${channel.rtspAlias ?? ""}?enableSrtp`;

/**
 * Switch RTSP on for a channel.
 *
 * Protect ships with RTSP off on every channel, so a camera that has never been
 * streamed from has no alias and cannot be reached at all. The write is a
 * read-modify-write of the whole `channels` array, which is how the console
 * expects it — patching a single channel object replaces the array with a
 * one-element one and silently disables the others.
 */
export const enableRtsp = async (
  client: ProtectClient,
  camera: Camera,
  channelId: number,
): Promise<void> => {
  const channels = camera.channels.map((channel) => ({
    ...channel,
    isRtspEnabled: channel.id === channelId ? true : channel.isRtspEnabled,
  }));
  await client.patch(`cameras/${camera.id}`, { channels });
};

/**
 * The resolutions to advertise to HomeKit for a camera.
 *
 * The camera's own channel sizes come first, because a resolution HomeKit picks
 * from that list is one the stream can be copied for rather than transcoded —
 * which is the difference between a few percent of a CPU and a whole core. The
 * standard HomeKit sizes follow so that a controller asking for something small
 * on a slow link still finds a match.
 */
export const advertisedResolutions = (camera: Camera): [number, number, number][] => {
  const native = camera.channels
    .filter((channel) => channel.width && channel.height)
    .map((channel): [number, number, number] => [
      channel.width!,
      channel.height!,
      advertisedFps(channel),
    ]);

  const standard: [number, number, number][] = [
    [1920, 1080, 30],
    [1280, 720, 30],
    [640, 360, 30],
    [480, 270, 30],
    [320, 180, 30],
  ];

  const seen = new Set<string>();
  return [...native, ...standard].filter(([width, height]) => {
    const key = `${width}x${height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * The resolutions to offer HomeKit for RECORDING.
 *
 * The camera's own channel sizes and nothing else — deliberately narrower than
 * what live streaming advertises. Streaming can afford the standard fallback
 * list because a transcode there lasts only as long as somebody is watching; a
 * Secure Video prebuffer runs for as long as recording is armed, so a size no
 * channel provides buys a permanently re-encoding ffmpeg. Measured on one
 * 2688x1512 camera asked for 1080p: 152% of a core, against low single digits
 * when the stream can be copied.
 *
 * A camera reporting no usable channel dimensions has nothing to copy anyway,
 * so it falls back to what streaming would offer rather than advertising an
 * empty list, which HAP rejects outright.
 */
export const recordingResolutions = (camera: Camera): [number, number, number][] => {
  const native = advertisedResolutions(camera).filter(([width, height]) =>
    camera.channels.some((channel) => channel.width === width && channel.height === height),
  );
  return native.length > 0 ? native : advertisedResolutions(camera);
};
