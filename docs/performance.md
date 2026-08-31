# Performance

Every number here was measured on one real installation, with the commands
needed to reproduce it. Nothing is extrapolated, and the cases where this plugin
is *slow* are included alongside the ones where it is fast — the whole point of
measuring was to find out which is which.

## The test bench

| | |
|---|---|
| Host | Intel Core i7-7567U @ 3.5 GHz, 2 cores / 4 threads, 31 GB RAM |
| OS | Ubuntu 24.04, `homebridge/homebridge:beta` container, host networking |
| Homebridge | 2.4.1-beta.10 (HAP 2.2.3), Node 26.8.1 |
| ffmpeg | 8.0, static alpine x86_64 build shipped in the image |
| Console | UniFi UNVR running Protect 7.2.105, 13 cameras |
| Video encoder | `libx264` (software) — this host has no usable hardware encoder |

That last row matters when reading the transcode figures: they are a **software**
encoder's numbers. A host with VideoToolbox, NVENC, QuickSync or Rockchip will do
considerably better, and a Raspberry Pi rather worse.

`percent of a core` is ffmpeg's own CPU time sampled from `/proc/<pid>/stat`,
divided by wall clock. 100% means one core fully occupied. The host has 4
threads, so 166% is real and sustainable; it is not a measurement artefact.

## Idle cost

Both plugins run side by side on this bridge, against the same console, with the
same 13 cameras, as separate child bridges. Neither had a stream open, neither
had Secure Video armed. This is what each costs to simply *be there*:

| | [`homebridge-unifi-protect`][hjdhjd] 8.1.0 | this plugin |
|---|---|---|
| CPU consumed over 257 s | **1 m 27 s** | **8 s** |
| Resident memory | **310 MB** | **142 MB** |

Roughly **11× less CPU and half the memory**, reproduced across two independent
257-second windows (1 m 15 s vs 6.5 s in the first, 1 m 27 s vs 8 s in the
second).

Read it fairly, though. The other plugin was exposing 15 accessories to this
one's 14 — it also handles the doorbell's package camera and a UP Chime, which
this plugin does not — and it caches snapshots on a timer, which this plugin does
not do at all. Some of the gap is genuinely extra work. Not eleven-fold's worth,
but the number is a comparison of two different feature sets, not of two
implementations of the same one.

Reproduce it with both plugins installed and idle:

```console
$ docker exec homebridge ps -eo etimes,time,rss,args | grep 'homebridge: '
  257 00:01:27 309864 homebridge: homebridge-unifi-protect
  257 00:00:08 141724 homebridge: @mgcrea/homebridge-unifi-protect
```

## Video cost

This is where the design decisions show up. The plugin advertises the camera's
own channel sizes to HomeKit so that the common case is a **copy** — the
camera's H.264 passed through untouched — rather than a re-encode.

All three runs are the same camera (a G4 Instant: 2688×1512 / 1280×720 / 640×360
channels) and the same 8-second sample, via `scripts/media-check.ts`:

| What HomeKit asks for | Channel chosen | Live stream | Secure Video |
|---|---|---|---|
| 1280×720 | Medium 1280×720, keyframes 2 s | **2%** (copy) | **5%** (copy) |
| 1280×720, keyframes forced to 5 s | Medium 1280×720 | 3% (copy) | **87%** (re-encode) |
| 1920×1080 | High 2688×1512, keyframes 5 s | **166%** (transcode) | **163%** (transcode) |

Three things worth pulling out.

**Copying is nearly free, transcoding is not.** 2% against 166% for the same
picture is a factor of eighty. It is the difference between a bridge that can
serve several cameras on a low-power box and one that cannot serve one.

**Row two isolates the keyframe trap.** Same resolution, same channel, same copy
path for live — only the keyframe interval changed, and recording went from 5% to
87%. With `-codec:v copy` ffmpeg can only cut a fragment where the camera already
put a keyframe, so the camera's keyframe interval has to divide HomeKit's 4-second
fragment length. Protect's medium channels ship at 2 s, which divides 4; the high
channels ship at 5 s, which does not. **This plugin does not reconfigure your
cameras to fix that** — it re-encodes and moves on. The console's settings are
yours.

**Row three is why recording advertises fewer sizes than streaming.** 1920×1080
is on HomeKit's standard list but no channel on this camera produces it, so the
request falls through to the 2688×1512 high channel and gets scaled. For live
viewing that costs a core only while somebody is watching. For Secure Video the
prebuffer runs for as long as recording is armed, so it would cost a core
permanently — which is why `recordingResolutions` offers native sizes only.

Reproduce with a bundled copy of the harness — it is read-only with respect to
the console and changes no camera settings:

```bash
npx tsdown --entry scripts/media-check.ts --format esm --platform node \
  --out-dir dist-check --no-dts
UNIFI_PROTECT_HOST=… UNIFI_PROTECT_USERNAME=… UNIFI_PROTECT_PASSWORD=… \
UNIFI_PROTECT_STATE_DIR=/tmp/check UNIFI_PROTECT_CAMERA='Front Door' \
UNIFI_PROTECT_W=1280 UNIFI_PROTECT_H=720 \
  node dist-check/media-check.mjs
```

`UNIFI_PROTECT_ASSUME_IDR=5` forces the keyframe interval used for the recording
leg, which is how row two was produced without touching the camera.

## What this does not measure

- **Hardware encoders.** Every transcode figure here is `libx264`. The plugin
  probes for VideoToolbox, NVENC, QuickSync, Rockchip and v4l2m2m, and verifies
  the encoder actually runs before choosing it — but this host has none.
- **Many simultaneous viewers.** One stream at a time. The costs add up roughly
  linearly, but that is reasoning, not measurement.
- **Sustained Secure Video across a full day**, with motion events triggering
  real recordings, rather than an 8-second sample.
- **Anything on ARM.** No Raspberry Pi was harmed in the making of these numbers.

[hjdhjd]: https://github.com/hjdhjd/homebridge-unifi-protect
