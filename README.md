<!-- markdownlint-disable MD033 MD041 -->
# homebridge-unifi-protect

<p align="center">
  <a href="https://www.npmjs.com/package/@mgcrea/homebridge-unifi-protect"><img src="https://img.shields.io/npm/v/@mgcrea/homebridge-unifi-protect.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@mgcrea/homebridge-unifi-protect"><img src="https://img.shields.io/npm/dm/@mgcrea/homebridge-unifi-protect.svg" alt="downloads"></a>
  <a href="https://github.com/mgcrea/homebridge-unifi-protect/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@mgcrea/homebridge-unifi-protect.svg" alt="license"></a>
  <a href="https://github.com/mgcrea/homebridge-unifi-protect/actions/workflows/ci.yml"><img src="https://github.com/mgcrea/homebridge-unifi-protect/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

---

A Homebridge plugin for UniFi Protect: cameras, doorbells, UP Sense sensors and
UP FloodLights, driven by the console's realtime update stream.

> **Not** the widely used [`homebridge-unifi-protect`][hjdhjd] by hjdhjd, which
> is a much larger and more featureful plugin. This one is deliberately small:
> it exists so that the code holding admin credentials for a security system is
> code its author wrote and can audit. If you want breadth, use that one.

## Features

- **Live video and snapshots** over the console's own RTSPS, sent straight
  through without re-encoding whenever HomeKit asks for a size the camera
  already produces.
- **HomeKit Secure Video**, with the same copy-don't-re-encode approach, and
  without writing anything to your console to achieve it — a recording costs
  about 5% of a CPU core where the camera's own stream can be passed through.
- **Cameras** — a motion sensor per camera, held on for a configurable window so
  one person walking up a path is one notification rather than a burst.
- **Doorbells** — a HomeKit doorbell button, so rings can drive automations.
- **UP Sense** — contact, motion, temperature, humidity, ambient light, leak and
  battery. Only the measurements your sensor is actually reporting get a tile,
  and a tile disappears if the sensor is re-mounted and stops reporting it.
- **UP FloodLight** — dimmable light plus its built-in PIR sensor.
- **Console diagnostics** (opt-in) — whether the bridge is talking to the
  console, and how much recording space is left.
- **Certificate pinning.** See below; this is the reason the plugin exists.
- **No cloud.** Everything is local, and the password is never written to disk.

## Requirements

- Homebridge 2.0 or newer, on Node 22, 24 or 26.
- A UniFi console running Protect, reachable on your network.
- A **Local Access Only** user on the console with Protect permissions.
- `ffmpeg`, for live video. For camera **audio** it must be built with
  `libfdk_aac`: HomeKit negotiates the AAC-ELD profile, which no other encoder
  produces. Without it, streams are video-only and the log says so once.

## Install

```sh
npm install -g @mgcrea/homebridge-unifi-protect
```

Then add the platform, or fill in the form in the Homebridge UI:

```json
{
  "platforms": [
    {
      "platform": "UniFiProtect",
      "host": "10.0.0.1",
      "username": "homebridge",
      "password": "…"
    }
  ]
}
```

## Configuration

| Option | Default | Notes |
|---|---|---|
| `host` | — | Hostname or IP of the console itself, not a proxy in front of it. A pasted URL is accepted. |
| `port` | `443` | |
| `username` / `password` | — | A Local Access Only user. See [Credentials](#credentials). |
| `fingerprint` | — | SHA-256 of the console's certificate. See [Certificate pinning](#certificate-pinning). |
| `insecureTls` | `false` | Turns verification off entirely. Don't. |
| `exposeCameras` | `true` | Motion sensors, and doorbell buttons for doorbells. |
| `exposeSensors` | `true` | UP Sense. |
| `exposeLights` | `true` | UP FloodLight. |
| `exposeNvr` | `false` | Console reachability and free storage. Diagnostics, so opt-in. |
| `motionDuration` | `10` | Seconds a motion sensor stays tripped. Clamped to 2–300. |
| `enableStreaming` | `true` | Live video and snapshots. Off keeps motion and doorbell events working. |
| `enableRecording` | `true` | Offer Secure Video. Costs nothing until enabled per camera in the Home app. |
| `videoProcessor` | `ffmpeg` | Path to ffmpeg. |
| `rtspPort` | `7441` | Where Protect serves camera streams. |
| `verboseFfmpeg` | `false` | Log every ffmpeg line, not just the tail of a failure. |
| `cameras` | `[]` | Per-camera settings, keyed by MAC: `exclude`, `channel`. |
| `debug` | `false` | Logs the console conversation at info level. Verbose. |

## Credentials

Create a dedicated account rather than reusing your own: **Settings → Admins →
Add Admin → Local Access Only**, with Protect permissions. View access is enough
unless you want to control FloodLights from HomeKit, which needs Admin.

Two things that catch people out:

- A **Ubiquiti cloud (SSO) account usually cannot log in locally at all.** The
  plugin says so explicitly if that is what happened.
- **Avoid two-factor on this account.** A bridge that runs unattended cannot
  answer a prompt.

## Certificate pinning

UniFi consoles present a self-signed certificate for `CN=unifi.local`, with SANs
for `unifi.local`, `localhost` and `127.0.0.1` — and **no IP SAN**. A bridge
addresses the console by IP, so ordinary verification cannot succeed however the
certificate is trusted, which is why plugins in this space end up disabling
verification outright. That leaves your console's admin password readable by
anything on the network that can answer on port 443.

This plugin pins instead. On the first connection it records the certificate and
logs its fingerprint:

```
Console certificate fingerprint: 3F2A…C61D. Set it as `fingerprint` in the plugin config to make the trust explicit.
```

Every connection after that verifies the chain against exactly that certificate
and *replaces* the host name check with a fingerprint comparison — so it works
by IP, and a swapped certificate fails loudly instead of silently.

Trust-on-first-use is only as good as that first moment, so paste the value into
`fingerprint` once you have it. If the console legitimately reissues its
certificate, the error names the file to delete.

## How video works

Protect publishes each camera on up to three channels — `high`, `medium`, `low`
— and the plugin advertises those exact sizes to HomeKit alongside the standard
ones. That ordering is the whole trick: when HomeKit picks a size the camera
already produces, the stream is **copied** rather than re-encoded, which is a
few percent of one CPU core instead of most of one. Otherwise it transcodes,
using hardware where the host has it (VideoToolbox, NVENC, QuickSync, Rockchip,
or the Pi's v4l2m2m) and libx264 where it does not.

Channel choice is "the smallest channel that is still big enough", not "the best
one available" — sending a 4K stream to be scaled down on a phone spends the
console's uplink and the bridge's CPU on a picture that ends up the same size.
Override it per camera with `channel` if you disagree.

Protect ships with RTSP switched **off** on every channel, so a camera nobody
has streamed from has no address at all. The plugin switches the top channel on
the first time it needs one, provided the configured account may write; if it is
view-only, the log says so and you can enable it in Protect yourself.

Snapshots come from the console's own endpoint first, and fall back to pulling a
single frame off the live stream — that endpoint fails more often than you would
expect, and without the fallback the camera tile just spins.

## How recording works

HomeKit Secure Video needs footage from *before* the motion that triggered it —
by the time Protect reports someone at the door, the part where they walked up
has already happened. So while Secure Video is armed for a camera, one ffmpeg
runs continuously for it, holding the last few seconds in memory.

That is the only continuous cost in the plugin, and it is why recording is armed
per camera in the Home app rather than for everything at once. It is also why
the copy path matters more here than it does for live viewing: with
`-codec:v copy` the process is nearly free.

Copying requires fragments to come out the length HomeKit asked for, and ffmpeg
can only cut a fragment where the camera already placed a keyframe — so the
camera's keyframe interval has to divide HomeKit's four seconds. Protect's medium
channels ship at two seconds, which divides four, so the common case copies with
nothing on the console changed. The high channels ship at five, which does not.

**The plugin does not reconfigure your cameras to fix that.** Protect exposes the
interval and would let it be written, but a plugin that quietly edits the
settings of a security system is not one you can audit by reading its config.
Where the interval does not divide, it re-encodes and says so in the log. That
costs about 87% of a core against 5% for the copy path — [measured][perf], along
with everything else.

The plugin does no muxing of its own. ffmpeg's MP4 muxer already emits exactly
what Secure Video consumes — an `ftyp`/`moov` header followed by `moof`/`mdat`
fragment pairs — so all that is needed is ninety lines that slice the byte
stream on box boundaries.

One useful asymmetry: **recording works with a plain ffmpeg, live audio does
not.** Secure Video accepts AAC-LC, which the built-in encoder produces, while
live streaming only ever negotiates AAC-ELD and needs `libfdk_aac`. A host
without it records with sound and streams silently.

### One caveat about RTSPS

The plugin pins the console's certificate for its API connection, but it cannot
for the media connection: ffmpeg accepts a trust anchor and not a fingerprint,
so it still runs the host name check — and the console's certificate has no IP
SAN. Addressing the console by **IP** therefore means ffmpeg cannot verify it;
addressing it by a **host name that resolves to it** means the pinned
certificate is handed to ffmpeg and verification is real.

What that costs is worth being precise about: no credentials cross the media
connection. The RTSP alias in the URL is a per-channel bearer token, and the
media itself is separately encrypted (`enableSrtp`). It is still weaker than the
API path, and using a host name closes it.

## Performance

Measured on one real installation — an i7-7567U running both this plugin and
[hjdhjd's][hjdhjd] side by side against the same console and the same 13
cameras, neither streaming:

| Idle, per plugin | `homebridge-unifi-protect` 8.1.0 | this plugin |
|---|---|---|
| CPU consumed over 257 s | 1 m 27 s | **8 s** |
| Resident memory | 310 MB | **142 MB** |

And the cost of video, same camera, same eight seconds:

| HomeKit asks for | Live stream | Secure Video |
|---|---|---|
| a size the camera produces | **2%** of a core (copy) | **5%** of a core (copy) |
| a size it does not | 166% (transcode) | 163% (transcode) |

The gap between those two rows is the reason the plugin advertises the camera's
own channel sizes first, and the reason Secure Video advertises *only* those.

[**Full methodology, the reproduction commands, and what these numbers do not
cover →**][perf]

## How it maps to HomeKit

| Protect | HomeKit |
|---|---|
| Camera | Camera + Motion Sensor |
| Doorbell | Camera + Motion Sensor + Doorbell |
| UP Sense (door) | Contact Sensor + Battery |
| UP Sense (leak) | Leak Sensor + Battery |
| UP Sense readings | Temperature / Humidity / Light Sensor |
| UP FloodLight | Lightbulb (dimmable) + Motion Sensor |
| Console | Contact Sensor (online) + Battery (free storage) |

Free storage is a battery because it is the only HomeKit primitive that means "a
percentage, with a warning when it gets low". A console that is recycling — 
overwriting the oldest footage, which is normal — never raises that warning.

## Diagnosing

```sh
UNIFI_PROTECT_HOST=10.0.0.1 \
UNIFI_PROTECT_USERNAME=homebridge \
UNIFI_PROTECT_PASSWORD=... \
pnpm diagnose
```

Prints the resolved configuration, each camera's MAC and channels, which
channels have RTSP enabled, and any camera whose smart-detect zones ask for
something the camera's own detection switch does not allow — a state in which
Protect reports nothing at all, forever, with no error anywhere.

## Roadmap

1. ✅ Sensors, doorbells, lights, console diagnostics.
2. ✅ Live streaming and snapshots, over RTSPS.
3. ✅ HomeKit Secure Video.
4. Two-way audio.

## Development

```sh
pnpm install
pnpm test            # lint, typecheck, spec, format:check
pnpm dev:homebridge  # an isolated bridge under ./.homebridge
```

The Protect client lives in a separate package,
[`@mgcrea/unifi-protect`][client], and is resolved from a sibling checkout
during development.

## License

MIT

[hjdhjd]: https://github.com/hjdhjd/homebridge-unifi-protect
[client]: https://github.com/mgcrea/unifi-protect-client
[perf]: docs/performance.md
