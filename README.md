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

> **Status: video is not implemented yet.** Cameras appear as motion sensors and
> doorbells as buttons, which covers automations. Live streaming and HomeKit
> Secure Video are the next two releases — see [Roadmap](#roadmap).

## Features

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
| `cameras` | `[]` | Per-camera settings, keyed by MAC. Currently just `exclude`. |
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

## How it maps to HomeKit

| Protect | HomeKit |
|---|---|
| Camera | Motion Sensor |
| Doorbell | Motion Sensor + Doorbell |
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
2. Live streaming and snapshots, over RTSPS.
3. HomeKit Secure Video.

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
