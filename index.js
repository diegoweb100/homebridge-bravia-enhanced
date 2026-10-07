'use strict';
var http = require('http');
var url = require('url');
var base64 = require('base-64');
var wol = require('wake_on_lan');
var fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Base identifier for TV tuner channels to avoid collisions with HDMI/App identifiers.
const TV_IDENTIFIER_BASE = 1000;

// HAP limit is 100 services per accessory: AccessoryInformation + Television +
// TelevisionSpeaker leave room for 97 InputSource services.
const MAX_HOMEKIT_INPUTS = 97;
// Sony pairing cookies last 14 days (Set-Cookie Max-Age=1209600).
const COOKIE_DEFAULT_LIFETIME_MS = 14 * 86400000;

// Fallback list of external input sources, used only when "sources" is not set
// in config AND the TV does not answer getSourceList. Sources the TV does not
// have simply return an error and are skipped.
const DEFAULT_SOURCES = ['extInput:hdmi', 'extInput:composite', 'extInput:component', 'extInput:scart', 'extInput:cec', 'extInput:widi'];

// Remote-control functions offered as selectable inputs in the Channel
// Selector. Selecting one in the Home app presses that key on the TV.
// Only keys the TV reports in getRemoteControllerInfo are offered; "usb"
// entries only when a USB recording drive is connected to the TV.
const VIRTUAL_INPUTS = [
  { name: 'Teletext', uri: 'ircc:Teletext' },
  { name: 'TV Guide', uri: 'ircc:GGuide' },
  { name: 'Subtitles', uri: 'ircc:SubTitle' },
  { name: 'Audio track', uri: 'ircc:Audio' },
  { name: 'TV / Radio', uri: 'ircc:Tv_Radio' },
  { name: 'Home menu', uri: 'ircc:Home' },
  { name: 'Channel +', uri: 'ircc:ChannelUp' },
  { name: 'Channel -', uri: 'ircc:ChannelDown' },
  { name: 'Record now', uri: 'ircc:Rec', needs: 'usb' }
];
// IRCC codes used when the TV does not answer getRemoteControllerInfo
// (standard Sony codes, verified on a KD-55X9005B).
const IRCC_FALLBACK = {
  Teletext: 'AAAAAQAAAAEAAAA/Aw==',
  GGuide: 'AAAAAQAAAAEAAAAOAw==',
  SubTitle: 'AAAAAgAAAJcAAAAoAw==',
  Audio: 'AAAAAQAAAAEAAAAXAw==',
  Tv_Radio: 'AAAAAgAAABoAAABXAw==',
  Home: 'AAAAAQAAAAEAAABgAw==',
  ChannelUp: 'AAAAAQAAAAEAAAAQAw==',
  ChannelDown: 'AAAAAQAAAAEAAAARAw==',
  Rec: 'AAAAAgAAAJcAAAAgAw==',
  Options: 'AAAAAgAAAJcAAAA2Aw=='
};

// Reads the DNS domain suffix configured on the host without hardcoding any value.
// Tries nmcli (Linux/NetworkManager), scutil (macOS), ipconfig (Windows).
// Returns e.g. '.local' or '.deltatre.it' or '' if not determinable.
function getDomainSuffix() {
  const { execSync } = require('child_process');
  const platform = os.platform();
  try {
    if (platform === 'linux') {
      const conList = execSync('nmcli -t -f NAME,DEVICE con show --active 2>/dev/null', { timeout: 3000 }).toString().trim();
      const firstCon = conList.split('\n')[0];
      if (firstCon) {
        const conName = firstCon.split(':')[0];
        const out = execSync('nmcli -t -f IP4.DOMAIN con show "' + conName + '" 2>/dev/null', { timeout: 3000 }).toString();
        const m = out.match(/IP4\.DOMAIN\[1\]:(.+)/);
        if (m && m[1].trim()) return '.' + m[1].trim();
      }
    } else if (platform === 'darwin') {
      const out = execSync('scutil --dns 2>/dev/null', { timeout: 3000 }).toString();
      const m = out.match(/search domain\[0\]\s*:\s*(.+)/);
      if (m && m[1].trim()) return '.' + m[1].trim();
    } else if (platform === 'win32') {
      const out = execSync('ipconfig /all', { timeout: 3000 }).toString();
      const m = out.match(/Primary Dns Suffix[^:]*:\s*(.+)/i);
      if (m && m[1].trim()) return '.' + m[1].trim();
    }
  } catch (e) {
    // silent — fallback to IP only
  }
  return '';
}

// Helper: returns the first non-loopback IPv4 address or null.
function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && iface.internal === false) return iface.address;
    }
  }
  return null;
}

var Service, Characteristic, Accessory, UUIDGen, STORAGE_PATH;

// ─────────────────────────────────────────────────────────────────────────────
// v1.4.20: Autoscan / managed-TVs subsystem
// ─────────────────────────────────────────────────────────────────────────────
// All helpers below operate on a single JSON file in the plugin persist dir:
//     <STORAGE_PATH>/tvs-managed.json
// The file is the *only* state for autoscan. config.json is never modified.
// Layout:
//   { "version": 1, "managedTvs": [ { mac, name, ip, psk?, tvsource?, enabled,
//     addedAt, lastSeen, discovered: { model, productName, interfaceVer,
//     serial?, generation?, fwVersion? } }, ... ] }
// Primary key is `mac` (normalised uppercase, ':' separated).

// Path of the managed-tvs file. STORAGE_PATH is set by module.exports before
// the platform constructor runs, so reading it here is safe.
function getManagedTvsPath() {
  return STORAGE_PATH + '/tvs-managed.json';
}

// Normalise a MAC to uppercase, colon-separated form. Returns null if invalid.
function normaliseMac(mac) {
  if (!mac || typeof mac !== 'string') return null;
  var hex = mac.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) return null;
  return hex.toUpperCase().match(/.{2}/g).join(':');
}

// Load the managed file. Returns { version, managedTvs:[] }. Never throws:
// missing or corrupt file returns an empty default. Corrupt files are renamed
// aside so the user can recover them if needed.
function loadManagedTvs(log) {
  var p = getManagedTvsPath();
  if (!fs.existsSync(p)) return { version: 1, managedTvs: [] };
  try {
    var raw = fs.readFileSync(p, 'utf8');
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    if (!Array.isArray(parsed.managedTvs)) parsed.managedTvs = [];
    if (!parsed.version) parsed.version = 1;
    return parsed;
  } catch (e) {
    var bak = p + '.corrupt.' + Date.now();
    try { fs.renameSync(p, bak); } catch (e2) {}
    if (log) log('[homebridge-bravia-enhanced] ⚠️  tvs-managed.json was corrupt, moved to ' + bak + ' (' + e.message + ')');
    return { version: 1, managedTvs: [] };
  }
}

// Atomic write of the managed file with a timestamped backup of the previous
// version (if any). The temp file is written first then renamed onto the real
// path, which is atomic on POSIX. Returns the backup path or null.
function saveManagedTvs(data, log) {
  var p = getManagedTvsPath();
  var tmp = p + '.tmp.' + process.pid + '.' + Date.now();
  var bak = null;
  // Validate before touching disk: parse-roundtrip catches missing keys.
  var json;
  try { json = JSON.stringify(data, null, 2); }
  catch (e) { throw new Error('serialise failed: ' + e.message); }
  // Backup existing file if present.
  if (fs.existsSync(p)) {
    bak = p + '.bak.' + new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.copyFileSync(p, bak); }
    catch (e) { if (log) log('[homebridge-bravia-enhanced] ⚠️  backup of tvs-managed.json failed (' + e.message + '), continuing anyway'); bak = null; }
  }
  // Atomic write: write tmp, then rename.
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, p);
  return bak;
}

// Expand a CIDR range (e.g. "192.168.1.0/24") into the list of usable host
// IPs (excluding network and broadcast for /24 and smaller). Returns null on
// invalid input. Caps at 4096 hosts to avoid runaway sweeps on /20 or wider.
function expandCidr(cidr) {
  if (typeof cidr !== 'string') return null;
  var m = cidr.trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  if (!m) return null;
  var bits = parseInt(m[5], 10);
  if (bits < 16 || bits > 32) return null;
  var ipNum = (parseInt(m[1], 10) << 24) | (parseInt(m[2], 10) << 16) | (parseInt(m[3], 10) << 8) | parseInt(m[4], 10);
  var mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  var network = (ipNum & mask) >>> 0;
  var size = bits === 32 ? 1 : (1 << (32 - bits)) >>> 0;
  if (size > 4096) return null;
  var hosts = [];
  var first = size > 1 ? 1 : 0;
  var last = size > 1 ? size - 1 : 1;
  for (var i = first; i < last; i++) {
    var n = (network + i) >>> 0;
    hosts.push([(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF].join('.'));
  }
  return hosts;
}

// Read the ARP table to find the MAC for a given IP. Best-effort across OSes.
// Linux: /proc/net/arp. macOS/BSD: parses output of `arp -n <ip>` if available.
// Returns null when not resolvable (common in Docker without the host's ARP
// cache, or when the IP has not been pinged recently).
function arpLookup(ip) {
  // Linux: /proc/net/arp
  try {
    if (fs.existsSync('/proc/net/arp')) {
      var lines = fs.readFileSync('/proc/net/arp', 'utf8').split('\n');
      for (var i = 1; i < lines.length; i++) {
        var parts = lines[i].trim().split(/\s+/);
        if (parts.length >= 4 && parts[0] === ip && parts[3] && parts[3] !== '00:00:00:00:00:00') {
          return normaliseMac(parts[3]);
        }
      }
    }
  } catch (e) {}
  // BSD/macOS: best-effort via the `arp` binary (synchronous, short timeout).
  try {
    var cp = require('child_process');
    var out = cp.execFileSync('arp', ['-n', ip], { timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    var m = out.match(/([0-9a-fA-F]{1,2}(:[0-9a-fA-F]{1,2}){5})/);
    if (m) return normaliseMac(m[1]);
  } catch (e) {}
  return null;
}

// Probe a single IP with getInterfaceInformation. No auth required. Returns
// the result object on success, null on any failure (timeout, parse error,
// non-Sony response). Used by the parallel sweep.
function probeBraviaInterface(ip, timeoutMs, cb) {
  var body = JSON.stringify({ id: 1, method: 'getInterfaceInformation', version: '1.0', params: [] });
  var done = false;
  var finish = function (result) { if (done) return; done = true; cb(result); };
  var req = http.request({
    host: ip,
    port: 80,
    path: '/sony/system',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    timeout: timeoutMs
  }, function (res) {
    if (res.statusCode !== 200) { res.resume(); finish(null); return; }
    var data = '';
    res.on('data', function (c) { data += c; if (data.length > 4096) { res.destroy(); finish(null); } });
    res.on('end', function () {
      try {
        var json = JSON.parse(data);
        if (!json.result || !json.result[0] || !json.result[0].productCategory) { finish(null); return; }
        finish(json.result[0]);
      } catch (e) { finish(null); }
    });
    res.on('error', function () { finish(null); });
  });
  req.on('timeout', function () { req.destroy(); finish(null); });
  req.on('error', function () { finish(null); });
  req.write(body);
  req.end();
}

// Call getSystemInformation with PSK auth. Returns the result object (with
// serial, macAddr, generation, fwVersion) or null/error string on failure.
function fetchSystemInformation(ip, psk, timeoutMs, cb) {
  var body = JSON.stringify({ id: 50, method: 'getSystemInformation', version: '1.0', params: [] });
  var done = false;
  var finish = function (err, result) { if (done) return; done = true; cb(err, result); };
  var headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  };
  if (psk) headers['X-Auth-PSK'] = String(psk);
  var req = http.request({
    host: ip, port: 80, path: '/sony/system', method: 'POST',
    headers: headers, timeout: timeoutMs
  }, function (res) {
    var data = '';
    res.on('data', function (c) { data += c; if (data.length > 8192) { res.destroy(); finish('response too large', null); } });
    res.on('end', function () {
      if (res.statusCode === 401 || res.statusCode === 403) { finish('auth rejected (HTTP ' + res.statusCode + ')', null); return; }
      try {
        var json = JSON.parse(data);
        if (json.error) { finish('TV error ' + (json.error[0] || '') + ': ' + (json.error[1] || ''), null); return; }
        if (!json.result || !json.result[0]) { finish('unexpected response shape', null); return; }
        finish(null, json.result[0]);
      } catch (e) { finish('parse error: ' + e.message, null); }
    });
  });
  req.on('timeout', function () { req.destroy(); finish('timeout', null); });
  req.on('error', function (e) { finish('network error: ' + e.message, null); });
  req.write(body);
  req.end();
}

// Run a parallel HTTP sweep on the given list of IPs, with bounded concurrency.
// For each responding Bravia, the result includes the interface info and the
// MAC resolved via ARP (best-effort, may be null). cb(results[]) called once.
function runDiscoverySweep(hosts, opts, log, cb) {
  opts = opts || {};
  var concurrency = Math.max(1, Math.min(64, opts.concurrency || 32));
  var timeoutMs = Math.max(500, Math.min(10000, opts.timeoutMs || 2000));
  var found = [];
  var idx = 0;
  var active = 0;
  var startNext = function () {
    while (active < concurrency && idx < hosts.length) {
      var ip = hosts[idx++];
      active++;
      probeBraviaInterface(ip, timeoutMs, function (capturedIp) {
        return function (info) {
          if (info) {
            found.push({
              ip: capturedIp,
              productCategory: info.productCategory || '',
              productName: info.productName || '',
              modelName: info.modelName || '',
              serverName: info.serverName || '',
              interfaceVersion: info.interfaceVersion || '',
              mac: arpLookup(capturedIp)
            });
          }
          active--;
          if (idx >= hosts.length && active === 0) {
            // Sort by IP for stable output.
            found.sort(function (a, b) {
              var pa = a.ip.split('.').map(Number);
              var pb = b.ip.split('.').map(Number);
              for (var i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
              return 0;
            });
            cb(found);
          } else {
            startNext();
          }
        };
      }(ip));
    }
  };
  if (hosts.length === 0) { cb([]); return; }
  startNext();
}

class BraviaPlatform {
  constructor(log, config, api) {
    if (!config || !api) {
      log('Config or API not provided, exiting');
      return;
    }
    this.log = log;
    this.config = config;
    this.api = api;
    this.devices = [];
    var self = this;

    log('Platform initializing');

    // v1.4.20: autoscan / managed TVs.
    // When autoscan is true, TVs added through the /discover web UI are stored
    // in <STORAGE_PATH>/tvs-managed.json and merged with config.tvs at load
    // time. config.json is never written to. Priority on duplicates (same
    // MAC): config.json wins, managed entry is silently skipped with a
    // warning in the log. Entries with enabled:false are loaded but ignored.
    this.autoscan = config.autoscan === true;
    this.discoveryRange = config.discoveryRange || null; // string or string[]
    this._effectiveTvs = Array.isArray(config.tvs) ? config.tvs.slice() : [];
    if (this.autoscan) {
      try {
        var managed = loadManagedTvs(log);
        var configMacs = {};
        // Collect MACs already present in config.json (case-insensitive).
        this._effectiveTvs.forEach(function (t) {
          var nm = normaliseMac(t.mac);
          if (nm) configMacs[nm] = t.name || t.ip || '?';
        });
        var added = 0, skipped = 0, disabled = 0;
        (managed.managedTvs || []).forEach(function (m) {
          if (!m || !m.name || !m.ip) return;
          if (m.enabled === false) { disabled++; return; }
          var nm = normaliseMac(m.mac);
          if (nm && configMacs[nm]) {
            log('[homebridge-bravia-enhanced] ⚠️  Managed TV "' + m.name + '" (MAC ' + nm + ') is also configured in config.json as "' + configMacs[nm] + '" — config.json wins, managed entry skipped');
            skipped++;
            return;
          }
          // Project managed entry into a config-shaped TV object. Only fields
          // the rest of the plugin knows about are forwarded.
          var projected = {
            name: m.name,
            ip: m.ip,
            mac: m.mac,
            psk: m.psk,
            tvsource: m.tvsource,
            // The user can edit these from the managed UI in a future step;
            // for now they fall back to platform defaults.
            debug: m.debug === true
          };
          self._effectiveTvs.push(projected);
          added++;
        });
        log('Autoscan: loaded ' + (managed.managedTvs ? managed.managedTvs.length : 0) + ' managed TV(s) (' + added + ' added, ' + skipped + ' skipped, ' + disabled + ' disabled)');
      } catch (e) {
        log('[homebridge-bravia-enhanced] ⚠️  Failed to load managed TVs: ' + (e && e.message ? e.message : e));
      }
    }
    if (!this._effectiveTvs || this._effectiveTvs.length === 0) {
      log('Warning: Bravia plugin not configured - no TVs in config or managed file');
      return;
    }

    log('Found ' + this._effectiveTvs.length + ' TV(s) (config + managed)');

    // Install global error handlers ONLY if at least one TV has debug enabled.
    // These handlers help diagnose otherwise-silent plugin crashes by surfacing
    // the full stack trace into the Homebridge log.
    const anyDebug = (this._effectiveTvs || []).some((t) => t && t.debug === true);
    if (anyDebug && !global.__braviaEnhancedErrorHandlersInstalled) {
      global.__braviaEnhancedErrorHandlersInstalled = true;
      process.on('uncaughtException', (err) => {
        try { log('[homebridge-bravia-enhanced] ⚠️  uncaughtException: ' + (err && err.stack ? err.stack : err)); } catch (e) {}
      });
      process.on('unhandledRejection', (reason) => {
        try { log('[homebridge-bravia-enhanced] ⚠️  unhandledRejection: ' + (reason && reason.stack ? reason.stack : reason)); } catch (e) {}
      });
    }

    this.devices = [];
    api.on('didFinishLaunching', function () {
      if (self.debug) self.log('Platform launched');
      self._effectiveTvs.forEach(function (tv) {
        if (self.devices.find(device => device.name === tv.name) == undefined) {
          if (self.debug) self.log('Registering TV: ' + tv.name);
          self.devices.push(new SonyTV(self, tv));
        } else {
          if (self.debug) self.log('TV ' + tv.name + ' already registered, skipping');
        }
      });
      if (self.debug) self.log('Starting all TV devices...');
      self.devices.forEach(device => {
        if (self.debug) self.log('Starting device: ' + device.name);
        device.start();
      });
      if (self.debug) self.log('All devices started');
    });
  }
  // Called by Homebridge when a device is restored from cache
  configureAccessory(accessory) {
    const self = this;
    if (this.debug) this.log('Restoring cached accessory: ' + accessory.displayName);
    
    // v1.4.21: the pool of known TVs is config.tvs PLUS the autoscan-managed
    // TVs (_effectiveTvs). Up to v1.4.20 a config with only autoscan TVs (no
    // "tvs" array) bailed out here, the cached accessory was never restored,
    // a new accessory with the same UUID was then created and Homebridge
    // skipped it as a duplicate — leaving a dead TV tile in HomeKit.
    var pool = (this._effectiveTvs && this._effectiveTvs.length > 0) ? this._effectiveTvs : ((this.config && Array.isArray(this.config.tvs)) ? this.config.tvs : null);
    if (!this.config || !pool) { // plugin disabled / not configured but accessories still cached
      this.log('Config not available, cannot restore accessory');
      return;
    }
    var existingConfig = pool.find(tv => tv.name === accessory.context.config.name);
    
    if (existingConfig === undefined) {
      this.log('Removing TV ' + accessory.displayName + ' from HomeKit (not in config)');
      this.api.on('didFinishLaunching', function () {
        if (!accessory.context.isexternal) {
          self.api.unregisterPlatformAccessories('homebridge-bravia-enhanced', 'BraviaPlatform', [accessory]);
        } else {
          // TODO: delete context file? not here, we're not called
        }
      });
    } else {
      this.log('Restoring ' + accessory.displayName + ' from HomeKit');
      // if its restored its registered
      if (this.debug) this.log('Creating TV instance from cache');
      self.devices.push(new SonyTV(this, existingConfig, accessory));
      accessory.context.isRegisteredInHomeKit = true;
    }
  }
}


// TV accessory class

// --- Application title matching helpers (for Option A: Applications section) ---
function normalizeAppTitle(title) {
  return String(title || '')
    .trim()
    .toLowerCase()
    .replace(/\+/g, 'plus')     // treat "+" as "plus"
    .replace(/[^a-z0-9]+/g, '')  // drop punctuation/spaces
    .replace(/plus$/g, '');      // allow optional trailing plus
}

function appTitleMatches(configTitle, tvTitle) {
  const a = normalizeAppTitle(configTitle);
  const b = normalizeAppTitle(tvTitle);
  if (!a || !b) return false;
  if (a === b) return true;
  return b.startsWith(a) || a.startsWith(b);
}
// ---------------------------------------------------------------------------

class SonyTV {
  // Constructor: Initialize TV accessory with config and optionally restore from cached accessory
  constructor(platform, config, accessory = null) {
    try {
      // CRITICAL: Assign log function FIRST before using it
      this.log = platform.log;
      this.platform = platform;
      
      if (this.debug) this.log('[' + this.name + '] ========================================');
      if (this.debug) this.log('[' + this.name + '] Constructing TV: ' + config.name);
      if (this.debug) this.log('[' + this.name + '] Config debug: ' + config.debug);
      
      // Assign debug flag from config
      this.debug = config.debug;
      if (this.debug) this.log('[' + this.name + '] Debug mode: ' + this.debug);
      if (this.debug) this.log('[' + this.name + '] ========================================');
    
    this.config = config;
    this.name = config.name;
    this.ip = config.ip;
    this.mac = config.mac || null;
    // WOL broadcast address: if not explicitly configured, derive the directed broadcast
    // from the TV's IP address by replacing the last octet with 255 (assumes /24 subnet,
    // which covers the vast majority of home and SMB networks). This ensures WOL works
    // across VLANs when the router has broadcast-forward enabled on the TV's interface,
    // because the magic packet is sent as a routable unicast IP to the subnet broadcast
    // address (e.g. 192.168.11.255) instead of the limited broadcast 255.255.255.255
    // which never crosses router boundaries.
    this.woladdress = config.woladdress || this._deriveDirectedBroadcast(config.ip);
    this.port = config.port || '80';
    this.psk = config.psk || null;
    this.tvsource = config.tvsource || null;
    this.soundoutput = config.soundoutput || 'speaker';
    // Base polling interval when the TV is ON. Used as the "active" rate by the
    // adaptive polling logic in updateStatus(). Default 5s.
    this.updaterate = config.updaterate || 5000;
    this.channelupdaterate = config.channelupdaterate === undefined ? 30000 : config.channelupdaterate;
    // ── Adaptive polling (v1.4.13) ───────────────────────────────────────────
    // Polling interval applied while the TV is in standby/off. Slower than
    // updaterate to reduce log noise and network traffic when nothing is
    // happening. Default 25s.
    this.standbyUpdateRate = config.standbyUpdateRate || 25000;
    // Aggressive polling interval used temporarily after a wake attempt to
    // detect the TV becoming alive as quickly as possible. Default 2s.
    this.postWakePollRate = config.postWakePollRate || 2000;
    // Window (ms) during which postWakePollRate is used after a wake attempt.
    // After this window expires the regular updaterate/standbyUpdateRate apply.
    this.postWakePollWindow = config.postWakePollWindow || 30000;
    // ── Power-on / WOL behaviour (v1.4.13) ───────────────────────────────────
    // wolMode selects the WOL fallback strategy when REST setPowerStatus fails:
    //   'auto'              REST first, then WOL burst sent as unicast to the TV's IP
    //   'directed-broadcast' REST first, then WOL burst sent to the subnet broadcast (woladdress)
    //   'disabled'          REST only, no WOL fallback even if a MAC is configured
    // Defaults to 'auto'. Existing installations that explicitly set woladdress
    // and want the previous behaviour should set wolMode: 'directed-broadcast'.
    //
    // v1.4.15 back-compat: if the user explicitly set woladdress in config but
    // did not set wolMode, default to 'directed-broadcast'. In v1.4.12 and
    // earlier the plugin always sent WOL to woladdress (subnet broadcast by
    // default), so users who relied on that behaviour and had woladdress
    // configured would otherwise silently switch to unicast on upgrade and
    // their cross-VLAN setups would stop working.
    var _wolModeRaw = config.wolMode;
    var _woladdressExplicit = !isNull(config.woladdress) && config.woladdress !== '';
    var _wolMode;
    if (isNull(_wolModeRaw) || _wolModeRaw === '') {
      // wolMode not set in config — pick default
      if (_woladdressExplicit) {
        _wolMode = 'directed-broadcast';
        this.log('[' + this.name + '] ⚙️  wolMode not set but woladdress is configured (' + config.woladdress + ') — defaulting wolMode to "directed-broadcast" for backward compatibility with v1.4.12 and earlier. Set wolMode explicitly to silence this notice.');
      } else {
        _wolMode = 'auto';
      }
    } else {
      _wolMode = _wolModeRaw.toString().toLowerCase();
      if (_wolMode !== 'auto' && _wolMode !== 'directed-broadcast' && _wolMode !== 'disabled') {
        this.log('[' + this.name + '] ⚠️  Invalid wolMode "' + _wolMode + '", falling back to "auto"');
        _wolMode = 'auto';
      }
    }
    this.wolMode = _wolMode;
    // v1.4.16: sanity-check woladdress when directed-broadcast is in effect.
    // A common misconfiguration is setting woladdress to the TV's own IP
    // (e.g. 192.168.11.14) instead of the subnet broadcast (192.168.11.255).
    // In that case the magic packet is sent as a unicast to a TV that is off,
    // the gateway cannot resolve ARP for it, and WOL silently fails. We cannot
    // know the netmask for sure, but a directed broadcast for the common /24
    // case ends in .255; if it does not, warn so the user can spot the mistake.
    if (this.wolMode === 'directed-broadcast' && !isNull(this.mac)) {
      var _waParts = (this.woladdress || '').split('.');
      if (_waParts.length === 4 && _waParts[3] !== '255') {
        var _suggested = _waParts.slice(0, 3).join('.') + '.255';
        this.log('[' + this.name + '] ⚠️  wolMode is "directed-broadcast" but woladdress (' + this.woladdress + ') does not look like a subnet broadcast (it does not end in .255). On a typical /24 network this should be ' + _suggested + '. If WOL is not waking the TV, set "woladdress": "' + _suggested + '" (or remove woladdress to let the plugin derive it from the TV IP).');
      }
    }
    // Number of magic packets sent in a burst and the interval between them.
    // A burst is more reliable than a single packet on flaky networks (some
    // TVs miss the first packet while NIC firmware is still booting up).
    this.wolBurstCount = config.wolBurstCount || 5;
    this.wolBurstInterval = config.wolBurstInterval || 500;
    // After the WOL burst, poll getPowerStatus until the TV reports active or
    // until this timeout expires. Used only for logging/verification, the
    // HomeKit callback is invoked earlier so HomeKit doesn't time out.
    // v1.4.21: default raised from 15s to 45s. Older Bravia (e.g. KD-55X9005B)
    // need ~25s from the magic packet to a working REST API, so a 15s window
    // logged a misleading "TV did not become alive" on every successful wake.
    this.wakeWaitMaxMs = config.wakeWaitMaxMs || 45000;
    this.wakeWaitIntervalMs = config.wakeWaitIntervalMs || 2000;
    // Delay applied before the first channel scan after a wake-up. Channel
    // queries may fail if issued too soon after the TV becomes alive while
    // the AV stack is still initialising.
    this.postWakeScanDelay = config.postWakeScanDelay || 3000;
    // Timestamp of the last wake event (set when setPowerState(true) is invoked
    // or when getPowerState detects an OFF→ON transition). Drives both the
    // adaptive polling window and the post-wake scan delay.
    this.recentlyWokenAt = 0;
    this.starttimeout = config.starttimeout || 5000;
    if (!isNull(config.compatibilitymode)) {
      this.log('[' + config.name + '] ℹ️  "compatibilitymode" is obsolete and ignored since v1.4.21 — you can remove it from config.');
    }
    this.serverPort = config.serverPort || 8999;
    // v1.4.21: external input sources.
    //  - `sources` set in config → used exactly as configured (only entries
    //    that are not Sony source URIs, e.g. "HDMI 3" typed by mistake, are
    //    dropped with a warning — they could never match anything, and they
    //    silently replaced the whole default list: issue #6).
    //  - `sources` not set → the TV's own list is read at scan time with
    //    getSourceList (e.g. cec, composite, hdmi, scart, widi). Fallback if the
    //    TV does not answer: DEFAULT_SOURCES. The old default list used
    //    "extInput:component", which Sony TVs reject: the analog A/V input is
    //    "extInput:composite" (issue #8).
    this.sourcesAuto = false;
    if (Array.isArray(config.sources) && config.sources.length > 0) {
      var _valid = [];
      config.sources.forEach((s) => {
        var v = (typeof s === 'string') ? s.trim() : '';
        if (/^[a-zA-Z]+:[a-zA-Z0-9_\-]+/.test(v)) {
          _valid.push(v);
        } else {
          this.log('[' + config.name + '] ⚠️  Ignoring invalid entry in "sources": "' + s + '". Use Sony source URIs such as extInput:hdmi, extInput:composite, extInput:scart, extInput:cec, extInput:widi. To show or hide single inputs (e.g. only HDMI 3) use the Channel Selector.');
        }
      });
      if (_valid.length > 0) {
        this.sources = _valid;
      } else {
        this.log('[' + config.name + '] ⚠️  No valid entry in "sources" — reading the input list from the TV instead');
        this.sources = DEFAULT_SOURCES.slice();
        this.sourcesAuto = true;
      }
    } else {
      this.sources = DEFAULT_SOURCES.slice();
      this.sourcesAuto = true;
    }
    this.useApps = (isNull(config.applications)) ? false : (config.applications instanceof Array == true ? config.applications.length > 0 : config.applications);
    this.applications = (isNull(config.applications) || (config.applications instanceof Array != true)) ? [] : config.applications;
    this.cookiepath = STORAGE_PATH + '/sonycookie_' + this.name;
    // v1.4.22: when the pairing cookie was issued, when it expires and how the
    // last automatic renewal went (shown in the web UI as "days left").
    this.cookieMetaPath = STORAGE_PATH + '/sonycookie_' + this.name + '.meta.json';
    this.cookieMeta = null;
    
    // Web server configuration
    this.channelSelectorPort = config.channelSelectorPort || this.serverPort;
    this.enableChannelSelector = config.enableChannelSelector !== false;
    this.selectedChannelsPath = STORAGE_PATH + '/selected-channels-' + this.name + '.json';
    this.volumeAccessory = config.volumeAccessory === true;
    this.volumeUI = config.volumeUI === true;
    this.volumeAccessoryInstance = null; // will hold the Lightbulb accessory if enabled
    // v1.4.21: optional "<name> Controls" accessory: picture-mode switches and "Screen off".
    this.controlsAccessory = config.controlsAccessory === true;
    this.controlsScenes = Array.isArray(config.controlsScenes) && config.controlsScenes.length
      ? config.controlsScenes.filter((x) => typeof x === 'string' && /^[a-zA-Z0-9]+$/.test(x)).slice(0, 12)
      : ['cinema', 'game', 'sports'];
    this.controlsAccessoryInstance = null;
    // v1.4.21: optional separate Home tiles, so the TV's input list keeps only
    // inputs, channels and radio: "<name> Apps" and "<name> Recordings" (own
    // TV tiles: picking an entry launches the app / plays the recording) and
    // "<name> Functions" (one button per remote function, e.g. Teletext).
    this.appsAccessory = config.appsAccessory === true;
    this.recordingsAccessory = config.recordingsAccessory === true;
    this.functionsAccessory = config.functionsAccessory === true;
    this.fullScanCachePath = STORAGE_PATH + '/sonytv-fullscan-' + this.name + '.json';
    this.capabilitiesPath = STORAGE_PATH + '/sonytv-capabilities-' + this.name + '.json';
    // Device capabilities — loaded from file or detected at runtime
    // apiVersions is populated automatically at boot via getVersions probe on every Sony endpoint.
    // Each method is mapped to the highest supported version reported by the TV.
    this.capabilities = {
      detectedAt: null,
      interface: null,   // from getInterfaceInformation (no auth)
      system: null,      // from getSystemInformation (auth required)
      apiVersions: {}    // method name -> highest supported version, populated dynamically
    };
    // Static map: method name -> Sony endpoint path. Used by getVersions probe and by callers.
    this.methodEndpoints = {
      // accessControl
      'actRegister': '/sony/accessControl',
      'getMethodTypes': '/sony/accessControl',
      // system
      'getInterfaceInformation': '/sony/system',
      'getSystemInformation': '/sony/system',
      'getPowerStatus': '/sony/system',
      'setPowerStatus': '/sony/system',
      // avContent
      'getContentList': '/sony/avContent',
      'getCurrentExternalInputsStatus': '/sony/avContent',
      // v1.4.15: getApplicationList lives on /sony/appControl, not on
      // /sony/avContent. The actual HTTP call in receiveApplications()
      // correctly targets /sony/appControl, but the methodEndpoints map
      // pointed to /sony/avContent. As a result probeApiVersions() looked for
      // getApplicationList in avContent's getMethodTypes responses, never
      // found it (it is not advertised there), and getApiVersion() always
      // fell back to the default v1.0. Harmless on most TVs but blocked any
      // future auto-downgrade for this method and is simply the wrong mapping.
      'getApplicationList': '/sony/appControl',
      'getPlayingContentInfo': '/sony/avContent',
      'setPlayContent': '/sony/avContent',
      'setActiveApp': '/sony/avContent',
      // audio
      'getVolumeInformation': '/sony/audio',
      'setAudioVolume': '/sony/audio',
      'setAudioMute': '/sony/audio'
    };
    
    // HAP-NodeJS refuses more than 100 services per accessory. The count
    // includes the AccessoryInformation service that every accessory carries,
    // plus Television and TelevisionSpeaker, so at most 100 - 3 = 97 input
    // sources fit. (Up to v1.4.20 the cap was 98, which made the 101st service
    // throw: on a new TV the speaker service was silently dropped, on an
    // existing one the scan got stuck and channels never refreshed again.)
    this.maxInputSources = config.maxInputSources || MAX_HOMEKIT_INPUTS;
    if (this.maxInputSources > MAX_HOMEKIT_INPUTS) {
      this.log('[' + this.name + '] ⚠️  maxInputSources set to ' + this.maxInputSources + ' but the HomeKit limit is ' + MAX_HOMEKIT_INPUTS + ' — using ' + MAX_HOMEKIT_INPUTS);
      this.maxInputSources = MAX_HOMEKIT_INPUTS;
    }
    
    // When true, HDMI inputs that are physically disconnected are hidden in HomeKit
    this.hideDisconnectedInputs = config.hideDisconnectedInputs === true;
    // Cache of external input connection status: Map<uri, {title, label, connection, icon}>
    this.externalInputsStatus = new Map();

    if (this.debug) this.log('[' + this.name + '] TV Source configured: ' + this.tvsource);
    if (this.debug) this.log('[' + this.name + '] Channel update rate: ' + this.channelupdaterate + 'ms');
    if (this.debug) this.log('[' + this.name + '] Max input sources: ' + this.maxInputSources + ' (HomeKit limit: ' + MAX_HOMEKIT_INPUTS + ')');
    if (this.debug) this.log('[' + this.name + '] Hide disconnected inputs: ' + this.hideDisconnectedInputs);

    // Authentication and state variables
    this.cookie = null;
    this.pwd = config.pwd || null;
    this.registercheck = false;
    this.authok = false;
    this.appsLoaded = false;
    if (!this.useApps)
      this.appsLoaded = true;

    this.power = false; // Initially assume TV is off
    if (this.debug) this.log('[' + this.name + '] Initial power state: false');

    // Channel and input tracking
    this.inputSourceList = [];
    this.inputSourceMap = new Map();
    this.tvChannelCounter = 1; // for TV tuner channels (offset by TV_IDENTIFIER_BASE)

    this.currentUri = null;
    this.currentMediaState = Characteristic.TargetMediaState.STOP; // TODO
    this.uriToInputSource = new Map();

    // Load authentication cookie if exists
    this.loadCookie();

    this.services = [];
    this.channelServices = [];
    this.scannedChannels = [];

    const contextPath = STORAGE_PATH + '/sonytv-context-' + this.name + '.json';
    if (this.debug) this.log('[' + this.name + '] Context path: ' + contextPath);
    
      if (accessory != null) {
        // RESTORE PATH 1: Dynamic plugin with configureAccessory restore
        if (this.debug) this.log('[' + this.name + '] Restoring from HomeKit cache');
        this.accessory = accessory;
        this.accessory.category = this.platform.api.hap.Categories.TELEVISION; // 31;
        this.grabServices(accessory);
        this.applyCallbacks();
        if (this.debug) this.log('[' + this.name + '] Services restored from cache');
        
      } else if (this.config.externalaccessory && fs.existsSync(contextPath)) {
        // RESTORE PATH 2: External accessory from context file
        if (this.debug) this.log('[' + this.name + '] External accessory context file found');
        const rawdata = fs.readFileSync(contextPath);
        const accessoryContext = JSON.parse(rawdata);
        var uuid = UUIDGen.generate(this.name + '-SonyTV');
        this.accessory = new Accessory(this.name, uuid, this.platform.api.hap.Categories.TELEVISION);
        this.accessory.context.uuid = accessoryContext.uuid;
        this.accessory.context.isexternal = true;
        // not registered - needs to be added
        // this.accessory.context.isRegisteredInHomeKit = accessoryContext.isRegisteredInHomeKit;
        this.accessory.context.config = this.config;
        this.log('[' + this.name + '] Cached external TV ' + this.name + ' restored');
        this.createServices();
        this.applyCallbacks();
        if (this.debug) this.log('[' + this.name + '] Loading channels from file...');
        this.loadChannelsFromFile();
        if (this.debug) this.log('[' + this.name + '] Channels loaded from file');
        
      } else {
        // NEW ACCESSORY PATH: Create brand new accessory
        var uuid = UUIDGen.generate(this.name + '-SonyTV');
        this.log('[' + this.name + '] Creating new accessory for ' + this.name);
        this.accessory = new Accessory(this.name, uuid, this.platform.api.hap.Categories.TELEVISION);
        this.accessory.context.config = config;
        this.accessory.context.uuid = uuidv4();
        this.log('[' + this.name + '] New TV ' + this.name + ' → will scan channels and register in HomeKit');
        this.accessory.context.isexternal = this.config.externalaccessory;
        this.createServices();
        this.applyCallbacks();
        if (this.debug) this.log('[' + this.name + '] New accessory created');
      }
    } catch (e) {
      this.log('[' + this.name + '] ERROR Exception in constructor: ' + e);
      this.log('[' + this.name + '] ERROR Stack: ' + e.stack);
    }
    if (this.debug) this.log('[' + this.name + '] Constructor done for ' + this.name);
  }
  // get free channel identifier
  getFreeIdentifier() {
    var id = 1;
    var keys = [...this.inputSourceMap.keys()];
    // v1.4.21: never hand out an identifier that belonged to an input removed
    // while Homebridge is running (e.g. swapping HDMI 1 for HDMI 3 in one
    // save): the Home app would briefly associate the old input's name and
    // settings with the new one.
    var retired = this._retiredIdentifiers || new Set();
    while (keys.includes(id) || retired.has(id)) {
      id++;
    }
    return id;
  }
  // Start method: Called after constructor completes, initiates authentication and status polling
  start() {
    if (this.debug) this.log('[' + this.name + '] start() called for ' + this.name);

    // Emit comprehensive debug banners (no-op unless debug:true).
    // These banners contain everything needed to diagnose any user-reported
    // problem without asking for additional information.
    this._logEnvironmentBanner();
    this._logConfigBanner();
    this._logStorageBanner();

    // STEP 1 (synchronous): load capabilities from disk if a previous probe exists.
    // This makes detected API versions available immediately for the very first
    // checkRegistration / actRegister call, which is critical on TVs (e.g. Bravia
    // XR with interface v6.3.0+) that reject actRegister v1.0.
    this.loadCapabilities();
    if (this.debug && this.capabilities && Object.keys(this.capabilities.apiVersions || {}).length > 0) {
      this._logCapabilitiesBanner();
    }

    // Start the permanent web server. The web server is ALWAYS started
    // because it is needed for the pairing PIN entry page (which is required
    // to authenticate with the TV the first time). The enableChannelSelector
    // option only controls whether the channel selector UI page is exposed,
    // not whether the web server itself is running.
    try {
      this.log('[' + this.name + '] Starting web server on port ' + this.channelSelectorPort);
      this.startWebServer();
    } catch (e) {
      this.log('[' + this.name + '] ERROR Failed to start web server: ' + e);
    }
    if (this.debug) this.log('[' + this.name + '] Current state - authok: ' + this.authok + ', power: ' + this.power + ', receivingSources: ' + this.receivingSources);
    if (this.debug) this.log('[' + this.name + '] Accessory registered: ' + this.accessory.context.isRegisteredInHomeKit);
    
    // CRITICAL: Ensure accessory is always published to HomeKit
    // Even if TV is powered off, we need the accessory visible so user can turn it on
    if (!this.accessory.context.isRegisteredInHomeKit && this.channelServices.length > 0) {
      this.log('[' + this.name + '] ⚠️  Accessory not registered but has channels - registering now');
      this.syncAccessory();
    }

    // STEP 2 (asynchronous): probe interface info and API versions in parallel.
    // STEP 3 (asynchronous): once the probe completes (or after a 5s timeout if the
    // TV is unreachable / off), trigger the first checkRegistration with the freshest
    // possible API versions. Subsequent checkRegistration calls are scheduled by
    // updateStatus() polling and will always have full capabilities available.
    this.probeInterfaceInfo();
    const self = this;
    let bootCheckDone = false;
    const doBootCheck = (reason) => {
      if (bootCheckDone) return;
      bootCheckDone = true;
      if (self.debug) self.log('[' + self.name + '] 🚀 First checkRegistration triggered: ' + reason);
      self.checkRegistration();
    };
    this.probeApiVersions(() => doBootCheck('API probe completed'));
    // Safety net: if probe takes too long (TV off / unreachable), still try to register.
    // The default fallback version '1.0' will be used and the call may fail, but the
    // updateStatus polling will retry every updaterate ms until the TV comes online.
    setTimeout(() => doBootCheck('probe timeout (5s)'), 5000);

    this.updateStatus();
    this.setupVolumeAccessory();
    this.setupControlsAccessory();
    this._initSideAccessories();
    if (this.debug) this.log('[' + this.name + '] Auth + status polling started');
  }
  // Get the services (TV service, channels) from a restored HomeKit accessory
  grabServices(accessory) {
    const self = this;
    if (this.debug) this.log('[' + this.name + '] grabServices() called, recovering services from cached accessory');
    if (this.debug) this.log('[' + this.name + '] Accessory has ' + accessory.services.length + ' services');
    
    var channelCount = 0;
    // FIXME: Hack, using subtype to store URI for channel
    accessory.services.forEach(service => {
      if ((service.subtype !== undefined) && service.testCharacteristic(Characteristic.Identifier)) {
        var identifier = service.getCharacteristic(Characteristic.Identifier).value;
        self.inputSourceMap.set(identifier, service);
        self.uriToInputSource.set(service.subtype, service);
        self.uriToInputSource.set(self.normalizeUri(service.subtype), service);
        self.channelServices.push(service);
        channelCount++;
      }
    });
    
    if (this.debug) this.log('[' + this.name + '] Recovered ' + channelCount + ' channel services');
    if (this.debug) this.log('[' + this.name + '] inputSourceMap size: ' + this.inputSourceMap.size);
    
    this.services = [];
    this.tvService = accessory.getService(Service.Television);
    this.services.push(this.tvService);
    this.speakerService = accessory.getService(Service.TelevisionSpeaker);
    this.services.push(this.speakerService);
    
    if (this.debug) this.log('[' + this.name + '] ✓ Services grabbed successfully');
    return this.services;
  }
  // Create the television service for a new TV accessory
  createServices() {
    if (this.debug) this.log('[' + this.name + '] createServices() called, creating new TV and Speaker services');
    /// sony/system/
    // ["getSystemInformation",[],["{\"product\":\"string\", \"region\":\"string\", \"language\":\"string\", \"model\":\"string\", \"serial\":\"string\", \"macAddr\":\"string\", \"name\":\"string\", \"generation\":\"string\", \"area\":\"string\", \"cid\":\"string\"}"],"1.0"]
    this.tvService = new Service.Television(this.name);
    this.services.push(this.tvService);
    this.speakerService = new Service.TelevisionSpeaker();
    this.services.push(this.speakerService);
    if (this.debug) this.log('[' + this.name + '] ✓ Created TV and Speaker services');
    // TODO: information services
    //  var informationService = new Service.AccessoryInformation();
    //  informationService
    //  .setCharacteristic(Characteristic.Manufacturer, "Sony")
    //  .setCharacteristic(Characteristic.Model, "Android TV")
    //  .setCharacteristic(Characteristic.SerialNumber, "12345");
    //  this.services.push(informationService);
    return this.services;
  }
  // sets the callbacks for the homebridge services to call the functions of this TV instance
  applyCallbacks() {
    this.tvService.setCharacteristic(Characteristic.ConfiguredName, this.name);
    this.tvService
      .setCharacteristic(
        Characteristic.SleepDiscoveryMode,
        Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE
      );
    this.tvService
      .getCharacteristic(Characteristic.Active)
      .on('set', this.setPowerState.bind(this))
    this.tvService.setCharacteristic(Characteristic.ActiveIdentifier, 0);
    this.tvService
      .getCharacteristic(Characteristic.ActiveIdentifier)
      .on('set', this.setActiveIdentifier.bind(this))
      .on('get', this.getActiveIdentifier.bind(this));
    this.tvService
      .getCharacteristic(Characteristic.RemoteKey)
      .on('set', this.setRemoteKey.bind(this));
    // v1.4.21: "View TV Settings" in the iOS remote / Home app → opens the
    // TV's Options menu.
    this.tvService
      .getCharacteristic(Characteristic.PowerModeSelection)
      .on('set', (value, callback) => {
        this.sendRemoteFunction('Options');
        callback(null);
      });
    this.speakerService
      .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE);
    this.speakerService
      .setCharacteristic(Characteristic.Name, this.soundoutput);
    this.speakerService
      .setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.ABSOLUTE);
    this.speakerService
      .getCharacteristic(Characteristic.VolumeSelector) // increase/decrease volume
      .on('set', this.setVolumeSelector.bind(this));
    this.speakerService
      .getCharacteristic(Characteristic.Mute)
      .on('get', this.getMuted.bind(this))
      .on('set', this.setMuted.bind(this));
    this.speakerService.getCharacteristic(Characteristic.Volume)
      .on('get', this.getVolume.bind(this))
      .on('set', this.setVolume.bind(this));
  }
  // Do TV status check every 5 seconds
  // Creates and publishes a Lightbulb accessory that maps brightness→volume and on/off→mute
  // ══════════════════════════════════════════════════════════════════════════
  // DEBUG HELPERS
  // Sanitised, structured debug output. All helpers below are no-ops unless
  // debug:true is set in the per-TV config. The intent is to provide ALL the
  // info needed to diagnose any user-reported issue WITHOUT having to ask the
  // user follow-up questions or run extra commands.
  // ══════════════════════════════════════════════════════════════════════════

  // Mask sensitive values for debug output
  // type: 'psk' (full mask), 'mac' (last 4 chars), 'cookie' (length + last 6 chars), 'pin' (full mask)
  _sanitize(value, type) {
    if (value === null || value === undefined) return '<null>';
    const s = String(value);
    if (s.length === 0) return '<empty>';
    if (type === 'psk' || type === 'pin') {
      return '***' + s.length + 'chars***';
    }
    if (type === 'mac') {
      // AA:BB:CC:DD:EE:FF -> **:**:**:**:EE:FF
      const parts = s.split(/[:-]/);
      if (parts.length === 6) return '**:**:**:**:' + parts[4] + ':' + parts[5];
      return s.slice(-5);
    }
    if (type === 'cookie') {
      const tail = s.length > 6 ? s.slice(-6) : s;
      return s.length + 'chars ending with ...' + tail;
    }
    return s;
  }

  // Derive the directed broadcast address from a TV IP by replacing the last octet
  // with 255. Assumes a /24 subnet, which is correct for the vast majority of home
  // and SMB networks. If the IP is a hostname or cannot be parsed, falls back to
  // the limited broadcast 255.255.255.255 (same-subnet only).
  _deriveDirectedBroadcast(ip) {
    if (!ip || typeof ip !== 'string') return '255.255.255.255';
    var parts = ip.split('.');
    if (parts.length !== 4) return '255.255.255.255';
    // Validate that all four octets are numeric
    for (var i = 0; i < 4; i++) {
      var n = parseInt(parts[i], 10);
      if (isNaN(n) || n < 0 || n > 255) return '255.255.255.255';
    }
    parts[3] = '255';
    return parts.join('.');
  }

  // ── v1.4.13: WOL burst helper ────────────────────────────────────────────
  // Sends `wolBurstCount` magic packets at `wolBurstInterval` ms intervals.
  // Returns immediately and invokes `done(errArr)` after the last packet,
  // where `errArr` is an array of any send errors (empty on full success).
  // The destination address is chosen by `wolMode`:
  //   - 'auto'              → unicast to the TV's IP
  //   - 'directed-broadcast' → woladdress (subnet broadcast)
  // Caller must check that wolMode !== 'disabled' and that a MAC is configured.
  _sendWolBurst(done) {
    var that = this;
    if (isNull(that.mac)) {
      if (typeof done === 'function') done([new Error('no MAC configured')]);
      return;
    }
    // v1.4.21: 'auto' now sends every packet BOTH as unicast to the TV's IP and
    // to the subnet broadcast derived from it. Unicast alone often never left
    // the host: while the TV's NIC sleeps, the host (or the router, across
    // VLANs) has no ARP entry for the TV any more, so the packet is dropped.
    var dests = (that.wolMode === 'directed-broadcast')
      ? [that.woladdress || '255.255.255.255']
      : [that.ip, that.woladdress].filter(function (d, i, a) { return !isNull(d) && d !== '' && a.indexOf(d) === i; });
    var dest = dests.join(' + ');
    var count = that.wolBurstCount;
    var interval = that.wolBurstInterval;
    var errors = [];
    var idx = 0;

    var destLabel = (that.wolMode === 'directed-broadcast') ? 'subnet broadcast' : 'unicast to TV + subnet broadcast';
    that.log('[' + that.name + '] [POWER] ⚡ WOL burst: sending ' + count + ' magic packets to mac=' + that._sanitize(that.mac, 'mac') + ' dest=' + dest + ' [' + destLabel + '] (mode=' + that.wolMode + ', interval=' + interval + 'ms)');

    var sendNext = function () {
      if (idx >= count) {
        if (errors.length === 0) {
          that.log('[' + that.name + '] [POWER] ✓ WOL burst complete: ' + count + '/' + count + ' packets sent');
        } else {
          that.log('[' + that.name + '] [POWER] ⚠️  WOL burst complete with errors: ' + (count - errors.length) + '/' + count + ' packets sent, ' + errors.length + ' failed');
        }
        if (typeof done === 'function') done(errors);
        return;
      }
      idx++;
      var packetIdx = idx;
      // One "packet" = one magic packet to each destination. It counts as sent
      // if at least one destination accepted it.
      var pending = dests.length;
      var packetErrors = [];
      var afterPacket = function () {
        if (packetErrors.length === dests.length) errors.push(packetErrors[0]);
        if (packetIdx >= count) {
          sendNext();
        } else {
          setTimeout(sendNext, interval);
        }
      };
      dests.forEach(function (d) {
        var finished = false;
        var finishOne = function (err) {
          if (finished) return;
          finished = true;
          if (err) {
            packetErrors.push(err);
            if (that.debug) that.log('[' + that.name + '] [POWER] ⚡ WOL packet ' + packetIdx + '/' + count + ' to ' + d + ' FAILED: ' + err);
          } else if (that.debug) {
            that.log('[' + that.name + '] [POWER] ⚡ WOL packet ' + packetIdx + '/' + count + ' sent to ' + d);
          }
          pending--;
          if (pending === 0) afterPacket();
        };
        try {
          wol.wake(that.mac, { address: d }, finishOne);
        } catch (e) {
          finishOne(e);
        }
      });
    };

    sendNext();
  }

  // ── v1.4.13: Wait for REST alive ─────────────────────────────────────────
  // Polls getPowerStatus every `wakeWaitIntervalMs` until the TV reports
  // status=active or until `wakeWaitMaxMs` elapses. Used purely for logging
  // verification of WOL effectiveness — the HomeKit callback is invoked
  // earlier (after the WOL burst completes) to avoid HomeKit timeouts.
  // `done(alive, elapsedMs)` is invoked once at the end.
  _waitForRestAlive(done) {
    var that = this;
    var startedAt = Date.now();
    var attempt = 0;
    var maxMs = that.wakeWaitMaxMs;
    var intervalMs = that.wakeWaitIntervalMs;

    that.log('[' + that.name + '] [POWER] 👀 Waiting for REST alive (poll every ' + intervalMs + 'ms, timeout ' + maxMs + 'ms)');

    var tick = function () {
      attempt++;
      var elapsed = Date.now() - startedAt;
      if (elapsed >= maxMs) {
        that.log('[' + that.name + '] [POWER] ⏱️  REST alive wait timed out after ' + elapsed + 'ms (' + attempt + ' attempts), TV not reachable yet (regular polling continues; raise wakeWaitMaxMs if your TV boots slower)');
        if (typeof done === 'function') done(false, elapsed);
        return;
      }

      var getPowerStatusVersion = that.getApiVersion('getPowerStatus', '1.0');
      var post_data = '{"id":2,"method":"getPowerStatus","version":"' + getPowerStatusVersion + '","params":[]}';

      var onErr = function (err) {
        if (that.debug) that.log('[' + that.name + '] [POWER] alive-check #' + attempt + ' (t+' + elapsed + 'ms) ERROR: ' + err);
        if (Date.now() - startedAt + intervalMs >= maxMs) {
          // No time for another attempt
          var finalElapsed = Date.now() - startedAt;
          that.log('[' + that.name + '] [POWER] ⏱️  REST alive wait timed out after ' + finalElapsed + 'ms (' + attempt + ' attempts)');
          if (typeof done === 'function') done(false, finalElapsed);
          return;
        }
        setTimeout(tick, intervalMs);
      };

      var onOk = function (chunk) {
        try {
          var j = JSON.parse(chunk);
          var alive = !isNull(j) && !isNull(j.result) && !isNull(j.result[0]) && j.result[0].status === 'active';
          if (alive) {
            var t = Date.now() - startedAt;
            that.log('[' + that.name + '] [POWER] ✅ REST alive after ' + t + 'ms (' + attempt + ' attempts)');
            // Mirror the alive state into HomeKit immediately so the regular
            // polling loop doesn't have to wait for its next tick.
            that.updatePowerState(true);
            if (typeof done === 'function') done(true, t);
            return;
          }
          if (that.debug) that.log('[' + that.name + '] [POWER] alive-check #' + attempt + ' (t+' + (Date.now() - startedAt) + 'ms): not active yet');
          if (Date.now() - startedAt + intervalMs >= maxMs) {
            var finalElapsed = Date.now() - startedAt;
            that.log('[' + that.name + '] [POWER] ⏱️  REST alive wait timed out after ' + finalElapsed + 'ms (' + attempt + ' attempts)');
            if (typeof done === 'function') done(false, finalElapsed);
            return;
          }
          setTimeout(tick, intervalMs);
        } catch (e) {
          onErr('parse error: ' + e);
        }
      };

      try {
        that.makeHttpRequest(onErr, onOk, '/sony/system/', post_data, false);
      } catch (e) {
        onErr('throw: ' + e);
      }
    };

    setTimeout(tick, intervalMs);
  }

  // ── v1.4.13: Adaptive polling interval ───────────────────────────────────
  // Returns the polling interval to use for the next updateStatus() tick:
  //   - postWakePollRate (default 2s) inside the postWakePollWindow after a
  //     wake event, while the TV is still detected as OFF
  //   - updaterate (default 5s) when the TV is ON
  //   - standbyUpdateRate (default 25s) when the TV is OFF and no recent wake
  _currentPollInterval() {
    if (this.recentlyWokenAt) {
      var sinceWake = Date.now() - this.recentlyWokenAt;
      if (sinceWake < this.postWakePollWindow && !this.power) {
        return this.postWakePollRate;
      }
    }
    return this.power ? this.updaterate : this.standbyUpdateRate;
  }

  // Print a formatted debug banner with a title and a list of "key: value" lines
  _debugBanner(title, lines) {
    if (!this.debug) return;
    const tag = '[' + this.name + ']';
    this.log(tag + ' ╔══════════════════════════════════════════════════════════');
    this.log(tag + ' ║ ' + title);
    this.log(tag + ' ╠══════════════════════════════════════════════════════════');
    (lines || []).forEach((line) => {
      this.log(tag + ' ║ ' + line);
    });
    this.log(tag + ' ╚══════════════════════════════════════════════════════════');
  }

  // Detect runtime environment hints (Docker/Synology/RPi/generic)
  _detectEnvironment() {
    const hints = [];
    try {
      if (fs.existsSync('/.dockerenv')) hints.push('docker');
      if (fs.existsSync('/etc/synoinfo.conf')) hints.push('synology');
      if (fs.existsSync('/proc/device-tree/model')) {
        try {
          const m = fs.readFileSync('/proc/device-tree/model', 'utf8');
          if (m.toLowerCase().indexOf('raspberry') >= 0) hints.push('raspberry-pi');
        } catch (e) {}
      }
      // Check cgroup for additional container hints
      if (fs.existsSync('/proc/1/cgroup')) {
        try {
          const cg = fs.readFileSync('/proc/1/cgroup', 'utf8');
          if (cg.indexOf('docker') >= 0 && hints.indexOf('docker') < 0) hints.push('docker');
          if (cg.indexOf('lxc') >= 0) hints.push('lxc');
        } catch (e) {}
      }
    } catch (e) {}
    return hints.length > 0 ? hints.join(', ') : 'generic';
  }

  // Log full environment + plugin + host info at startup
  _logEnvironmentBanner() {
    if (!this.debug) return;
    let pkgVersion = 'unknown';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
      pkgVersion = pkg.version || 'unknown';
    } catch (e) {}
    const lines = [
      'Plugin: homebridge-bravia-enhanced v' + pkgVersion,
      'Node: ' + process.version + ' | Platform: ' + process.platform + ' | Arch: ' + process.arch,
      'Hostname: ' + os.hostname() + ' | Environment: ' + this._detectEnvironment(),
      'CWD: ' + process.cwd(),
      'PID: ' + process.pid + ' | uptime: ' + Math.round(process.uptime()) + 's',
      'Timezone: ' + Intl.DateTimeFormat().resolvedOptions().timeZone + ' | Locale: ' + (process.env.LANG || 'unset')
    ];
    this._debugBanner('🛠️  ENVIRONMENT', lines);
  }

  // Log full sanitised TV config at startup
  _logConfigBanner() {
    if (!this.debug) return;
    const lines = [
      'name: ' + this.name,
      'ip: ' + this.ip + ' | tv port: ' + this.port,
      'serverPort: ' + this.serverPort + ' | channelSelectorPort: ' + this.channelSelectorPort,
      'enableChannelSelector: ' + this.enableChannelSelector,
      'soundoutput: ' + this.soundoutput,
      'tvsource: ' + (this.tvsource || '<none>'),
      'externalaccessory: ' + (this.externalaccessory === true),
      'volumeAccessory: ' + this.volumeAccessory,
      'separate tiles: apps=' + this.appsAccessory + ' recordings=' + this.recordingsAccessory + ' functions=' + this.functionsAccessory,
      'controlsAccessory: ' + this.controlsAccessory + (this.controlsAccessory ? ' (' + this.controlsScenes.join(', ') + ')' : ''),
      'volumeUI: ' + this.volumeUI,
      'hideDisconnectedInputs: ' + (this.hideDisconnectedInputs === true),
      'maxInputSources: ' + this.maxInputSources,
      'updaterate: ' + this.updaterate + 'ms | channelupdaterate: ' + this.channelupdaterate + 'ms',
      'standbyUpdateRate: ' + this.standbyUpdateRate + 'ms | postWakePollRate: ' + this.postWakePollRate + 'ms | postWakePollWindow: ' + this.postWakePollWindow + 'ms',
      'wolMode: ' + this.wolMode + ' | wolBurstCount: ' + this.wolBurstCount + ' | wolBurstInterval: ' + this.wolBurstInterval + 'ms',
      'wakeWaitMaxMs: ' + this.wakeWaitMaxMs + ' | wakeWaitIntervalMs: ' + this.wakeWaitIntervalMs + ' | postWakeScanDelay: ' + this.postWakeScanDelay + 'ms',
      'mac: ' + this._sanitize(this.mac, 'mac'),
      'woladdress: ' + (this.woladdress || '<default>') + ' (used when wolMode=directed-broadcast; auto-promotes to that mode if set without explicit wolMode)',
      'psk: ' + this._sanitize(this.psk, 'psk'),
      'applications: ' + (this.applications ? this.applications.length + ' configured' : '<none>'),
      'sources: ' + (this.sources ? this.sources.join(', ') : '<defaults>')
    ];
    this._debugBanner('⚙️  TV CONFIG (sanitised)', lines);
  }

  // Log file paths and existence/size for storage files
  _logStorageBanner() {
    if (!this.debug) return;
    const fileStat = (p) => {
      try {
        const s = fs.statSync(p);
        return 'exists, ' + s.size + ' bytes, modified ' + s.mtime.toISOString();
      } catch (e) { return 'not present'; }
    };
    const lines = [
      'cookie: ' + this.cookiepath,
      '   -> ' + fileStat(this.cookiepath),
      'capabilities: ' + this.capabilitiesPath,
      '   -> ' + fileStat(this.capabilitiesPath),
      'fullscan: ' + this.fullScanCachePath,
      '   -> ' + fileStat(this.fullScanCachePath),
      'STORAGE_PATH base: ' + STORAGE_PATH
    ];
    this._debugBanner('💾 STORAGE PATHS', lines);
  }

  // Log full detected capabilities (model, firmware, all API versions)
  // Called automatically when probe completes
  _logCapabilitiesBanner() {
    if (!this.debug) return;
    const c = this.capabilities || {};
    const iface = c.interface || {};
    const sys = c.system || {};
    const apiVersions = c.apiVersions || {};
    // Group methods by endpoint for readability
    const byEndpoint = {};
    Object.keys(apiVersions).forEach((m) => {
      const ep = this.methodEndpoints[m] || '<unknown>';
      if (!byEndpoint[ep]) byEndpoint[ep] = [];
      byEndpoint[ep].push(m + '=' + apiVersions[m]);
    });
    const lines = [
      'Model: ' + (sys.model || iface.modelName || '<unknown>') + ' (' + (iface.productName || '?') + ')',
      'Serial: ' + (sys.serial || '<not yet, requires pairing>'),
      'Generation: ' + (sys.generation || '<not yet, requires pairing>'),
      'Interface version: ' + (iface.interfaceVersion || '<unknown>'),
      'Detected at: ' + (c.detectedAt || '<never>'),
      'API methods detected: ' + Object.keys(apiVersions).length
    ];
    Object.keys(byEndpoint).sort().forEach((ep) => {
      lines.push(ep + ':');
      byEndpoint[ep].sort().forEach((m) => lines.push('   ' + m));
    });
    this._debugBanner('📺 TV CAPABILITIES', lines);
  }

  // Log current runtime state (auth, power, cookie, awaiting pin, etc.)
  _logStateDump(reason) {
    if (!this.debug) return;
    const lines = [
      'reason: ' + (reason || 'manual dump'),
      'authok: ' + this.authok,
      'awaitingPin: ' + this.awaitingPin,
      'power: ' + this.power,
      'receivingSources: ' + this.receivingSources,
      'cookie: ' + this._sanitize(this.cookie, 'cookie'),
      'channels in service list: ' + (this.channelServices ? this.channelServices.length : 0),
      'webServer running: ' + (!!this.webServer),
      'last volume known: ' + (this.capabilities && this.capabilities.lastKnownVolume) || 'unknown'
    ];
    this._debugBanner('🔍 STATE DUMP', lines);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CAPABILITIES MODULE
  // Detects and persists device info and supported API versions
  // Each method is independent — failure of one does not affect others
  // ══════════════════════════════════════════════════════════════════════════

  // Load capabilities from disk (called at boot)
  loadCapabilities() {
    try {
      if (fs.existsSync(this.capabilitiesPath)) {
        const raw = fs.readFileSync(this.capabilitiesPath, 'utf8');
        const saved = JSON.parse(raw);
        this.capabilities = Object.assign(this.capabilities, saved);
        if (saved && saved.remoteKeys && typeof saved.remoteKeys === 'object') this._irccCodes = saved.remoteKeys;
        if (this.debug) this.log('[' + this.name + '] ✓ Capabilities loaded from ' + this.capabilitiesPath);
      }
    } catch (e) {
      if (this.debug) this.log('[' + this.name + '] Could not load capabilities: ' + e);
    }
  }

  // Save capabilities to disk
  saveCapabilities() {
    try {
      this.capabilities.detectedAt = new Date().toISOString();
      fs.writeFileSync(this.capabilitiesPath, JSON.stringify(this.capabilities, null, 2));
      if (this.debug) this.log('[' + this.name + '] ✓ Capabilities saved to ' + this.capabilitiesPath);
    } catch (e) {
      if (this.debug) this.log('[' + this.name + '] Could not save capabilities: ' + e);
    }
  }

  // Probe getInterfaceInformation — authLevel: none, always available
  probeInterfaceInfo() {
    const that = this;
    const getInterfaceInfoVersion = this.getApiVersion('getInterfaceInformation', '1.0');
    const post_data = '{"id":1,"method":"getInterfaceInformation","version":"' + getInterfaceInfoVersion + '","params":[]}';
    const onError = (err) => {
      if (that.debug) that.log('[' + that.name + '] probeInterfaceInfo error: ' + err);
    };
    const onSuccess = (data) => {
      try {
        if (data.indexOf('"error"') >= 0) return;
        const json = JSON.parse(data);
        if (!json || !json.result || !json.result[0]) return;
        const info = json.result[0];
        that.capabilities.interface = {
          modelName: info.modelName || '',
          productName: info.productName || '',
          interfaceVersion: info.interfaceVersion || ''
        };
        that.log('[' + that.name + '] 📺 Device: ' + (info.productName || '') + ' ' + (info.modelName || '') + ' (interface v' + (info.interfaceVersion || '?') + ')');
        that.saveCapabilities();
      } catch (e) {
        if (that.debug) that.log('[' + that.name + '] probeInterfaceInfo parse error: ' + e);
      }
    };
    that.makeHttpRequest(onError, onSuccess, '/sony/system/', post_data, false);
  }

  // Probe getSystemInformation — authLevel: private, requires cookie
  probeSystemInfo() {
    const that = this;
    const getSystemInfoVersion = this.getApiVersion('getSystemInformation', '1.0');
    const post_data = '{"id":1,"method":"getSystemInformation","version":"' + getSystemInfoVersion + '","params":[]}';
    const onError = (err) => {
      if (that.debug) that.log('[' + that.name + '] probeSystemInfo error: ' + err);
    };
    const onSuccess = (data) => {
      try {
        if (data.indexOf('"error"') >= 0) return;
        const json = JSON.parse(data);
        if (!json || !json.result || !json.result[0]) return;
        const info = json.result[0];
        that.capabilities.system = {
          model: info.model || '',
          serial: info.serial || '',
          generation: info.generation || '',
          language: info.language || '',
          macAddr: info.macAddr || ''
        };
        that.log('[' + that.name + '] 🔍 System info: model=' + (info.model || '?') + ' serial=' + (info.serial || '?') + ' gen=' + (info.generation || '?'));
        that.saveCapabilities();
      } catch (e) {
        if (that.debug) that.log('[' + that.name + '] probeSystemInfo parse error: ' + e);
      }
    };
    that.makeHttpRequest(onError, onSuccess, '/sony/system/', post_data, false);
  }

  // Probe supported API versions on every Sony endpoint via getVersions + getMethodTypes.
  // No auth required for either call. Runs at boot, before pairing.
  // Result: this.capabilities.apiVersions is populated with the highest supported version
  // for every method exposed by the TV.
  // Optional onComplete callback is invoked once when all endpoint probes finish (success or failure).
  probeApiVersions(onComplete) {
    const that = this;
    // Unique endpoints derived from the static method map
    const endpoints = Array.from(new Set(Object.values(this.methodEndpoints)));
    let pending = endpoints.length;
    let completedCalled = false;
    const done = () => {
      pending--;
      if (pending === 0) {
        that.saveCapabilities();
        const detected = Object.keys(that.capabilities.apiVersions).length;
        if (that.debug) that.log('[' + that.name + '] ✓ API probe complete: ' + detected + ' methods detected');
        // Dump full capabilities for diagnostics
        that._logCapabilitiesBanner();
        if (typeof onComplete === 'function' && !completedCalled) {
          completedCalled = true;
          try { onComplete(); } catch (e) { if (that.debug) that.log('[' + that.name + '] probe onComplete handler error: ' + e); }
        }
      }
    };
    endpoints.forEach((endpoint) => {
      const post = '{"id":1,"method":"getVersions","version":"1.0","params":[]}';
      const onErr = (err) => {
        if (that.debug) that.log('[' + that.name + '] getVersions error on ' + endpoint + ': ' + err);
        done();
      };
      const onOk = (data) => {
        try {
          const json = JSON.parse(data);
          if (!json || !json.result || !json.result[0]) { done(); return; }
          const versions = json.result[0]; // array of supported version strings, e.g. ["1.0","1.1","1.2"]
          // For each version, query getMethodTypes to learn which methods exist at that version
          let vPending = versions.length;
          const vDone = () => { vPending--; if (vPending === 0) done(); };
          versions.forEach((v) => {
            const mt = '{"id":2,"method":"getMethodTypes","version":"1.0","params":["' + v + '"]}';
            that.makeHttpRequest(
              () => vDone(),
              (mtData) => {
                try {
                  const mtJson = JSON.parse(mtData);
                  if (mtJson && mtJson.results) {
                    mtJson.results.forEach((row) => {
                      // row = [methodName, paramTypes, returnTypes, version]
                      const methodName = row[0];
                      const methodVersion = row[3];
                      // Only record if endpoint matches (TV may expose other methods we do not know about)
                      if (that.methodEndpoints[methodName] === endpoint) {
                        const current = that.capabilities.apiVersions[methodName];
                        // Keep the highest version for each method (numeric comparison)
                        if (!current || compareVersions(methodVersion, current) > 0) {
                          that.capabilities.apiVersions[methodName] = methodVersion;
                        }
                      }
                    });
                  }
                } catch (e) {
                  if (that.debug) that.log('[' + that.name + '] getMethodTypes parse error on ' + endpoint + ' v' + v + ': ' + e);
                }
                vDone();
              },
              endpoint + '/',
              mt,
              false
            );
          });
        } catch (e) {
          if (that.debug) that.log('[' + that.name + '] getVersions parse error on ' + endpoint + ': ' + e);
          done();
        }
      };
      that.makeHttpRequest(onErr, onOk, endpoint + '/', post, false);
    });
  }

  // Get the best API version for a given method
  getApiVersion(methodName, defaultVersion) {
    if (this.capabilities && this.capabilities.apiVersions && this.capabilities.apiVersions[methodName]) {
      return this.capabilities.apiVersions[methodName];
    }
    return defaultVersion || '1.0';
  }

  // Handle a runtime "Method Not Implemented at this version" error (Sony error code 12)
  // by downgrading the cached version of that method to the next-lower one we know exists.
  // Some Sony firmware advertises a version via getMethodTypes but actually rejects calls at
  // that version (it happened with getCurrentExternalInputsStatus on multiple Bravia models).
  // We avoid an infinite loop by tracking which versions we have already tried and rejected.
  // Returns the new version to try, or null if no fallback is available.
  _downgradeApiVersion(methodName) {
    if (!this._apiVersionBlacklist) this._apiVersionBlacklist = {};
    if (!this._apiVersionBlacklist[methodName]) this._apiVersionBlacklist[methodName] = new Set();
    const currentVersion = this.getApiVersion(methodName, '1.0');
    this._apiVersionBlacklist[methodName].add(currentVersion);
    // Standard Sony version progression: 1.2 -> 1.1 -> 1.0
    const fallbackChain = ['1.2', '1.1', '1.0'];
    for (let i = 0; i < fallbackChain.length; i++) {
      const candidate = fallbackChain[i];
      if (compareVersions(candidate, currentVersion) < 0 && !this._apiVersionBlacklist[methodName].has(candidate)) {
        // Update capabilities and persist
        if (!this.capabilities.apiVersions) this.capabilities.apiVersions = {};
        this.capabilities.apiVersions[methodName] = candidate;
        if (this.debug) this.log('[' + this.name + '] ⬇️  API version downgrade: ' + methodName + ' v' + currentVersion + ' rejected by TV (error 12), retrying with v' + candidate);
        try { this.saveCapabilities(); } catch (e) {}
        return candidate;
      }
    }
    if (this.debug) this.log('[' + this.name + '] ⚠️  No more fallback versions for ' + methodName + ' (already tried: ' + Array.from(this._apiVersionBlacklist[methodName]).join(', ') + ')');
    return null;
  }

  // Inspect a JSON-string response and return the Sony error code if present, else null.
  _extractSonyErrorCode(responseText) {
    if (!responseText || responseText.indexOf('"error"') < 0) return null;
    try {
      const parsed = JSON.parse(responseText);
      if (parsed && Array.isArray(parsed.error) && parsed.error.length > 0) {
        return parsed.error[0];
      }
    } catch (e) {}
    return null;
  }

  // Return device info as a plain object for the web UI
  getDeviceInfo() {
    return {
      name: this.name,
      ip: this.ip,
      interface: this.capabilities.interface || null,
      system: this.capabilities.system || null,
      apiVersions: this.capabilities.apiVersions || {},
      detectedAt: this.capabilities.detectedAt || null
    };
  }

  // v1.4.21: one Sony JSON-RPC call → cb(err, result). err is a short string
  // ('tv-off', 'error 12: …', 'http …'); result is json.result.
  tvCall(endpoint, method, version, params, cb) {
    const post = JSON.stringify({ id: 30, method: method, version: version, params: params || [] });
    this.makeHttpRequest(
      (err) => cb('unreachable: ' + (err && err.message ? err.message : err), null),
      (data) => {
        try {
          const j = JSON.parse(data);
          if (j.error) return cb('error ' + j.error[0] + ': ' + j.error[1], null);
          if (j.auth_url) return cb('authentication required', null);
          cb(null, j.result);
        } catch (e) { cb('invalid response', null); }
      },
      endpoint, post, false
    );
  }

  // Run several tvCall()s in parallel; cb(results) with {key: {err, result}}.
  tvCalls(calls, cb) {
    const out = {};
    const keys = Object.keys(calls);
    let pending = keys.length;
    if (!pending) return cb(out);
    keys.forEach((k) => {
      const c = calls[k];
      this.tvCall(c[0], c[1], c[2], c[3], (err, result) => {
        out[k] = { err: err, result: result };
        if (--pending === 0) cb(out);
      });
    });
  }

  // GET /api/diagnostics — live read of useful TV settings (read-only).
  apiDiagnostics(req, res) {
    const self = this;
    if (!this.power) return this.sendJSON(res, { success: true, tvOn: false });
    this.tvCalls({
      network: ['/sony/system', 'getNetworkSettings', '1.0', []],
      wol: ['/sony/system', 'getWolMode', '1.0', []],
      powerSaving: ['/sony/system', 'getPowerSavingMode', '1.0', []],
      time: ['/sony/system', 'getCurrentTime', '1.0', []],
      scene: ['/sony/videoScreen', 'getSceneSetting', '1.0', []],
      recording: ['/sony/recording', 'getRecordingStatus', '1.0', []],
      playing: ['/sony/avContent', 'getPlayingContentInfo', '1.0', []]
    }, (r) => {
      const first = (x) => (x && Array.isArray(x.result) ? x.result[0] : null);
      const net = r.network && Array.isArray(r.network.result) && Array.isArray(r.network.result[0]) ? r.network.result[0][0] : null;
      const scene = first(r.scene);
      self.sendJSON(res, {
        success: true,
        tvOn: true,
        network: net ? { ip: net.ipAddrV4, netmask: net.netmask, gateway: net.gateway, mac: net.hwAddr, dns: net.dns, netif: net.netif } : null,
        wolEnabled: first(r.wol) ? first(r.wol).enabled === true : null,
        powerSavingMode: first(r.powerSaving) ? first(r.powerSaving).mode : null,
        tvTime: first(r.time),
        pictureMode: scene ? (scene.currentValue || scene.current || null) : null,
        pictureModes: scene && Array.isArray(scene.candidate) ? scene.candidate.map((c) => c.value) : [],
        recordingStatus: first(r.recording) ? first(r.recording).status : null,
        playing: first(r.playing),
        usbRecordingDrive: !!self._hasRecStorage,
        remoteKeys: self._irccCodes ? Object.keys(self._irccCodes).length : 0
      });
    });
  }

  // GET /api/recordings — recordings on the TV's USB drive (live), scheduled
  // recordings and history. Available only when a USB drive is connected.
  apiRecordings(req, res) {
    const self = this;
    if (!this.power) return this.sendJSON(res, { success: true, tvOn: false, usb: !!self._hasRecStorage });
    this.detectRecStorage((present) => {
      if (!present) return self.sendJSON(res, { success: true, tvOn: true, usb: false });
      const list = [];
      const page = (stIdx) => {
        const v = self.getApiVersion('getContentList', '1.0');
        const prm = compareVersions(v, '1.5') >= 0 ? { uri: 'usb:recStorage', stIdx: stIdx, cnt: 50 } : { source: 'usb:recStorage', stIdx: stIdx, cnt: 50 };
        self.tvCall('/sony/avContent', 'getContentList', v, [prm], (err, result) => {
          const rows = !err && result && Array.isArray(result[0]) ? result[0] : [];
          rows.forEach((x) => list.push(x));
          if (rows.length === 50 && stIdx < 1000) return page(stIdx + 50);
          self.tvCalls({
            status: ['/sony/recording', 'getRecordingStatus', '1.0', []],
            schedules: ['/sony/recording', 'getScheduleList', '1.0', [{ stIdx: 0, cnt: 100 }]],
            history: ['/sony/recording', 'getHistoryList', '1.0', [{ stIdx: 0, cnt: 50 }]]
          }, (r) => {
            const arr = (x) => (x && Array.isArray(x.result) && Array.isArray(x.result[0]) ? x.result[0] : []);
            self._lastRecList = list.map((x) => ({ uri: x.uri, isProtected: x.isProtected === true }));
            self.sendJSON(res, {
              success: true, tvOn: true, usb: true,
              status: r.status && r.status.result ? r.status.result[0].status : null,
              recordings: list.map((x) => ({
                uri: x.uri, title: x.title, channelName: x.channelName || '', startDateTime: x.startDateTime || '',
                durationSec: x.durationSec || 0, isAlreadyPlayed: x.isAlreadyPlayed === true, isProtected: x.isProtected === true
              })),
              schedules: arr(r.schedules),
              history: arr(r.history)
            });
          });
        });
      };
      page(0);
    });
  }

  // POST /api/recordings/{play|protect|delete} — body { uri, isProtected? }.
  // Only recordings on the TV's USB drive (usb:recStorage URIs) are accepted.
  apiRecordingAction(req, res, action) {
    const self = this;
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let p;
      try { p = JSON.parse(body || '{}'); } catch (e) { return self.sendJSON(res, { success: false, message: 'Invalid JSON' }); }
      const uri = typeof p.uri === 'string' ? p.uri : '';
      if (uri.indexOf('usb:recStorage?') !== 0) return self.sendJSON(res, { success: false, message: 'Not a recording' });
      if (!self.power && action !== 'play') return self.sendJSON(res, { success: false, message: 'Switch the TV on first' });
      const done = (err) => {
        if (err) return self.sendJSON(res, { success: false, message: err });
        self.log('[' + self.name + '] Recording ' + action + ': ' + uri);
        self.sendJSON(res, { success: true });
      };
      if (action === 'play') {
        // setPlayContent with canTurnTvOn: wakes the TV first if needed.
        self.setPlayContent(uri);
        return self.sendJSON(res, { success: true });
      }
      if (action === 'protect') return self.tvCall('/sony/avContent', 'setDeleteProtection', '1.0', [{ uri: uri, isProtected: p.isProtected === true }], (e) => {
        if (!e) (self._lastRecList || []).forEach((x) => { if (x.uri === uri) x.isProtected = p.isProtected === true; });
        done(e);
      });
      if (action === 'delete') {
        const known = (self._lastRecList || []).find((x) => x.uri === uri);
        if (known && known.isProtected) return self.sendJSON(res, { success: false, message: 'Protected recording: remove the protection first' });
        return self.tvCall('/sony/avContent', 'deleteContent', '1.0', [{ uri: uri }], (e) => {
          done(e);
          // A deleted recording that is also a HomeKit input disappears at the next scan.
          if (!e && (self.recordingsAccessory || (self.uriToInputSource && self.uriToInputSource.get(uri)))) setTimeout(() => self.receiveSources(true), 3000);
        });
      }
      self.sendJSON(res, { success: false, message: 'Unknown action' });
    });
  }

  // v1.4.22: pairing cookie validity for the web UI (no secret values).
  cookieStatus() {
    if (!isNull(this.psk)) return { mode: 'psk' };
    const m = this.cookieMeta || {};
    const left = this.cookieDaysLeft();
    return {
      mode: 'cookie',
      present: !!this.cookie,
      daysLeft: left === null ? null : Math.round(left * 10) / 10,
      expiresAt: m.expiresAt || null,
      obtainedAt: m.obtainedAt || null,
      estimated: m.estimated === true,
      lastRenewAttempt: m.lastRenewAttempt || null,
      lastRenewOk: m.lastRenewOk || null,
      lastRenewResult: m.lastRenewResult || null,
      autoRenew: !m.renewBlocked,
      refused: this.authok !== true && !!this.cookie,
      awaitingPin: this.awaitingPin === true
    };
  }

  // v1.4.21: compact status for the web UI header (no secrets).
  getUiStatus() {
    var cookieExists = false;
    try { cookieExists = fs.existsSync(this.cookiepath); } catch (e) {}
    var hasCookieInMemory = (!!this.cookie && String(this.cookie).length > 0);
    var paired = (this.awaitingPin !== true) && ((this.authok === true) || cookieExists || hasCookieInMemory);
    var iface = this.capabilities.interface || {};
    var sys = this.capabilities.system || {};
    if (!SonyTV._pkgVersion) {
      try { SonyTV._pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; } catch (e) { SonyTV._pkgVersion = ''; }
    }
    return {
      success: true,
      pluginVersion: SonyTV._pkgVersion,
      tv: {
        name: this.name,
        ip: this.ip,
        model: sys.model || iface.modelName || '',
        productName: iface.productName || '',
        interfaceVersion: iface.interfaceVersion || '',
        generation: sys.generation || '',
        serial: sys.serial || ''
      },
      power: this.power === true,
      authMode: isNull(this.psk) ? 'cookie' : 'psk',
      paired: paired,
      authenticated: this.authok === true,
      awaitingPin: this.awaitingPin === true,
      homekitInputs: this.channelServices ? this.channelServices.length : 0,
      tiles: { apps: this.appsAccessory, recordings: this.recordingsAccessory, functions: this.functionsAccessory },
      cookie: this.cookieStatus(),
      maxInputSources: this.maxInputSources,
      channelSelector: this.enableChannelSelector,
      externalAccessory: this.accessory && this.accessory.context ? this.accessory.context.isexternal === true : false,
      apiVersions: this.capabilities.apiVersions || {},
      detectedAt: this.capabilities.detectedAt || null
    };
  }

  setupVolumeAccessory() {
    const that = this;
    if (!that.volumeAccessory) return;

    const volName = that.name + ' Volume';
    const uuid = UUIDGen.generate(that.name + '-SonyTV-Volume');
    const acc = new Accessory(volName, uuid, that.platform.api.hap.Categories.LIGHTBULB);

    const bulb = new Service.Lightbulb(volName);

    // On/Off → mute/unmute
    bulb.getCharacteristic(Characteristic.On)
      .on('get', (callback) => {
        that.getMuted((err, muted) => {
          callback(null, !muted); // On=true means NOT muted
        });
      })
      .on('set', (value, callback) => {
        that.setMuted(!value, callback); // On=true means unmute
      });

    // Brightness 0-100 → volume 0-100
    bulb.getCharacteristic(Characteristic.Brightness)
      .on('get', (callback) => {
        that.getVolume(callback);
      })
      .on('set', (value, callback) => {
        that.setVolume(value, callback);
      });

    acc.addService(bulb);
    that.volumeAccessoryInstance = acc;
    that.platform.api.publishExternalAccessories('homebridge-bravia-enhanced', [acc]);
    // v1.4.21: log the HomeKit ID (issue #7). The ID is derived from the TV
    // name: after renaming or re-adding a TV, an old pairing kept by Homebridge
    // for the same ID makes the Home app answer "Accessory already in another
    // home". Knowing the ID lets the user remove exactly that pairing in
    // Homebridge UI → Settings → "Unpair Bridges / Cameras / TVs / External Accessories".
    that.log('[' + that.name + '] 🔊 Volume accessory published: ' + volName + ' (HomeKit ID ' + homeKitIdFor(uuid) + ')');
  }

  // v1.4.21: optional external accessory "<name> Controls" with one switch per
  // picture mode (mutually exclusive; switching one off returns to "auto") and
  // a "Screen off" switch (power saving: picture off, sound keeps playing).
  setupControlsAccessory() {
    const that = this;
    if (!that.controlsAccessory) return;
    const accName = that.name + ' Controls';
    const uuid = UUIDGen.generate(that.name + '-SonyTV-Controls');
    const acc = new Accessory(accName, uuid, that.platform.api.hap.Categories.SWITCH);
    const pretty = (v) => v.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
    that._sceneSwitches = {};
    const revert = (sw, val) => setTimeout(() => sw.updateCharacteristic(Characteristic.On, val), 800);

    that.controlsScenes.forEach((scene) => {
      const label = 'Picture ' + pretty(scene);
      const sw = new Service.Switch(label, 'scene-' + scene);
      if (Characteristic.ConfiguredName) { try { sw.setCharacteristic(Characteristic.ConfiguredName, label); } catch (e) {} }
      sw.getCharacteristic(Characteristic.On).on('set', (value, callback) => {
        callback(null);
        if (!that.power) { revert(sw, false); return; }
        const target = value ? scene : 'auto';
        that.tvCall('/sony/videoScreen', 'setSceneSetting', '1.0', [{ value: target }], (err) => {
          if (err) {
            that.log.warn('[' + that.name + '] Picture mode "' + target + '" not accepted by the TV: ' + err);
            revert(sw, !value);
            return;
          }
          that.log('[' + that.name + '] 🎬 Picture mode: ' + target);
          that._applySceneState(target);
        });
      });
      acc.addService(sw);
      that._sceneSwitches[scene] = sw;
    });

    const scr = new Service.Switch('Screen off', 'screen-off');
    if (Characteristic.ConfiguredName) { try { scr.setCharacteristic(Characteristic.ConfiguredName, 'Screen off'); } catch (e) {} }
    scr.getCharacteristic(Characteristic.On).on('set', (value, callback) => {
      callback(null);
      if (!that.power) { revert(scr, false); return; }
      that.tvCall('/sony/system', 'setPowerSavingMode', '1.0', [{ mode: value ? 'pictureOff' : 'off' }], (err) => {
        if (err) {
          that.log.warn('[' + that.name + '] Screen off not accepted by the TV: ' + err);
          revert(scr, !value);
          return;
        }
        that.log('[' + that.name + '] 🖥️ Screen ' + (value ? 'off (audio only)' : 'on'));
      });
    });
    acc.addService(scr);
    that._screenOffSwitch = scr;

    that.controlsAccessoryInstance = acc;
    that.platform.api.publishExternalAccessories('homebridge-bravia-enhanced', [acc]);
    that.log('[' + that.name + '] 🎛️ Controls accessory published: ' + accName + ' (HomeKit ID ' + homeKitIdFor(uuid) + ')');
  }

  _applySceneState(current) {
    if (!this._sceneSwitches) return;
    Object.keys(this._sceneSwitches).forEach((k) => {
      this._sceneSwitches[k].updateCharacteristic(Characteristic.On, !!this.power && k === current);
    });
  }

  // Refresh the Controls switches from the TV (called from the status loop).
  syncControlsAccessory(force) {
    if (!this.controlsAccessoryInstance) return;
    if (!this.power) {
      this._applySceneState(null);
      if (this._screenOffSwitch) this._screenOffSwitch.updateCharacteristic(Characteristic.On, false);
      return;
    }
    const now = Date.now();
    if (!force && this._lastControlsSync && now - this._lastControlsSync < 30000) return;
    this._lastControlsSync = now;
    this.tvCall('/sony/videoScreen', 'getSceneSetting', '1.0', [], (err, r) => {
      if (!err && r && r[0]) this._applySceneState(r[0].currentValue || r[0].current || null);
    });
    this.tvCall('/sony/system', 'getPowerSavingMode', '1.0', [], (err, r) => {
      if (!err && r && r[0] && this._screenOffSwitch) this._screenOffSwitch.updateCharacteristic(Characteristic.On, r[0].mode === 'pictureOff');
    });
  }

  // ── v1.4.21: separate Home tiles for apps, recordings and TV functions ──────
  _kindOf(ch) {
    const uri = String(ch[1] || '');
    if (uri.indexOf('ircc:') === 0) return 'fn';
    if (uri.indexOf('usb:recStorage') === 0) return 'rec';
    if (ch[2] === Characteristic.InputSourceType.APPLICATION) return 'app';
    return 'main';
  }

  // Channels that stay on the main TV tile.
  _mainTvChannels(list) {
    if (!this.appsAccessory && !this.recordingsAccessory && !this.functionsAccessory) return list;
    return (list || []).filter((ch) => {
      const k = this._kindOf(ch);
      if (k === 'app') return !this.appsAccessory;
      if (k === 'rec') return !this.recordingsAccessory;
      if (k === 'fn') return !this.functionsAccessory;
      return true;
    });
  }

  _readFullScanCache() {
    try {
      const c = JSON.parse(fs.readFileSync(this.fullScanCachePath, 'utf8'));
      if (c && c.recMeta && !this._recMeta) this._recMeta = c.recMeta;
      return Array.isArray(c.channels) ? c.channels : [];
    } catch (e) { return []; }
  }

  // At start: build the tiles from the last scan, so they exist (with their
  // entries) even when the TV is off.
  _initSideAccessories() {
    if (!this.appsAccessory && !this.recordingsAccessory && !this.functionsAccessory) return;
    const full = this._readFullScanCache();
    const selUris = this.getSelectedChannelUris();
    const picked = selUris.length ? this.getSelectedChannelsFromList(full, selUris) : full;
    this._refreshSideAccessories(full, picked);
  }

  // full: everything the TV offers; picked: the user's selection.
  // Apps and functions: the selected ones (all of them when none is selected).
  // Recordings: all of them, newest first (they change often).
  _refreshSideAccessories(full, picked) {
    try {
      full = Array.isArray(full) ? full : [];
      picked = Array.isArray(picked) ? picked : [];
      // v1.4.22: an empty scan (TV refused the requests, timed out…) must
      // never empty the tiles. Keep what they show until a real answer.
      if (full.length === 0) {
        if (this.debug) this.log('[' + this.name + '] Empty scan: separate tiles left unchanged');
        return;
      }
      const of = (arr, k) => arr.filter((c) => this._kindOf(c) === k);
      const hasReal = (kind) => this._sides && this._sides[kind] && Array.from(this._sides[kind].inputs.keys()).some((u) => u.indexOf('placeholder:') !== 0);
      if (this.appsAccessory) {
        const sel = of(picked, 'app');
        const list = sel.length ? sel : of(full, 'app');
        // The app list comes from a separate request: if it failed, keep the tile.
        if (list.length || !hasReal('apps')) this._updateSideTv('apps', list);
      }
      if (this.recordingsAccessory && (of(full, 'rec').length > 0 || this._hasRecStorage === false || !hasReal('recs'))) {
        const meta = this._recMeta || {};
        const recs = of(full, 'rec').slice().sort((a, b) => String((meta[b[1]] || {}).startDateTime || '').localeCompare(String((meta[a[1]] || {}).startDateTime || '')));
        // Several recordings of the same programme: add the date to tell them apart.
        const count = {};
        recs.forEach((c) => { count[c[0]] = (count[c[0]] || 0) + 1; });
        this._updateSideTv('recs', recs.map((c) => {
          const m = meta[c[1]] || {};
          const d = /^(\d{4})-(\d\d)-(\d\d)/.exec(m.startDateTime || '');
          return [count[c[0]] > 1 && d ? c[0] + ' ' + d[3] + '-' + d[2] + '-' + d[1] : c[0], c[1], c[2]];
        }));
      }
      if (this.functionsAccessory) {
        const sel = of(picked, 'fn');
        const list = sel.length ? sel : of(full, 'fn');
        if (list.length || !(this._fnSide && this._fnSide.sw.size)) this._updateFunctions(list);
      }
    } catch (e) {
      this.log.warn('[' + this.name + '] Could not update the separate Home tiles: ' + (e && e.stack ? e.stack : e));
    }
  }

  // HAP-safe display name (the Name characteristic must start and end with a
  // letter or digit); the full title stays in ConfiguredName.
  _hapName(s) {
    let n = String(s || '').replace(/[^\p{L}\p{N} '.,\-&()]/gu, ' ').replace(/\s+/g, ' ').trim();
    n = n.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    return (n || 'Input').slice(0, 64).trim();
  }

  _sideIdsPath(kind) { return STORAGE_PATH + '/sonytv-' + kind + '-' + this.name + '.json'; }

  _sideTv(kind) {
    this._sides = this._sides || {};
    if (this._sides[kind]) return this._sides[kind];
    const accName = this.name + ' ' + (kind === 'apps' ? 'Apps' : 'Recordings');
    const uuid = UUIDGen.generate(this.name + '-SonyTV-' + kind);
    const acc = new Accessory(accName, uuid, this.platform.api.hap.Categories.TELEVISION);
    const info = acc.getService(Service.AccessoryInformation);
    if (info) info.setCharacteristic(Characteristic.Manufacturer, 'Sony').setCharacteristic(Characteristic.Model, (this.capabilities.system && this.capabilities.system.model) || 'Bravia');
    const tv = new Service.Television(accName, 'tv-' + kind);
    tv.setCharacteristic(Characteristic.ConfiguredName, accName);
    tv.setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
    tv.getCharacteristic(Characteristic.Active)
      .on('get', (cb) => cb(null, this.power ? 1 : 0))
      .on('set', (v, cb) => this.setPowerState(v, cb));
    const side = { kind: kind, acc: acc, tv: tv, inputs: new Map(), byId: new Map(), ids: {}, published: false, name: accName };
    try { side.ids = JSON.parse(fs.readFileSync(this._sideIdsPath(kind), 'utf8')) || {}; } catch (e) { side.ids = {}; }
    tv.setCharacteristic(Characteristic.ActiveIdentifier, 0);
    tv.getCharacteristic(Characteristic.ActiveIdentifier)
      .on('get', (cb) => cb(null, this._sideActiveId(side)))
      .on('set', (id, cb) => {
        cb(null);
        const uri = side.byId.get(id);
        if (!uri) return; // placeholder entry
        this.currentUri = uri;
        if (kind === 'apps') this.setActiveApp(uri);
        else this.setPlayContent(uri);
      });
    tv.getCharacteristic(Characteristic.RemoteKey).on('set', this.setRemoteKey.bind(this));
    tv.getCharacteristic(Characteristic.PowerModeSelection).on('set', (v, cb) => { this.sendRemoteFunction('Options'); cb(null); });
    acc.addService(tv);
    this._sides[kind] = side;
    return side;
  }

  _sideActiveId(side) {
    const u = this.currentUri;
    if (!u || !this.power) return 0;
    for (const [id, uri] of side.byId) { if (uri === u) return id; }
    return 0;
  }

  _updateSideTv(kind, list) {
    const side = this._sideTv(kind);
    const PLACEHOLDER = 'placeholder:' + kind;
    let want = list.slice(0, MAX_HOMEKIT_INPUTS);
    if (want.length === 0) {
      // A TV tile with no inputs looks broken in Home: show why it is empty.
      want = [[kind === 'apps' ? 'No apps' : 'No recordings', PLACEHOLDER, Characteristic.InputSourceType.OTHER]];
    }
    const wantUris = new Set(want.map((c) => c[1]));
    let changed = false;
    side.inputs.forEach((svc, uri) => {
      if (wantUris.has(uri)) return;
      side.tv.removeLinkedService(svc);
      side.acc.removeService(svc);
      side.inputs.delete(uri);
      side.byId.delete(svc.getCharacteristic(Characteristic.Identifier).value);
      changed = true;
    });
    const used = new Set(Object.keys(side.ids).map((u) => side.ids[u]));
    let next = 1;
    want.forEach((c) => {
      const uri = c[1];
      const label = String(c[0] || uri).slice(0, 64);
      const ex = side.inputs.get(uri);
      if (ex) {
        if (ex.getCharacteristic(Characteristic.ConfiguredName).value !== label) ex.updateCharacteristic(Characteristic.ConfiguredName, label);
        return;
      }
      let id = uri === PLACEHOLDER ? 9999 : side.ids[uri];
      if (!id) {
        while (used.has(next)) next++;
        id = next; used.add(id); side.ids[uri] = id;
      }
      const type = kind === 'apps' ? Characteristic.InputSourceType.APPLICATION : Characteristic.InputSourceType.OTHER;
      const svc = new Service.InputSource(this._hapName(label), uri);
      svc.setCharacteristic(Characteristic.Identifier, id)
        .setCharacteristic(Characteristic.ConfiguredName, label)
        .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(Characteristic.InputSourceType, type)
        .setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
      try { side.acc.addService(svc); } catch (e) { this.log.warn('[' + this.name + '] Cannot add "' + label + '" to ' + side.name + ': ' + e.message); return; }
      side.tv.addLinkedService(svc);
      side.inputs.set(uri, svc);
      if (uri !== PLACEHOLDER) side.byId.set(id, uri);
      changed = true;
    });
    if (changed) {
      try { fs.writeFileSync(this._sideIdsPath(kind), JSON.stringify(side.ids)); } catch (e) {}
      const real = want.filter((c) => c[1] !== PLACEHOLDER).length;
      this.log('[' + this.name + '] ' + (kind === 'apps' ? '📱' : '📼') + ' ' + side.name + ': ' + real + ' ' + (kind === 'apps' ? 'apps' : 'recordings'));
    }
    if (!side.published) {
      side.published = true;
      this.platform.api.publishExternalAccessories('homebridge-bravia-enhanced', [side.acc]);
      this.log('[' + this.name + '] Published ' + side.name + ' (HomeKit ID ' + homeKitIdFor(side.acc.UUID) + ')');
    }
  }

  // "<name> Functions": one momentary button (switch that turns itself off)
  // per remote function.
  _updateFunctions(list) {
    if (!this._fnSide) {
      const accName = this.name + ' Functions';
      const uuid = UUIDGen.generate(this.name + '-SonyTV-functions');
      this._fnSide = { acc: new Accessory(accName, uuid, this.platform.api.hap.Categories.SWITCH), sw: new Map(), published: false, name: accName };
    }
    const side = this._fnSide;
    const want = new Map(list.map((c) => [c[1], c[0]]));
    let changed = false;
    side.sw.forEach((svc, uri) => {
      if (want.has(uri)) return;
      side.acc.removeService(svc); side.sw.delete(uri); changed = true;
    });
    want.forEach((label, uri) => {
      if (side.sw.has(uri)) return;
      const key = uri.slice(5);
      const svc = new Service.Switch(this._hapName(label), 'fn-' + key);
      if (Characteristic.ConfiguredName) { try { svc.setCharacteristic(Characteristic.ConfiguredName, label); } catch (e) {} }
      svc.getCharacteristic(Characteristic.On)
        .on('get', (cb) => cb(null, false))
        .on('set', (v, cb) => {
          cb(null);
          if (v) {
            if (this.power) this.sendRemoteFunction(key);
            setTimeout(() => svc.updateCharacteristic(Characteristic.On, false), 1000);
          }
        });
      try { side.acc.addService(svc); } catch (e) { return; }
      side.sw.set(uri, svc); changed = true;
    });
    if (changed) this.log('[' + this.name + '] 🔘 ' + side.name + ': ' + Array.from(want.values()).join(', '));
    if (!side.published && side.sw.size > 0) {
      side.published = true;
      this.platform.api.publishExternalAccessories('homebridge-bravia-enhanced', [side.acc]);
      this.log('[' + this.name + '] Published ' + side.name + ' (HomeKit ID ' + homeKitIdFor(side.acc.UUID) + ')');
    }
  }

  // Keep the separate TV tiles' on/off and current entry in step with the TV.
  _syncSideState() {
    if (!this._sides) return;
    Object.keys(this._sides).forEach((k) => {
      const side = this._sides[k];
      side.tv.updateCharacteristic(Characteristic.Active, this.power ? 1 : 0);
      side.tv.updateCharacteristic(Characteristic.ActiveIdentifier, this._sideActiveId(side));
    });
  }

  updateStatus() {
    var that = this;
    // v1.4.13: adaptive polling — fast post-wake, slower in standby, normal when ON
    var interval = that._currentPollInterval();
    if (this.debug) this.log('[' + this.name + '] Polling status, next in ' + interval + 'ms (power=' + this.power + ', sinceWake=' + (this.recentlyWokenAt ? (Date.now() - this.recentlyWokenAt) + 'ms' : 'n/a') + ')');
    setTimeout(function () {
      that.getPowerState(null);
      that.pollPlayContent();
      that.pollExternalInputsStatus();
      // v1.4.21: safety net — TV is on but the cookie registration never
      // succeeded (e.g. transient error at boot). Throttled inside.
      if (that.power === true && that.authok !== true) {
        that._requestReRegistration('TV is on but not authenticated');
      }
      if (that.authok === true || that.power !== true) that.syncControlsAccessory(false);
      that._syncSideState();
      that._maybeRenewCookie(false);
      that.updateStatus();
    }, interval);
  }
  // Check if we already registered with the TV and authenticate if needed
  checkRegistration() {
    const self = this;
    // v1.4.21: every registration attempt (boot, web UI, retry) is timestamped
    // so _requestReRegistration() never overlaps a call already in flight.
    this._lastRegistrationAttempt = Date.now();
    if (this.debug) this.log('[' + this.name + '] checkRegistration() called');

    // PSK mode: authentication is handled by the X-Auth-PSK header on every request.
    // No cookie-based pairing (actRegister) is needed. Mark as authenticated and
    // proceed directly to channel scanning.
    if (!isNull(this.psk)) {
      if (this.debug) this.log('[' + this.name + '] 🔑 PSK mode: skipping actRegister (authentication via X-Auth-PSK header)');
      this.authok = true;
      this.awaitingPin = false;
      this.registercheck = true;

      const _rIp     = getLocalIp();
      const _rPort   = self.serverPort;
      const _rIpBase = (_rIp ? 'http://' + _rIp : 'http://' + os.hostname()) + ':' + _rPort;
      self.log('[' + self.name + '] ✓ PSK authentication active');
      if (self.enableChannelSelector) {
        self.log('[' + self.name + '] ✅ Channel Selector: ' + _rIpBase + '/');
      }
      self.probeSystemInfo();
      self.receiveSources(true);
      return;
    }

    if (this.debug) this.log('[' + this.name + '] registercheck: ' + this.registercheck + ', authok: ' + this.authok);
    if (this.debug) this._logStateDump('checkRegistration entry');

    this.registercheck = true;
    var clientId = 'HomeBridge-Bravia' + ':' + this.accessory.context.uuid;
    var actRegisterVersion = this.getApiVersion('actRegister', '1.0');
    // Sony Bravia REST API actRegister payload structure:
    //
    //   First param object: {clientid, nickname, level}
    //   Second param array: [{function, value}]
    //
    // The "level":"private" field in the first object is required on Bravia XR
    // firmware (interface v6.x and above, e.g. K-55XR8M2) and ignored on older
    // firmware that does not declare it (e.g. KD-55X9005B with interface v2.5.0).
    //
    // The inner WOL object MUST contain only "function" and "value" as declared
    // by the schema returned by getMethodTypes. Older Bravia firmware tolerates
    // extra fields (clientid, nickname) inside this object, but Bravia XR firmware
    // rejects payloads with extra fields, returning error [1] "Internal Server Error".
    // The cleaner two-field form is what Sony's TV SideView app, the python-bravia-tv
    // library and the breunigs/bravia-auth-and-remote reference implementation all
    // use, and is verified to work on every Sony Bravia generation supported by
    // the plugin.
    var post_data = '{"id":8,"method":"actRegister","version":"' + actRegisterVersion + '","params":[{"clientid":"' + clientId + '","nickname":"homebridge","level":"private"},[{"value":"yes","function":"WOL"}]]}';

    if (this.debug) {
      this.log('[' + this.name + '] 🔑 PAIRING TRACE: clientId=' + clientId);
      this.log('[' + this.name + '] 🔑 PAIRING TRACE: actRegister version selected=' + actRegisterVersion + ' (from capabilities or default)');
      this.log('[' + this.name + '] 🔑 PAIRING TRACE: TV endpoint=http://' + this.ip + ':' + this.port + '/sony/accessControl');
      this.log('[' + this.name + '] 🔑 PAIRING TRACE: cookie before request=' + this._sanitize(this.cookie, 'cookie'));
    }
    if (this.debug) this.log('[' + this.name + '] Sending registration check to ' + this.ip);
    
    var onError = function (err) {
      self._lastRegistrationUnreachable = true;
      self.log('[' + self.name + '] Auth error: ' + err);
      if (self.debug) {
        self.log('[' + self.name + '] 🔑 PAIRING TRACE: network/transport error during actRegister: ' + err);
        self.log('[' + self.name + '] 🔑 PAIRING TRACE: this typically means the TV is unreachable at ' + self.ip + ':' + self.port + ' (off, wrong IP, firewall blocking, or interface mismatch)');
      }
      return false;
    };
    
    var onSucces = function (chunk) {
      self._lastRegistrationUnreachable = false;
      if (self.debug) self.log('[' + self.name + '] Auth response received');
      if (self.debug) self.log('[' + self.name + '] 🔑 PAIRING TRACE: TV response body=' + chunk);
      // Try to parse and log structured info
      if (self.debug) {
        try {
          const parsed = JSON.parse(chunk);
          if (parsed.error) {
            self.log('[' + self.name + '] 🔑 PAIRING TRACE: error code=' + parsed.error[0] + ' message=' + parsed.error[1]);
            self.log('[' + self.name + '] 🔑 PAIRING TRACE: meaning of common codes: 1=Internal Server Error (often method/version mismatch), 14=Illegal Argument, 401=Auth required (PIN), 403=Forbidden, 404=Method Not Found, 12=Method Not Implemented at this version');
          } else if (parsed.result !== undefined) {
            self.log('[' + self.name + '] 🔑 PAIRING TRACE: success result=' + JSON.stringify(parsed.result));
          }
        } catch (e) {
          self.log('[' + self.name + '] 🔑 PAIRING TRACE: response is not valid JSON');
        }
        self.log('[' + self.name + '] 🔑 PAIRING TRACE: cookie after request=' + self._sanitize(self.cookie, 'cookie'));
      }
      if (chunk.indexOf('"error"') >= 0) {
        if (self.debug)
          self.log('[' + self.name + '] Auth error in response: ' + chunk);
      }
      if (chunk.indexOf('[]') < 0) {
        self.log('[' + self.name + '] Pairing required');
        // If the user removed pairing on the TV side, an old cookie may still exist on disk.
        // In that case, clear it so the UI does not incorrectly report "Already paired".
        try {
          const hadCookie = (!!self.cookie && String(self.cookie).length > 0) || fs.existsSync(self.cookiepath);
          if (hadCookie) {
            self.cookie = null;
            try { fs.unlinkSync(self.cookiepath); } catch (e) {}
            self.log('[' + self.name + '] ⚠️  Stored cookie rejected by TV — pairing required again');
          }
        } catch (e) {}

        const _rIp     = getLocalIp();
        const _rSuffix = getDomainSuffix();
        const _rPort   = self.serverPort;
        const _rIpBase = (_rIp ? 'http://' + _rIp : 'http://' + os.hostname()) + ':' + _rPort;
        const _rDnBase = _rSuffix ? 'http://' + os.hostname() + _rSuffix + ':' + _rPort : null;
        self.log('Please enter the PIN that appears on your TV at ' + _rIpBase + '/pair?tv=' + encodeURIComponent(self.name));
        self.awaitingPin = true;
        self.authok = false;
        // The permanent web server hosts the pairing page.
        self.log('[' + self.name + '] 🔑 Pairing: ' + _rIpBase + '/pair?tv=' + encodeURIComponent(self.name));
        if (_rDnBase) self.log('[' + self.name + '] 🔑 Also try: ' + _rDnBase + '/pair?tv=' + encodeURIComponent(self.name));
        if (self.enableChannelSelector) {
          self.log('[' + self.name + '] 📺 Channels: ' + _rIpBase + '/  (available after pairing)');
        }
      } else {
        const _rIp     = getLocalIp();
        const _rSuffix = getDomainSuffix();
        const _rPort   = self.serverPort;
        const _rIpBase = (_rIp ? 'http://' + _rIp : 'http://' + os.hostname()) + ':' + _rPort;
        const _rDnBase = _rSuffix ? 'http://' + os.hostname() + _rSuffix + ':' + _rPort : null;
        self.log('[' + self.name + '] ✓ Paired successfully');
        self.authok = true;
        self.awaitingPin = false;
        self.pwd = null; // v1.4.22: the PIN is single-use; never re-send it
        if (self.enableChannelSelector) {
          self.log('[' + self.name + '] ✅ Channel Selector: ' + _rIpBase + '/');
          if (_rDnBase) self.log('[' + self.name + '] ✅ Also try: ' + _rDnBase + '/');
        }
        if (self.debug) self.log('[' + self.name + '] Starting channel scan');
        self.probeSystemInfo(); // detect device info after auth (API versions are already probed at boot)
        self.receiveSources(true);
      }
    };
    self.makeHttpRequest(onError, onSucces, '/sony/accessControl/', post_data, false);
  }
  // Creates HomeKit service for TV input source (channel, HDMI, app, etc.)
  addInputSource(name, uri, type, configuredName = null, identifier = null) {
    if (this.debug) this.log('[' + this.name + '] addInputSource called for: ' + name);
    if (this.debug) this.log('[' + this.name + '] URI: ' + uri + ', Type: ' + type);
    
    // FIXME: Using subtype to store URI, hack!
    if (identifier === null) {
      if (type === Characteristic.InputSourceType.TUNER) {
        // TV channels: keep identifiers stable and away from HDMI/App ids.
        // v1.4.21: skip identifiers already in use or retired. After a
        // restart the counter restarts at 1 while restored channels already
        // own 1001, 1002…, so a newly added channel used to collide with them.
        var _retired = this._retiredIdentifiers || new Set();
        while (this.inputSourceMap.has(TV_IDENTIFIER_BASE + this.tvChannelCounter) || _retired.has(TV_IDENTIFIER_BASE + this.tvChannelCounter)) {
          this.tvChannelCounter += 1;
        }
        identifier = TV_IDENTIFIER_BASE + this.tvChannelCounter;
        this.tvChannelCounter += 1;
        if (this.debug) this.log('[' + this.name + '] Using TV-range identifier ' + identifier + ' for: ' + name);
      } else {
        identifier = this.getFreeIdentifier();
        if (this.debug) this.log('[' + this.name + '] Using sequential identifier ' + identifier + ' for: ' + name);
      }
    } else {
      // If a provided identifier collides, fall back to a free one.
      if (this.inputSourceMap && this.inputSourceMap.has(identifier)) {
        if (this.debug) this.log('[' + this.name + '] ⚠️ Provided identifier ' + identifier + ' already in use. Using sequential for: ' + name);
        identifier = this.getFreeIdentifier();
      }
      if (this.debug) this.log('[' + this.name + '] Using provided identifier ' + identifier + ' for: ' + name);
    }
    

    
    if (configuredName === null)
      configuredName = name;
      
    if (this.debug) this.log('[' + this.name + '] Creating InputSource service with identifier=' + identifier);
    var inputSource = new Service.InputSource(name, uri); // displayname, subtype?
    inputSource.setCharacteristic(Characteristic.Identifier, identifier)
      .setCharacteristic(Characteristic.ConfiguredName, configuredName)
      .setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN)
      .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
      .setCharacteristic(Characteristic.InputSourceType, type);

    // v1.4.21: add to the accessory FIRST. If HAP refuses the service (e.g. the
    // 100-services limit) nothing below runs, so channelServices, the maps and
    // the TV linked services stay consistent with what HomeKit really has.
    try {
      this.accessory.addService(inputSource);
    } catch (e) {
      this.log('[' + this.name + '] ⚠️  Cannot add input "' + name + '": ' + (e && e.message ? e.message : e));
      return false;
    }
    this.channelServices.push(inputSource);
    this.tvService.addLinkedService(inputSource);
    this.uriToInputSource.set(uri, inputSource);
    // Also map a normalized key to handle URI variations returned by getPlayingContentInfo
    this.uriToInputSource.set(this.normalizeUri(uri), inputSource);
    this.inputSourceMap.set(identifier, inputSource);
    if (this.debug) this.log('[' + this.name + '] ✓ Added input ' + name + ' with identifier ' + identifier);
    return true;
  }
  haveChannel(source) {
    return this.scannedChannels.find(channel => (
      (source.subtype == channel[1]) &&
      (source.getCharacteristic(Characteristic.InputSourceType).value == channel[2])
    )) !== undefined;
  }
  haveInputSource(name, uri, type) {
    return this.channelServices.find(source => (
      (source.subtype == uri) &&
      (source.getCharacteristic(Characteristic.InputSourceType).value == type)
    )) !== undefined;
  }
  // save channels to file for external accessories
  // Save scanned channels to file cache for external accessories
  saveChannelsToFile() {
    if (this.debug) this.log('[' + this.name + '] saveChannelsToFile() called');
    if (this.debug) this.log('[' + this.name + '] channelServices count: ' + this.channelServices.length);
    
    const storeObject = [];
    this.channelServices.forEach(service => {
      storeObject.push({
        identifier: service.getCharacteristic(Characteristic.Identifier).value,
        name: service.getCharacteristic(Characteristic.Name).value,
        configuredName: service.getCharacteristic(Characteristic.ConfiguredName).value,
        uri: service.subtype,
        type: service.getCharacteristic(Characteristic.InputSourceType).value
      });
    });
    
    if (this.debug) this.log('[' + this.name + '] Prepared ' + storeObject.length + ' channels to save');
    
    try {
      const data = JSON.stringify(storeObject);
      const channelsPath = STORAGE_PATH + '/sonytv-channels-' + this.name + '.json';
      fs.writeFileSync(channelsPath, data);
      this.log('[' + this.name + '] ✓ Saved ' + storeObject.length + ' channels in external storage: ' + channelsPath);
      if (this.debug)
        this.log('[' + this.name + '] Channels saved to file');
    } catch (e) {
      this.log('[' + this.name + '] ERROR saving channels: ' + e);
    }
  }
  // load channels from file for external accessories
  loadChannelsFromFile() {
    const self = this;
    const channelsPath = STORAGE_PATH + '/sonytv-channels-' + this.name + '.json';
    if (this.debug) this.log('[' + this.name + '] Checking cache: ' + channelsPath);
    // If the user has saved a channel selection via the web UI, prefer that over the HomeKit cache.
    try {
      if (fs.existsSync(this.selectedChannelsPath)) {
        this.log('[' + this.name + '] Loading saved channel selection: ' + this.selectedChannelsPath);
        const sel = JSON.parse(fs.readFileSync(this.selectedChannelsPath, 'utf8'));
        if (sel && Array.isArray(sel.channels) && sel.channels.length > 0) {
          // Convert saved channel objects into internal scannedChannels tuples.
                    // Ensure each saved channel has a stable identifier; avoid using large extracted channel numbers.
          // Allocate TV channels in a dedicated range to avoid collisions with HDMI/App identifiers.
          let nonTvId = 1;
          let tvIdx = 1;
          let changed = false;
          sel.channels.forEach((ch) => {
            if (ch.identifier == null) {
              if (ch.sourceType === this.SOURCETYPE_TUNER || ch.sourceType === 2) {
                ch.identifier = TV_IDENTIFIER_BASE + tvIdx;
                tvIdx += 1;
              } else {
                ch.identifier = nonTvId;
                nonTvId += 1;
              }
              changed = true;
            }
          });
          if (changed) {
            try {
              fs.writeFileSync(this.selectedChannelsPath, JSON.stringify(sel, null, 2));
              if (this.debug) this.log('[' + this.name + '] Identifiers persisted to selection file');
            } catch (e) {}
          }
          // Convert saved channel objects into internal scannedChannels tuples.
          // tuple format: [name, uri, sourceType, identifier]
          this.scannedChannels = sel.channels.map(ch => [ch.name, ch.uri, ch.sourceType, ch.identifier]);
          // Rebuild services from selection
          this.channelServices = [];
          // IMPORTANT: keep Maps as real Map instances (HomeKit expects identifiers lookup)
          this.inputSourceMap = new Map();
          this.uriToInputSource = new Map();
          this.scannedChannels.forEach(function (source) {
            self.addInputSource(source[0], source[1], source[2], null, (source.length > 3 ? source[3] : null));
          });
          // Persist to the HomeKit cache too (so the normal cache path stays consistent)
          this.saveChannelsToFile();
          return;
        }
      }
    } catch (e) {
      this.log('[' + this.name + '] ERROR loading selection, falling back to cache: ' + e);
    }
    try {
      if (fs.existsSync(channelsPath)) {
        if (this.debug) this.log('[' + this.name + '] Loading channels from cache');
        const rawdata = fs.readFileSync(channelsPath);
        const storeObject = JSON.parse(rawdata);
        this.log('[' + this.name + '] Loaded ' + storeObject.length + ' channels from cache');
        storeObject.forEach(source => {
          self.scannedChannels.push([source.name, source.uri, source.type]);
          self.addInputSource(source.name, source.uri, source.type, source.configuredName, source.identifier);
        });
        if (this.debug)
          this.log('[' + this.name + '] Channels loaded from external storage');
        
        // CRITICAL: If accessory not yet registered, register it now with cached channels
        // This ensures TV is visible in HomeKit even when powered off at startup
        if (!this.accessory.context.isRegisteredInHomeKit) {
          if (this.debug) this.log('[' + this.name + '] Registering accessory with cached channels');
          this.syncAccessory();
        }
      } else {
        this.log('[' + this.name + '] No channel cache — will scan TV');
        // No cache, need to scan TV
        this.authok = true;
        this.receiveSources(true);
      }
    } catch (e) {
      this.log('[' + this.name + '] ERROR (cache): ' + e);
      this.log('[' + this.name + '] ERROR (cache): Will attempt to scan TV');
      this.authok = true;
      this.receiveSources(true);
    }
  }
  // Syncs the channels and publishes/updates the TV accessory for HomeKit
  syncAccessory() {
    const self = this;
    if (this.debug) this.log('[' + this.name + '] syncAccessory() called');
    if (this.debug) this.log('[' + this.name + '] scannedChannels count: ' + this.scannedChannels.length);
    if (this.debug) this.log('[' + this.name + '] channelServices count: ' + this.channelServices.length);
    if (this.debug) this.log('[' + this.name + '] inputSourceMap size: ' + this.inputSourceMap.size);

    // Guard: if the scan returned zero channels but we already have channels registered,
    // the TV was almost certainly off or unreachable during the scan. Proceeding would
    // remove every channel as "stale" and corrupt the user's selection. Skip the entire
    // reconcile and keep the existing channel list.
    if (this.scannedChannels.length === 0 && this.channelServices.length > 0) {
      if (this.debug) this.log('[' + this.name + '] ⚠️  Scan returned 0 channels but ' + this.channelServices.length + ' are registered — skipping reconcile (TV likely off)');
      return;
    }
    
    var changeDone = false;
    
    // HomeKit limit: max 100 services per accessory (HAP specification)
    // This includes: AccessoryInformation + TV + Speaker + N Input Sources
    // Maximum input sources = 100 - 3 = 97 (MAX_HOMEKIT_INPUTS)
    // User can configure via maxInputSources in config.json
    const MAX_CHANNELS = this.maxInputSources;

    // Remove channels that no longer exist on TV (or are no longer selected).
    // v1.4.21: done BEFORE adding, so a swapped selection at the cap still has
    // room for the new entries; and iterate over a copy, because splicing the
    // array inside its own forEach skipped every other stale service.
    let removedCount = 0;
    const keepAll = this._noRemoveOnSync === true;
    this._noRemoveOnSync = false;
    this.channelServices.slice().forEach((service) => {
      if (!keepAll && !self.haveChannel(service)) {
        self.tvService.removeLinkedService(service);
        self.accessory.removeService(service);
        const _rid = service.getCharacteristic(Characteristic.Identifier).value;
        if (!self._retiredIdentifiers) self._retiredIdentifiers = new Set();
        self._retiredIdentifiers.add(_rid);
        self.inputSourceMap.delete(_rid);
        self.uriToInputSource.delete(service.subtype);
        self.uriToInputSource.delete(self.normalizeUri(service.subtype));
        self.log('[' + self.name + '] Removing channel: ' + service.getCharacteristic(Characteristic.ConfiguredName).value);
        const idx = self.channelServices.indexOf(service);
        if (idx >= 0) self.channelServices.splice(idx, 1);
        changeDone = true;
        removedCount++;
      }
    });
    if (removedCount > 0) {
      this.log('[' + this.name + '] ✓ Removed ' + removedCount + ' stale channels');
    }

    // Add new channels discovered during scan
    if (this.debug) this.log('[' + this.name + '] Adding new channels...');
    if (this.debug) this.log('[' + this.name + '] HomeKit limit: maximum ' + MAX_CHANNELS + ' channel services allowed');
    
    var addedCount = 0;
    var skippedCount = 0;
    this.scannedChannels.forEach(channel => {
      // Check if we're at the limit
      if (self.channelServices.length >= MAX_CHANNELS) {
        if (addedCount === 0 && skippedCount === 0) {
          self.log('[' + self.name + '] ⚠️  WARNING: Reached configured limit of ' + MAX_CHANNELS + ' services!');
          self.log('[' + self.name + '] ⚠️  Cannot add more channels. Total scanned: ' + self.scannedChannels.length);
          self.log('[' + self.name + '] ⚠️  Currently have: ' + self.channelServices.length + ' services');
          self.log('[' + self.name + '] ⚠️  Skipping remaining ' + (self.scannedChannels.length - self.channelServices.length) + ' channels');
          self.log('[' + self.name + '] ⚠️  To increase limit, set "maxInputSources" in config.json (max ' + MAX_HOMEKIT_INPUTS + ')');
        }
        skippedCount++;
        return; // Skip this channel
      }
      
      if (!self.haveInputSource(channel[0], channel[1], channel[2])) {
        if (self.debug) {
          self.log('[' + self.name + '] Adding channel #' + (self.channelServices.length + 1) + ': ' + channel[0]);
        } else {
          if (self.debug) self.log('[' + self.name + '] Adding channel: ' + channel[0]);
        }
        if (self.addInputSource(channel[0], channel[1], channel[2], null, (channel.length > 3 ? channel[3] : null)) !== false) {
          changeDone = true;
          addedCount++;
        } else {
          skippedCount++;
        }
      }
    });

    if (skippedCount > 0) {
      this.log('[' + this.name + '] ⚠️  Skipped ' + skippedCount + ' channels (HomeKit limit)');
    }
    this.log('[' + this.name + '] ✓ Added ' + addedCount + ' new channels');
    this.log('[' + this.name + '] Total channels now: ' + this.channelServices.length + ' / ' + MAX_CHANNELS);

    if (!this.accessory.context.isRegisteredInHomeKit) {
      if (this.debug) this.log('[' + this.name + '] Registering accessory in HomeKit');
      // add base services that haven't been added yet
      this.services.forEach(service => {
        try {
          if (!self.accessory.services.includes(service)) {
            if (self.debug) self.log('[' + self.name + '] Adding base service');
            self.accessory.addService(service);
            changeDone = true;
          }
        } catch (e) {
          self.log('[' + self.name + '] ERROR adding service: ' + e);
        }
      });
      this.log('[' + this.name + '] Registering accessory for ' + this.name);
      this.accessory.context.isRegisteredInHomeKit = true;
      if (!this.accessory.context.isexternal) {
        if (this.debug) this.log('[' + this.name + '] Registered as platform accessory');
        this.platform.api.registerPlatformAccessories('homebridge-bravia-enhanced', 'BraviaPlatform', [this.accessory]);
      } else {
        this.log('[' + this.name + '] Publishing as external accessory (HomeKit ID ' + homeKitIdFor(this.accessory.UUID) + ')');
        try {
          const data = JSON.stringify(this.accessory.context);
          const contextPath = STORAGE_PATH + '/sonytv-context-' + this.accessory.context.config.name + '.json';
          fs.writeFileSync(contextPath, data);
          if (this.debug) this.log('[' + this.name + '] Context saved to: ' + contextPath);
        } catch (e) {
          this.log('[' + this.name + '] ERROR saving context: ' + e);
        }
        this.platform.api.publishExternalAccessories('homebridge-bravia-enhanced', [this.accessory]);
      }
    } else if (changeDone) {
      // Only platform-managed accessories live in Homebridge's cachedAccessories file.
      // External accessories are published directly with publishExternalAccessories and
      // are not part of the cache. Calling updatePlatformAccessories on an external
      // accessory triggers a cache write and Homebridge logs:
      //   "Failed to save cached accessories to disk: Cannot serialize accessory <name>
      //    - missing associated platform"
      // because external accessories have no associated platform record. The change is
      // already live on the running accessory and persisted via saveChannelsToFile,
      // so we just skip the platform-cache update for the external case.
      if (this.accessory.context.isexternal) {
        if (this.debug) this.log('[' + this.name + '] Accessory changed (external, skipping platform cache update)');
      } else {
        if (this.debug) this.log('[' + this.name + '] Updating accessory for ' + this.name);
        this.platform.api.updatePlatformAccessories([this.accessory]);
      }
    }
    if (this.accessory.context.isexternal) {
      if (this.debug) this.log('[' + this.name + '] External accessory, calling saveChannelsToFile()');
      this.saveChannelsToFile();
    } else {
      if (this.debug) this.log('[' + this.name + '] Non-external accessory, skipping saveChannelsToFile()');
    }
    this.receivingSources = false;
    if (this.debug) this.log('[' + this.name + '] syncAccessory() complete');
    // Detailed scan summary banner — typed counts and HomeKit limit status
    if (this.debug) {
      let counts = { tv: 0, hdmi: 0, app: 0, other: 0 };
      try {
        (this.scannedChannels || []).forEach((ch) => {
          const t = ch[2];
          if (t === Characteristic.InputSourceType.TUNER) counts.tv++;
          else if (t === Characteristic.InputSourceType.HDMI) counts.hdmi++;
          else if (t === Characteristic.InputSourceType.APPLICATION) counts.app++;
          else counts.other++;
        });
      } catch (e) {}
      const lines = [
        'scanned channels total: ' + (this.scannedChannels ? this.scannedChannels.length : 0),
        '   - TV tuner: ' + counts.tv,
        '   - HDMI: ' + counts.hdmi,
        '   - apps: ' + counts.app,
        '   - other: ' + counts.other,
        'HomeKit services published: ' + (this.channelServices ? this.channelServices.length : 0),
        'HomeKit input cap: ' + this.maxInputSources + (this.channelServices && this.channelServices.length >= this.maxInputSources ? '  ⚠️  REACHED' : ''),
        'inputSourceMap size: ' + (this.inputSourceMap ? this.inputSourceMap.size : 0)
      ];
      this._debugBanner('🔎 SCAN SUMMARY', lines);
    }
  }
  // Finish a scan without losing the full channel list used by the web UI.
  // HomeKit is reconciled with either the saved user selection or the configured cap,
  // while the full scan cache keeps every TV/HDMI/app entry visible in Channel Selector.
  finalizeChannelScan() {
    const fullScannedChannels = Array.isArray(this.scannedChannels) ? this.scannedChannels.slice() : [];

    // v1.4.21: remote-control functions offered as selectable inputs (e.g.
    // Teletext). They only appear when the TV answered the scan, and reach
    // HomeKit only if the user selects them in the Channel Selector.
    if (fullScannedChannels.length > 0) {
      const keys = this._irccCodes || (this.capabilities && this.capabilities.remoteKeys) || null;
      VIRTUAL_INPUTS.forEach((v) => {
        const key = v.uri.slice(5);
        if (keys && !keys[key]) return;                    // TV does not have this key
        if (v.needs === 'usb' && !this._hasRecStorage) return; // recording needs a USB drive
        if (!fullScannedChannels.some((c) => c[1] === v.uri)) {
          fullScannedChannels.push([v.name, v.uri, Characteristic.InputSourceType.OTHER]);
        }
      });
    }

    if (fullScannedChannels.length > 0) {
      this.saveFullScanCache(fullScannedChannels);
    } else if (this.debug) {
      this.log('[' + this.name + '] Full scan returned 0 channels; keeping any previous full-scan cache');
    }

    const selectedUris = this.getSelectedChannelUris();
    let channelsForHomeKit = fullScannedChannels;

    if (selectedUris && selectedUris.length > 0) {
      const selectedChannels = this.getSelectedChannelsFromList(fullScannedChannels, selectedUris);

      if (selectedChannels.length === 0 && fullScannedChannels.length > 0) {
        this.log('[' + this.name + '] ⚠️  Saved channel selection matched 0/' + selectedUris.length + ' scanned channels; preserving current HomeKit inputs and keeping full scan for Channel Selector');
        this.scannedChannels = fullScannedChannels;
        this.receivingSources = false;
        return;
      }

      channelsForHomeKit = selectedChannels;
      this.log('[' + this.name + '] Applied channel selection for HomeKit: ' + channelsForHomeKit.length + ' channels (full scan: ' + fullScannedChannels.length + ')');
    } else if (fullScannedChannels.length > this.maxInputSources) {
      this.log('[' + this.name + '] Full scan found ' + fullScannedChannels.length + ' channels; HomeKit will publish at most ' + this.maxInputSources + ' input sources');
    }

    // v1.4.21: apps / TV functions / recordings go to their own Home tiles
    // when those are enabled; the TV keeps the rest.
    this._refreshSideAccessories(fullScannedChannels, channelsForHomeKit);
    channelsForHomeKit = this._mainTvChannels(channelsForHomeKit);

    this.scannedChannels = channelsForHomeKit;
    // v1.4.22: a scan where the TV did not answer for some source (standby,
    // display off, refused, timeout) only ADDS inputs; nothing is removed
    // until a complete scan confirms it is really gone.
    this._noRemoveOnSync = this._scanIncomplete === true;
    if (this._noRemoveOnSync && this.debug) this.log('[' + this.name + '] Incomplete scan: existing inputs kept');
    try {
      this.syncAccessory();
    } catch (e) {
      this.log('[' + this.name + '] ERROR while applying the scan to HomeKit: ' + (e && e.stack ? e.stack : e));
    } finally {
      // v1.4.21: never leave the scan flag latched. If syncAccessory threw,
      // receivingSources stayed true forever and no further scan ever ran.
      this.receivingSources = false;
      // syncAccessory uses this.scannedChannels as the HomeKit reconcile source.
      // Restore the complete scan immediately afterwards so /api/scan and debug
      // summaries do not report only the selected HomeKit subset.
      this.scannedChannels = fullScannedChannels;
    }
  }

  // v1.4.21: keep exactly ONE periodic channel-refresh timer. Previously every
  // call to receiveSources() scheduled its own follow-up, so each extra caller
  // (pairing via the web UI, PSK re-check, cache-less boot) started another
  // endless 30s loop running in parallel.
  _ensureScanLoop() {
    if (this._scanLoopTimer || !this.channelupdaterate) return;
    this._scanLoopTimer = setTimeout(() => {
      this._scanLoopTimer = null;
      this.receiveSources();
    }, this.channelupdaterate);
  }

  // v1.4.21: (re)run the cookie registration. Used when the TV comes on after
  // it was unreachable at boot, when the TV is on but we are not authenticated,
  // and when a request is refused with 401/403 (expired cookie). Throttled, and
  // never while a PIN is pending (actRegister would pop the PIN on the TV again).
  _requestReRegistration(reason, bypassIfUnreachable) {
    if (!isNull(this.psk)) return;            // PSK: no cookie registration needed
    if (this.awaitingPin === true) return;     // user has to enter the PIN first
    var now = Date.now();
    var minGap = 30000;
    // When the TV has just come on and the previous attempt failed only because
    // the TV was unreachable, retry immediately instead of waiting out the gap.
    var bypass = (bypassIfUnreachable === true) && (this._lastRegistrationUnreachable === true);
    if (!bypass && this._lastRegistrationAttempt && (now - this._lastRegistrationAttempt) < minGap) return;
    this.log('[' + this.name + '] 🔑 Re-checking registration with the TV (' + reason + ')');
    this.checkRegistration();
  }

  // v1.4.21: read the TV's external input list with getSourceList (only used
  // when "sources" is not set in config). On any failure keep DEFAULT_SOURCES
  // and try again at the next scan; done() is always called exactly once.
  _resolveAutoSources(done) {
    const that = this;
    const post = '{"id":14,"method":"getSourceList","version":"1.0","params":[{"scheme":"extInput"}]}';
    const fallback = (why) => {
      if (that.debug) that.log('[' + that.name + '] getSourceList not available (' + why + '), using default sources: ' + DEFAULT_SOURCES.join(', '));
      done();
    };
    that.makeHttpRequest(
      (err) => fallback('error: ' + err),
      (data) => {
        try {
          const json = JSON.parse(data);
          const list = json && Array.isArray(json.result) && Array.isArray(json.result[0]) ? json.result[0] : null;
          const srcs = (list || []).map((x) => x && x.source).filter((s) => typeof s === 'string' && s.indexOf('extInput:') === 0);
          if (srcs.length === 0) return fallback('empty or error response');
          that.sources = srcs;
          that._autoSourcesResolved = true;
          that.log('[' + that.name + '] External inputs reported by the TV: ' + srcs.join(', '));
          done();
        } catch (e) {
          fallback('parse error: ' + e);
        }
      },
      '/sony/avContent', post, false
    );
  }

  // initialize a scan for new sources
  receiveSources(checkPower = null) {
    this._ensureScanLoop();
    // v1.4.22: never scan without a working pairing (cookie mode): every call
    // would be refused and, every 30 s, produce an empty channel list.
    if (isNull(this.psk) && this.authok !== true) {
      if (this.debug) this.log('[' + this.name + '] Scan skipped: not authenticated with the TV');
      return;
    }
    if (this.debug) this.log('[' + this.name + '] receiveSources checkPower=' + checkPower + ', this.power=' + this.power + ', this.receivingSources=' + this.receivingSources);
    if (checkPower === null)
      checkPower = this.power;
    if (this.debug) this.log('[' + this.name + '] checkPower=' + checkPower);

    // v1.4.13: if the TV woke up very recently, defer the scan briefly to let
    // the AV stack initialise (channel queries can fail otherwise). The natural
    // channelupdaterate reschedule still runs on top of this, but we add a
    // one-shot deferred call so we don't have to wait the full cycle.
    if (checkPower && this.recentlyWokenAt) {
      var sinceWake = Date.now() - this.recentlyWokenAt;
      if (sinceWake < this.postWakeScanDelay) {
        var wait = this.postWakeScanDelay - sinceWake + 100;
        this.log('[' + this.name + '] [POWER] Deferring channel scan by ' + wait + 'ms (TV woke ' + sinceWake + 'ms ago, postWakeScanDelay=' + this.postWakeScanDelay + 'ms)');
        var thatDefer = this;
        setTimeout(function () { thatDefer.receiveSources(checkPower); }, wait);
        return;
      }
    }

    if (!this.receivingSources && checkPower && !this._scanPrepared) {
      // v1.4.21: before each scan (one attempt per scan):
      //  - "sources" not configured → ask the TV which external inputs it has
      //  - read the remote-control key list once (for the "TV functions")
      //  - check whether a USB recording drive is connected
      this.receivingSources = true;
      const steps = [];
      if (this.sourcesAuto && !this._autoSourcesResolved) steps.push((next) => this._resolveAutoSources(next));
      if (!this._irccCodes) steps.push((next) => this.loadRemoteCodes(next));
      steps.push((next) => this.detectRecStorage(() => next()));
      const run = () => {
        const step = steps.shift();
        if (step) { step(run); return; }
        this.receivingSources = false;
        this._scanPrepared = true;
        this.receiveSources(true);
      };
      run();
      return;
    }

    if (!this.receivingSources && checkPower) {
      this._scanPrepared = false;
      this.log('[' + this.name + '] Starting channel scan...');
      const that = this;
      this.inputSourceList = [];
      this.sources.forEach(function (sourceName) {
        that.inputSourceList.push(new InputSource(sourceName, getSourceType(sourceName)));
      });
      if (!isNull(this.tvsource)) {
        this.inputSourceList.push(new InputSource(this.tvsource, getSourceType(this.tvsource)));
      }
      // v1.4.21: recordings on the TV's USB drive, offered as selectable
      // inputs (only when the drive is connected).
      if (this._hasRecStorage) {
        this.inputSourceList.push(new InputSource('usb:recStorage', Characteristic.InputSourceType.OTHER));
      }

      this.receivingSources = true;
      this.scannedChannels = [];
      this._scanIncomplete = false; // v1.4.22: set when the TV fails to answer for a source
      // v1.4.15: reset appsLoaded at the start of every scan cycle so apps are
      // re-fetched on every refresh, not just on the very first boot scan.
      // Without this reset, appsLoaded stayed latched to true after the first
      // successful scan, the gate in receiveNextSources() would skip
      // receiveApplications() on cycles 2 to N, and scannedChannels would not
      // contain any apps. The reconcile step would then remove every app from
      // HomeKit because they were no longer present in scannedChannels, even
      // though the user had them in config and selected via the Channel
      // Selector UI. The on-disk selection survived (it is a separate file),
      // which produced the puzzling symptom of apps still being marked as
      // selected in the UI but missing from HomeKit.
      // (Fixes GitHub issue #4: apps removed after every rescan.)
      this.appsLoaded = !this.useApps;
      this.receiveNextSources();
    } else {
      if (this.debug) this.log('[' + this.name + '] Skipping scan — receivingSources=' + this.receivingSources + ', checkPower=' + checkPower);
    }
  }
  // Process next source in the queue, or finish scanning and sync accessory
  receiveNextSources() {
    if (this.debug) this.log('[' + this.name + '] Processing sources queue, remaining: ' + this.inputSourceList.length);
    
    if (this.inputSourceList.length == 0) {
      if (this.debug) this.log('[' + this.name + '] All sources processed');
      if (this.useApps && !this.appsLoaded) {
        if (this.debug) this.log('[' + this.name + '] Loading applications...');
        this.receiveApplications();
      } else {
        if (this.debug) this.log('[' + this.name + '] Finalizing scan...');
        this.finalizeChannelScan();
      }
      return;
    }
    
    var source = this.inputSourceList.shift();
    if (!isNull(source)) {
      if (this.debug) this.log('[' + this.name + '] Processing source: ' + source.name + ' (type: ' + source.type + ')');
      this.receiveSource(source.name, source.type);
    } else {
      if (this.debug) this.log('[' + this.name + '] Source was null, skipping');
    }
  }
  // TV http call to receive input list for source
  receiveSource(sourceName, sourceType, startIndex = 0) {
    const that = this;
    if (that.debug) that.log('[' + that.name + '] Fetching source: ' + sourceName + ' with startIndex=' + startIndex);
    
    var onError = function (err) {
      that._scanIncomplete = true; // v1.4.22: TV did not answer for this source
      if (that.debug) that.log('[' + that.name + '] Error loading source: ' + sourceName + ' at index ' + startIndex);
      if (that.debug) that.log(err);
      that.receiveNextSources();
    };
    var onSucces = function (data) {
      try {
        if (data.indexOf('"error"') < 0) {
          var jayons = JSON.parse(data);
          var reslt = jayons.result[0];
          var foundChannels = 0;
          reslt.forEach(function (source) {
            // v1.4.19: filter out phantom CEC entries returned by the Sony API.
            // On newer Bravia XR firmware, getContentList for extInput:cec
            // sometimes includes a stub row representing the TV's own CEC
            // logical address (typically port=-1, empty title, logicalAddr=4
            // which is "Playback Device 1" assigned by the TV to itself).
            // It cannot be selected as an input , selecting it does nothing
            // , but the web UI rendered it as a raw URI (no title) and the
            // polling loop logged it on every cycle. Reported by @Mamac-FR
            // on K-55XR8M2 (Bravia 8 II, interface v6.3.0). HDMI sources
            // never have negative ports or empty titles, so the filter is
            // safe for every other source type.
            var _isCec = typeof source.uri === 'string' && source.uri.indexOf('extInput:cec') === 0;
            var _hasNegativePort = typeof source.uri === 'string' && /[?&]port=-\d/.test(source.uri);
            var _hasEmptyTitle = !source.title || String(source.title).trim().length === 0;
            if (_isCec && (_hasNegativePort || _hasEmptyTitle)) {
              if (that.debug) that.log('[' + that.name + '] Skipping phantom CEC entry: ' + source.uri + ' (title="' + (source.title || '') + '")');
              return;
            }
            that.scannedChannels.push([source.title, source.uri, sourceType]);
            // v1.4.21: remember the number shown on the remote (dispNum) for
            // the web UI; it is not part of the channel tuple used by HomeKit.
            if (source.dispNum !== undefined && source.dispNum !== null && String(source.dispNum).trim() !== '') {
              if (!that._dispNums) that._dispNums = {};
              that._dispNums[source.uri] = String(source.dispNum).trim();
            }
            // v1.4.21: the TV marks each broadcast service as "tv" or "radio"
            // (programMediaType); keep it so the web UI can list radio
            // stations separately instead of mixing them with TV channels.
            if (typeof source.programMediaType === 'string' && source.programMediaType) {
              if (!that._mediaTypes) that._mediaTypes = {};
              that._mediaTypes[source.uri] = source.programMediaType;
            }
            // v1.4.21: recordings on the USB drive — keep channel, date,
            // duration and flags for the web UI.
            if (typeof source.uri === 'string' && source.uri.indexOf('usb:recStorage') === 0) {
              if (!that._recMeta) that._recMeta = {};
              that._recMeta[source.uri] = {
                channelName: source.channelName || '',
                startDateTime: source.startDateTime || '',
                durationSec: source.durationSec || 0,
                isAlreadyPlayed: source.isAlreadyPlayed === true,
                isProtected: source.isProtected === true
              };
            }
            foundChannels++;
          });
          
          if (that.debug) that.log('[' + that.name + '] Found ' + foundChannels + ' channels for ' + sourceName + ' at startIndex ' + startIndex);
          
          // If we got exactly 50 channels, there might be more - request next batch
          if (foundChannels === 50) {
            if (that.debug) that.log('[' + that.name + '] Paginating channels for ' + sourceName + ', next startIndex: ' + (startIndex + 50));
            that.receiveSource(sourceName, sourceType, startIndex + 50);
            return; // Don't call receiveNextSources yet
          } else {
            that.log('[' + that.name + '] Loaded all channels for ' + sourceName + ', total channels: ' + (startIndex + foundChannels));
          }
        } else {
          // v1.4.22: "source is invalid" (error 3) means the TV has no such
          // input: a real answer. Anything else (illegal state, display off,
          // refused) means we do not know: keep the inputs we already have.
          if (!/"error"\s*:\s*\[\s*3\s*,/.test(data)) that._scanIncomplete = true;
          if (that.debug) that.log('[' + that.name + '] ERROR: Can\'t load sources for ' + sourceName + ' at index ' + startIndex);
          if (that.debug) that.log('[' + that.name + '] ERROR: TV response: ' + data);
        }
      } catch (e) {
        that._scanIncomplete = true;
        that.log('[' + that.name + '] ERROR processing channels for ' + sourceName + ': ' + e + ' — answer: ' + String(data).slice(0, 120));
      }
      that.receiveNextSources();
    };
    var getContentListVersion = that.getApiVersion('getContentList', '1.0');
    // Sony getContentList API changed the parameter name across versions:
    //   v1.0 - v1.2: { "source": "<uri>", "stIdx": N }
    //   v1.5+:       { "uri": "<uri>", "stIdx": N, "cnt": 50 }
    // The v1.5 schema also supports an explicit "cnt" (max items per response,
    // device-specific limit, max 200). We include it for v1.5+ to be explicit.
    var sourceParam;
    if (compareVersions(getContentListVersion, '1.5') >= 0) {
      sourceParam = '{ "uri":"' + sourceName + '","stIdx": ' + startIndex + ',"cnt": 50}';
    } else {
      sourceParam = '{ "source":"' + sourceName + '","stIdx": ' + startIndex + '}';
    }
    var post_data = '{"id":13,"method":"getContentList","version":"' + getContentListVersion + '","params":[' + sourceParam + ']}';
    if (that.debug) that.log('[' + that.name + '] API request: ' + post_data);
    that.makeHttpRequest(onError, onSucces, '/sony/avContent', post_data, false);
  }
  
  // Extract channel number from URI
  extractChannelNumber(uri) {
    if (this.debug) this.log('[' + this.name + '] Attempting to extract channel number from URI: ' + uri);
    // Try to extract channel number from URI
    // Example URIs: "tv:dvbt?trip=29.512.70&srvName=..." 
    // We want to extract the last number before "&" (70 in this case)
    var match = uri.match(/trip=[\d\.]+\.(\d+)/);
    if (match && match[1]) {
      if (this.debug) this.log('[' + this.name + '] Successfully extracted channel number: ' + match[1] + ' using trip pattern');
      return parseInt(match[1]);
    }
    // Fallback: try to extract any number from the URI
    match = uri.match(/(\d+)/);
    if (match && match[1]) {
      if (this.debug) this.log('[' + this.name + '] Extracted number using fallback pattern: ' + match[1]);
      return parseInt(match[1]);
    }
    if (this.debug) this.log('[' + this.name + '] Failed to extract channel number from URI');
    return null;
  }

  // Normalize a content URI so it can be matched reliably between getContentList and getPlayingContentInfo.
  // Sony TVs may return equivalent channel URIs with different querystring ordering/encoding and/or leading zeros in trip.
  // We key primarily on a canonicalized `trip=` when available (DVB channels).
  normalizeUri(uri) {
    if (isNull(uri)) return uri;

    const m = uri.match(/(?:\?|&)trip=([^&]+)/);
    if (m && m[1]) {
      // Canonicalize trip by parsing numeric segments to remove leading zeros (e.g. 29.512.052 -> 29.512.52)
      const tripRaw = m[1];
      const tripCanon = tripRaw
        .split('.')
        .map(seg => {
          const n = parseInt(seg, 10);
          return Number.isFinite(n) ? String(n) : seg;
        })
        .join('.');
      return 'trip=' + tripCanon;
    }

    // Fallback: strip srvName (often varies/encoded) but keep other params
    return uri.replace(/([?&])srvName=[^&]*/g, '$1').replace(/[?&]$/,'');
  }

  // TV HTTP call to receive application list
  receiveApplications() {
    const that = this;
    if (that.debug) that.log('[' + that.name + '] receiveApplications() called');
    if (that.debug) that.log('[' + that.name + '] Configured applications filter: ' + JSON.stringify(that.applications));
    
    var onError = function (err) {
      that._scanIncomplete = true;
      if (that.debug) that.log('[' + that.name + '] ERROR loading apps: ' + err);
      if (that.debug)
        that.log(err);
      that.appsLoaded = true;
      that.finalizeChannelScan();
    };
    var onSucces = function (data) {
      try {
        if (data.indexOf('"error"') < 0) {
          var jayons = JSON.parse(data);
          var reslt = jayons.result[0];
          that.log('[' + that.name + '] Found ' + reslt.length + ' apps on TV');
          var addedCount = 0;
          
          reslt.sort((a, b) => (a.title || '').localeCompare(b.title || '')).forEach(function (source) {
            if (that.applications.length == 0 || that.applications.map(app => app.title).filter(title => source.title.includes(title)).length > 0) {
              if (that.debug) that.log('[' + that.name + '] Adding app: ' + source.title);
              that.scannedChannels.push([source.title, source.uri, Characteristic.InputSourceType.APPLICATION]);
              addedCount++;
            } else {
              if (that.debug)
                if (that.debug) that.log('[' + that.name + '] Skipping app: ' + source.title);
            }
          });
          
          that.log('[' + that.name + '] ✓ Added ' + addedCount + ' apps');
        } else {
          that._scanIncomplete = true;
          if (that.debug) that.log('[' + that.name + '] ERROR (apps): Can\'t load applications');
          if (that.debug) {
            if (that.debug) that.log('TV response:');
            if (that.debug) that.log(data);
          }
        }
      } catch (e) {
        if (that.debug) that.log('[' + that.name + '] ERROR (apps): Exception parsing applications: ' + e);
        if (that.debug)
          if (that.debug) that.log(e);
      }
      that.appsLoaded = true;
      that.finalizeChannelScan();
    };
    var getApplicationListVersion = that.getApiVersion('getApplicationList', '1.0');
    var post_data = '{"id":13,"method":"getApplicationList","version":"' + getApplicationListVersion + '","params":[]}';
    that.makeHttpRequest(onError, onSucces, '/sony/appControl', post_data, false);
  }
  // TV HTTP call to poll currently playing content
  pollPlayContent() {
    // TODO: check app list if no play content for currentUri
    const that = this;
    var getPlayingContentInfoVersion = that.getApiVersion('getPlayingContentInfo', '1.0');
    var post_data = '{"id":13,"method":"getPlayingContentInfo","version":"' + getPlayingContentInfoVersion + '","params":[]}';
    var onError = function (err) {
      if (that.debug)
        that.log('[' + that.name + '] Error polling play content: ' + err);
      if (!isNull(that.currentUri)) {
        that.currentUri = null;
        that.tvService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(0);
      }
    };
    var onSucces = function (chunk) {
      if (chunk.indexOf('"error"') >= 0) {
        // happens when TV display is off
        if (that.debug)
          that.log('[' + that.name + '] TV display is off');
        if (!isNull(that.currentUri)) {
          that.currentUri = null;
          that.tvService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(0);
        }
      } else {
        try {
          var jason = JSON.parse(chunk);
          if (!isNull(jason) && jason.result) {
            var result = jason.result[0];
            var uri = result.uri;
            if (that.currentUri != uri) {
              if (that.debug)
                that.log('[' + that.name + '] Current content changed to URI: ' + uri);
              that.currentUri = uri;
              var inputSource = that.uriToInputSource.get(uri) || that.uriToInputSource.get(that.normalizeUri(uri));
              if (inputSource) {
                var id = inputSource.getCharacteristic(Characteristic.Identifier).value;
                if (!isNull(inputSource)) {
                  if (that.debug)
                    that.log('[' + that.name + '] Updating active identifier to: ' + id);
                  that.tvService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(id);
                }
              } else {
                if (that.debug)
                  that.log('[' + that.name + '] Warning: URI not found in input sources: ' + uri);
              }
            }
          }
        } catch (e) {
          if (!isNull(that.currentUri)) {
            that.currentUri = null;
            that.tvService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(0);
          }
          if (that.debug)
            that.log('[' + that.name + '] Can\'t poll play content: ' + e);
        }
      }
    };
    that.makeHttpRequest(onError, onSucces, '/sony/avContent/', post_data, false);
  }
  // TV HTTP call to get the connection status of external (HDMI/component) inputs
  // Uses getCurrentExternalInputsStatus v1.1 which includes the 'connection' field
  pollExternalInputsStatus() {
    const that = this;
    if (!that.power) return; // no point polling when TV is off

    var getExtInputsVersion = that.getApiVersion('getCurrentExternalInputsStatus', '1.1');
    var post_data = '{"id":13,"method":"getCurrentExternalInputsStatus","version":"' + getExtInputsVersion + '","params":[]}';
    var onError = function (err) {
      if (that.debug) that.log('[' + that.name + '] ERROR polling external inputs: ' + err);
    };
    var onSucces = function (data) {
      try {
        // Note: error 12 (Method Not Implemented at version) is now handled
        // transparently by makeHttpRequest, which downgrades and retries automatically.
        if (data.indexOf('"error"') >= 0) {
          if (that.debug) that.log('[' + that.name + '] External inputs status error response');
          return;
        }
        var json = JSON.parse(data);
        if (!json || !json.result || !json.result[0]) return;
        var inputs = json.result[0];
        var changed = false;

        inputs.forEach(function (input) {
          var uri = input.uri;
          if (!uri) return;
          // v1.4.19: same phantom CEC filter as in receiveSource, keep this
          // map consistent so the web UI does not display the stub entry from
          // here either, and the polling log is not spammed every 5 seconds.
          var _isCec = uri.indexOf('extInput:cec') === 0;
          var _hasNegativePort = /[?&]port=-\d/.test(uri);
          var _hasEmptyTitle = !input.title || String(input.title).trim().length === 0;
          if (_isCec && (_hasNegativePort || _hasEmptyTitle)) {
            return;
          }
          var prev = that.externalInputsStatus.get(uri);
          var wasConnected = prev ? prev.connection : null;
          var isConnected = input.connection === true;

          // Store full status for the web UI
          that.externalInputsStatus.set(uri, {
            title: input.title || '',
            label: input.label || '',
            connection: isConnected,
            icon: input.icon || ''
          });

          // If connection state changed, log it
          if (wasConnected !== isConnected) {
            that.log('[' + that.name + '] Input ' + (input.label || input.title || uri) + ': ' + (isConnected ? '🟢 connected' : '⚫ disconnected'));
            changed = true;
          }

          // Optionally update HomeKit visibility based on physical connection
          if (that.hideDisconnectedInputs) {
            var inputSource = that.uriToInputSource.get(uri) || that.uriToInputSource.get(that.normalizeUri(uri));
            if (inputSource) {
              var targetVisibility = isConnected
                ? Characteristic.CurrentVisibilityState.SHOWN
                : Characteristic.CurrentVisibilityState.HIDDEN;
              var currentVisibility = inputSource.getCharacteristic(Characteristic.CurrentVisibilityState).value;
              if (currentVisibility !== targetVisibility) {
                inputSource.updateCharacteristic(Characteristic.CurrentVisibilityState, targetVisibility);
                if (that.debug) that.log('[' + that.name + '] Visibility updated for ' + (input.label || uri) + ': ' + (isConnected ? 'SHOWN' : 'HIDDEN'));
              }
            }
          }
        });

        if (that.debug && changed) that.log('[' + that.name + '] External inputs status updated');
      } catch (e) {
        if (that.debug) that.log('[' + that.name + '] ERROR parsing external inputs: ' + e);
      }
    };
    that.makeHttpRequest(onError, onSucces, '/sony/avContent', post_data, false);
  }

  // TV HTTP call to set play content (change channel/input)
  setPlayContent(uri) {
    const that = this;
    that.log('[' + that.name + '] Switching to: ' + uri);
    var setPlayContentVersion = that.getApiVersion('setPlayContent', '1.0');
    var post_data = '{"id":13,"method":"setPlayContent","version":"' + setPlayContentVersion + '","params":[{ "uri": "' + uri + '" }]}';
    var onError = function (err) {
      if (that.debug) that.log('[' + that.name + '] ERROR setting play content: ' + err);
    };
    var onSucces = function (chunk) {
      if (that.debug) that.log('[' + that.name + '] ✓ Content switched');
    };
    that.makeHttpRequest(onError, onSucces, '/sony/avContent/', post_data, true);
  }
  // TV http call to set the active app
  setActiveApp(uri) {
    const that = this;
    that.log('[' + that.name + '] Launching app: ' + uri);
    var setActiveAppVersion = that.getApiVersion('setActiveApp', '1.0');
    var post_data = '{"id":13,"method":"setActiveApp","version":"' + setActiveAppVersion + '","params":[{"uri":"' + uri + '"}]}';
    var onError = function (err) {
      if (that.debug) that.log('[' + that.name + '] ERROR launching app: ' + err);
    };
    var onSucces = function (data) {
      if (that.debug) that.log('[' + that.name + '] ✓ App launched');
    };
    that.makeHttpRequest(onError, onSucces, '/sony/appControl', post_data, true);
  }
  // Homebridge callback to get current channel identifier
  getActiveIdentifier(callback) {
    if (this.debug)
      this.log('[' + this.name + '] getActiveIdentifier called, currentUri: ' + this.currentUri);
    
    var uri = this.currentUri;
    if (!isNull(uri)) {
      var inputSource = this.uriToInputSource.get(uri);
      if (inputSource) {
        var id = inputSource.getCharacteristic(Characteristic.Identifier).value;
        if (!isNull(inputSource)) {
          if (this.debug)
            this.log('[' + this.name + '] Returning identifier: ' + id);
          if (!isNull(callback))
            callback(null, id);
          return;
        }
      }
    }
    if (this.debug)
      this.log('[' + this.name + '] No active input, returning 0');
    if (!isNull(callback))
      callback(null, 0);
  }
  // v1.4.21: press a named remote-control key via IRCC. The code comes from the
  // TV's own getRemoteControllerInfo list (read once, cached); a built-in
  // fallback covers the functions offered as virtual inputs.
  sendRemoteFunction(fnName) {
    const that = this;
    const send = (code) => {
      if (!code) { that.log('[' + that.name + '] ⚠️  Remote function "' + fnName + '" not supported by this TV'); return; }
      that.log('[' + that.name + '] Remote key: ' + fnName);
      that.makeHttpRequest(
        (err) => { if (that.debug) that.log('[' + that.name + '] IRCC ' + fnName + ' failed: ' + err); },
        () => {},
        '', that.createIRCC(code), false
      );
    };
    if (this._irccCodes) return send(this._irccCodes[fnName] || IRCC_FALLBACK[fnName]);
    this.loadRemoteCodes(() => send((that._irccCodes && that._irccCodes[fnName]) || IRCC_FALLBACK[fnName]));
  }

  // v1.4.21: read the TV's remote-control key list (name → IRCC code) once
  // and keep it (also in the capabilities file, so the list of offered
  // "TV functions" is right even when the TV is off at start). done() always
  // runs exactly once.
  loadRemoteCodes(done) {
    const that = this;
    const post = '{"id":20,"method":"getRemoteControllerInfo","version":"1.0","params":[]}';
    const finish = () => { if (typeof done === 'function') done(); };
    this.makeHttpRequest(
      finish,
      (data) => {
        try {
          const json = JSON.parse(data);
          const list = json && json.result && Array.isArray(json.result[1]) ? json.result[1] : [];
          const map = {};
          list.forEach((k) => { if (k && k.name && k.value) map[k.name] = k.value; });
          if (Object.keys(map).length > 0) {
            that._irccCodes = map;
            that.capabilities.remoteKeys = map;
            that.saveCapabilities();
          }
        } catch (e) {}
        finish();
      },
      '/sony/system/', post, false
    );
  }

  // v1.4.21: is a USB recording drive connected to the TV? (getSourceList
  // with scheme "usb" lists "usb:recStorage" only when a formatted drive is
  // plugged in). cb(present:boolean). Never throws.
  detectRecStorage(cb) {
    const that = this;
    const post = '{"id":21,"method":"getSourceList","version":"1.0","params":[{"scheme":"usb"}]}';
    this.makeHttpRequest(
      () => cb(!!that._hasRecStorage),
      (data) => {
        let present = !!that._hasRecStorage;
        try {
          const json = JSON.parse(data);
          if (json && Array.isArray(json.result)) {
            const list = Array.isArray(json.result[0]) ? json.result[0] : [];
            present = list.some((x) => x && x.source === 'usb:recStorage');
          } else if (json && json.error && json.error[0] !== 401 && json.error[0] !== 403 && !json.auth_url) {
            present = false; // e.g. "no source" when no drive is plugged in
          }
          // auth_url / 401 / 403: the TV refused the call, so we know nothing
        } catch (e) {}
        if (present !== !!that._hasRecStorage) {
          that.log('[' + that.name + '] ' + (present ? '💾 USB recording drive detected on the TV' : 'USB recording drive not connected'));
        }
        that._hasRecStorage = present;
        cb(present);
      },
      '/sony/avContent', post, false
    );
  }
  // Homebridge callback to set current channel/input
  setActiveIdentifier(identifier, callback) {
    if (this.debug) this.log('[' + this.name + '] setActiveIdentifier called with identifier: ' + identifier);
    var inputSource = this.inputSourceMap.get(identifier);
    if (inputSource && inputSource.testCharacteristic(Characteristic.InputSourceType)) {
      var sourceName = inputSource.getCharacteristic(Characteristic.ConfiguredName).value;
      var sourceType = inputSource.getCharacteristic(Characteristic.InputSourceType).value;
      if (this.debug) this.log('[' + this.name + '] Switching to: ' + sourceName + ' (type: ' + sourceType + ')');
      
      if (typeof inputSource.subtype === 'string' && inputSource.subtype.indexOf('ircc:') === 0) {
        // v1.4.21: virtual input = press a remote-control key (e.g. Teletext)
        // on whatever is playing. Forget the current URI so the next status
        // poll moves the HomeKit selection back to the channel being watched.
        this.sendRemoteFunction(inputSource.subtype.slice(5));
        this.currentUri = null;
      } else if (sourceType == Characteristic.InputSourceType.APPLICATION) {
        if (this.debug) this.log('[' + this.name + '] Type is APPLICATION, calling setActiveApp');
        this.setActiveApp(inputSource.subtype);
      } else {
        if (this.debug) this.log('[' + this.name + '] Type is not APPLICATION, calling setPlayContent');
        this.setPlayContent(inputSource.subtype);
      }
    } else {
      if (this.debug) this.log('[' + this.name + '] Warning: inputSource not found for identifier ' + identifier);
    }
    if (!isNull(callback))
      callback(null);
  }
  // homebridge callback to set volume via selector (up/down)
  setVolumeSelector(key, callback) {
    const that = this;
    var value = '';
    var onError = function (err) {
      if (that.debug) that.log(err);
      if (!isNull(callback))
        callback(null);
    };
    var onSucces = function (data) {
      if (!isNull(callback))
        callback(null);
    };
    switch (key) {
      case Characteristic.VolumeSelector.INCREMENT: // Volume up
        value = 'AAAAAQAAAAEAAAASAw==';
        break;
      case Characteristic.VolumeSelector.DECREMENT: // Volume down
        value = 'AAAAAQAAAAEAAAATAw==';
        break;
    }
    var post_data = that.createIRCC(value);
    that.makeHttpRequest(onError, onSucces, '', post_data, false);
  }
  // homebridge callback to set pressed key
  setRemoteKey(key, callback) {
    var value = '';
    var that = this;
    var onError = function (err) {
      if (that.debug) that.log(err);
      if (!isNull(callback))
        callback(null);
    };
    var onSucces = function (data) {
      if (!isNull(callback))
        callback(null);
    };
    // https://gist.github.com/joshluongo/51dcfbe5a44ee723dd32
    switch (key) {
      case Characteristic.RemoteKey.REWIND:
        value = 'AAAAAgAAAJcAAAAbAw==';
        break;
      case Characteristic.RemoteKey.FAST_FORWARD:
        value = 'AAAAAgAAAJcAAAAcAw==';
        break;
      case Characteristic.RemoteKey.NEXT_TRACK:
        value = 'AAAAAgAAAJcAAAA9Aw==';
        break;
      case Characteristic.RemoteKey.PREVIOUS_TRACK:
        value = 'AAAAAgAAAJcAAAB5Aw==';
        break;
      case Characteristic.RemoteKey.ARROW_UP:
        value = 'AAAAAQAAAAEAAAB0Aw==';
        break;
      case Characteristic.RemoteKey.ARROW_DOWN:
        value = 'AAAAAQAAAAEAAAB1Aw==';
        break;
      case Characteristic.RemoteKey.ARROW_LEFT:
        value = 'AAAAAQAAAAEAAAA0Aw==';
        break;
      case Characteristic.RemoteKey.ARROW_RIGHT:
        value = 'AAAAAQAAAAEAAAAzAw==';
        break;
      case Characteristic.RemoteKey.SELECT:
        value = 'AAAAAQAAAAEAAABlAw==';
        break;
      case Characteristic.RemoteKey.BACK:
        value = 'AAAAAgAAAJcAAAAjAw==';
        break;
      case Characteristic.RemoteKey.EXIT:
        value = 'AAAAAQAAAAEAAABjAw==';
        break;
      case Characteristic.RemoteKey.PLAY_PAUSE:
        value = 'AAAAAgAAAJcAAAAaAw==';
        break;
      case Characteristic.RemoteKey.INFORMATION:
        value = 'AAAAAQAAAAEAAAA6Aw==';
        break;
    }
    var post_data = that.createIRCC(value);
    that.makeHttpRequest(onError, onSucces, '', post_data, false);
  }
  // homebridge callback to get muted state
  getMuted(callback) {
    var that = this;
    if (!that.power) {
      if (!isNull(callback))
        callback(null, 0);
      return;
    }
    var getVolumeInfoVersion = that.getApiVersion('getVolumeInformation', '1.0');
    var post_data = '{"id":4,"method":"getVolumeInformation","version":"' + getVolumeInfoVersion + '","params":[]}';
    var onError = function (err) {
      if (that.debug)
        if (that.debug) that.log('[' + that.name + '] ERROR: ' + err);
      if (!isNull(callback))
        callback(null, false);
    };
    var onSucces = function (chunk) {
      if (chunk.indexOf('"error"') >= 0) {
        if (that.debug)
          that.log('[' + that.name + '] ERROR response: ' + chunk);
        if (!isNull(callback))
          callback(null, false);
        return;
      }
      var _json = null;
      try {
        _json = JSON.parse(chunk);
      } catch (e) {
        if (!isNull(callback))
          callback(null, false);
        return;
      }
      if (isNull(_json.result)) {
        if (!isNull(callback))
          callback(null, false);
        return;
      }
      for (var i = 0; i < _json.result[0].length; i++) {
        var volume = _json.result[0][i].volume;
        var typ = _json.result[0][i].target;
        if (typ === that.soundoutput) {
          if (!isNull(callback))
            callback(null, _json.result[0][i].mute);
          return;
        }
      }
      if (!isNull(callback))
        callback(null, false);
    };
    that.makeHttpRequest(onError, onSucces, '/sony/audio/', post_data, false);
  }
  // homebridge callback to set muted state
  setMuted(muted, callback) {
    var that = this;
    if (!that.power) {
      if (!isNull(callback))
        callback(null);
      return;
    }
    var merterd = muted ? 'true' : 'false';
    var setAudioMuteVersion = that.getApiVersion('setAudioMute', '1.0');
    var post_data = '{"id":13,"method":"setAudioMute","version":"' + setAudioMuteVersion + '","params":[{"status":' + merterd + '}]}';
    var onError = function (err) {
      if (that.debug)
        if (that.debug) that.log('[' + that.name + '] ERROR: ' + err);
      if (!isNull(callback))
        callback(null);
    };
    var onSucces = function (chunk) {
      if (chunk.indexOf('"error"') >= 0) {
        if (that.debug)
          that.log('[' + that.name + '] ERROR response: ' + chunk);
      }
      if (!isNull(callback))
        callback(null);
    };
    that.makeHttpRequest(onError, onSucces, '/sony/audio/', post_data, false);
  }
  // homebridge callback to get absoluet volume
  getVolume(callback) {
    var that = this;
    if (!that.power) {
      if (!isNull(callback))
        callback(null, 0);
      return;
    }
    var getVolumeInfoVersion2 = that.getApiVersion('getVolumeInformation', '1.0');
    var post_data = '{"id":4,"method":"getVolumeInformation","version":"' + getVolumeInfoVersion2 + '","params":[]}';
    var onError = function (err) {
      if (that.debug)
        if (that.debug) that.log('[' + that.name + '] ERROR: ' + err);
      if (!isNull(callback))
        callback(null, 0);
    };
    var onSucces = function (chunk) {
      if (chunk.indexOf('"error"') >= 0) {
        if (that.debug)
          that.log('[' + that.name + '] ERROR response: ' + chunk);
        if (!isNull(callback))
          callback(null, 0);
        return;
      }
      var _json = null;
      try {
        _json = JSON.parse(chunk);
      } catch (e) {
        if (!isNull(callback))
          callback(null, 0);
        return;
      }
      if (isNull(_json.result)) {
        if (!isNull(callback))
          callback(null, 0);
        return;
      }
      for (var i = 0; i < _json.result[0].length; i++) {
        var volume = _json.result[0][i].volume;
        var typ = _json.result[0][i].target;
        if (typ === that.soundoutput) {
          if (!isNull(callback))
            callback(null, volume);
          return;
        }
      }
      if (!isNull(callback))
        callback(null, 0);
    };
    that.makeHttpRequest(onError, onSucces, '/sony/audio/', post_data, false);
  }
  // homebridge callback to set absolute volume
  setVolume(volume, callback) {
    var that = this;
    if (!that.power) {
      if (!isNull(callback))
        callback(null);
      return;
    }
    // setAudioVolume v1.2 supports the "ui" parameter to control the on-screen volume
    // overlay. When "ui":"on" the TV shows the native volume slider on screen; when
    // "ui":"off" the volume changes silently. Configurable via config.volumeUI (default: false).
    var setAudioVolumeVersion = that.getApiVersion('setAudioVolume', '1.0');
    var setAudioVolumeParams;
    if (compareVersions(setAudioVolumeVersion, '1.2') >= 0) {
      var uiFlag = that.volumeUI ? 'on' : 'off';
      setAudioVolumeParams = '{"target":"' + that.soundoutput + '","volume":"' + volume + '","ui":"' + uiFlag + '"}';
    } else {
      setAudioVolumeParams = '{"target":"' + that.soundoutput + '","volume":"' + volume + '"}';
    }
    var post_data = '{"id":13,"method":"setAudioVolume","version":"' + setAudioVolumeVersion + '","params":[' + setAudioVolumeParams + ']}';
    var onError = function (err) {
      if (that.debug)
        if (that.debug) that.log('[' + that.name + '] ERROR: ' + err);
      if (!isNull(callback))
        callback(null);
    };
    var onSucces = function (chunk) {
      if (!isNull(callback))
        callback(null);
    };
    that.makeHttpRequest(onError, onSucces, '/sony/audio/', post_data, false);
  }
  // HomeKit callback to get power state
  getPowerState(callback) {
    var that = this;
    var onError = function (err) {
      if (that.debug)
        that.log('[' + that.name + '] ERROR getting power: ' + err);
      if (!isNull(callback))
        callback(null, false);
      that.updatePowerState(false);
    };
    var onSucces = function (chunk) {
      var _json = null;
      try {
        _json = JSON.parse(chunk);
        if (!isNull(_json) && !isNull(_json.result[0]) && _json.result[0].status === 'active') {
          if (that.debug) that.log('[' + that.name + '] TV is ON');
          that.updatePowerState(true);
          if (!isNull(callback))
            callback(null, true);
        } else {
          if (that.debug) that.log('[' + that.name + '] TV is OFF');
          that.updatePowerState(false);
          if (!isNull(callback))
            callback(null, false);
        }
      } catch (e) {
        if (that.debug)
          if (that.debug) that.log('[' + that.name + '] ERROR (power): ' + e);
        that.updatePowerState(false);
        if (!isNull(callback))
          callback(null, false);
      }
    };
    try {
      var getPowerStatusVersion = that.getApiVersion('getPowerStatus', '1.0');
      var post_data = '{"id":2,"method":"getPowerStatus","version":"' + getPowerStatusVersion + '","params":[]}';
      that.makeHttpRequest(onError, onSucces, '/sony/system/', post_data, false);
    } catch (globalExcp) {
      if (that.debug)
        if (that.debug) that.log('[' + that.name + '] ERROR (power global): ' + globalExcp);
      that.updatePowerState(false);
      if (!isNull(callback))
        callback(null, false);
    }
  }
  // homebridge callback to set power state
  setPowerState(state, callback) {
    var that = this;
    var callbackCalled = false;
    var invokeCallback = function () {
      if (!callbackCalled && !isNull(callback)) {
        callbackCalled = true;
        callback(null);
      }
    };

    if (state) {
      // ── POWER ON ──────────────────────────────────────────────────────────
      // Strategy (v1.4.13):
      //   1. Try REST setPowerStatus first (works when the TV's NIC is alive in
      //      WiFi/standby). If the TV accepts it, we're done.
      //   2. On REST failure, fall back to a WOL burst (5 packets at 500ms by
      //      default) targeted according to wolMode:
      //         'auto'              → unicast to the TV's IP
      //         'directed-broadcast' → subnet broadcast (woladdress)
      //         'disabled'          → no WOL, REST only
      //   3. After the burst, run a parallel REST alive poll (every 2s up to
      //      15s) for verification/logging — the HomeKit callback is invoked
      //      right after the burst so HomeKit doesn't time out.
      //   4. Set recentlyWokenAt so adaptive polling speeds up and the next
      //      channel scan is deferred by postWakeScanDelay (default 3s).
      //
      // This covers every known scenario:
      //   - TV in WiFi standby (NIC alive, no WoWLAN): REST works, WOL doesn't
      //   - TV in deep sleep (NIC off): REST fails, WOL wakes via burst
      //   - TV with REST error 15 (older Bravia): WOL fallback
      //   - TV without MAC configured / wolMode=disabled: REST only

      // Mark wake event up-front so adaptive polling kicks in immediately,
      // even before REST or WOL completes.
      that.recentlyWokenAt = Date.now();

      // v1.4.21: answer HomeKit right away. REST (up to the 8s request timeout
      // when the TV is unreachable across VLANs) plus the WOL burst (~2.5s)
      // could exceed HomeKit's ~10s budget and show "No Response". Waking is a
      // fire-and-forget operation anyway; the real state is reported by the
      // status polling (fast post-wake polling kicks in via recentlyWokenAt).
      invokeCallback();

      var setPowerOnVersion = that.getApiVersion('setPowerStatus', '1.0');
      var post_data = '{"id":2,"method":"setPowerStatus","version":"' + setPowerOnVersion + '","params":[{"status":true}]}';

      var doWolFallback = function (reason) {
        if (that.wolMode === 'disabled') {
          that.log('[' + that.name + '] [POWER] ✗ REST failed (' + reason + ') and wolMode=disabled, giving up');
          invokeCallback();
          return;
        }
        if (isNull(that.mac)) {
          that.log('[' + that.name + '] [POWER] ✗ REST failed (' + reason + ') and no MAC configured, cannot fall back to WOL');
          invokeCallback();
          return;
        }
        that.log('[' + that.name + '] [POWER] ↻ REST failed (' + reason + '), falling back to WOL burst');
        that._sendWolBurst(function (errors) {
          // Invoke HomeKit callback right after the burst completes (typical
          // total: wolBurstCount * wolBurstInterval ≈ 2.5s). The alive poll
          // runs in parallel and just logs the result.
          invokeCallback();
          if (errors.length === that.wolBurstCount) {
            that.log('[' + that.name + '] [POWER] ✗ WOL burst failed entirely, skipping alive wait');
            return;
          }
          that._waitForRestAlive(function (alive, elapsedMs) {
            if (alive) {
              // Refresh recentlyWokenAt so post-wake scan delay is measured
              // from the moment the TV actually came alive.
              that.recentlyWokenAt = Date.now();
            }
          });
        });
      };

      var onRestError = function (err) {
        doWolFallback('transport error: ' + err);
      };

      var onRestSuccess = function (chunk) {
        // The TV may return JSON with an error field even on HTTP 200 (e.g. error 15).
        try {
          var _json = JSON.parse(chunk);
          if (_json.error) {
            doWolFallback('TV returned error ' + (_json.error[0] || '') + ': ' + (_json.error[1] || ''));
            return;
          }
          // v1.4.17: a TV that requires re-authentication answers setPowerStatus
          // with HTTP 403 and a body like {"auth_url":{"default":"http://.../sony/webauth/..."}}.
          // makeHttpRequest passes any body (including 403) to this success
          // callback, and that body parses as valid JSON with no "error" field,
          // so the previous code logged "REST accepted" and marked the TV ON
          // without ever sending the WOL burst — the TV never actually turned on.
          // Detect the auth_url marker and treat it as a REST failure so the WOL
          // fallback runs (which is what actually wakes the TV in this case).
          if (_json.auth_url) {
            doWolFallback('TV requires re-authentication (HTTP 403 auth_url) — REST power-on rejected');
            return;
          }
        } catch (e) {
          doWolFallback('invalid response body: ' + chunk);
          return;
        }
        that.log('[' + that.name + '] [POWER] ✓ REST setPowerStatus accepted (TV was reachable)');
        // REST already confirmed the TV accepted the command, so it's alive.
        // Update HomeKit state immediately rather than waiting for the next poll.
        that.updatePowerState(true);
        invokeCallback();
      };

      that.log('[' + that.name + '] [POWER] → Powering ON: trying REST setPowerStatus first (wolMode=' + that.wolMode + ', mac=' + (that.mac ? 'configured' : 'none') + ')');
      that.makeHttpRequest(onRestError, onRestSuccess, '/sony/system/', post_data, false);

    } else {
      // ── POWER OFF ─────────────────────────────────────────────────────────
      // Use REST setPowerStatus(false) as the primary method. IRCC power-off
      // was previously used when MAC was configured, but setPowerStatus(false)
      // is cleaner and works on all TVs that accept REST commands (the TV is
      // always reachable when it's on). IRCC is kept as fallback only if REST
      // returns an error.
      var onOffError = function (err) {
        if (that.debug) that.log('[' + that.name + '] REST power-off failed: ' + err);
        // Fallback: try IRCC power toggle
        if (that.debug) that.log('[' + that.name + '] Falling back to IRCC power-off');
        var ircc_data = that.createIRCC('AAAAAQAAAAEAAAAvAw==');
        that.makeHttpRequest(
          function (irccErr) {
            if (that.debug) that.log('[' + that.name + '] IRCC power-off also failed: ' + irccErr);
            invokeCallback();
          },
          function () { invokeCallback(); },
          '', ircc_data, false
        );
      };

      var onOffSuccess = function (chunk) {
        try {
          var _json = JSON.parse(chunk);
          if (_json.error) {
            if (that.debug) that.log('[' + that.name + '] REST power-off returned error: ' + JSON.stringify(_json.error));
            onOffError('TV returned error ' + (_json.error[0] || '') + ': ' + (_json.error[1] || ''));
            return;
          }
        } catch (e) {
          // Non-JSON is fine for power-off (some TVs return empty)
        }
        if (that.debug) that.log('[' + that.name + '] ✓ REST power-off accepted');
        invokeCallback();
      };

      var setPowerOffVersion = that.getApiVersion('setPowerStatus', '1.0');
      var off_data = '{"id":2,"method":"setPowerStatus","version":"' + setPowerOffVersion + '","params":[{"status":false}]}';
      if (that.debug) that.log('[' + that.name + '] Powering off: trying REST setPowerStatus first');
      that.makeHttpRequest(onOffError, onOffSuccess, '/sony/system/', off_data, false);
    }
  }
  // Sends the current power state to HomeKit
  updatePowerState(state) {
    if (this.power != state) {
      this.log('[' + this.name + '] Power: ' + this.power + ' -> ' + state);
      // v1.4.13: track external OFF→ON transitions (e.g. TV powered on via the
      // physical remote, not via HomeKit) so the post-wake scan delay applies
      // and adaptive polling has a fresh reference point.
      var _cameOn = (state === true && this.power === false);
      if (_cameOn) {
        this.recentlyWokenAt = Date.now();
        if (this.debug) this.log('[' + this.name + '] [POWER] OFF→ON transition detected, recentlyWokenAt=now');
      }
      this.power = state;
      // v1.4.21: when the TV was off or unreachable at Homebridge start, the
      // one-shot boot registration failed and nothing ever retried it, so the
      // channel list was never refreshed (and a brand-new TV was never
      // published). Now, on every OFF→ON transition, either finish the
      // registration (cookie mode, not yet authenticated) or run a refresh scan
      // (already authenticated). receiveSources() applies postWakeScanDelay.
      if (_cameOn) {
        if (this.authok === true) {
          this.receiveSources(true);
        } else {
          this._requestReRegistration('TV powered on', true);
        }
      }
      this.tvService.getCharacteristic(Characteristic.Active).updateValue(this.power);
      // Sync volume accessory on/off state with TV power
      if (this.volumeAccessoryInstance) {
        const bulb = this.volumeAccessoryInstance.getService(Service.Lightbulb);
        if (bulb) {
          if (!state) {
            bulb.updateCharacteristic(Characteristic.On, false);
          } else {
            // TV turned on — refresh volume and mute state
            this.getVolume((err, vol) => {
              if (!err && vol !== null) bulb.updateCharacteristic(Characteristic.Brightness, vol);
            });
            this.getMuted((err, muted) => {
              if (!err) bulb.updateCharacteristic(Characteristic.On, !muted);
            });
          }
        }
      }
    }
  }
  // Make HTTP request to TV
  makeHttpRequest(errcallback, resultcallback, url, post_data, canTurnTvOn) {
    var that = this;
    var data = '';
    if (isNull(canTurnTvOn)) {canTurnTvOn = false;}

    // v1.4.21: guarantee that exactly ONE of errcallback/resultcallback fires,
    // exactly once. On the 8s safety timeout, req.destroy() makes Node emit an
    // extra 'error' event ("socket hang up") after the timeout handler already
    // reported the failure, so errcallback used to fire twice. In a channel scan
    // that advanced the source queue twice (skipping a source and possibly
    // finalising the scan twice); in power-on it could send two WOL bursts.
    var _settled = false;
    var _origErr = errcallback;
    var _origRes = resultcallback;
    errcallback = isNull(_origErr) ? null : function (err) {
      if (_settled) return;
      _settled = true;
      _origErr(err);
    };
    resultcallback = isNull(_origRes) ? null : function (body) {
      if (_settled) return;
      _settled = true;
      _origRes(body);
    };
    
    if (!that.power && canTurnTvOn) {
      if (that.debug) that.log('[' + that.name + '] TV off, will power on first');
      that.setPowerState(true, null);
      var timeout = that.starttimeout;
      setTimeout(function () {
        that.makeHttpRequest(errcallback, resultcallback, url, post_data, false);
      }, timeout);
      return;
    }

    // Identify the method+version being called for clearer debug output
    // and to enable the transparent error-12 (Method Not Implemented) retry-with-downgrade flow.
    var requestMethodName = null;
    var requestMethodVersion = null;
    var debugMethodInfo = '';
    try {
      const parsed = JSON.parse(post_data);
      requestMethodName = parsed.method || null;
      requestMethodVersion = parsed.version || null;
      debugMethodInfo = (parsed.method || '?') + ' v' + (parsed.version || '?') + ' id=' + (parsed.id || '?');
    } catch (e) {
      // Not JSON (e.g. SOAP / IRCC) — keep empty
      debugMethodInfo = '<non-JSON body>';
    }
    if (that.debug) {
      that.log('[' + that.name + '] ▶ HTTP ' + url + ' [' + debugMethodInfo + '] (' + post_data.length + ' bytes out)');
      // Full request body — already sanitised at construction (no PSK / no PIN ever go through actRegister body)
      that.log('[' + that.name + '] ▶ REQ: ' + post_data);
    }
    var _t0 = Date.now();

    try {
      var post_options = that.getPostOptions(url);
      // v1.4.22: actRegister is sent WITHOUT the stored cookie. Verified on a
      // KD-55X9005B: with an expired cookie in the request the TV answers 401
      // (and the plugin waited for a PIN), while the same call without cookie
      // returns a fresh cookie at once for a client it already knows, no PIN.
      if (requestMethodName === 'actRegister' && post_options.headers) delete post_options.headers.Cookie;
      // v1.4.16: log outgoing headers with secrets masked. The missing
      // Content-Type was the root cause of issue #2 (channel scan on Bravia XR)
      // and would have been impossible to spot without this. We always log the
      // header names; PSK and cookie values are replaced with their length so
      // we can confirm presence without leaking the secret.
      if (that.debug) {
        var _hdrs = {};
        Object.keys(post_options.headers || {}).forEach(function (k) {
          var v = post_options.headers[k];
          if (/^x-auth-psk$/i.test(k) || /^authorization$/i.test(k) || /^cookie$/i.test(k)) {
            _hdrs[k] = '<set, ' + String(v).length + ' chars>';
          } else {
            _hdrs[k] = v;
          }
        });
        that.log('[' + that.name + '] ▶ HDR (out): ' + JSON.stringify(_hdrs));
      }
      var post_req = http.request(post_options, function (res) {
        post_req.__responded = true;
        // v1.4.16: log incoming headers (cookie values masked). Reveals if the
        // TV is setting cookies on PSK requests, returning unexpected
        // Content-Type, or doing redirects.
        if (that.debug) {
          var _rhdrs = {};
          Object.keys(res.headers || {}).forEach(function (k) {
            var v = res.headers[k];
            if (/cookie/i.test(k)) {
              _rhdrs[k] = Array.isArray(v) ? v.map(function (s) { return '<set, ' + String(s).length + ' chars>'; }) : '<set, ' + String(v).length + ' chars>';
            } else {
              _rhdrs[k] = v;
            }
          });
          that.log('[' + that.name + '] ◀ HDR (in): HTTP ' + res.statusCode + ' ' + JSON.stringify(_rhdrs));
        }
        that.setCookie(res.headers);
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
          data += chunk;
        });
        res.on('end', function () {
          if (that.debug) {
            const _ms = Date.now() - _t0;
            that.log('[' + that.name + '] ◀ HTTP ' + res.statusCode + ' ' + url + ' [' + debugMethodInfo + '] (' + data.length + ' bytes in, ' + _ms + 'ms)');
            // Full response body. Sony API responses do not contain user secrets — they contain
            // method results, error codes, model info, channel lists. Safe to log in full.
            // Truncate at 4KB to avoid spamming logs with huge channel lists.
            const truncated = data.length > 4096 ? data.slice(0, 4096) + '... [truncated, total ' + data.length + ' bytes]' : data;
            that.log('[' + that.name + '] ◀ RES: ' + truncated);
          }
          // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          // Auto-downgrade on error 12 (Method Not Implemented at this version).
          // Some Sony firmware advertises a method+version via getMethodTypes but
          // rejects it at runtime. We catch the error here, downgrade the cached
          // version, rebuild the same request body with the new version, and retry
          // exactly once. This is fully transparent to the caller — the original
          // resultcallback is invoked with the response of the retried call.
          // The downgrade tracker is bounded (each downgraded version is blacklisted)
          // so a misbehaving method cannot cause an infinite retry loop.
          // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          const errCode = that._extractSonyErrorCode(data);
          // v1.4.17: surface authentication failures. A 401/403 (often with an
          // auth_url body) means the TV is refusing the request pending
          // re-authentication; without this line it is easy to mistake the
          // JSON body for a valid result. The body is still passed to the
          // callback (callers like onRestSuccess now handle auth_url), but the
          // warning makes the root cause obvious in the log.
          if ((res.statusCode === 401 || res.statusCode === 403) && that.debug) {
            that.log('[' + that.name + '] ⚠️  HTTP ' + res.statusCode + ' on ' + url + ' [' + debugMethodInfo + '] — TV refused the request (authentication required). Body: ' + (data.length > 200 ? data.slice(0, 200) + '...' : data));
          }
          // v1.4.21: the pairing cookie was only (re)validated at boot. If it
          // expires while Homebridge keeps running, every private call is
          // refused with 401/403 + auth_url. Re-run the registration (throttled)
          // so a fresh cookie is obtained without restarting Homebridge. For a
          // client already registered on the TV this does not show a new PIN.
          if ((res.statusCode === 401 || res.statusCode === 403) && requestMethodName !== 'actRegister') {
            that._onAuthRejected('HTTP ' + res.statusCode + ' on ' + (requestMethodName || url));
          }
          if (errCode === 12 && requestMethodName && requestMethodVersion && that.methodEndpoints[requestMethodName]) {
            const newVersion = that._downgradeApiVersion(requestMethodName);
            if (newVersion && newVersion !== requestMethodVersion) {
              try {
                const parsed = JSON.parse(post_data);
                parsed.version = newVersion;
                const retryBody = JSON.stringify(parsed);
                if (that.debug) that.log('[' + that.name + '] ↻ Retrying ' + requestMethodName + ' with v' + newVersion);
                that.makeHttpRequest(errcallback, resultcallback, url, retryBody, false);
                return;
              } catch (e) {
                if (that.debug) that.log('[' + that.name + '] retry rebuild failed: ' + e);
              }
            }
          }
          if (!isNull(resultcallback)) {
            try {
              resultcallback(data);
            } catch (cbErr) {
              that.log('[' + that.name + '] ERROR in response handler: ' + cbErr);
            }
          }
        });
      });
      post_req.on('error', function (err) {
        if (that.debug) that.log('[' + that.name + '] ✖ HTTP error on ' + url + ' [' + debugMethodInfo + ']: ' + err);
        if (!isNull(errcallback)) {
          errcallback(err);
        }
      });
      post_req.write(post_data);
      post_req.end();

      // Safety timeout: if the TV does not respond within 8 seconds (connect + response),
      // abort the request and invoke the error callback. Without this, a hung connection
      // (TV in deep sleep, half-open TCP, network glitch) causes the callback to never fire,
      // which makes Homebridge log "read handler didn't respond at all" and marks the
      // accessory as unresponsive. 8 seconds is generous enough for slow TVs (typical
      // response is 5-200ms) while still being well under Homebridge's 10-second HAP timeout.
      post_req.setTimeout(8000, function () {
        if (!post_req.__responded) {
          if (that.debug) that.log('[' + that.name + '] ✖ HTTP timeout (8s) on ' + url + ' [' + debugMethodInfo + ']');
          post_req.destroy();
          if (!isNull(errcallback)) {
            errcallback(new Error('HTTP timeout after 8000ms'));
          }
        }
      });
    } catch (e) {
      that.log('[' + that.name + '] HTTP exception: ' + e);
      if (!isNull(errcallback)) {
        errcallback(e);
      }
    }
  }
  // helper to create IRCC command string
  createIRCC(command) {
    return '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>' + command + '</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>';
  }
  // helper to apply post options to http request
  getPostOptions(url) {
    var that = this;
    if (url == '')
      url = '/sony/IRCC';
    // v1.4.21: the legacy "compatibilitymode" branch inherited from the
    // original plugin sent every request — including the pairing cookie and
    // the PSK header — to closure-compiler.appspot.com instead of the TV. It
    // has been removed: requests always go to the configured TV.
    var post_options = {
      host: that.ip,
      port: that.port,
      path: url,
      method: 'POST',
      headers: {}
    };
    if (!isNull(this.cookie)) {
      post_options.headers.Cookie = this.cookie; // = { 'Cookie': cookie };
    }
    // Pre-Shared Key authentication: newer Bravia XR models (interface v6.x+) may
    // require PSK instead of cookie-based PIN pairing. When configured, the PSK is
    // sent as an HTTP header on every request, bypassing actRegister entirely.
    if (!isNull(this.psk)) {
      post_options.headers['X-Auth-PSK'] = this.psk;
    }
    if (!isNull(this.pwd)) {
      var encpin = 'Basic ' + base64.encode(':' + this.pwd);
      post_options.headers.Authorization = encpin; // {':  encpin  };
    }
    // v1.4.16: send an explicit Content-Type for every JSON-RPC call to the
    // Sony API. The plugin historically omitted this header; older Bravia
    // firmwares are permissive and accept a body without Content-Type, but
    // newer Bravia XR firmware (interface v6.x and above) requires the header
    // explicitly. Without it, the TV accepts the connection and returns HTTP
    // 200, but does not parse the JSON body, so methods like getContentList
    // silently produce empty or error results (this matches Mamac-FR's report
    // in issue #2: curl with the header works, plugin without it does not).
    // The IRCC endpoint overrides Content-Type to text/xml below, so the
    // default is applied only for JSON-RPC calls.
    if (url != '/sony/IRCC' && !post_options.headers['Content-Type']) {
      post_options.headers['Content-Type'] = 'application/json';
    }
    if (url == '/sony/IRCC') {
      post_options.headers['Content-Type'] = 'text/xml';
      post_options.headers.SOAPACTION = '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"';
    }
    return post_options;
  }
  // helper function to extract and store passcode cookie from header
  setCookie(headers) {
    var that = this;
    var setcookie = null;
    try {
      setcookie = headers['set-cookie'];
    } catch (e) {
      setcookie = null;
    }
    if (setcookie != null && setcookie != undefined) {
      setcookie.forEach(function (cookiestr) {
        try {
          const str = cookiestr.toString();
          const prev = that.cookie;
          that.cookie = str.split(';')[0];
          that.saveCookie(that.cookie);
          // v1.4.22: remember when it expires (Max-Age or Expires; Sony uses
          // 14 days) so the plugin can renew it in time and show "days left".
          const now = Date.now();
          let exp = null;
          const ma = /;\s*max-age=(\d+)/i.exec(str);
          if (ma) exp = now + parseInt(ma[1], 10) * 1000;
          if (!exp) { const ex = /;\s*expires=([^;]+)/i.exec(str); if (ex) { const t = Date.parse(ex[1]); if (!isNaN(t)) exp = t; } }
          const meta = Object.assign({}, that.cookieMeta || {}, {
            obtainedAt: now,
            expiresAt: exp || (now + COOKIE_DEFAULT_LIFETIME_MS),
            estimated: !exp,
            renewBlocked: false
          });
          that.cookieMeta = meta;
          that._saveCookieMeta();
          if (prev && prev !== that.cookie) {
            that.log('[' + that.name + '] 🔑 Pairing cookie renewed — valid until ' + new Date(meta.expiresAt).toLocaleString());
          }
        } catch (e) {}
      });
    }
  }

  _saveCookieMeta() {
    try { fs.writeFileSync(this.cookieMetaPath, JSON.stringify(this.cookieMeta || {})); } catch (e) {}
  }

  _loadCookieMeta() {
    try { this.cookieMeta = JSON.parse(fs.readFileSync(this.cookieMetaPath, 'utf8')); } catch (e) { this.cookieMeta = null; }
    if (!this.cookieMeta || !this.cookieMeta.expiresAt) {
      // Cookie saved by an older version: estimate from the file date.
      try {
        const st = fs.statSync(this.cookiepath);
        this.cookieMeta = { obtainedAt: st.mtimeMs, expiresAt: st.mtimeMs + COOKIE_DEFAULT_LIFETIME_MS, estimated: true };
      } catch (e) { this.cookieMeta = null; }
    }
  }

  // Days left before the pairing cookie expires (null when unknown / PSK).
  cookieDaysLeft() {
    if (!isNull(this.psk) || !this.cookieMeta || !this.cookieMeta.expiresAt) return null;
    return (this.cookieMeta.expiresAt - Date.now()) / 86400000;
  }

  // v1.4.22: renew the pairing cookie BEFORE it expires. For a client the TV
  // already knows, actRegister with the still-valid cookie returns a fresh
  // one (no PIN). Called from the status loop; runs at most once a day while
  // the TV is on, and every hour in the last 3 days. If the TV answers that a
  // PIN would be needed, automatic renewal stops (so the TV does not show a
  // PIN popup every day) and the web UI asks the user to pair again.
  _maybeRenewCookie(force) {
    if (!isNull(this.psk) || !this.cookie || this.awaitingPin === true || this.authok !== true) return;
    if (this._renewInFlight) return;
    const meta = this.cookieMeta || {};
    if (!force) {
      if (this.power !== true) return;
      if (meta.renewBlocked) return;
      const left = this.cookieDaysLeft();
      const since = Date.now() - (meta.lastRenewAttempt || 0);
      const gap = (left !== null && left < 3) ? 3600000 : 20 * 3600000;
      if (since < gap) return;
    }
    this._renewCookie(() => {});
  }

  _renewCookie(cb) {
    const self = this;
    this._renewInFlight = true;
    const before = this.cookie;
    this.cookieMeta = Object.assign({}, this.cookieMeta || {}, { lastRenewAttempt: Date.now() });
    this._saveCookieMeta();
    const meta = {};
    const clientId = 'HomeBridge-Bravia' + ':' + this.accessory.context.uuid;
    const post = JSON.stringify({ id: 8, method: 'actRegister', version: this.getApiVersion('actRegister', '1.0'),
      params: [{ clientid: clientId, nickname: 'homebridge', level: 'private' }, [{ value: 'yes', function: 'WOL' }]] });
    const done = (result, note) => {
      self._renewInFlight = false;
      meta.lastRenewResult = result;
      if (result === 'renewed' || result === 'accepted') meta.lastRenewOk = Date.now();
      if (result === 'pin-required') meta.renewBlocked = true;
      self.cookieMeta = Object.assign({}, self.cookieMeta || {}, meta);
      self._saveCookieMeta();
      if (result === 'pin-required') {
        const left = self.cookieDaysLeft();
        self.log.warn('[' + self.name + '] ⚠️  The TV did not renew the pairing automatically (it asks for a PIN). ' +
          (left !== null && left > 0 ? 'Current pairing still valid ' + Math.floor(left) + ' day(s). ' : '') +
          'Pair again from the web page: Pairing & device.');
      } else if (self.debug) {
        self.log('[' + self.name + '] Cookie renewal: ' + result + (note ? ' (' + note + ')' : ''));
      }
      cb(result);
    };
    this.makeHttpRequest(
      (err) => done('unreachable', String(err)),
      (data) => {
        let j = null; try { j = JSON.parse(data); } catch (e) {}
        if (j && Array.isArray(j.result)) {
          return done(self.cookie && self.cookie !== before ? 'renewed' : 'accepted');
        }
        if (j && j.error && (j.error[0] === 401 || j.error[0] === 403)) return done('pin-required');
        done('error', data ? String(data).slice(0, 120) : '');
      },
      '/sony/accessControl/', post, false
    );
  }

  // v1.4.22: the TV refused a private call (cookie expired or revoked). Stop
  // scanning, say it ONCE, and let the registration check decide whether the
  // TV renews silently or needs a new PIN.
  _onAuthRejected(where) {
    if (!isNull(this.psk)) return;
    if (this.authok === true) {
      this.authok = false;
      const left = this.cookieDaysLeft();
      this.log.warn('[' + this.name + '] ⚠️  The TV refused the pairing cookie (' + where + ')' +
        (left !== null ? (left > 0 ? ', ' + Math.floor(left) + ' day(s) were left' : ', it expired ' + Math.ceil(-left) + ' day(s) ago') : '') +
        '. Checking the registration…');
    }
    this._requestReRegistration(where);
  }
  // Helper function to save authentication cookie to disk
  saveCookie(cookie) {
    const that = this;
    if (cookie != undefined && cookie != null && cookie.length > 0) {
      if (that.debug) that.log('[' + that.name + '] Saving cookie to: ' + this.cookiepath);
      var stream = fs.createWriteStream(this.cookiepath);
      stream.on('error', function (err) {
        that.log('[' + that.name + '] ERROR writing cookie to ' + that.cookiepath + ': ' + err + '. Pairing will need to be repeated on next restart.');
      });
      stream.once('open', function (fd) {
        stream.write(cookie);
        stream.end();
        if (that.debug) that.log('[' + that.name + '] ✓ Cookie saved');
      });
    }
  }
  // Helper function to load cookie from disk
  loadCookie() {
    var that = this;
    if (this.debug) this.log('[' + this.name + '] Loading cookie from: ' + this.cookiepath);
    fs.readFile(this.cookiepath, function (err, data) {
      if (err) {
        if (that.debug) that.log('[' + that.name + '] No cookie at ' + that.cookiepath);
        if (that.debug)
          that.log('[' + that.name + '] Cookie error: ' + err);
        return;
      }
      if (that.debug) that.log('[' + that.name + '] ✓ Cookie loaded from ' + that.cookiepath);
      if (that.debug)
        that.log('[' + that.name + '] Cookie loaded from ' + that.cookiepath);
      that.cookie = data.toString();
      that._loadCookieMeta();
      that.awaitingPin = false;
});
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEB SERVER - Permanent server for channel selection and PIN entry
  // ══════════════════════════════════════════════════════════════════════════
  
  startWebServer() {
    const self = this;

    if (this.webServer) {
      if (this.debug) this.log('[' + this.name + '] Web server already running');
      return;
    }
    
    this.webServer = http.createServer((req, res) => {
      const urlObject = url.parse(req.url, true);
      const pathname = urlObject.pathname;


      // Pairing UI and API (same webserver/port)
      if (pathname === '/pair') {
        self.serveFile(res, path.join(__dirname, 'web', 'pairing.html'), 'text/html');
        return;
      }
      if (pathname === '/web/pairing.js') {
        self.serveFile(res, path.join(__dirname, 'web', 'pairing.js'), 'application/javascript');
        return;
      }
      // v1.4.21: shared design system for all pages (always available, no
      // secrets inside) and the channel selector script under /web/.
      if (pathname === '/web/ui.css') {
        self.serveFile(res, path.join(__dirname, 'web', 'ui.css'), 'text/css');
        return;
      }
      if (pathname === '/web/ui.js') {
        self.serveFile(res, path.join(__dirname, 'web', 'ui.js'), 'application/javascript');
        return;
      }
      if (pathname === '/web/channel-selector.js') {
        if (!self.enableChannelSelector) { res.writeHead(404); res.end('Channel Selector is disabled'); return; }
        self.serveFile(res, path.join(__dirname, 'web', 'channel-selector.js'), 'application/javascript');
        return;
      }
      // v1.4.21: recordings page (USB drive on the TV) and diagnostics.
      if (pathname === '/recordings') {
        self.serveFile(res, path.join(__dirname, 'web', 'recordings.html'), 'text/html');
        return;
      }
      if (pathname === '/web/recordings.js') {
        self.serveFile(res, path.join(__dirname, 'web', 'recordings.js'), 'application/javascript');
        return;
      }
      if (pathname === '/api/renew-cookie' && req.method === 'POST') {
        if (!isNull(self.psk)) return self.sendJSON(res, { success: false, message: 'PSK authentication: no cookie to renew' });
        if (!self.cookie || self.awaitingPin === true) return self.sendJSON(res, { success: false, message: 'Not paired: pair with a PIN first' });
        self._renewCookie((result) => {
          const ok = result === 'renewed' || result === 'accepted';
          self.sendJSON(res, { success: ok, result: result, cookie: self.cookieStatus(),
            message: ok ? null : (result === 'unreachable' ? 'The TV is not reachable (off?)' : result === 'pin-required' ? 'The TV asks for a new PIN: pair again' : 'The TV did not accept the request') });
        });
        return;
      }
      if (pathname === '/api/diagnostics' && req.method === 'GET') {
        self.apiDiagnostics(req, res);
        return;
      }
      if (pathname === '/api/recordings' && req.method === 'GET') {
        self.apiRecordings(req, res);
        return;
      }
      if (pathname.indexOf('/api/recordings/') === 0 && req.method === 'POST') {
        self.apiRecordingAction(req, res, pathname.slice('/api/recordings/'.length));
        return;
      }
      // v1.4.21: one call with everything the page header needs.
      if (pathname === '/api/status') {
        self.sendJSON(res, self.getUiStatus());
        return;
      }
      if (pathname === '/api/pairing-status') {
        const tv = urlObject.query.tv;
        if (isNull(tv) || tv !== self.name) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ success: false, message: 'Missing or invalid tv parameter' }));
          return;
        }
        // Pairing is a one-time operation. If a cookie file exists (or cookie is loaded), we treat the TV as paired.
        const cookieExists = (() => {
          try { return fs.existsSync(self.cookiepath); } catch (e) { return false; }
        })();
        const hasCookieInMemory = (!!self.cookie && String(self.cookie).length > 0);
// Consider the TV paired only if we are authenticated OR we have a cookie and we are NOT currently awaiting a PIN.
// If the user removed pairing on the TV, checkRegistration() will set awaitingPin=true and clear the cookie.
const paired = (self.awaitingPin !== true) && ((self.authok === true) || cookieExists || hasCookieInMemory);
const pinRequired = !paired;
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ success: true, paired, pinRequired }));
        return;
      }
      if (pathname === '/api/pin' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}');
            const tv = urlObject.query.tv;
            if (isNull(tv) || tv !== self.name) {
              res.writeHead(400, {'Content-Type': 'application/json'});
              res.end(JSON.stringify({ success: false, message: 'Missing or invalid tv parameter' }));
              return;
            }
            const pin = payload.pin ? String(payload.pin).trim() : '';
            if (!pin) {
              res.writeHead(400, {'Content-Type': 'application/json'});
              res.end(JSON.stringify({ success: false, message: 'Missing pin' }));
              return;
            }
            self.pwd = pin;
            self.awaitingPin = false;
            self.log('[' + self.name + '] PIN received via web UI, retrying auth');
            self.checkRegistration();
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ success: true }));
          } catch (e) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
          }
        });
        return;
      }

      
      if (urlObject.query.pin) {
        self.handlePinEntry(urlObject.query.pin, res);
        return;
      }

      if (pathname === '/api/device-info') {
        const tv = urlObject.query.tv;
        if (isNull(tv) || tv !== self.name) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ success: false, message: 'Missing or invalid tv parameter' }));
          return;
        }
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ success: true, data: self.getDeviceInfo() }));
        return;
      }

      // Request a new PIN from the TV without restarting Homebridge.
      // Sends actRegister without cookie/auth, which causes the TV to display
      // a PIN on screen. The user then enters the PIN in the pairing UI.
      if (pathname === '/api/request-pin' && req.method === 'POST') {
        const tv = urlObject.query.tv;
        if (isNull(tv) || tv !== self.name) {
          self.sendJSON(res, { success: false, message: 'Missing or invalid tv parameter' });
          return;
        }
        // Clear existing auth state so actRegister triggers a fresh PIN prompt
        self.cookie = '';
        self.authok = false;
        self.registercheck = false;
        self.awaitingPin = true;
        self.pwd = null;
        self.log('[' + self.name + '] PIN request triggered from web UI');
        // Send actRegister to TV — this will cause the TV to show a PIN popup
        self.checkRegistration();
        self.sendJSON(res, { success: true, message: 'PIN requested. Check your TV screen.' });
        return;
      }

      // Channel Selector routes are gated behind the enableChannelSelector option.
      // The pairing flow above is always reachable; only the selector UI is optional.
      if (pathname === '/api/tvs') {
        if (!self.enableChannelSelector) {
          res.writeHead(404, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ success: false, message: 'Channel Selector is disabled in plugin config (enableChannelSelector=false)' }));
          return;
        }
        self.apiGetTVs(req, res);
      } else if (pathname === '/api/scan') {
        if (!self.enableChannelSelector) {
          res.writeHead(404, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ success: false, message: 'Channel Selector is disabled in plugin config (enableChannelSelector=false)' }));
          return;
        }
        self.apiScanChannels(req, res);
      } else if (pathname === '/api/inputs') {
        if (!self.enableChannelSelector) {
          res.writeHead(404, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ success: false, message: 'Channel Selector is disabled in plugin config (enableChannelSelector=false)' }));
          return;
        }
        self.apiGetExternalInputsStatus(req, res);
      } else if (pathname === '/api/selection') {
        if (!self.enableChannelSelector) {
          res.writeHead(404, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ success: false, message: 'Channel Selector is disabled in plugin config (enableChannelSelector=false)' }));
          return;
        }
        self.apiGetSelection(req, res);
      } else if (pathname === '/api/save') {
        if (!self.enableChannelSelector) {
          res.writeHead(404, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ success: false, message: 'Channel Selector is disabled in plugin config (enableChannelSelector=false)' }));
          return;
        }
        self.apiSaveSelection(req, res);
      } else if (pathname === '/api/delete-cookie' && req.method === 'POST') {
        // Always available regardless of enableChannelSelector flag because the
        // Pairing page (which is part of the always-on web server) needs it.
        self.apiDeleteCookie(req, res);
      } else if (pathname === '/discover') {
        // v1.4.20: Autoscan UI page. Always served (regardless of
        // enableChannelSelector) so a fresh install can find TVs before any
        // are configured.
        self.serveFile(res, path.join(__dirname, 'web', 'discover.html'), 'text/html');
      } else if (pathname === '/web/discover.js') {
        self.serveFile(res, path.join(__dirname, 'web', 'discover.js'), 'application/javascript');
      } else if (pathname === '/api/discover' && req.method === 'GET') {
        // v1.4.20: trigger an HTTP sweep across the configured discoveryRange
        // (or the local /24 if none is set). Returns the list of Bravia TVs
        // found, with model / interface version / MAC (best-effort via ARP).
        self.apiDiscover(req, res);
      } else if (pathname === '/api/managed-tvs' && req.method === 'GET') {
        // v1.4.20: dump the current tvs-managed.json content, with each
        // managed entry annotated with whether it conflicts with config.json.
        self.apiManagedList(req, res);
      } else if (pathname === '/api/managed-tvs' && req.method === 'POST') {
        // v1.4.20: add a new managed TV. Body: { ip, name, psk?, tvsource? }.
        // The plugin enriches the entry with getSystemInformation when a PSK
        // is provided, then persists. Returns the saved entry.
        self.apiManagedAdd(req, res);
      } else if (pathname.indexOf('/api/managed-tvs/') === 0 && req.method === 'PATCH') {
        // v1.4.20: update an existing managed TV by MAC. Allowed fields:
        // name, ip, psk, tvsource, enabled.
        self.apiManagedPatch(req, res, pathname.slice('/api/managed-tvs/'.length));
      } else if (pathname.indexOf('/api/managed-tvs/') === 0 && req.method === 'DELETE') {
        // v1.4.20: remove a single managed TV by MAC.
        self.apiManagedDelete(req, res, pathname.slice('/api/managed-tvs/'.length));
      } else if (pathname === '/api/managed-tvs/clear' && req.method === 'POST') {
        // v1.4.20: wipe the managed file (the UI prompts for confirmation
        // client-side; this endpoint trusts the request and always backs up
        // before clearing).
        self.apiManagedClear(req, res);
      } else if (pathname === '/channel-selector.js') {
        if (!self.enableChannelSelector) {
          res.writeHead(404);
          res.end('Channel Selector is disabled');
          return;
        }
        self.serveFile(res, path.join(__dirname, 'web', 'channel-selector.js'), 'application/javascript');
      } else {
        // Default landing page:
        // - If the TV is not paired (no valid cookie / awaiting PIN), redirect to the Pairing page.
        // - Otherwise: show the Channel Selector if enabled, or a small info page explaining the flag is off.
        const cookieExists = (() => { try { return fs.existsSync(self.cookiepath); } catch (e) { return false; } })();
        const hasCookieInMemory = (!!self.cookie && String(self.cookie).length > 0);
        const paired = (self.awaitingPin !== true) && ((self.authok === true) || cookieExists || hasCookieInMemory);
        if (!paired) {
          res.writeHead(302, { 'Location': '/pair?tv=' + encodeURIComponent(self.name) });
          res.end();
          return;
        }
        if (!self.enableChannelSelector) {
          // Channel Selector UI is disabled; redirect to pairing page (still useful for re-pairing).
          res.writeHead(302, { 'Location': '/pair?tv=' + encodeURIComponent(self.name) });
          res.end();
          return;
        }
        self.serveFile(res, path.join(__dirname, 'web', 'channel-selector.html'), 'text/html');
      }
    });
    
    this.webServer.listen(this.channelSelectorPort, '0.0.0.0', () => {
      const _ip     = getLocalIp();
      const _suffix = getDomainSuffix();
      const _port   = self.channelSelectorPort;
      const _ipBase = (_ip ? 'http://' + _ip : 'http://' + os.hostname()) + ':' + _port;
      const _dnBase = _suffix ? 'http://' + os.hostname() + _suffix + ':' + _port : null;
      const _selectorOn = self.enableChannelSelector;
      self.log('[' + self.name + '] ════════════════════════════════════════════════════════');
      self.log('[' + self.name + '] 🌐 Bravia Web UI - ACTIVE' + (_selectorOn ? ' (Channel Selector + Pairing)' : ' (Pairing only — Channel Selector disabled)'));
      self.log('[' + self.name + '] ════════════════════════════════════════════════════════');
      if (_selectorOn) {
        self.log('[' + self.name + '] 📺 Channels: ' + _ipBase + '/');
        if (_dnBase) self.log('[' + self.name + '] 📺 Also try: ' + _dnBase + '/');
      }
      self.log('[' + self.name + '] 🔑 Pairing : ' + _ipBase + '/pair?tv=' + encodeURIComponent(self.name));
      if (_dnBase) self.log('[' + self.name + '] 🔑 Also try: ' + _dnBase + '/pair?tv=' + encodeURIComponent(self.name));
      self.log('[' + self.name + '] 🔧 Test locally: curl http://127.0.0.1:' + _port + '/pair?tv=' + encodeURIComponent(self.name));
      self.log('[' + self.name + '] ════════════════════════════════════════════════════════');
    });
    
    this.webServer.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        // v1.4.21: each TV runs its own web server. With several TVs on the
        // default port only the first one gets it, and the pairing / Channel
        // Selector pages of the others are unreachable.
        self.log('[' + self.name + '] ⚠️  Web UI port ' + self.channelSelectorPort + ' is already in use (another TV of this plugin or another program). Pairing and Channel Selector for this TV are NOT available. Give each TV its own "serverPort" (e.g. 8999, 9000, 9001...).');
      } else {
        self.log('[' + self.name + '] Web ERROR: ' + err);
      }
    });
  }
  
  serveFile(res, filepath, contentType) {
    fs.readFile(filepath, (err, data) => {
      if (err) {
        if (this.debug) this.log('[' + this.name + '] File not found: ' + filepath);
        res.writeHead(404, {'Content-Type': 'text/plain'});
        res.end('File not found');
      } else {
        res.writeHead(200, {'Content-Type': contentType + '; charset=utf-8'});
        res.end(data);
      }
    });
  }
  
  handlePinEntry(pin, res) {
    this.pwd = pin;
    if (this.debug) {
      this.log('[' + this.name + '] 🔑 PAIRING TRACE: PIN received from web UI: ' + this._sanitize(pin, 'pin'));
      this.log('[' + this.name + '] 🔑 PAIRING TRACE: triggering checkRegistration to send PIN-authenticated actRegister');
    } else {
      this.log('[' + this.name + '] PIN received');
    }
    this.registercheck = false;
    this.checkRegistration();
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end('<html><body><h1>✓ PIN Received!</h1><p>Authenticating...</p><script>setTimeout(()=>location.href="/",2000)</script></body></html>');
  }
  
  apiGetTVs(req, res) {
    this.sendJSON(res, { success: true, tvs: [{ name: this.name, ip: this.ip }] });
  }

  // Returns the cached connection status of all external (HDMI) inputs for the web UI
  apiGetExternalInputsStatus(req, res) {
    const urlObject = url.parse(req.url, true);
    const tvName = urlObject.query.tv;
    if (!tvName || tvName !== this.name) {
      return this.sendJSON(res, { success: false, error: 'TV mismatch' });
    }
    // Convert Map to plain object array for JSON serialization
    const inputs = [];
    this.externalInputsStatus.forEach(function (status, uri) {
      inputs.push({ uri, title: status.title, label: status.label, connection: status.connection, icon: status.icon });
    });
    this.sendJSON(res, { success: true, inputs });
  }
  
  apiScanChannels(req, res) {
    const self = this;
    const urlObject = url.parse(req.url, true);
    const tvName = urlObject.query.tv;
    
    if (!tvName || tvName !== this.name) {
      return this.sendJSON(res, { success: false, error: 'TV mismatch' });
    }

    const reply = (rescanState) => {
      const extra = rescanState ? { rescan: rescanState } : {};
      if (fs.existsSync(self.fullScanCachePath)) {
        try {
          const cached = JSON.parse(fs.readFileSync(self.fullScanCachePath, 'utf8'));
          let formatted = self.formatChannelsForWeb(cached.channels, cached.dispNums, cached.mediaTypes, cached.recMeta);
          formatted = self.appendApplicationsToWebChannels(formatted);
          return self.sendJSON(res, Object.assign({ success: true, channels: formatted, maxChannels: self.maxInputSources, totalFound: formatted.length, scannedAt: cached.savedAt || null }, extra));
        } catch (e) {}
      }
      if (self.scannedChannels.length > 0) {
        let formatted = self.formatChannelsForWeb(self.scannedChannels);
        formatted = self.appendApplicationsToWebChannels(formatted);
        return self.sendJSON(res, Object.assign({ success: true, channels: formatted, maxChannels: self.maxInputSources, totalFound: formatted.length }, extra));
      }
      let formatted = self.appendApplicationsToWebChannels([]);
      self.sendJSON(res, Object.assign({ success: true, channels: formatted, maxChannels: self.maxInputSources, totalFound: formatted.length }, extra));
    };

    // v1.4.21: "Rescan TV" really asks the TV for a fresh list (up to v1.4.20
    // the rescan flag was ignored and the cached list was returned). Waits
    // for the scan to finish (max ~30 s), then answers with the new cache.
    if (urlObject.query.rescan === '1') {
      if (!self.power) return reply('tv-off');
      const started = Date.now();
      if (!self.receivingSources) {
        self.recentlyWokenAt = 0; // no post-wake delay for a manual rescan
        self.receiveSources(true);
      }
      const poll = () => {
        if (!self.receivingSources) return reply('done');
        if (Date.now() - started > 30000) return reply('timeout');
        setTimeout(poll, 400);
      };
      setTimeout(poll, 400);
      return;
    }
    reply(null);
  }
  
  apiGetSelection(req, res) {
    const urlObject = url.parse(req.url, true);
    const tvName = urlObject.query.tv;
    
    if (!tvName || tvName !== this.name) {
      return this.sendJSON(res, { success: false, selection: [] });
    }
    
    if (fs.existsSync(this.selectedChannelsPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.selectedChannelsPath, 'utf8'));
        const uris = data.channels.map(ch => ch.uri);
        // v1.4.21: also return the saved objects (with their HomeKit
        // identifier) so the UI can keep identifiers stable on re-save.
        const channels = data.channels.map(ch => ({ uri: ch.uri, name: ch.name, identifier: ch.identifier }));
        return this.sendJSON(res, { success: true, selection: uris, channels: channels, savedAt: data.savedAt || null });
      } catch (e) {}
    }
    
    this.sendJSON(res, { success: true, selection: [] });
  }
  
  apiSaveSelection(req, res) {
    const self = this;
    let body = '';
    
    req.on('data', chunk => { body += chunk.toString(); });
    
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        
        if (!data.tv || data.tv !== self.name || !Array.isArray(data.channels)) {
          return self.sendJSON(res, { success: false, error: 'Invalid data' });
        }
        
        const onMainTv = self._mainTvChannels(data.channels.map(ch => [ch.name, ch.uri, ch.sourceType])).length;
        if (onMainTv > self.maxInputSources) {
          return self.sendJSON(res, { success: false, error: 'Too many channels' });
        }
        
        const saveData = { tv: data.tv, channels: data.channels, savedAt: new Date().toISOString() };

        fs.writeFileSync(self.selectedChannelsPath, JSON.stringify(saveData, null, 2));

        // Respond immediately so the browser UI doesn't hang if syncAccessory is slow or throws.
        self.sendJSON(res, { success: true, message: 'Saved', channelCount: data.channels.length });

        // Apply selection asynchronously to avoid blocking the HTTP response.
        // v1.4.21: wait for a running scan to finish first (it writes into
        // scannedChannels too), keep the full scan list afterwards, and write
        // the identifiers HomeKit actually uses back into the selection file so
        // they stay the same after a restart.
        const started = Date.now();
        const apply = () => {
          if (self.receivingSources && Date.now() - started < 30000) { setTimeout(apply, 300); return; }
          const full = self.scannedChannels;
          try {
            // v1.4.22: take the input type from the scan when the client did not send it.
            const typeOf = new Map((Array.isArray(full) ? full : []).map((c) => [c[1], c[2]]));
            const picked = data.channels.map(ch => [ch.name, ch.uri, (ch.sourceType != null ? ch.sourceType : typeOf.get(ch.uri)), (ch.identifier != null ? ch.identifier : null)]);
            self._refreshSideAccessories(Array.isArray(full) && full.length ? full : self._readFullScanCache(), picked);
            self.scannedChannels = self._mainTvChannels(picked);
            self.syncAccessory();
            let changed = false;
            saveData.channels.forEach((ch) => {
              const svc = self.uriToInputSource.get(ch.uri);
              if (svc) {
                const id = svc.getCharacteristic(Characteristic.Identifier).value;
                if (ch.identifier !== id) { ch.identifier = id; changed = true; }
              }
            });
            if (changed) fs.writeFileSync(self.selectedChannelsPath, JSON.stringify(saveData, null, 2));
            self.log('[' + self.name + '] ✓ Channel selection applied from web UI: ' + data.channels.length + ' inputs');
          } catch (e) {
            self.log('[' + self.name + '] ERROR applying selection: ' + e.toString());
          } finally {
            self.receivingSources = false;
            if (Array.isArray(full) && full.length > 0) self.scannedChannels = full;
          }
        };
        setTimeout(apply, 10);
      } catch (e) {
        self.sendJSON(res, { success: false, error: e.toString() });
      }
    });
  }

  // Force re-pairing by deleting the stored cookie and clearing in-memory auth state.
  // The Pairing UI calls this endpoint when the user clicks "Delete cookie & force re-pairing".
  // Note: this only resets the plugin side. The TV may still hold the previous client_id in
  // its registered devices list, in which case the next actRegister will be accepted without
  // a new PIN. To force a fresh PIN prompt the user must also remove "homebridge" from the
  // TV's "Network -> Remote Start -> Registered Devices" menu.
  apiDeleteCookie(req, res) {
    const self = this;
    const urlObject = url.parse(req.url, true);
    const tvName = urlObject.query.tv;

    if (!tvName || tvName !== self.name) {
      return self.sendJSON(res, { success: false, message: 'TV mismatch' });
    }

    try {
      let removed = false;
      if (fs.existsSync(self.cookiepath)) {
        fs.unlinkSync(self.cookiepath);
        removed = true;
      }
      // Clear in-memory state so the next polling cycle triggers a fresh registration.
      self.cookie = '';
      self.authok = false;
      self.registercheck = false;
      if (self.debug) self.log('[' + self.name + '] Cookie deleted by web UI request, in-memory auth state reset');
      self.sendJSON(res, {
        success: true,
        message: removed ? 'Cookie deleted' : 'No cookie file present, in-memory state reset'
      });
    } catch (e) {
      self.log('[' + self.name + '] ERROR deleting cookie: ' + e.toString());
      self.sendJSON(res, { success: false, message: 'Could not delete cookie: ' + e.toString() });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v1.4.20: Autoscan / managed-TVs HTTP API
  // ─────────────────────────────────────────────────────────────────────────

  // Resolve the list of host IPs to sweep. Looks at platform.discoveryRange
  // first (string or string[]), falls back to the local /24 derived from
  // getLocalIp(). Returns { hosts, ranges, source } for logging/diagnostics.
  _autoscanResolveHosts() {
    const platform = this.platform || {};
    let ranges = platform.discoveryRange;
    let source = 'config.discoveryRange';
    if (!ranges) {
      const localIp = getLocalIp();
      if (!localIp) return { hosts: [], ranges: [], source: 'autodetect (failed)' };
      const prefix = localIp.split('.').slice(0, 3).join('.');
      ranges = [prefix + '.0/24'];
      source = 'autodetect from local IP ' + localIp;
    }
    if (typeof ranges === 'string') ranges = [ranges];
    if (!Array.isArray(ranges)) ranges = [];
    const all = [];
    const accepted = [];
    ranges.forEach(function (r) {
      const expanded = expandCidr(r);
      if (expanded) {
        accepted.push(r);
        // Deduplicate while preserving order.
        expanded.forEach(function (ip) { if (all.indexOf(ip) === -1) all.push(ip); });
      }
    });
    return { hosts: all, ranges: accepted, source: source };
  }

  // GET /api/discover — sweep + return found TVs with ARP-resolved MAC.
  // Also annotates whether each MAC is already in config.json or already in
  // the managed file, so the UI can grey out duplicates.
  apiDiscover(req, res) {
    const self = this;
    const resolved = self._autoscanResolveHosts();
    if (resolved.hosts.length === 0) {
      return self.sendJSON(res, {
        success: false,
        message: 'No subnet to scan. Set "discoveryRange" in plugin config, or ensure the host has a non-loopback IPv4 address.'
      });
    }
    self.log('[' + self.name + '] /api/discover: sweeping ' + resolved.hosts.length + ' host(s) on ' + resolved.ranges.join(', ') + ' (' + resolved.source + ')');
    runDiscoverySweep(resolved.hosts, { concurrency: 32, timeoutMs: 2000 }, self.log, function (found) {
      // Build the MAC-indexed view of what's already known so the UI can grey
      // duplicates out instead of failing on POST later.
      const configMacs = {};
      const configByMac = {};
      const platform = self.platform || {};
      (platform.config && platform.config.tvs ? platform.config.tvs : []).forEach(function (t) {
        const nm = normaliseMac(t.mac);
        if (nm) { configMacs[nm] = true; configByMac[nm] = t.name; }
      });
      const managedMacs = {};
      let managedData = { managedTvs: [] };
      try { managedData = loadManagedTvs(self.log); } catch (e) {}
      (managedData.managedTvs || []).forEach(function (m) {
        const nm = normaliseMac(m.mac);
        if (nm) managedMacs[nm] = m.name;
      });
      const enriched = found.map(function (f) {
        const nm = normaliseMac(f.mac);
        return {
          ip: f.ip,
          mac: nm,
          productCategory: f.productCategory,
          productName: f.productName,
          modelName: f.modelName,
          serverName: f.serverName,
          interfaceVersion: f.interfaceVersion,
          // Suggest a default display name based on the TV info.
          suggestedName: (f.productName || 'BRAVIA') + (f.modelName ? ' ' + f.modelName : ''),
          // Help the UI decide whether to require PSK upfront.
          authHint: self._guessAuthMode(f.interfaceVersion),
          inConfig: nm ? !!configMacs[nm] : false,
          inConfigAs: nm && configMacs[nm] ? configByMac[nm] : null,
          inManaged: nm ? !!managedMacs[nm] : false,
          inManagedAs: nm && managedMacs[nm] ? managedMacs[nm] : null
        };
      });
      self.log('[' + self.name + '] /api/discover: ' + enriched.length + ' Bravia TV(s) found');
      self.sendJSON(res, {
        success: true,
        scannedHosts: resolved.hosts.length,
        ranges: resolved.ranges,
        source: resolved.source,
        results: enriched
      });
    });
  }

  // Heuristic auth mode hint based on interface version. Bravia XR (v6.x+)
  // requires PSK in most setups; older Android TVs can pair via PIN+cookie.
  // This is informational only — the user can always override.
  _guessAuthMode(interfaceVersion) {
    if (!interfaceVersion) return 'unknown';
    const major = parseInt(String(interfaceVersion).split('.')[0], 10);
    if (isNaN(major)) return 'unknown';
    if (major >= 6) return 'psk-recommended';
    return 'cookie-pairing';
  }

  // GET /api/managed-tvs — list managed entries with conflict annotation.
  apiManagedList(req, res) {
    const self = this;
    let data;
    try { data = loadManagedTvs(self.log); }
    catch (e) { return self.sendJSON(res, { success: false, message: 'Could not load managed file: ' + e.message }); }
    // Annotate each entry with conflict-with-config flag.
    const platform = self.platform || {};
    const configMacs = {};
    (platform.config && platform.config.tvs ? platform.config.tvs : []).forEach(function (t) {
      const nm = normaliseMac(t.mac);
      if (nm) configMacs[nm] = t.name;
    });
    const out = (data.managedTvs || []).map(function (m) {
      const nm = normaliseMac(m.mac);
      const conflictsWithConfig = nm && configMacs[nm];
      const out = Object.assign({}, m, {
        mac: nm,
        conflictsWithConfig: !!conflictsWithConfig,
        conflictName: conflictsWithConfig ? configMacs[nm] : null,
        // v1.4.21: never return the PSK itself on this unauthenticated LAN
        // endpoint; the UI only needs to know whether one is set.
        psk: m.psk ? true : undefined,
        hasPsk: !!m.psk
      });
      return out;
    });
    self.sendJSON(res, { success: true, autoscanEnabled: !!(platform.autoscan), version: data.version || 1, managedTvs: out });
  }

  // POST /api/managed-tvs — body { ip, name, psk?, tvsource?, mac? }.
  // The plugin verifies the TV is reachable and (if a PSK is given) calls
  // getSystemInformation to enrich the entry with serial/MAC/generation.
  apiManagedAdd(req, res) {
    const self = this;
    let body = '';
    req.on('data', function (chunk) { body += chunk; if (body.length > 16384) { req.destroy(); } });
    req.on('end', function () {
      let payload;
      try { payload = JSON.parse(body || '{}'); }
      catch (e) { return self.sendJSON(res, { success: false, message: 'Invalid JSON body' }); }
      const ip = (payload.ip || '').trim();
      const name = (payload.name || '').trim();
      if (!ip) return self.sendJSON(res, { success: false, message: 'Missing required field: ip' });
      if (!name) return self.sendJSON(res, { success: false, message: 'Missing required field: name' });
      const psk = payload.psk ? String(payload.psk) : null;
      const tvsource = payload.tvsource || null;
      // Step 1: try to enrich via getSystemInformation. This needs auth.
      // - With PSK: we get serial/macAddr/generation/fwVersion right away.
      // - Without PSK (cookie pairing TVs): skipped; we use ARP for MAC.
      const finishWith = function (enriched, enrichmentError) {
        // Resolve MAC: enrichment first, then ARP, then payload.mac, else null.
        let mac = enriched && enriched.macAddr ? normaliseMac(enriched.macAddr) : null;
        if (!mac) mac = arpLookup(ip);
        if (!mac && payload.mac) mac = normaliseMac(payload.mac);
        // Without a MAC the entry has no stable key; reject.
        if (!mac) {
          return self.sendJSON(res, {
            success: false,
            message: 'Could not resolve a MAC address for ' + ip + '. ' +
              (psk ? 'PSK enrichment failed (' + (enrichmentError || 'no macAddr in response') + '), ' : '') +
              'and the host ARP table did not return one (try pinging the TV first, or pass "mac" in the request body).'
          });
        }
        // Check duplicates against config.json — config wins, refuse add.
        const platform = self.platform || {};
        const configTvs = (platform.config && platform.config.tvs) ? platform.config.tvs : [];
        for (let i = 0; i < configTvs.length; i++) {
          if (normaliseMac(configTvs[i].mac) === mac) {
            return self.sendJSON(res, {
              success: false,
              message: 'A TV with MAC ' + mac + ' is already in config.json as "' + (configTvs[i].name || '?') + '". Edit it there instead.'
            });
          }
        }
        // Load + upsert managed entry.
        let data;
        try { data = loadManagedTvs(self.log); }
        catch (e) { return self.sendJSON(res, { success: false, message: 'Could not load managed file: ' + e.message }); }
        const existingIdx = (data.managedTvs || []).findIndex(function (m) { return normaliseMac(m.mac) === mac; });
        const nowIso = new Date().toISOString();
        const entry = {
          mac: mac,
          name: name,
          ip: ip,
          psk: psk || undefined,
          tvsource: tvsource || undefined,
          enabled: existingIdx >= 0 ? (data.managedTvs[existingIdx].enabled !== false) : true,
          addedAt: existingIdx >= 0 ? (data.managedTvs[existingIdx].addedAt || nowIso) : nowIso,
          lastSeen: nowIso,
          discovered: {
            model: enriched && enriched.model ? enriched.model : (payload.modelName || null),
            productName: payload.productName || null,
            interfaceVer: payload.interfaceVersion || null,
            serial: enriched && enriched.serial ? enriched.serial : null,
            generation: enriched && enriched.generation ? enriched.generation : null,
            fwVersion: enriched && enriched.fwVersion ? enriched.fwVersion : null
          }
        };
        if (existingIdx >= 0) data.managedTvs[existingIdx] = entry;
        else data.managedTvs.push(entry);
        try {
          const bak = saveManagedTvs(data, self.log);
          self.log('[' + self.name + '] /api/managed-tvs (POST): ' + (existingIdx >= 0 ? 'updated' : 'added') + ' "' + name + '" (' + mac + ', ' + ip + ')' + (bak ? ' [backup: ' + bak + ']' : ''));
          self.sendJSON(res, {
            success: true,
            message: existingIdx >= 0 ? 'Updated' : 'Added',
            entry: Object.assign({}, entry, { psk: entry.psk ? true : undefined, hasPsk: !!entry.psk }),
            backup: bak,
            enrichmentError: enrichmentError,
            restartRequired: true
          });
        } catch (e) {
          self.log('[' + self.name + '] /api/managed-tvs (POST) ERROR: ' + e.message);
          self.sendJSON(res, { success: false, message: 'Save failed: ' + e.message });
        }
      };
      // No PSK → skip enrichment, go straight to MAC resolution.
      if (!psk) return finishWith(null, 'no PSK provided');
      fetchSystemInformation(ip, psk, 4000, function (err, sysInfo) {
        if (err) return finishWith(null, err);
        finishWith(sysInfo, null);
      });
    });
  }

  // PATCH /api/managed-tvs/:mac — partial update of an existing entry.
  apiManagedPatch(req, res, macRaw) {
    const self = this;
    const targetMac = normaliseMac(decodeURIComponent(macRaw || ''));
    if (!targetMac) return self.sendJSON(res, { success: false, message: 'Invalid MAC in path' });
    let body = '';
    req.on('data', function (chunk) { body += chunk; if (body.length > 16384) { req.destroy(); } });
    req.on('end', function () {
      let payload;
      try { payload = JSON.parse(body || '{}'); }
      catch (e) { return self.sendJSON(res, { success: false, message: 'Invalid JSON body' }); }
      let data;
      try { data = loadManagedTvs(self.log); }
      catch (e) { return self.sendJSON(res, { success: false, message: 'Could not load managed file: ' + e.message }); }
      const idx = (data.managedTvs || []).findIndex(function (m) { return normaliseMac(m.mac) === targetMac; });
      if (idx < 0) return self.sendJSON(res, { success: false, message: 'No managed TV with MAC ' + targetMac });
      const entry = data.managedTvs[idx];
      // Allow-listed fields only.
      const allowed = ['name', 'ip', 'psk', 'tvsource', 'enabled'];
      let changed = [];
      allowed.forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(payload, k)) {
          entry[k] = payload[k];
          changed.push(k);
        }
      });
      if (changed.length === 0) return self.sendJSON(res, { success: false, message: 'No allowed fields to update (allowed: ' + allowed.join(', ') + ')' });
      try {
        const bak = saveManagedTvs(data, self.log);
        self.log('[' + self.name + '] /api/managed-tvs (PATCH): updated ' + targetMac + ' fields=' + changed.join(',') + (bak ? ' [backup: ' + bak + ']' : ''));
        self.sendJSON(res, { success: true, entry: Object.assign({}, entry, { psk: entry.psk ? true : undefined, hasPsk: !!entry.psk }), backup: bak, restartRequired: true });
      } catch (e) {
        self.sendJSON(res, { success: false, message: 'Save failed: ' + e.message });
      }
    });
  }

  // DELETE /api/managed-tvs/:mac — remove one entry.
  apiManagedDelete(req, res, macRaw) {
    const self = this;
    const targetMac = normaliseMac(decodeURIComponent(macRaw || ''));
    if (!targetMac) return self.sendJSON(res, { success: false, message: 'Invalid MAC in path' });
    let data;
    try { data = loadManagedTvs(self.log); }
    catch (e) { return self.sendJSON(res, { success: false, message: 'Could not load managed file: ' + e.message }); }
    const before = (data.managedTvs || []).length;
    data.managedTvs = (data.managedTvs || []).filter(function (m) { return normaliseMac(m.mac) !== targetMac; });
    if (data.managedTvs.length === before) return self.sendJSON(res, { success: false, message: 'No managed TV with MAC ' + targetMac });
    try {
      const bak = saveManagedTvs(data, self.log);
      self.log('[' + self.name + '] /api/managed-tvs (DELETE): removed ' + targetMac + (bak ? ' [backup: ' + bak + ']' : ''));
      self.sendJSON(res, { success: true, removed: targetMac, backup: bak, restartRequired: true });
    } catch (e) {
      self.sendJSON(res, { success: false, message: 'Save failed: ' + e.message });
    }
  }

  // POST /api/managed-tvs/clear — wipe all managed entries. The client-side
  // is expected to have shown a confirmation prompt before calling this.
  apiManagedClear(req, res) {
    const self = this;
    let data;
    try { data = loadManagedTvs(self.log); }
    catch (e) { return self.sendJSON(res, { success: false, message: 'Could not load managed file: ' + e.message }); }
    const removedCount = (data.managedTvs || []).length;
    data.managedTvs = [];
    try {
      const bak = saveManagedTvs(data, self.log);
      self.log('[' + self.name + '] /api/managed-tvs/clear: removed ' + removedCount + ' entry/entries' + (bak ? ' [backup: ' + bak + ']' : ''));
      self.sendJSON(res, { success: true, removed: removedCount, backup: bak, restartRequired: removedCount > 0 });
    } catch (e) {
      self.sendJSON(res, { success: false, message: 'Save failed: ' + e.message });
    }
  }
  
  sendJSON(res, data) {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
  }
  
  formatChannelsForWeb(channels, dispNums, mediaTypes, recMeta) {
    // v1.4.21: channelNumber is the number shown on the remote (dispNum from
    // getContentList). The previous value was the last segment of the DVB
    // triplet (a service id such as 1101 for Rai 1), which was misleading.
    // Types: tv, radio (programMediaType from the TV), hdmi, app, fn (remote
    // functions such as Teletext).
    const nums = dispNums || this._dispNums || {};
    const media = mediaTypes || this._mediaTypes || {};
    const recs = recMeta || this._recMeta || {};
    return channels.map(ch => {
      const n = nums[ch[1]];
      let type = ch[2] === 2 ? 'tv' : (ch[2] === 10 ? 'app' : 'hdmi');
      if (type === 'tv' && media[ch[1]] === 'radio') type = 'radio';
      if (typeof ch[1] === 'string' && ch[1].indexOf('ircc:') === 0) type = 'fn';
      if (typeof ch[1] === 'string' && ch[1].indexOf('usb:recStorage') === 0) type = 'rec';
      const o = {
        name: ch[0],
        uri: ch[1],
        sourceType: ch[2],
        channelNumber: (n !== undefined && n !== null && n !== '') ? (String(n).replace(/^0+(?=\d)/, '')) : 'N/A',
        type: type
      };
      if (type === 'rec' && recs[ch[1]]) o.rec = recs[ch[1]];
      return o;
    });
  }

  // Add configured applications to a formatted channel list for the web UI (Option A: separate "Applications" section)
  // Avoid duplicates if the TV scan already returned apps.
  // The deduplication key is the *title* (case-insensitive, trimmed): if the TV's getApplicationList
  // already returned an app with the same name (with its real URI like "preset://wifi-display" or
  // "kamaji://BIV-3607"), we keep that and skip the synthetic "appControl:<title>" entry. Otherwise
  // an entry from config.applications that the TV does not expose is still added with the synthetic
  // URI so it remains visible in the web UI.
  appendApplicationsToWebChannels(formattedChannels) {
    try {
      if (!Array.isArray(formattedChannels)) return formattedChannels;
      const apps = Array.isArray(this.applications) ? this.applications : [];
      if (apps.length === 0) return formattedChannels;

      const norm = (s) => String(s || '').toLowerCase().trim();
      const existingTitles = new Set(
        formattedChannels.map(c => norm(c && c.name)).filter(Boolean)
      );
      apps.forEach(app => {
        const title = (app && (app.title || app.name)) ? (app.title || app.name) : null;
        if (!title) return;
        if (existingTitles.has(norm(title))) return;
        const uri = 'appControl:' + title;
        formattedChannels.push({
          name: title,
          uri,
          sourceType: 10,
          channelNumber: 'APP',
          type: 'app'
        });
        existingTitles.add(norm(title));
      });
      return formattedChannels;
    } catch (e) {
      if (this.debug) this.log('[' + this.name + '] ERROR appending apps to web list: ' + e.toString());
      return formattedChannels;
    }

  }


  // Read the user-selected channel list (saved by the web UI). Returns an array of channel URIs.
  getSelectedChannelUris() {
    try {
      if (fs.existsSync(this.selectedChannelsPath)) {
        const data = JSON.parse(fs.readFileSync(this.selectedChannelsPath, 'utf8'));
        if (data && Array.isArray(data.channels)) {
          return data.channels.map(ch => ch.uri).filter(Boolean);
        }
      }
    } catch (e) {
      this.log('[' + this.name + '] ERROR reading channel selection: ' + e);
    }
    return [];
  }

  // Return only the channels selected by the user, preserving selection order.
  // Exact URI matching is used first; legacy synthetic app URIs from <=1.4.5
  // still fall back to title matching so old selections keep working.
  getSelectedChannelsFromList(channels, selectedUris) {
    if (!Array.isArray(channels) || !selectedUris || selectedUris.length === 0) {
      return [];
    }

    const byUri = new Map(channels.map(ch => [ch[1], ch]));
    const norm = (s) => String(s || '').toLowerCase().trim();
    const byTitle = new Map(channels.map(ch => [norm(ch[0]), ch]));

    const filtered = [];
    selectedUris.forEach(uri => {
      let ch = byUri.get(uri);
      if (!ch && typeof uri === 'string' && uri.indexOf('appControl:') === 0) {
        const legacyTitle = uri.substring('appControl:'.length);
        ch = byTitle.get(norm(legacyTitle));
        if (ch && this.debug) {
          this.log('[' + this.name + '] Legacy app URI "' + uri + '" matched by title to real URI: ' + ch[1]);
        }
      }
      if (ch) filtered.push(ch);
    });

    return filtered;
  }

  // Backward-compatible wrapper for older internal callers.
  applySelectionFilterToScannedChannels() {
    const selectedUris = this.getSelectedChannelUris();
    if (!selectedUris || selectedUris.length === 0) {
      return;
    }
    const filtered = this.getSelectedChannelsFromList(this.scannedChannels, selectedUris);
    this.scannedChannels = filtered;
    this.log('[' + this.name + '] Applied channel selection: ' + this.scannedChannels.length + ' channels');
  }

  // Save the full scan (unlimited list) so the web UI can display all channels even when HomeKit is limited.
  saveFullScanCache(channels) {
    try {
      const payload = { tv: this.name, savedAt: new Date().toISOString(), channels: channels, dispNums: this._dispNums || {}, mediaTypes: this._mediaTypes || {}, recMeta: this._recMeta || {} };
      fs.writeFileSync(this.fullScanCachePath, JSON.stringify(payload, null, 2));
      if (this.debug) this.log('[' + this.name + '] ✓ Full scan cache saved: ' + this.fullScanCachePath + ' (' + channels.length + ' items)');
    } catch (e) {
      this.log('[' + this.name + '] ERROR saving scan cache: ' + e);
    }
  }

}

function isNull(object) {
  return object === undefined || object === null;
}

// HomeKit ID ("username") Homebridge assigns to an external accessory: the
// first 12 hex digits of sha1(UUID), same algorithm as homebridge/util/mac.
// Informational only (logged so users can find the matching pairing).
function homeKitIdFor(uuid) {
  try {
    const s = require('crypto').createHash('sha1').update(String(uuid)).digest('hex');
    return s.slice(0, 12).match(/../g).join(':').toUpperCase();
  } catch (e) {
    return '?';
  }
}

// Compare two Sony API version strings (e.g. "1.0", "1.2", "1.10").
// Returns -1 if a<b, 0 if equal, 1 if a>b. Lexicographic comparison is unsafe
// because "1.10" < "1.2" as strings; this function compares the numeric parts.
function compareVersions(a, b) {
  if (a === b) return 0;
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}


// helper class to convert an input type strin to a hb InputSourceType
function InputSource(name, type) {
  this.name = name;
  this.type = type;
}

function getSourceType(name) {
  if (name.indexOf('hdmi') !== -1) {
    return Characteristic.InputSourceType.HDMI;
  } else if (name.indexOf('composite') !== -1) {
    // v1.4.21: analog A/V input ("AV2/Component" on many Bravia) — issue #8
    return Characteristic.InputSourceType.COMPOSITE_VIDEO;
  } else if (name.indexOf('component') !== -1) {
    return Characteristic.InputSourceType.COMPONENT_VIDEO;
  } else if (name.indexOf('scart') !== -1) {
    return Characteristic.InputSourceType.S_VIDEO;
  } else if (name.indexOf('cec') !== -1) {
    return Characteristic.InputSourceType.OTHER;
  } else if (name.indexOf('widi') !== -1) {
    return Characteristic.InputSourceType.AIRPLAY;
  } else if (name.indexOf('dvb') !== -1) {
    return Characteristic.InputSourceType.TUNER;
  } else if (name.indexOf('app') !== -1) {
    return Characteristic.InputSourceType.APPLICATION;
  } else {
    return Characteristic.InputSourceType.OTHER;
  }
}

// create storage folder and move files to folder
function updateStorage(newPath){
  var confPath = newPath + "/plugin-persist/homebridge-bravia";
  if(!fs.existsSync(confPath)){
    fs.mkdirSync(confPath, {recursive: true});
    var rootFiles = fs.readdirSync(newPath);
    rootFiles.forEach(file => {
      if(file.startsWith("sonycookie") || file.startsWith("sonytv-")){
        console.log("[Bravia] moving %s to new storage folder", file);
        fs.renameSync(newPath+"/"+file, confPath+"/"+file);
      }
    });
  }
  return confPath;
}

module.exports = function (homebridge) {
  Accessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  STORAGE_PATH = updateStorage(homebridge.user.storagePath());
  homebridge.registerPlatform('homebridge-bravia-enhanced', 'BraviaPlatform', BraviaPlatform, true);
};