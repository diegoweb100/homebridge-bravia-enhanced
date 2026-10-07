# homebridge-bravia-enhanced

[![npm](https://img.shields.io/npm/v/homebridge-bravia-enhanced)](https://www.npmjs.com/package/homebridge-bravia-enhanced)
[![downloads](https://img.shields.io/npm/dt/homebridge-bravia-enhanced)](https://www.npmjs.com/package/homebridge-bravia-enhanced)
[![license](https://img.shields.io/npm/l/homebridge-bravia-enhanced)](LICENSE)
[![homebridge verified](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/diegoweb100)

> **Enhanced fork** of [homebridge-bravia](https://github.com/normen/homebridge-bravia) by Normen Hansen.
> Maintained by [diegoweb100](https://github.com/diegoweb100)

Homebridge plugin for Sony Bravia TVs (AndroidTV based ones and possibly others).

---

## What's new in this fork

### User-facing features

- **Web-based Channel Selector UI**: browse, search and save your favourite channels directly from the browser, no config file editing required.
- **Full-scan cache**: all channels are always visible in the UI even when HomeKit shows only a subset.
- **User selection persistence**: your channel selection survives Homebridge restarts.
- **HomeKit 97-input limit enforced** (100 services minus AccessoryInformation, TV and Speaker equals 97 max inputs), configurable via `maxInputSources`.
- **New pairing page**: clean PIN entry UI with live pairing status, a **Request PIN from TV** button to trigger a new PIN without restarting Homebridge (v1.4.12+), and a **Delete cookie and force re-pairing** button for cookie-based setups.
- **Improved app title matching**: fuzzy normalisation prevents duplicates and handles `+`/`plus` variants.
- **HDMI input status polling**: auto-detects connected/disconnected HDMI inputs with automatic API version fallback (v1.1 to v1.0).
- **Verbose structured logging**: easier troubleshooting with prefixed log lines (`[POWER]`, `[PAIRING]`, etc.).
- **Volume accessory** (optional): a separate Lightbulb to control TV volume (brightness) and mute (on/off) directly from HomeKit.
- **Volume On-Screen Display toggle** (v1.4.12+): `volumeUI` controls whether HomeKit volume changes show the TV's native OSD slider. Off by default (silent changes).

### Compatibility and reliability

- **Pre-Shared Key (PSK) authentication** (v1.4.2+) for Bravia XR and newer models (interface v6.x and above). Set `psk` in the TV config and the plugin sends the `X-Auth-PSK` header instead of going through cookie pairing. Resolves the persistent `error [1] Internal Server Error` on models like K-55XR8M2 (Bravia 8 II) where cookie pairing is no longer supported.
- **Full API version auto-detection** (v1.3.0+): at boot the plugin probes every Sony endpoint via `getVersions` and `getMethodTypes` and uses the versions actually supported by your specific TV for every API call. Fixes pairing and channel scan on newer Bravia XR models where `actRegister` v1.0 or `getContentList` v1.0 are no longer accepted.
- **WOL directed-broadcast auto-derivation** (v1.4.2+): when `woladdress` is not set, the plugin derives the subnet broadcast from the TV's IP (e.g. `192.168.11.14` becomes `192.168.11.255`). Makes WOL work across VLANs when the router has `broadcast-forward` enabled, without manual calculation.
- **Web server always active** (v1.3.0+): the embedded HTTP server (pairing UI and Channel Selector) is always started. `enableChannelSelector` now controls only whether the Channel Selector page is exposed.
- **Comprehensive debug output** (v1.4.0+): set `debug: true` per TV and the plugin produces a complete, self-contained diagnostic dump on startup: environment hints (Docker / Synology / RPi auto-detection), sanitised config, storage paths with file sizes, full capabilities table, every HTTP request/response with body and latency, detailed pairing trace, WOL trace, and global handlers for uncaught exceptions. Sensitive values (PSK, PIN, cookies, MAC) are masked.

### Robust power-on (v1.4.13+)

- **WOL burst**: power-on sends a configurable burst of magic packets (5 packets at 500 ms intervals by default) instead of a single packet. Much more reliable on flaky networks and on TVs whose NIC firmware is still booting when the first packet arrives.
- **REST alive verification after WOL**: the plugin polls `getPowerStatus` every 2 s for up to 15 s after a WOL burst and logs precisely when the TV came alive (or timed out).
- **`wolMode` configuration option**: selects the WOL fallback strategy when REST `setPowerStatus` fails.
  - `"auto"` (default): WOL burst sent both as unicast to the TV's IP and to the subnet broadcast derived from it (since v1.4.21: unicast alone is dropped when the host no longer has an ARP entry for a sleeping TV).
  - `"directed-broadcast"`: WOL burst to subnet broadcast (`woladdress`). Useful across VLANs when broadcast-forward is enabled.
  - `"disabled"`: REST only, no WOL.
- **Back-compat for `woladdress`** (v1.4.15+): if you set `woladdress` in config but do not set `wolMode`, the plugin auto-promotes `wolMode` to `directed-broadcast` so v1.4.12 setups keep working after upgrade.
- **Post-wake channel-scan delay**: the first channel scan after a wake-up is deferred 3 s (`postWakeScanDelay`) so the TV's AV stack has time to initialise before content list queries.
- **Adaptive status polling**: 5 s when the TV is on (`updaterate`), 25 s when in standby (`standbyUpdateRate`), 2 s temporarily during the post-wake window (`postWakePollRate` / `postWakePollWindow`). Cuts log noise and traffic during long standby periods.
- **`[POWER]` log prefix**: every step of the power-on flow is logged with a `[POWER]` prefix for easy `grep`.

### Recent bug fixes

- **v1.4.15**: cross-VLAN WOL regression introduced in v1.4.13 fixed via `woladdress` back-compat.
- **v1.4.14**: apps removed after every rescan ([issue #4](https://github.com/diegoweb100/homebridge-bravia-enhanced/issues/4)); `getApplicationList` endpoint mismatch in capabilities map.

See the [CHANGELOG](CHANGELOG.md) for the complete history.

---

## Supported functions

- Turning the TV on/off
- Setting volume and mute
- Selecting inputs, channels and apps
- Starting apps
- Triggering automations when the TV turns on/off
- iOS 12.2 remote support
- Authentication with or without PSK (cookie pairing for legacy models, PSK for XR)
- TV functions as inputs: Teletext, TV Guide, Subtitles, Audio track, TV / Radio, Home menu, Channel +/− (v1.4.21)
- "TV Settings" in the iOS remote / TV tile opens the TV's options menu (v1.4.21)
- Radio stations, with their own group in the Channel Selector (v1.4.21)
- **Recordings — only with a USB hard drive connected to the TV** (v1.4.21): recordings as inputs, "Record now", and a Recordings web page to play, protect and delete them
- Optional Controls accessory: picture-mode switches and "Screen off" (v1.4.21)
- Diagnostics page: Wake-on-LAN, network, power saving, picture mode, USB drive, TV clock (v1.4.21)

This plugin requires iOS 12.2+.

---

## Installation

```bash
npm install -g homebridge-bravia-enhanced
```

Or clone this repo and run `npm install` locally.

### Setup steps

1. Configure the plugin in `config.json` or via the Homebridge UI (see below).
2. Turn on the TV.
3. Recommended: enable **Remote Start** on the TV (Settings > Network > Remote Start).
4. Pick an authentication method:
   - **PSK (recommended for Bravia XR and newer models)**: enable Pre-Shared Key on the TV (Settings > Network > IP control > Authentication > Pre-Shared Key), pick a key, and add `"psk": "<your-key>"` to the TV config. No PIN needed.
   - **Cookie pairing (legacy models)**: leave `psk` unset. The plugin will trigger a PIN on the TV at startup.
5. Restart Homebridge.
6. **PSK users**: the TV will appear in HomeKit once channels are scanned. No further action needed.
7. **Cookie users**: a PIN appears on the TV screen. Open `http://<homebridge-ip>:8999/pair?tv=<TV_NAME>` (the URL is also logged at boot) and enter the PIN there.

### Channel Selector UI

Since v1.4.21 the web UI has three tabs — **Channels & inputs**, **Pairing & device** and **Discover TVs** — with light/dark theme and phone layout. Saving a selection applies it to HomeKit immediately (no restart) and keeps the HomeKit identifiers of the inputs you already had. TV channels, **radio stations**, HDMI inputs, apps and **Teletext** (a virtual input that presses the Teletext key on the TV) can all be selected.

After pairing, open `http://<homebridge-ip>:8999` (or the configured `serverPort`) to access the Channel Selector. You can:

- Browse all channels, HDMI inputs and apps.
- Use the search box or type filter to find channels.
- Click channels to select or deselect them.
- Use the **Select All**, **Clear All**, **HD Channels Only** or **Top 20** shortcuts.
- Click **🔄 Rescan TV** to force a fresh scan from the TV.
- Click **💾 Save Selection** to push the selection to HomeKit immediately.

### Re-pairing / Force re-pairing (cookie auth only)

If the TV stops responding or you want to manually reset cookie pairing, open the pairing page:

```
http://<homebridge-ip>:8999/pair?tv=<TV_NAME>
```

If already paired, a **🗑️ Delete cookie and force re-pairing** button will appear. Click it to delete the stored session cookie and trigger a new PIN request on the TV. There is also a **📺 Request PIN from TV** button to ask the TV to display a PIN without restarting Homebridge.

PSK setups have no cookie: re-authentication is not needed. To rotate the PSK, just change it on the TV and in the plugin config.

### External accessory mode

If you set `externalaccessory: true`, after the Homebridge restart:

1. In HomeKit, press **+** and **Add Device**.
2. Select **I have no code**, then enter the Homebridge setup code to add the TV.

---

## config.json examples

### Minimal (cookie pairing)

```json
"platforms": [
  {
    "platform": "BraviaPlatform",
    "tvs": [
      {
        "name": "Living Room TV",
        "ip": "192.168.1.10",
        "soundoutput": "speaker",
        "tvsource": "tv:dvbt",
        "applications": [{"title": "Netflix"}, {"title": "YouTube"}],
        "sources": ["extInput:hdmi"],
        "maxInputSources": 50
      }
    ]
  }
]
```

### Bravia XR (PSK)

```json
"platforms": [
  {
    "platform": "BraviaPlatform",
    "tvs": [
      {
        "name": "Bravia XR",
        "ip": "192.168.1.10",
        "psk": "your-pre-shared-key",
        "tvsource": "tv:dvbt"
      }
    ]
  }
]
```

### Cross-VLAN with Wake-on-LAN

```json
"platforms": [
  {
    "platform": "BraviaPlatform",
    "tvs": [
      {
        "name": "Bedroom TV",
        "ip": "192.168.11.14",
        "mac": "AA:BB:CC:DD:EE:FF",
        "wolMode": "directed-broadcast",
        "tvsource": "tv:dvbt"
      }
    ]
  }
]
```

This setup requires the router to forward directed broadcasts to the TV's VLAN (e.g. on FortiGate: `set broadcast-forward enable` on the TV's interface).

---

## Options

### Required

| Option | Description |
|---|---|
| `tvs` | Array of Sony TV configurations |
| `name` | Name of the TV as shown in HomeKit |
| `ip` | IP address or hostname of the TV |

### Authentication

| Option | Default | Description |
|---|---|---|
| `psk` | unset | Pre-Shared Key. If set, the plugin sends `X-Auth-PSK` on every request and skips PIN+cookie pairing. Required for Bravia XR and newer models (interface v6.x+). Set the same key on the TV: Settings > Network > IP control > Authentication > Pre-Shared Key. |

When `psk` is not set the plugin falls back to legacy cookie pairing (PIN entry via the web UI).

### Inputs and channels

| Option | Default | Description |
|---|---|---|
| `tvsource` | unset | TV tuner source: `tv:dvbt` (antenna), `tv:dvbc` (cable), or `tv:dvbs` (satellite). Leave unset to omit TV channels. |
| `sources` | read from the TV | Sony source URIs to scan, e.g. `["extInput:hdmi"]`. When set, **only** these are used, exactly as written. When not set, the plugin asks the TV for its real list (`getSourceList`, e.g. `extInput:hdmi`, `extInput:composite`, `extInput:scart`, `extInput:cec`, `extInput:widi`). Entries that are not source URIs (e.g. `"HDMI 3"` or a device name) are ignored with a warning: to show or hide single inputs use the Channel Selector. Note: the analog A/V input is `extInput:composite` (not `extInput:component`). |
| `applications` | unset | Array of `{title}` objects. **Apps are not added unless this array contains at least one entry.** Title matching is a partial-includes match (e.g. `{"title": "Netflix"}` matches anything whose title contains "Netflix"). |
| `maxInputSources` | `97` | Max input sources to register in HomeKit. Hard cap: 97 (100 services minus AccessoryInformation, TV and Speaker). |
| `hideDisconnectedInputs` | `false` | Automatically hide HDMI inputs that are physically disconnected. |
| `channelupdaterate` | `30000` | Interval (ms) for the periodic channel/input list refresh. Set to `0` to disable periodic refresh. |

### Power and Wake-on-LAN

| Option | Default | Description |
|---|---|---|
| `mac` | unset | MAC address of the TV. Only required if you want WOL. |
| `wolMode` | `auto` | WOL strategy used when REST `setPowerStatus` fails. `auto` sends a magic-packet burst both as **unicast** to the TV's IP and to the **subnet broadcast** derived from it (v1.4.21+). `directed-broadcast` sends the burst to the **subnet broadcast** (`woladdress`); useful across VLANs when broadcast-forward is enabled. `disabled` skips WOL entirely (REST only). |
| `woladdress` | `<TV-subnet>.255` (auto-derived from `ip`) | Subnet broadcast address used when `wolMode: "directed-broadcast"`. **Back-compat (v1.4.15+)**: if you set `woladdress` in config but do not set `wolMode`, the plugin auto-promotes `wolMode` to `directed-broadcast` so v1.4.12 setups keep working after upgrade. Ignored when `wolMode` is explicitly set to `auto` or `disabled`. |
| `wolBurstCount` | `5` | Number of magic packets sent in a burst. Higher counts increase reliability on flaky networks at the cost of a slightly longer wake response. |
| `wolBurstInterval` | `500` | Interval (ms) between magic packets in a burst. |
| `wakeWaitMaxMs` | `45000` | Maximum time (ms) to wait for REST `getPowerStatus` to report `active` after a WOL burst. Used for verification logging only: since v1.4.21 HomeKit is answered immediately when a power-on is requested. Older Bravia need about 25 s to become reachable. |
| `wakeWaitIntervalMs` | `2000` | Interval (ms) between alive-check polls during the wake-wait window. |
| `postWakeScanDelay` | `3000` | Delay (ms) before the first channel scan after a wake-up, to let the TV's AV stack initialise before content list queries are issued. |
| `updaterate` | `5000` | Power-status polling interval (ms) while the TV is on. |
| `standbyUpdateRate` | `25000` | Power-status polling interval (ms) while the TV is in standby. Slower than `updaterate` to reduce log noise and traffic when nothing is happening. |
| `postWakePollRate` | `2000` | Power-status polling interval (ms) used temporarily during the post-wake window to detect the TV becoming alive as quickly as possible. |
| `postWakePollWindow` | `30000` | Duration (ms) of the post-wake polling window during which `postWakePollRate` is used. |

### Audio

| Option | Default | Description |
|---|---|---|
| `soundoutput` | `speaker` | `speaker` or `headphone`. Required for volume control. |
| `volumeAccessory` | `false` | Publish a separate Lightbulb accessory to control volume (brightness) and mute (on/off) from HomeKit. |
| `appsAccessory` | `false` | Show apps in a separate **"<name> Apps"** TV tile instead of the TV's input list: pick one to launch it. The apps ticked in the Channel Selector, or all if none. |
| `recordingsAccessory` | `false` | **USB hard drive required.** Show every recording on the drive in a separate **"<name> Recordings"** TV tile, newest first, updated automatically: pick one to play it. |
| `functionsAccessory` | `false` | Show TV functions (Teletext, Guide, Subtitles, Record now…) as buttons in a separate **"<name> Functions"** accessory instead of the TV's input list. The ones ticked in the Channel Selector, or all if none. |
| `controlsAccessory` | `false` | Publish a separate "<name> Controls" accessory: one switch per picture mode (mutually exclusive; switching one off goes back to Auto) and a "Screen off" switch (power saving "picture off": the screen goes dark, sound keeps playing — handy for radio). |
| `controlsScenes` | `["cinema","game","sports"]` | Picture modes exposed as switches. The modes your TV supports are listed on the web page, Pairing & device → Diagnostics (e.g. `general`, `auto`, `photo`, `music`, `cinema`, `game`, `graphics`, `sports`, `animation`). |
| `volumeUI` | `false` | Show the TV's native volume slider overlay on screen when changing volume via HomeKit. Requires `setAudioVolume` v1.2+ (auto-detected). When `false`, volume changes are silent (no on-screen feedback). |

### Network and UI

| Option | Default | Description |
|---|---|---|
| `port` | `80` | HTTP port of the TV. |
| `serverPort` | `8999` | Port for the plugin's web server (PIN entry and Channel Selector). **Each TV runs its own web server: with more than one TV give each one a different `serverPort`.** |
| `channelSelectorPort` | same as `serverPort` | Override port for the Channel Selector UI (rarely needed). |
| `enableChannelSelector` | `true` | Controls only whether the Channel Selector UI page is exposed. The web server itself (needed for pairing) is always active, regardless of this option. |
| `externalaccessory` | `false` | Publish the TV as an external accessory. Needed for multiple TVs to work with Apple's Remote app. |

### Diagnostics

| Option | Default | Description |
|---|---|---|
| `debug` | `false` | Enable verbose debug logging for this TV. Strongly recommended when reporting an issue. |

---

## Wake-on-LAN quick reference

| Scenario | `wolMode` setting | Notes |
|---|---|---|
| Homebridge and TV on the same subnet | `auto` (default) | Unicast + subnet broadcast. |
| TV on a different VLAN, router has `broadcast-forward` enabled | `directed-broadcast` | Subnet broadcast is forwarded by the router into the TV's VLAN. |
| You used to have `woladdress` in config and upgraded from v1.4.12 | leave unset | The plugin auto-promotes to `directed-broadcast` for back-compat (v1.4.15+). |
| You do not want WOL at all (REST `setPowerStatus` only) | `disabled` | The plugin never sends magic packets. |
| TV is reachable in standby via REST already | any | REST `setPowerStatus` is always tried first; WOL is the fallback. |

---

## Usage

### On/Off

Control the TV through Siri or the Home app.

### Inputs, channels and apps

All scanned channels, inputs and apps appear in the HomeKit input selector. Use the Channel Selector web UI to curate which ones are exposed to HomeKit (HomeKit caps at 97 inputs).

### Recordings (USB hard drive required)

Everything about recordings works **only while a USB hard drive is connected to the TV and registered for recording** (TV menu → Settings → Recording setup). The plugin checks for the drive at every scan:

- the Channel Selector shows a **Recordings on the USB drive** group: each selected recording becomes a Home app input that plays it;
- the **Record now** function (TV functions group) is offered only when the drive is present;
- the **Recordings** web page (`/recordings`) lists what is on the drive with channel, date and length, and lets you play, protect/unprotect and delete (protected recordings cannot be deleted); it also shows scheduled timers and the recordings that failed.

Without the drive, none of these appear and the Recordings page says so.

### Separate tiles for apps, recordings and TV functions

HomeKit shows a TV's inputs as one flat list. With `appsAccessory`, `recordingsAccessory` and `functionsAccessory` the TV tile keeps only HDMI inputs, channels and radio, and the rest gets its own tile: **<name> Apps** and **<name> Recordings** are TV tiles (pick an entry to launch the app / play the recording; on/off follows the TV), **<name> Functions** has one button per function (it switches itself off after a second). They do not count towards the 97-input limit of the TV. Each is a separate HomeKit accessory: add it once in the Home app with the Homebridge setup code (Add Accessory → More options).

### TV Remote

The plugin registers a TV remote in HomeKit. Use the basic function keys, and set volume via the Apple Remote app. Your phone's volume buttons control TV volume.

### TV Speaker

The TV speaker is also exposed as a HomeKit accessory (not shown in the Home app, but visible in some third-party apps).

---

## Troubleshooting

- **Pairing (cookie mode) lasts 14 days**: since v1.4.22 the plugin renews it automatically while the TV is on and shows the days left in the web page (Pairing & device). If the TV ever asks for a new PIN, the page says so: switch the TV on and pair again there.
- **TV was off when Homebridge started**: since v1.4.21 the plugin completes the pairing check and refreshes channels automatically as soon as the TV is switched on. No restart needed.
- **An HDMI input is missing**: do not put input names (e.g. `"HDMI 3"` or `"Nintendo Switch 2"`) in `sources` — that field takes Sony source URIs and, when set, replaces the whole list. Remove `sources` (or set it to `["extInput:hdmi"]`) and pick single inputs in the Channel Selector.
- **Volume accessory: "Accessory already in another home"**: the volume accessory's HomeKit ID is derived from the TV name and is written in the log at startup (`Volume accessory published: <name> Volume (HomeKit ID XX:XX:...)`). After renaming or re-adding a TV, Homebridge may still hold the old pairing for that ID. In Homebridge UI go to Settings → *Unpair Bridges / Cameras / TVs / External Accessories*, remove the entry with that ID, restart Homebridge and add the accessory again.
- **Several TVs on the same Homebridge**: set a different `serverPort` for each TV, otherwise only the first TV gets the pairing / Channel Selector page (a warning is logged).
- **`compatibilitymode`**: obsolete, ignored since v1.4.21; remove it from config.

## Development

```bash
git clone https://github.com/diegoweb100/homebridge-bravia-enhanced.git
cd homebridge-bravia-enhanced
npm install
mkdir .homebridge
# add config.json to .homebridge
npm run test
```

---

## Support

If you find this plugin useful, consider buying me a coffee ☕

[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/diegoweb100)

---

## Reporting issues

If something does not work as expected, please open an issue on GitHub and **enable `debug: true`** in the plugin config for the affected TV, then attach the Homebridge log starting from the plugin's `ENVIRONMENT` banner. The debug output is designed to be self-contained: it includes the plugin version, the Node/OS environment, the (sanitised) config, the full TV capabilities table, every HTTP exchange, the pairing handshake, and the full WOL trace. With that information it is usually possible to diagnose the issue without further round trips.

For power-on issues specifically, filter the log by the `[POWER]` prefix to see the complete REST attempt, WOL burst, alive verification, and scan-defer flow.

Sensitive values (PSK, PIN, cookies, MAC address) are automatically masked in debug output, so the log can be shared safely.

---

## Credits

Based on [homebridge-bravia](https://github.com/normen/homebridge-bravia) by **Normen Hansen**, which was itself inspired by "lombi"'s original Sony Bravia plugin.

Enhanced and maintained by [diegoweb100](https://github.com/diegoweb100).
