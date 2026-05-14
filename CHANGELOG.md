# Changelog for homebridge-bravia-enhanced

This is the change log for the plugin, all relevant changes will be listed here.

For documentation please see the [README](https://github.com/diegoweb100/homebridge-bravia-enhanced/blob/master/README.md)

---

## [1.4.14] - 2026-05-14

### Fixed
- **Apps removed after every rescan (issue [#4](https://github.com/diegoweb100/homebridge-bravia-enhanced/issues/4)).** The internal `appsLoaded` flag was set to `true` after the first successful scan at boot and never reset for subsequent scan cycles. As a result, on every scan from cycle 2 onwards `receiveApplications()` was skipped, `scannedChannels` did not contain any apps, and the reconcile step removed every app from HomeKit because they were no longer present in the scan results. The on-disk selection file survived (it is separate), which produced the puzzling symptom of apps still being marked as selected in the Channel Selector UI but missing from HomeKit. Fix: `appsLoaded` is now reset to `!this.useApps` at the start of every `receiveSources()` call, so apps are re-fetched on every refresh cycle. When `applications` is not configured the behaviour is unchanged (gate still skips the app fetch).
- **`getApplicationList` endpoint mismatch in capabilities map.** The `methodEndpoints` table registered `getApplicationList` as `/sony/avContent`, but the actual HTTP call in `receiveApplications()` correctly used `/sony/appControl`. The mismatch was harmless on most TVs (the v1.0 default was always used) but it meant the capability probe never recorded a real version for this method and any future auto-downgrade logic could not fire for it. Corrected to `/sony/appControl`.

---

## [1.4.13] - 2026-05-10

### Added
- **WOL burst on power-on.** Power-on now sends 5 magic packets at 500 ms intervals (configurable via `wolBurstCount` and `wolBurstInterval`) instead of a single packet. A burst is significantly more reliable than a single packet on flaky or congested networks, and on TVs whose NIC firmware is still booting when the first packet arrives.
- **REST alive verification after WOL.** After the WOL burst, the plugin polls REST `getPowerStatus` every 2 s for up to 15 s (`wakeWaitIntervalMs` / `wakeWaitMaxMs`) and logs precisely when the TV came alive (or timed out). The HomeKit callback is invoked right after the burst completes so HomeKit does not time out — the alive poll runs in parallel for diagnostic purposes only.
- **`wolMode` configuration option.** Selects the WOL strategy when REST `setPowerStatus` fails. `auto` (default) sends the burst as **unicast** to the TV's IP — works on most home networks and avoids broadcast noise. `directed-broadcast` sends the burst to the subnet broadcast address (`woladdress`) — the previous default behaviour, useful across VLANs when broadcast-forward is enabled. `disabled` skips WOL entirely. Selectable from the Homebridge UI plugin settings.
- **Post-wake channel-scan delay.** The first channel scan after a wake-up is now deferred by 3 s (`postWakeScanDelay`) to give the TV's AV stack time to initialise before content list queries are issued. Without the delay, the first scan after a cold wake could fail and force a full 30 s wait until the next cycle.
- **Adaptive status polling.** The power-status polling interval now adapts to the TV state: 5 s when the TV is on (`updaterate`, unchanged), 25 s when the TV is in standby (`standbyUpdateRate`), and 2 s temporarily for 30 s after a wake attempt (`postWakePollRate` / `postWakePollWindow`). This cuts log noise and network traffic during long standby periods while still detecting the TV becoming alive within seconds of a wake.
- **Structured `[POWER]` log prefix.** Every step of the power-on flow (REST attempt, REST result, WOL fallback decision, individual burst packets, alive poll, alive detected/timeout, scan defer) is logged with a `[POWER]` prefix for easy filtering with `grep`.

### Changed
- **External OFF→ON transitions are now also tracked.** When the TV is turned on with the physical remote (not via HomeKit), the plugin still records the wake event so the post-wake scan delay applies and adaptive polling has a fresh reference point.
- **Default WOL destination changed for new installs.** With `wolMode: "auto"` (the new default), the WOL burst is sent as unicast to the TV's IP instead of the subnet directed broadcast. Existing installations that explicitly set `woladdress` and rely on broadcast delivery should set `wolMode: "directed-broadcast"` to keep the previous behaviour.

### Notes
- All new tunables (`wolBurstCount`, `wolBurstInterval`, `wakeWaitMaxMs`, `wakeWaitIntervalMs`, `postWakeScanDelay`, `standbyUpdateRate`, `postWakePollRate`, `postWakePollWindow`) default to the values described above and only need to be set in the config when overriding them. Only `wolMode` is exposed in the Homebridge UI to keep the settings page compact.

---

## [1.4.12] - 2026-05-10

### Fixed
- **Power on/off now uses REST first with WOL as fallback, instead of being mutually exclusive.** Previously the plugin used ONLY WOL if a MAC address was configured, or ONLY REST if it was not. This failed on WiFi-connected TVs (e.g. KD-43XF7596) where WOL doesn't work but REST `setPowerStatus` works perfectly, and on older Bravia (e.g. KD-55X9005B) where REST returns error 15 but WOL works. The new strategy tries REST `setPowerStatus` first; if it fails or returns an error, falls back to WOL if a MAC is configured. Power off follows the same pattern: REST first, IRCC command as fallback. This covers every known combination of TV model and standby mode.

### Added
- **`volumeUI` configuration option.** Controls whether the TV shows its native volume slider overlay on screen when changing volume via HomeKit. Defaults to `false` (silent volume changes). Set to `true` to see the OSD feedback. Requires `setAudioVolume` v1.2+ (auto-detected). Available in the Homebridge UI plugin settings.

---



### Fixed
- **Channel scan when TV is off removed all channels as "stale".** If the TV was powered off (or became unreachable) during a periodic rescan cycle, the scan returned zero channels. The plugin then compared zero scanned channels against the existing HomeKit channel list and removed every registered channel as "stale", corrupting the user's selection. The plugin now skips the entire reconcile step when the scan returns zero channels but channels are already registered, preserving the existing list until the next successful scan.
- **Volume/Mute read handlers could hang indefinitely, causing Homebridge to log "read handler didn't respond at all".** The underlying `http.request` had no timeout, so if the TV was slow to respond (e.g. waking from standby) or the TCP connection was half-open, the callback was never invoked. All HTTP requests now have an 8-second safety timeout. If the TV does not respond within that window, the request is aborted and the error callback is invoked, so Homebridge always gets a timely response and the accessory stays responsive.
- **Power on/off now uses REST first with WOL as fallback, instead of being mutually exclusive.** Previously the plugin used ONLY WOL if a MAC address was configured, or ONLY REST if it was not. This failed on TVs where WOL does not work (e.g. WiFi-connected TVs without WoWLAN support like KD-43XF7596) even though REST `setPowerStatus` worked perfectly. The new strategy tries REST `setPowerStatus` first (works whenever the TV's network interface is alive in standby); if REST fails or returns an error (e.g. error 15 "power on not supported" on older Bravia, or EHOSTUNREACH when the NIC is off in deep sleep), the plugin falls back to WOL if a MAC is configured. Power off follows the same pattern: REST first, IRCC command as fallback. This covers every known combination of TV model and standby mode.

### Added
- **"Request PIN from TV" button in the Pairing web UI.** Previously, triggering a new PIN prompt on the TV required restarting Homebridge. The pairing page now has a dedicated button that sends `actRegister` to the TV on demand, causing the TV to display a PIN without restarting Homebridge. The button is visible whenever the TV is not yet paired.
- **`volumeUI` configuration option.** Controls whether the TV shows its native volume slider overlay on screen when changing volume via HomeKit. Defaults to `false` (silent volume changes). Set to `true` to see the OSD feedback. Requires `setAudioVolume` v1.2+ (auto-detected by the plugin; older TVs that only support v1.0 always show the OSD regardless of this setting).

---



### Fixed
- **Channel scan failed on Bravia XR (interface v6.x) with `error [3, "Illegal Argument"]` on all sources.** The TV reports `getContentList` v1.5 as its highest supported version, and the plugin correctly used v1.5, but the v1.5 schema uses `"uri"` as the parameter name instead of `"source"` (which is the v1.0/v1.2 name). The plugin now constructs the correct parameter name based on the detected API version: `"source"` for v1.0-v1.2 and `"uri"` for v1.5+, following the official Sony REST API specification. The v1.5 payload also includes the explicit `"cnt": 50` parameter as documented.

---



### Added
- **Pre-Shared Key (PSK) authentication** for Bravia XR and newer models (interface v6.x and above). When `psk` is set in the TV config, the plugin sends an `X-Auth-PSK` header on every HTTP request and skips the traditional `actRegister` PIN+cookie pairing entirely. This resolves the persistent `error [1] Internal Server Error` on models like the K-55XR8M2 (Bravia 8 II) where cookie-based pairing is no longer supported. To use: enable Pre-Shared Key on the TV (Settings > Network & Internet > IP control > Authentication), set a key, and add `"psk": "<your-key>"` to the TV config in Homebridge.

### Changed
- **WOL directed broadcast auto-detection.** When `woladdress` is not explicitly configured, the plugin now derives the directed broadcast address from the TV's IP by replacing the last octet with 255 (e.g. `192.168.11.14` becomes `192.168.11.255`). This makes WOL work across VLANs/subnets when the router has `broadcast-forward` enabled on the TV's interface, without requiring the user to manually calculate the broadcast address. Previously the default was `255.255.255.255` (limited broadcast), which never crosses router boundaries and silently fails in multi-VLAN setups. Users who had already set `woladdress` explicitly are not affected: their value takes precedence.

---



### Fixed
- **Homebridge logged `Failed to save cached accessories to disk: Cannot serialize accessory <name> - missing associated platform` after every reconcile cycle when the TV was configured with `externalaccessory: true`.** The plugin called `updatePlatformAccessories` on every change regardless of whether the accessory was external or platform-managed. External accessories live outside Homebridge's `cachedAccessories` file (they are published with `publishExternalAccessories` and recreated at every boot), so calling `updatePlatformAccessories` on them triggers a cache serialisation that has no platform record to attach to, producing the noisy error. The plugin now skips the platform-cache update for external accessories. Their state is already live on the running accessory and persisted via the existing `saveChannelsToFile` and on-disk context, so no change is lost.

### Notes
- The error was harmless in practice (`externalaccessory: true` means the cache is not used for that TV anyway), but it spammed the Homebridge log every reconcile cycle and triggered the alarming-sounding "Your accessories will not persist between restarts until this issue is resolved" warning. With this fix the log stays clean.

---



### Fixed
- **Apps with non-`kamaji://` URIs (e.g. "Mirroring schermo" → `preset://wifi-display`) could not be activated from HomeKit.** The web UI used to add configured app titles with a synthetic `appControl:<title>` URI even when the TV had already returned the same app with its real URI in `getApplicationList`. Selecting the synthetic entry produced an unusable selection that the plugin removed as "stale" at the next reconcile cycle. The web UI now deduplicates app entries by title (case-insensitive) instead of by URI, so the real URI from the TV always wins. Selections saved with the legacy synthetic URI by previous versions are still honoured: the reconcile step falls back to title matching so existing user selections survive without manual cleanup.
- **`/api/delete-cookie` route returned the channel-selector HTML page instead of a JSON response.** The route was referenced by the Pairing UI but never registered in the web server, so the request fell through to the default fallback handler and the browser-side `r.json()` parse failed, surfacing as a generic "Network error" toast. The route is now registered (POST only) and the handler clears both the on-disk cookie and the in-memory auth state. The Pairing page also detects non-JSON responses explicitly and surfaces a clearer error message.
- **`Removing stale channels...` log line was printed every reconcile cycle (every `channelupdaterate` ms, default 30 s) regardless of whether anything was actually removed.** The header line is gone and a single summary line `✓ Removed N stale channels` is now emitted only when at least one channel is dropped.

### Notes
- The selected-channels file written by `<= 1.4.5` may contain `appControl:<title>` URIs. Thanks to the legacy fallback in `applySelectionFilterToScannedChannels` these continue to work without intervention. If you want a clean file, untick and retick the affected app in the Channel Selector UI and click Save.

---



### Fixed
- **`actRegister` still rejected with `error [1] Internal Server Error` on Bravia XR firmware (interface v6.x and above) even with v1.4.4.** The `level:private` field added in v1.4.4 was correct, but the inner WOL object inside the second parameter array was still being sent with four fields (`clientid`, `value`, `nickname`, `function`). The schema returned by `getMethodTypes` on Bravia XR declares only `{function, value}` for that object, and the firmware rejects payloads with extra fields. The plugin now sends the inner object with only the two declared fields, matching the payload used by Sony's TV SideView app and other public Bravia REST API clients.

### Compatibility
- Verified empirically against Sony KD-55X9005B (interface v2.5.0): the two-field inner object is accepted with the same `{result:[],"id":8}` response as the four-field form. Older Bravia firmware tolerates extra fields, so this change is backward-compatible across every Sony Bravia generation supported by the plugin. No configuration change is required for existing installations.

### Recommended after upgrading from v1.4.4 or earlier
- Existing cookies may have been issued with limited authorisation level. To get a full-privilege cookie issued under the corrected payload, delete `sonycookie_<TVNAME>` from the plugin storage directory and restart Homebridge to trigger a fresh PIN pairing. This step is optional for read operations (power, volume, channels) but **required** if `setActiveApp` or `setPlayContent` operations on apps and HDMI inputs return a `webauth` URL instead of a normal JSON-RPC response.

---



### Fixed
- **`actRegister` rejected with `error [1] Internal Server Error` on Bravia XR firmware (interface v6.x and above, e.g. K-55XR8M2)** — newer Bravia firmware declares `level` as a required parameter in the `actRegister v1.0` schema returned by `getMethodTypes`, and rejects pairing requests that omit it. The plugin now sends `"level":"private"` in the registration payload, which is the value documented by Sony for a paired domestic client and the same value used by Sony's own TV SideView application and other public Bravia REST API clients. Older Bravia firmware that does not include `level` in the schema (e.g. KD-55X9005B with interface v2.5.0) ignores the extra field, so this change is backward-compatible across every Sony Bravia generation supported by the plugin.

### Note
- Diagnosed by inspecting the schema returned by the TV itself via `getMethodTypes`. On a Bravia 8 II / K-55XR8M2 the schema declares three required fields (`clientid`, `nickname`, `level`); on the older KD-55X9005B it declares only the first two. Sending `level` works on both because Sony's REST layer ignores fields not present in the older schema.

---



### Changed
- **Auto-downgrade on Sony error 12 is now centralised in `makeHttpRequest`** — in v1.4.2 the downgrade was wired only inside `pollExternalInputsStatus`. Now it runs inside `makeHttpRequest`, so it applies to **every** Sony API call automatically: `actRegister`, `getInterfaceInformation`, `getSystemInformation`, `getPowerStatus`, `setPowerStatus`, `getContentList`, `getCurrentExternalInputsStatus`, `getApplicationList`, `getPlayingContentInfo`, `setPlayContent`, `setActiveApp`, `getVolumeInformation`, `setAudioVolume`, `setAudioMute`. When any call returns error 12, the plugin downgrades the cached version, rebuilds the request body with the new version, retries once, and invokes the original caller's `resultcallback` with the retry response — fully transparent to the caller. The corrected version is persisted to the capabilities file.
- `pollExternalInputsStatus` simplified: no longer needs the per-call downgrade logic, since the central handler covers it.

### Note
- Found during an audit of every error handler in the codebase, prompted by the realisation that other Sony API methods could be affected by the same "advertised but rejected" behaviour as `getCurrentExternalInputsStatus`. The new mechanism handles all of them uniformly without per-call code.

---

## [1.4.2] - 2026-05-06

### Fixed
- **`getCurrentExternalInputsStatus` rejected at runtime** — some Sony firmware advertises support for v1.1 of this method via `getMethodTypes` but actually rejects calls at v1.1 with error code 12 (Method Not Implemented at this version), accepting only v1.0. The pre-1.3.0 plugin had a hardcoded v1.1→v1.0 fallback that was lost in the v1.3.0 refactor. Restored as a generic mechanism inside `pollExternalInputsStatus`.

### Added
- `_downgradeApiVersion(methodName)` — bounded helper that walks the standard Sony version chain (1.2 → 1.1 → 1.0), skipping versions already proven to fail at runtime, and persists the corrected version. Returns `null` when no more fallbacks are available, so retry loops cannot run forever.
- `_extractSonyErrorCode(responseText)` — small JSON helper that returns the Sony API error code (or `null`) from a response body.

---

## [1.4.1] - 2026-05-06

### Fixed
- **Power state polling broken in 1.3.0/1.4.0** — `getPowerStatus`, `setPowerStatus` (on/off) used `self.getApiVersion(...)` inside scopes where the alias was actually `that`, causing `ReferenceError: self is not defined` on every poll cycle. The TV power state was therefore always reported as off in HomeKit even when the TV was on. Fixed all three occurrences. Surfaced thanks to the comprehensive debug output added in v1.4.0.
- **Boot lifecycle ordering** — `loadCapabilities()` was called AFTER `checkRegistration()`, meaning the very first `actRegister` call after a Homebridge restart used the default version (`1.0`) even when a capabilities file with the correct higher version existed on disk. On Bravia models that reject `actRegister v1.0` (e.g. K-55XR8M2 with interface v6.3.0) this caused the first pairing attempt after every restart to fail. Now `loadCapabilities()` runs synchronously first, then the API probe runs and only after it completes (or after a 5 s safety timeout) is the first `checkRegistration()` triggered.
- **Lexicographic version comparison bug** — version strings were compared with `>` and `.sort()` operators in three places (`probeApiVersions` highest-version selection, `setAudioVolume v1.2` detection). String comparison incorrectly returns `'1.10' < '1.2'`. Added a `compareVersions()` helper that splits on `.` and compares numerically, so future Sony API versions like `1.10` will be handled correctly.
- Removed an unused `highest` variable in `probeApiVersions` (dead code from earlier draft).

### Note
- These fixes were caught during a full static-analysis audit of the v1.4.0 codebase, triggered by the user-reported "TV state always off" bug.

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
