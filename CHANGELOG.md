# Changelog for homebridge-bravia-enhanced

This is the change log for the plugin, all relevant changes will be listed here.

For documentation please see the [README](https://github.com/diegoweb100/homebridge-bravia-enhanced/blob/master/README.md)

---

## 1.0.0 — Enhanced fork by [diegoweb100](https://github.com/diegoweb100)

This release is a significant enhancement of the original [homebridge-bravia](https://github.com/normen/homebridge-bravia) plugin (v2.4.9) by Normen Hansen. Full credit to the original author for the solid foundation.

### New features vs. original

- **Homebridge 2.0 compatible** — `engines` updated to `^1.6.0 || ^2.0.0`, Node.js minimum raised to 18.20.4; removed deprecated `accessory.reachable` (removed in HAP-NodeJS v1 / HB 2.0)
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
- **Full-scan cache** (`sonytv-fullscan-<name>.json`)
  - The complete channel list from the TV is saved to disk after every scan
  - The web UI reads this cache so all channels are always visible regardless of the HomeKit 98-input limit
- **User channel selection persistence** (`selected-channels-<name>.json`)
  - The user's channel selection is stored to disk and re-applied on every Homebridge restart
  - Changing the selection in the UI is reflected in HomeKit immediately without a restart
- **HomeKit 98-input limit enforcement**
  - Hard cap at 98 input sources (HomeKit limit = 100 services − TV − Speaker)
  - Configurable via `maxInputSources` (capped at 98 automatically)
  - Warning logged if the limit is exceeded
- **TV channel counter with collision-free identifiers**
  - TV tuner channels now use a dedicated identifier base (`TV_IDENTIFIER_BASE = 1000`) to avoid collisions with HDMI / App identifiers
- **Improved application title matching**
  - Fuzzy normalisation: strips punctuation, treats `+` as `plus`, matches prefix/suffix
  - Prevents duplicate apps between the TV scan and the configured app list
- **Per-TV debug logging** — already in 2.4.5 but now properly wired through all new code paths
- **Verbose structured log prefixes** — `[PLATFORM]`, `[INIT]`, `[WEB]`, `[CACHE]`, `[SELECTION]`, etc. for easier troubleshooting
- **Web server API endpoints** — `/api/channels`, `/api/pairing-status`, `/api/pin`, `/api/selection`, `/api/save-selection`, `/api/rescan`
- **`uuid` npm package** — replaced the hand-rolled `uuidv4()` helper with the standard `uuid` package

### Files added / replaced vs. original

| File | Status |
|---|---|
| `index.js` | Heavily extended |
| `channel-selector.html` | **New** |
| `channel-selector.js` | **New** |
| `pairing.html` | **New** |
| `pairing.js` | **New** |
| `config.schema.json` | Updated (`maxInputSources`, `channelSelectorPort`, `enableChannelSelector`) |
| `package.json` | Updated (author, name, version, `uuid` dependency) |
| `README.md` | Updated |

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
