/**
 * A one-off PoC check: can this host actually stream and record these cameras?
 *
 * Read-only with respect to the console — it enables nothing and changes no
 * camera settings. It only reads the bootstrap, then runs the exact ffmpeg
 * command lines the plugin would run, and reports whether each took the copy
 * path and what it cost in CPU.
 *
 * This is the tool that found the three defects real hardware exposed and unit
 * tests could not: a hardware encoder that lists but will not run, a fragment
 * flag that silently produced the wrong length, and the CPU gap between copying
 * and re-encoding.
 *
 * To run it on a host with no checkout, bundle it into one file first:
 *
 *   npx tsdown --entry scripts/media-check.ts --format esm --platform node \
 *     --out-dir dist-poc --no-dts --external ''
 *
 * then copy `dist-poc/media-check.mjs` over and run it with node, supplying
 * UNIFI_PROTECT_HOST / _USERNAME / _PASSWORD / _STATE_DIR, and optionally
 * _CAMERA, _W, _H and _FFMPEG.
 */
import { spawn } from "node:child_process";
import { connectProtect } from "@mgcrea/unifi-protect";

import { probeCodecs } from "#media/codecs";
import { Mp4Fragmenter } from "#media/mp4/boxes";
import { H264Level, H264Profile, AudioRecordingCodec } from "#media/hap";
import { recordingArgs } from "#media/recording-args";
import { advertisedResolutions, rtspUrl, selectChannel, usableChannels } from "#media/rtsp";
import { canCopyVideo, streamArgs } from "#media/stream-args";

const env = (n: string): string => {
  const v = process.env[n];
  if (!v) {
    console.error(`missing ${n}`);
    process.exit(1);
  }
  return v;
};

const VP = process.env["UNIFI_PROTECT_FFMPEG"] ?? "ffmpeg";
const HOST = env("UNIFI_PROTECT_HOST");

/** Sample the child's own CPU time from /proc, so the number is ffmpeg's and not ours. */
const cpuSecondsOf = async (pid: number): Promise<number> => {
  try {
    const { readFile } = await import("node:fs/promises");
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // utime and stime are fields 14 and 15, after the comm field which may
    // itself contain spaces — so split on the last ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[11]) + Number(fields[12]);
    return ticks / 100; // USER_HZ is 100 on every Linux we care about
  } catch {
    return Number.NaN;
  }
};

const run = (args: string[], seconds: number, onData?: (c: Buffer) => void) =>
  new Promise<{ code: number | null; err: string; bytes: number; cpuPercent: number }>(
    (resolve) => {
      const p = spawn(VP, args);
      let err = "",
        bytes = 0,
        cpu = Number.NaN;
      const started = Date.now();
      p.stderr.on("data", (c) => (err += c));
      p.stdout.on("data", (c: Buffer) => {
        bytes += c.length;
        onData?.(c);
      });
      // Sample just before asking it to stop; after exit /proc is gone.
      const sample = setInterval(() => {
        void cpuSecondsOf(p.pid!).then((v) => (cpu = v));
      }, 500);
      const t = setTimeout(() => p.kill("SIGTERM"), seconds * 1000);
      p.on("close", (code) => {
        clearTimeout(t);
        clearInterval(sample);
        const wall = (Date.now() - started) / 1000;
        resolve({ code, err: err.trim(), bytes, cpuPercent: Math.round((cpu / wall) * 100) });
      });
    },
  );

const main = async () => {
  const codecs = await probeCodecs(VP, {
    info: (...a) => console.log("  ", ...a),
    warn: (...a) => console.warn("  warn:", ...a),
    debug: (...a) => console.log("   debug:", ...a),
  });
  console.log(
    `\nencoder: ${codecs.videoEncoder} (${codecs.hardware ? "hardware" : "software"}), audio: ${codecs.audioEncoder ?? "none"}\n`,
  );

  const protect = await connectProtect({
    host: HOST,
    username: env("UNIFI_PROTECT_USERNAME"),
    password: env("UNIFI_PROTECT_PASSWORD"),
    stateDir: env("UNIFI_PROTECT_STATE_DIR"),
    fingerprint: process.env["UNIFI_PROTECT_FINGERPRINT"],
  });

  const wanted = process.env["UNIFI_PROTECT_CAMERA"];
  const cameras = protect.store.cameras();
  const camera = wanted ? (cameras.find((c) => c.name === wanted) ?? cameras[0]!) : cameras[0]!;
  console.log(`camera: ${camera.name} (${camera.marketName ?? camera.type})`);
  console.log(
    `advertised to HomeKit: ${advertisedResolutions(camera)
      .slice(0, 4)
      .map(([w, h]) => `${w}x${h}`)
      .join(", ")}\n`,
  );

  // --- live streaming, at the size HomeKit would most likely pick ---
  const req = {
    width: Number(process.env["UNIFI_PROTECT_W"] ?? 1920),
    height: Number(process.env["UNIFI_PROTECT_H"] ?? 1080),
    fps: 30,
    maxBitrateKbps: 2000,
    profile: H264Profile.HIGH,
    level: H264Level.LEVEL4_0,
  };
  const channel = selectChannel(usableChannels(camera), req);
  if (!channel) {
    console.log("no usable channel");
    await protect.disconnect();
    return;
  }
  console.log(
    `chose channel "${channel.name}" ${channel.width}x${channel.height} idr=${channel.idrInterval}s -> ${canCopyVideo(channel, req) ? "COPY" : "transcode"}`,
  );

  const target = {
    address: "127.0.0.1",
    port: 45900,
    localPort: 45902,
    srtpKey: Buffer.alloc(16, 1),
    srtpSalt: Buffer.alloc(14, 2),
    ssrc: 1,
    payloadType: 99,
    mtu: 1378,
  };
  const input = { url: rtspUrl(HOST, channel), caFile: undefined };
  const cpuBefore = process.cpuUsage();
  const wall = Date.now();
  const live = await run(
    streamArgs({ input, channel, video: { request: req, target }, codecs }),
    8,
  );
  console.log(
    `  live stream: exit=${live.code} cpu=${live.cpuPercent}% ${live.err ? "| " + live.err.split("\n")[0] : "(no errors)"}`,
  );
  void cpuBefore;
  void wall;

  // --- HKSV recording, exactly as the prebuffer would run it ---
  const alignedIdr = process.env["UNIFI_PROTECT_ASSUME_IDR"];
  const recChannel = alignedIdr ? { ...channel, idrInterval: Number(alignedIdr) } : channel;
  const recReq = {
    width: channel.width!,
    height: channel.height!,
    fps: 30,
    profile: H264Profile.HIGH,
    level: H264Level.LEVEL4_0,
    bitrateKbps: 2000,
    fragmentLengthMs: 4000,
    iFrameIntervalMs: 4000,
    audio: { codec: AudioRecordingCodec.AAC_LC, samplerate: 3, bitrateKbps: 32 },
  };
  const fragmenter = new Mp4Fragmenter();
  const frags: number[] = [];
  const rec = await run(
    recordingArgs({ input, channel: recChannel, request: recReq, codecs }),
    14,
    (c) => {
      for (const f of fragmenter.push(c)) frags.push(f.data.length);
    },
  );
  console.log(
    `  recording:   exit=${rec.code} cpu=${rec.cpuPercent}% ${rec.err ? "| " + rec.err.split("\n")[0] : "(no errors)"}`,
  );
  console.log(
    `    copy path: ${recordingArgs({ input, channel: recChannel, request: recReq, codecs }).includes("copy") ? "yes" : "no (re-encoding)"}`,
  );
  console.log(`    init segment: ${fragmenter.initSegment?.length ?? "MISSING"} bytes`);
  console.log(`    fragments: ${frags.length} [${frags.join(", ")}]`);

  await protect.disconnect();
};

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exit(1);
});
