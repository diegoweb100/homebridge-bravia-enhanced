# homebridge-bravia-enhanced

[![npm](https://img.shields.io/npm/v/homebridge-bravia-enhanced)](https://www.npmjs.com/package/homebridge-bravia-enhanced)
[![downloads](https://img.shields.io/npm/dt/homebridge-bravia-enhanced)](https://www.npmjs.com/package/homebridge-bravia-enhanced)
[![license](https://img.shields.io/npm/l/homebridge-bravia-enhanced)](LICENSE)
[![homebridge verified](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

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
| `serverPort` | `8999` | Port for the PIN entry / channel selector web server |
| `channelSelectorPort` | same as `serverPort` | Override port for the channel selector UI |
| `enableChannelSelector` | `true` | Set to `false` to disable the web UI |
| `maxInputSources` | `98` | Max inputs to register in HomeKit (hard cap: 98) |
| `externalaccessory` | `false` | Publish TV as external accessory (needed for multiple TVs in Remote app) |
| `hideDisconnectedInputs` | `false` | Automatically hide HDMI inputs that are physically disconnected |
| `mac` | — | MAC address for Wake-on-LAN (only set if needed) |
| `woladdress` | `255.255.255.255` | Subnet broadcast address for WOL |
| `updaterate` | `5000` | Interval (ms) for TV power status polling |
| `channelupdaterate` | `30000` | Interval (ms) for channel/input list refresh |
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

## Credits

Based on [homebridge-bravia](https://github.com/normen/homebridge-bravia) by **Normen Hansen**, which was itself inspired by "lombi"'s original Sony Bravia plugin.

Enhanced and maintained by [diegoweb100](https://github.com/diegoweb100).
