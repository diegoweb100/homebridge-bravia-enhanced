# homebridge-bravia-enhanced

[![npm](https://img.shields.io/npm/v/homebridge-bravia-enhanced)](https://www.npmjs.com/package/homebridge-bravia-enhanced)
[![downloads](https://img.shields.io/npm/dt/homebridge-bravia-enhanced)](https://www.npmjs.com/package/homebridge-bravia-enhanced)
[![license](https://img.shields.io/npm/l/homebridge-bravia-enhanced)](LICENSE)
[![homebridge verified](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/diegoweb100)

> **Enhanced fork** of [homebridge-bravia](https://github.com/normen/homebridge-bravia) by Normen Hansen.  
> Maintained by [diegoweb100](https://github.com/diegoweb100)

HomeBridge plugin for Sony Bravia TVs (AndroidTV based ones and possibly others).

---

## What's new in this fork

- **Web-based Channel Selector UI** — browse, search and save your favourite channels directly from the browser, no config file editing required
- **Full-scan cache** — all channels are always visible in the UI even when HomeKit shows only a subset
- **User selection persistence** — your channel selection survives Homebridge restarts
- **HomeKit 98-input limit** — automatically enforced (100 services − TV − Speaker = 98 max inputs), configurable via `maxInputSources`
- **Improved app title matching** — fuzzy normalisation prevents duplicates and handles `+`/`plus` variants
- **New pairing page** — clean PIN entry UI with live pairing status
- **HDMI input status polling** — auto-detects connected/disconnected HDMI inputs with automatic API version fallback (v1.1 → v1.0)
- **Verbose structured logging** — easier troubleshooting with prefixed log lines
- **Volume accessory** — optional Lightbulb accessory to control TV volume and mute directly from HomeKit
- **Full API version auto-detection (v1.3.0+)** — at boot the plugin probes every Sony endpoint via `getVersions` + `getMethodTypes` and uses the actual versions supported by your specific TV for every API call. This fixes pairing on newer Bravia XR models (e.g. K-55XR8M2) where `actRegister` v1.0 is no longer accepted.
- **Web server always active (v1.3.0+)** — the web server is required for pairing and is now started unconditionally. The `enableChannelSelector` flag now only controls whether the Channel Selector UI page is exposed.
- **Comprehensive debug output (v1.4.0+)** — set `debug: true` per TV in the config and the plugin will produce a complete, self-contained diagnostic dump on startup: environment hints (Docker / Synology / RPi auto-detection), sanitised config, storage paths with file sizes, full capabilities table, every HTTP request/response with body and latency, detailed pairing trace, WOL trace, and global handlers for uncaught exceptions. Sensitive values (PSK, PIN, cookies, MAC) are masked.
- **Robust power-on with WOL burst and adaptive polling (v1.4.13+)** — power-on now sends a configurable burst of magic packets (5 × 500ms by default) instead of a single packet, then polls REST `getPowerStatus` every 2s for up to 15s to verify the TV actually came alive. A new `wolMode` option selects the WOL strategy (`auto`/unicast, `directed-broadcast`, or `disabled`). Status polling adapts automatically: 5s when the TV is on, 25s when it is in standby, and 2s temporarily during the post-wake window. Channel scans are deferred 3s after a wake-up to give the AV stack time to settle. Every step of the power-on flow is logged with a `[POWER]` prefix for easy log filtering.

---

## Supported functions

- Turning TV on/off
- Setting volume / mute
- Selecting inputs / channels
- Starting apps
- Trigger automation when turning the TV on/off
- iOS 12.2 remote support
- Secure connection to TV without PSK

This plugin requires iOS 12.2+.

---

## Installation

```bash
npm install -g homebridge-bravia-enhanced
```

Or clone this repo and run `npm install` locally.

### Setup steps

1. Configure the plugin in `config.json` or via the Homebridge UI (see below)
2. Turn on the TV
3. Set **Remote start** to ON: TV Settings → Network → Remote Start *(optional but recommended)*
4. Restart Homebridge
5. The TV will display a PIN
6. Enter the PIN at `http://homebridge.local:8999` (replace with your Homebridge server address/IP)
7. Your TV will appear in HomeKit once all channels have been scanned

### Channel Selector UI

After pairing, open `http://homebridge.local:8999` (or the configured `serverPort`) to access the Channel Selector. You can:

- Browse all channels, HDMI inputs and apps
- Use the search box or type filter to find channels
- Click channels to select/deselect them
- Use **Select All**, **Clear All**, **HD Channels Only** or **Top 20** shortcuts
- Click **Save Selection** to push the selection to HomeKit immediately

### Re-pairing / Force re-pairing

If the TV stops responding or you want to manually reset the pairing, open the pairing page:

```
http://homebridge.local:8980/pair?tv=TV55
```

If already paired, a **🗑️ Delete cookie & force re-pairing** button will appear. Click it to delete the stored session cookie and trigger a new PIN request on the TV.

### External accessory mode

If you use `externalaccessory: true`, after Homebridge restart:

1. In HomeKit, press **+** → **Add Device**
2. Select **I have no code**, then enter the Homebridge setup code to add the TV

---

## config.json example

```json
"platforms": [
  {
    "platform": "BraviaPlatform",
    "tvs": [
      {
        "name": "TV",
        "ip": "192.168.1.10",
        "soundoutput": "speaker",
        "tvsource": "tv:dvbs",
        "applications": [{"title": "Netflix"}],
        "sources": ["extInput:hdmi"],
        "maxInputSources": 50
      }
    ]
  }
]
```

---

## Options

### Required

| Option | Description |
|---|---|
| `tvs` | Array of Sony TV configurations |
| `name` | Name of the TV as shown in HomeKit |
| `ip` | IP address or hostname of the TV |

### Optional (per TV entry)

| Option | Default | Description |
|---|---|---|
| `sources` | `["extInput:hdmi", "extInput:component", "extInput:scart", "extInput:cec", "extInput:widi"]` | Input sources to show in HomeKit |
| `tvsource` | — | TV tuner source: `tv:dvbt`, `tv:dvbc` or `tv:dvbs` |
| `applications` | — | Array of `{title}` objects to include apps in the input list |
| `soundoutput` | `speaker` | `speaker` or `headphone` |
| `port` | `80` | HTTP port of the TV |
| `psk` | — | Pre-Shared Key for authentication. If set, the plugin uses `X-Auth-PSK` header instead of PIN+cookie pairing. Required for some Bravia XR models (interface v6.x+). Set the same key on the TV: Settings > Network > IP control > Authentication > Pre-Shared Key. |
| `serverPort` | `8999` | Port for the PIN entry / channel selector web server |
| `channelSelectorPort` | same as `serverPort` | Override port for the channel selector UI |
| `enableChannelSelector` | `true` | Controls only the Channel Selector UI page. The web server (needed for pairing) is always active, regardless of this option. |
| `maxInputSources` | `98` | Max inputs to register in HomeKit (hard cap: 98) |
| `externalaccessory` | `false` | Publish TV as external accessory (needed for multiple TVs in Remote app) |
| `hideDisconnectedInputs` | `false` | Automatically hide HDMI inputs that are physically disconnected |
| `mac` | — | MAC address for Wake-on-LAN (only set if needed) |
| `wolMode` | `auto` | WOL strategy used when REST `setPowerStatus` fails. `auto` sends a magic-packet burst as **unicast** to the TV's IP — works on most home networks and avoids broadcast noise. `directed-broadcast` sends the burst to the **subnet broadcast** (`woladdress`) — useful across VLANs when broadcast-forward is enabled. `disabled` skips WOL entirely (REST only). |
| `woladdress` | `<TV-subnet>.255` | Subnet broadcast address used when `wolMode: "directed-broadcast"`. Ignored when `wolMode` is `auto` or `disabled`. |
| `wolBurstCount` | `5` | Number of magic packets sent in a burst. Higher counts increase reliability on flaky networks at the cost of a slightly longer wake response. |
| `wolBurstInterval` | `500` | Interval (ms) between magic packets in a burst. |
| `wakeWaitMaxMs` | `15000` | Maximum time (ms) to wait for REST `getPowerStatus` to report `active` after a WOL burst. Used for verification logging only — the HomeKit callback is invoked earlier. |
| `wakeWaitIntervalMs` | `2000` | Interval (ms) between alive-check polls during the wake-wait window. |
| `postWakeScanDelay` | `3000` | Delay (ms) before the first channel scan after a wake-up, to let the TV's AV stack initialise before issuing content list queries. |
| `standbyUpdateRate` | `25000` | Power-status polling interval (ms) while the TV is in standby. Slower than `updaterate` to reduce log noise and network traffic when nothing is happening. |
| `postWakePollRate` | `2000` | Power-status polling interval (ms) used temporarily during the post-wake window to detect the TV becoming alive as quickly as possible. |
| `postWakePollWindow` | `30000` | Duration (ms) of the post-wake polling window during which `postWakePollRate` is used. |
| `updaterate` | `5000` | Interval (ms) for TV power status polling while the TV is on. |
| `channelupdaterate` | `30000` | Interval (ms) for channel/input list refresh |
| `volumeAccessory` | `false` | Publish a separate Lightbulb accessory to control volume (brightness) and mute (on/off) from HomeKit |
| `volumeUI` | `false` | Show the TV's native volume slider overlay on screen when changing volume via HomeKit. Requires the TV to support `setAudioVolume` v1.2+. When `false`, volume changes are silent (no on-screen feedback). |
| `debug` | `false` | Enable verbose debug logging for this TV |

---

## Usage

### ON/OFF
Control your TV through Siri or the Home app.

### Inputs, Channels and Applications
All channels, inputs and apps appear in the HomeKit input selector. Use the Channel Selector web UI to curate the list.

### TV Remote
The plugin registers a TV remote in HomeKit — use basic function keys and set volume via the Apple Remote app. Your phone's volume buttons control TV volume.

### TV Speaker
The TV speaker is also exposed as a HomeKit accessory (not shown in the Home app, but visible in some third-party apps).

---

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

If something does not work as expected, please open an issue on GitHub and **enable `debug: true`** in the plugin config for the affected TV, then attach the Homebridge log starting from the plugin's "ENVIRONMENT" banner. The debug output is designed to be self-contained: it includes the plugin version, the Node/OS environment, the (sanitised) config, the full TV capabilities table, every HTTP exchange and the pairing handshake. With that information it is usually possible to diagnose the issue without further round trips.

Sensitive values (PSK, PIN, cookies, MAC address) are automatically masked in debug output, so the log can be shared safely.

---

## Credits

Based on [homebridge-bravia](https://github.com/normen/homebridge-bravia) by **Normen Hansen**, which was itself inspired by "lombi"'s original Sony Bravia plugin.

Enhanced and maintained by [diegoweb100](https://github.com/diegoweb100).
