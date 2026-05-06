# Changelog for homebridge-bravia-enhanced

This is the change log for the plugin, all relevant changes will be listed here.

For documentation please see the [README](https://github.com/diegoweb100/homebridge-bravia-enhanced/blob/master/README.md)

---

## [1.4.0] - 2026-05-06

### Added
- **Comprehensive debug output** — when `debug: true` is enabled the plugin now produces a self-contained, structured set of diagnostic banners that contain everything needed to investigate any issue without asking the user for additional information:
  - 🛠️ **Environment banner** — plugin version, Node version, platform, arch, hostname, runtime hints (Docker, Synology, Raspberry Pi, LXC), CWD, PID, uptime, timezone
  - ⚙️ **TV config banner** — full sanitised config dump (PSK masked, MAC partially masked, all flags visible)
  - 💾 **Storage paths banner** — cookie / capabilities / fullscan paths, file size and last modified time, base STORAGE_PATH
  - 📺 **Capabilities banner** — model, serial, firmware generation, interface version, every detected API method grouped by endpoint with its highest supported version
  - 🔍 **State dump** — auth state, awaiting PIN, power state, cookie summary, channels published, web server status, last known volume
  - 🔎 **Scan summary banner** — typed channel counts (TV / HDMI / app / other) plus HomeKit cap status
- **HTTP request/response tracing** — every Sony API call logs method+version, request body, response status code, response body (truncated at 4KB), and round-trip latency in ms
- **Pairing trace** (`🔑 PAIRING TRACE:`) — every step of the registration handshake: client ID, selected `actRegister` version, target endpoint, cookie state before and after, parsed error code with a key for the most common Sony error meanings (1 / 12 / 14 / 401 / 403 / 404)
- **WOL trace** (`⚡ WOL TRACE:`) — magic packet target MAC (sanitised) and broadcast address, plus success/failure outcome
- **Global error handlers** — when at least one TV has `debug:true`, the plugin installs `uncaughtException` and `unhandledRejection` handlers that surface the full stack trace into the Homebridge log so otherwise-silent crashes become visible

### Security
- PIN, PSK and full auth cookies are **never** logged in plain text. PSK is fully masked, MAC shows only the last two octets, cookies show only length and the last 6 characters.

### Notes
- The new debug output is a no-op unless `debug: true` is set per TV in the config, so existing installations are not affected.

---

## [1.3.0] - 2026-05-06

### Changed
- **Full API version auto-detection** — at boot the plugin now probes every Sony endpoint (`/sony/accessControl`, `/sony/system`, `/sony/avContent`, `/sony/audio`) via `getVersions` + `getMethodTypes` (no auth required) and populates `apiVersions` for every method exposed by the TV. Each API call now uses the highest version actually supported by the device instead of a hardcoded value.
- **Refactored every Sony API call** to use `getApiVersion(method, defaultVersion)` instead of hardcoded `version: "1.0"` / `"1.1"` / `"1.2"`. Affected methods: `actRegister`, `getInterfaceInformation`, `getSystemInformation`, `getPowerStatus`, `setPowerStatus`, `getContentList`, `getCurrentExternalInputsStatus`, `getApplicationList`, `getPlayingContentInfo`, `setPlayContent`, `setActiveApp`, `getVolumeInformation`, `setAudioVolume`, `setAudioMute`. Only `getVersions` and `getMethodTypes` (the probe itself) keep `version: "1.0"` — by definition.
- **`setAudioVolume` v1.2 detection** is now part of the general probe (no longer a separate post-auth probe). The optional `ui:"off"` parameter is included only when the TV actually supports v1.2 or higher.
- **Web server is now always active** — decoupled from the `enableChannelSelector` flag. The server is required for the pairing flow (PIN entry page, device info panel) and now starts unconditionally. `enableChannelSelector` continues to control whether the Channel Selector UI page is exposed; when disabled, the UI routes (`/`, `/api/tvs`, `/api/scan`, `/api/inputs`, `/api/selection`, `/api/save`, `/channel-selector.js`) return 404 and the root path redirects to the pairing page.
- `config.schema.json` — `enableChannelSelector` description clarified: "Controls only the Channel Selector UI page. The web server (needed for pairing) is always active."

### Fixed
- Bravia models with newer firmware (e.g. K-55XR8M2 with interface v6.3.0) that require `actRegister` v1.1 or higher and previously failed with `error [1] Internal Server Error` during pairing — the plugin now sends the actual version supported by the TV.

### Notes
- All in-source comments are now in English.
- Existing `sonytv-capabilities-<name>.json` files are still compatible. The first boot after upgrade will repopulate `apiVersions` with the full method map detected from the TV.

---

## [1.2.2] - 2026-04-08

### Changed
- Web UI URLs in the Homebridge log now show the actual machine IP address (read from `os.networkInterfaces()`) so the link is always correct and immediately usable
- When a DNS domain suffix is configured on the host, it is read dynamically from the OS (`nmcli` on Linux, `scutil` on macOS, `ipconfig` on Windows) and a second URL using `hostname.suffix` is also shown as an alternative
- Added `curl http://127.0.0.1:<port>/` line in the log to help diagnose connectivity issues

---

## [1.2.1] - 2026-04-08

### Fixed
- `startWebServer`: changed `listen(port)` to `listen(port, '0.0.0.0')` to explicitly bind on all network interfaces. On some Windows and Docker configurations Node.js was binding only on localhost, making the web UI (channel selector and pairing page) unreachable from other devices on the network
- `config.schema.json`: removed hardcoded port 8999 from `headerDisplay` — the hint now refers users to the Homebridge log for the actual URL, which reflects any custom `serverPort` value

---

## [1.2.0] - 2026-03-14

### Added
- **Capabilities module** — new modular system to detect and persist device info and supported API versions per TV
  - `probeInterfaceInfo()`: calls `getInterfaceInformation` (no auth required) at every boot to get model name and interface version
  - `probeSystemInfo()`: calls `getSystemInformation` after successful pairing to get serial number and firmware generation
  - `probeApiVersions()`: probes optional API versions (e.g. `setAudioVolume` v1.2) after auth — each probe is independent and non-blocking
  - `loadCapabilities()` / `saveCapabilities()`: persists detected info to `sonytv-capabilities-<name>.json`
  - `getApiVersion(method)`: returns the best supported version for a given API method
  - `getDeviceInfo()`: exposes device info to the web UI
- New API endpoint `GET /api/device-info?tv=<name>`: returns device model, serial, firmware, interface version and detected API versions
- **Pairing UI**: new **Device Info** panel always visible (independent of pairing state) showing model, serial, firmware, interface version and detected API versions. Serial and firmware shown as "Available after pairing" until auth succeeds

### Changed
- `checkRegistration`: on successful pairing, now calls `probeSystemInfo()` to populate device info immediately after auth

---

## [1.1.1] - 2026-03-14

### Fixed
- `config.schema.json`: `volumeAccessory` option was missing from the Homebridge UI form — it was present in the schema properties but not listed in the form section

---

## [1.1.0] - 2026-03-14

### Added
- `volumeAccessory` config option (default `false`): when enabled, publishes a separate **Lightbulb** accessory named `<TV Name> Volume` in HomeKit
  - **Brightness slider** (0–100) controls TV volume
  - **On/Off toggle** controls mute/unmute
  - Fully coexists with the existing Remote app volume control
  - Volume accessory state is automatically synced when the TV turns on/off
  - Zero impact on existing installations when not enabled

---

## [1.0.9] - 2026-03-14

### Fixed
- `pairing.js`: duplicate code block outside the IIFE caused the TV name field to appear blank on page load and prevented the pairing status from being checked

---

## [1.0.8] - 2026-03-14

### Fixed
- `checkRegistration`: cookie is no longer deleted automatically on transient errors (network issues, TV in deep standby). Cookie is now deleted only when the TV explicitly returns an authentication rejection (error 403, 401 or 14). This prevents unnecessary re-pairing after network hiccups or reboots

### Added
- New API endpoint `POST /api/delete-cookie?tv=<name>` to delete the stored cookie programmatically
- Pairing UI: when already paired, a **"Delete cookie & force re-pairing"** button is shown with confirmation dialog, allowing manual re-pairing without touching the filesystem

---

## [1.0.7] - 2026-02-25

### Added
- Debug logging for all volume/mute functions: `getMuted`, `setMuted`, `getVolume`, `setVolume`, `setVolumeSelector` now log entry, result, and errors when `debug: true` is set in config

---

## [1.0.6] - 2026-02-25

### Fixed
- `pollExternalInputsStatus`: now tries `getCurrentExternalInputsStatus` v1.1 first and automatically falls back to v1.0 on error 12 (Illegal Argument), fixing the continuous "External inputs status error response" log spam on older Bravia TVs that do not support v1.1

---


## [1.0.5] - 2026-02-25

### Fixed
- `CHANGELOG.md` reformatted to the standard `## [x.y.z] - YYYY-MM-DD` format so Homebridge UI can parse and display release notes correctly

---

## [1.0.4] - 2026-02-24

### Added
- PayPal funding link in `package.json` — users can now support the developer directly from the Homebridge UI donation prompt

---

## [1.0.3] - 2026-02-24

### Fixed
- `config.schema.json`: replaced non-standard `"required": true/false` boolean flags on individual fields with a JSON Schema compliant `"required": ["name", "ip"]` array at the object level, as required by the Homebridge plugin verification checker

---

## [1.0.2] - 2026-02-24

### Fixed
- `config.schema.json`: added missing `"type": "object"` and `"properties"` wrapper to the schema root; added mandatory `name` property at platform level — all required by the Homebridge plugin verification checker

### Changed
- Log prefix changed from the static `[Bravia]` to `[TV Name]` for each device, making multi-TV setups easier to troubleshoot
- `makeHttpRequest`: moved `http.request()` call inside the `try/catch` block for better error containment; added inner `try/catch` around the response callback to prevent unhandled exceptions crashing the plugin
- `saveCookie`: removed `process.exit(1)` on cookie write error — the plugin now logs the error and continues instead of killing the Homebridge process

### Added
- `pollExternalInputsStatus()`: new polling method using `getCurrentExternalInputsStatus` v1.1 to track physical HDMI connection state
- `hideDisconnectedInputs` config option: when `true`, HDMI inputs that are physically disconnected are automatically hidden in HomeKit
- `/api/inputs` web API endpoint: exposes the cached HDMI connection status to the Channel Selector UI

---

## [1.0.1] - 2026-02-23

### Changed
- First publication to NPM registry

---

## [1.0.0] - 2026-02-23

### Added
- Initial release as enhanced fork of [homebridge-bravia](https://github.com/normen/homebridge-bravia) v2.4.9 by Normen Hansen
- **Homebridge 2.0 compatible** — `engines` updated to `^1.6.0 || ^2.0.0`, Node.js minimum raised to 18.20.4; removed deprecated `accessory.reachable`
- **Web-based Channel Selector UI** (`channel-selector.html` / `channel-selector.js`)
  - Browse all scanned TV channels, HDMI inputs and apps in a modern dark-themed interface
  - Search/filter by name or type (TV, HDMI, App)
  - Quick-select helpers: Select All, Clear All, HD Channels Only, Top 20
  - Stats bar showing selected count, HomeKit maximum (98) and total available channels
  - Save selection directly from the browser — no config file editing required
  - Rescan TV channels on demand without restarting Homebridge
- **Web-based Pairing UI** (`pairing.html` / `pairing.js`)
  - Dedicated pairing page with PIN entry form
  - Live pairing status indicator
  - Back-to-channels navigation
  - Toast notification system for all feedback
- **Full-scan cache** (`sonytv-fullscan-<name>.json`) — complete channel list saved after every scan; web UI always shows all channels regardless of the HomeKit 98-input limit
- **User channel selection persistence** (`selected-channels-<name>.json`) — selection survives Homebridge restarts and is reflected in HomeKit immediately
- **HomeKit 98-input limit enforcement** — hard cap at 98 input sources, configurable via `maxInputSources`
- **Collision-free TV channel identifiers** — TV tuner channels use `TV_IDENTIFIER_BASE = 1000` to avoid collisions with HDMI / App identifiers
- **Improved application title matching** — fuzzy normalisation strips punctuation, treats `+` as `plus`, prevents duplicates
- **Verbose structured log prefixes** for easier troubleshooting
- **Web server API endpoints**: `/api/channels`, `/api/pairing-status`, `/api/pin`, `/api/selection`, `/api/save-selection`, `/api/rescan`
- Replaced hand-rolled `uuidv4()` with the standard `uuid` npm package

---

## Original homebridge-bravia history (by Normen Hansen)

### 2.4.9
- Use proper storage folder `plugin-persist/homebridge-bravia`

### 2.4.8
- Avoid annoying warnings

### 2.4.7
- Small improvements

### 2.4.6
- Store channels for external TVs in file as the device cache in homebridge doesn't store external devices
- Improve channel update logic

### 2.4.5
- Allow enabling debug output per TV through UI
- Fix debug output not working

### 2.4.4
- Fix UUID issue causing external TVs to be added twice
- External TVs might have to be added again

### 2.4.3
- Fix adding devices in non-external mode

### 2.4.2
- Fix external accessory mode (not enabled by default)
- External accessory mode will currently need to re-scan the TV channels on each homebridge boot

### 2.4.1
- Disable external accessory mode as its broken as of now

### 2.4
- Make externalaccessory mode the default

### 2.3.2
- Add accessory category to fix icon display

### 2.3.1
- Fix removal of nonexisting accessories
- Update README with new options

### 2.3
- Add option to register TV as external accessory, this allows multiple TVs to appear in the remote app

### 2.2.3
- Hide more warnings

### 2.2.2
- README updates
- Only log warnings when in debug mode
- Improve error checking of TV responses

### 2.2.1
- Layout fix

### 2.2.0
- Cleanups
- Add changelog
- Add development info
- Fix client ID issue for waking up TV

### 2.1.11
- Fix error when plugin is started without config (old homebridge)

### 2.1.10
- Only scan channels if TV is on

### 2.1.9
- Increase security by using unique uuid per instance

### 2.1.8
- Fix channelupdaterate

### 2.1.7
- Allow renaming channels

### 2.1.6
- Improve internal channel number handling

### 2.1.5
- Use map for channel identifier

### 2.1.4
- Avoid escalating channel identifiers

### 2.1.3
- Allow setting address for WOL

### 2.1.2
- Cleanups, small fixes, less scary error messages

### 2.1.1
- Update channels continuously by default

### 2.1.0
- Allow updates of channel/app list

### 2.0.4
- Fix error when channels appear twice in the TV

### 2.0.3
- Fix crash when channel is not found

### 2.0.2
- Fix starting applications

### 2.0.1
- README updates, small fix in IR URL, code cleanups

### 2.0.0
- Use dynamic accessory model (no more blocking HB boot)
- Store cookie file in HB storage path
- Store separate cookie files for separate TVs
- Use web server for PIN entry
- Requires setting up existing TVs again!

### 1.3.4
- Remove ping test

### 1.3.3
- Improve config panel

### 1.3.2
- Fix mac address in config panel

### 1.3.1
- Add support for config-ui-x settings panels
