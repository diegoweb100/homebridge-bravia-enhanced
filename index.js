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

class BraviaPlatform {
  constructor(log, config, api) {
    if (!config || !api) {
      log('Config or API not provided, exiting');
      return;
    }
    this.log = log;
    this.config = config;
    this.api = api;
    
    log('Platform initializing');
    
    if (!config.tvs) {
      log('Warning: Bravia plugin not configured - no TVs in config');
      return;
    }
    
    log('Found ' + config.tvs.length + ' TV(s) in config');

    // Install global error handlers ONLY if at least one TV has debug enabled.
    // These handlers help diagnose otherwise-silent plugin crashes by surfacing
    // the full stack trace into the Homebridge log.
    const anyDebug = (config.tvs || []).some((t) => t && t.debug === true);
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
    const self = this;
    api.on('didFinishLaunching', function () {
      if (self.debug) self.log('Platform launched');
      self.config.tvs.forEach(function (tv) {
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
    
    if (!this.config || !this.config.tvs) { // happens if plugin is disabled and still active accessories
      this.log('Config not available, cannot restore accessory');
      return;
    }
    
    var existingConfig = this.config.tvs.find(tv => tv.name === accessory.context.config.name);
    
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
    var _wolMode = (config.wolMode || 'auto').toString().toLowerCase();
    if (_wolMode !== 'auto' && _wolMode !== 'directed-broadcast' && _wolMode !== 'disabled') {
      this.log('[' + this.name + '] ⚠️  Invalid wolMode "' + _wolMode + '", falling back to "auto"');
      _wolMode = 'auto';
    }
    this.wolMode = _wolMode;
    // Number of magic packets sent in a burst and the interval between them.
    // A burst is more reliable than a single packet on flaky networks (some
    // TVs miss the first packet while NIC firmware is still booting up).
    this.wolBurstCount = config.wolBurstCount || 5;
    this.wolBurstInterval = config.wolBurstInterval || 500;
    // After the WOL burst, poll getPowerStatus until the TV reports active or
    // until this timeout expires. Used only for logging/verification, the
    // HomeKit callback is invoked earlier so HomeKit doesn't time out.
    this.wakeWaitMaxMs = config.wakeWaitMaxMs || 15000;
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
    this.comp = config.compatibilitymode;
    this.serverPort = config.serverPort || 8999;
    this.sources = config.sources || ['extInput:hdmi', 'extInput:component', 'extInput:scart', 'extInput:cec', 'extInput:widi'];
    this.useApps = (isNull(config.applications)) ? false : (config.applications instanceof Array == true ? config.applications.length > 0 : config.applications);
    this.applications = (isNull(config.applications) || (config.applications instanceof Array != true)) ? [] : config.applications;
    this.cookiepath = STORAGE_PATH + '/sonycookie_' + this.name;
    
    // Web server configuration
    this.channelSelectorPort = config.channelSelectorPort || this.serverPort;
    this.enableChannelSelector = config.enableChannelSelector !== false;
    this.selectedChannelsPath = STORAGE_PATH + '/selected-channels-' + this.name + '.json';
    this.volumeAccessory = config.volumeAccessory === true;
    this.volumeUI = config.volumeUI === true;
    this.volumeAccessoryInstance = null; // will hold the Lightbulb accessory if enabled
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
      'getApplicationList': '/sony/avContent',
      'getPlayingContentInfo': '/sony/avContent',
      'setPlayContent': '/sony/avContent',
      'setActiveApp': '/sony/avContent',
      // audio
      'getVolumeInformation': '/sony/audio',
      'setAudioVolume': '/sony/audio',
      'setAudioMute': '/sony/audio'
    };
    
    // HomeKit has a hardcoded limit of 100 services per accessory
    // This includes: 1 TV service + 1 Speaker service + N Input Sources
    // Maximum input sources = 100 - 2 = 98
    // User can configure a lower limit if desired
    this.maxInputSources = config.maxInputSources || 98;
    if (this.maxInputSources > 98) {
      this.log('[' + this.name + '] ⚠️  WARNING: maxInputSources set to ' + this.maxInputSources + ' but HomeKit limit is 98');
      this.log('[' + this.name + '] ⚠️  Reducing to 98 to avoid crashes');
      this.maxInputSources = 98;
    }
    
    // When true, HDMI inputs that are physically disconnected are hidden in HomeKit
    this.hideDisconnectedInputs = config.hideDisconnectedInputs === true;
    // Cache of external input connection status: Map<uri, {title, label, connection, icon}>
    this.externalInputsStatus = new Map();

    if (this.debug) this.log('[' + this.name + '] TV Source configured: ' + this.tvsource);
    if (this.debug) this.log('[' + this.name + '] Channel update rate: ' + this.channelupdaterate + 'ms');
    if (this.debug) this.log('[' + this.name + '] Max input sources: ' + this.maxInputSources + ' (HomeKit limit: 98)');
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
    while (keys.includes(id)) {
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
    var dest = (that.wolMode === 'directed-broadcast')
      ? (that.woladdress || '255.255.255.255')
      : that.ip; // 'auto' uses unicast to the TV's IP
    var count = that.wolBurstCount;
    var interval = that.wolBurstInterval;
    var errors = [];
    var idx = 0;

    that.log('[' + that.name + '] [POWER] ⚡ WOL burst: sending ' + count + ' magic packets to mac=' + that._sanitize(that.mac, 'mac') + ' dest=' + dest + ' (mode=' + that.wolMode + ', interval=' + interval + 'ms)');

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
      try {
        wol.wake(that.mac, { address: dest }, function (err) {
          if (err) {
            errors.push(err);
            if (that.debug) that.log('[' + that.name + '] [POWER] ⚡ WOL packet ' + packetIdx + '/' + count + ' FAILED: ' + err);
          } else {
            if (that.debug) that.log('[' + that.name + '] [POWER] ⚡ WOL packet ' + packetIdx + '/' + count + ' sent to ' + dest);
          }
          if (packetIdx >= count) {
            sendNext();
          } else {
            setTimeout(sendNext, interval);
          }
        });
      } catch (e) {
        errors.push(e);
        if (that.debug) that.log('[' + that.name + '] [POWER] ⚡ WOL packet ' + packetIdx + '/' + count + ' threw: ' + e);
        if (packetIdx >= count) {
          sendNext();
        } else {
          setTimeout(sendNext, interval);
        }
      }
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
        that.log('[' + that.name + '] [POWER] ⏱️  REST alive wait timed out after ' + elapsed + 'ms (' + attempt + ' attempts), TV did not become alive');
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
      'volumeUI: ' + this.volumeUI,
      'hideDisconnectedInputs: ' + (this.hideDisconnectedInputs === true),
      'maxInputSources: ' + this.maxInputSources,
      'updaterate: ' + this.updaterate + 'ms | channelupdaterate: ' + this.channelupdaterate + 'ms',
      'standbyUpdateRate: ' + this.standbyUpdateRate + 'ms | postWakePollRate: ' + this.postWakePollRate + 'ms | postWakePollWindow: ' + this.postWakePollWindow + 'ms',
      'wolMode: ' + this.wolMode + ' | wolBurstCount: ' + this.wolBurstCount + ' | wolBurstInterval: ' + this.wolBurstInterval + 'ms',
      'wakeWaitMaxMs: ' + this.wakeWaitMaxMs + ' | wakeWaitIntervalMs: ' + this.wakeWaitIntervalMs + ' | postWakeScanDelay: ' + this.postWakeScanDelay + 'ms',
      'mac: ' + this._sanitize(this.mac, 'mac'),
      'woladdress: ' + (this.woladdress || '<default>') + ' (used only when wolMode=directed-broadcast)',
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
    that.log('[' + that.name + '] 🔊 Volume accessory published: ' + volName);
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
      that.updateStatus();
    }, interval);
  }
  // Check if we already registered with the TV and authenticate if needed
  checkRegistration() {
    const self = this;
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
      self.log('[' + self.name + '] Auth error: ' + err);
      if (self.debug) {
        self.log('[' + self.name + '] 🔑 PAIRING TRACE: network/transport error during actRegister: ' + err);
        self.log('[' + self.name + '] 🔑 PAIRING TRACE: this typically means the TV is unreachable at ' + self.ip + ':' + self.port + ' (off, wrong IP, firewall blocking, or interface mismatch)');
      }
      return false;
    };
    
    var onSucces = function (chunk) {
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
      
    this.channelServices.push(inputSource);
    this.tvService.addLinkedService(inputSource);
    this.uriToInputSource.set(uri, inputSource);
    // Also map a normalized key to handle URI variations returned by getPlayingContentInfo
    this.uriToInputSource.set(this.normalizeUri(uri), inputSource);
    this.inputSourceMap.set(identifier, inputSource);
    this.accessory.addService(inputSource);
    if (this.debug) this.log('[' + this.name + '] ✓ Added input ' + name + ' with identifier ' + identifier);
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
    // This includes: 1 TV service + 1 Speaker service + N Input Sources
    // Maximum input sources = 100 - 2 = 98
    // User can configure via maxInputSources in config.json
    const MAX_CHANNELS = this.maxInputSources;
    
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
          self.log('[' + self.name + '] ⚠️  To increase limit, set "maxInputSources" in config.json (max 98)');
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
        self.addInputSource(channel[0], channel[1], channel[2], null, (channel.length > 3 ? channel[3] : null));
        changeDone = true;
        addedCount++;
      }
    });
    
    if (skippedCount > 0) {
      this.log('[' + this.name + '] ⚠️  Skipped ' + skippedCount + ' channels (HomeKit limit)');
    }
    this.log('[' + this.name + '] ✓ Added ' + addedCount + ' new channels');
    this.log('[' + this.name + '] Total channels now: ' + this.channelServices.length + ' / ' + MAX_CHANNELS);
    
    // Remove channels that no longer exist on TV. Only log if something is actually
    // removed, to avoid spamming the log with "Removing stale channels..." every
    // reconcile cycle (every channelupdaterate ms) when there is nothing to remove.
    let removedCount = 0;
    this.channelServices.forEach((service, idx, obj) => {
      if (!self.haveChannel(service)) {
        // TODO: make this function?
        self.tvService.removeLinkedService(service);
        self.accessory.removeService(service);
        self.inputSourceMap.delete(service.getCharacteristic(Characteristic.Identifier).value);
        self.uriToInputSource.delete(service.subtype);
        self.log('[' + self.name + '] Removing channel: ' + service.getCharacteristic(Characteristic.ConfiguredName).value);
        obj.splice(idx, 1);
        changeDone = true;
        removedCount++;
      }
    });
    if (removedCount > 0) {
      this.log('[' + this.name + '] ✓ Removed ' + removedCount + ' stale channels');
    }
    
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
        this.log('[' + this.name + '] Publishing as external accessory');
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
  // initialize a scan for new sources
  receiveSources(checkPower = null) {
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

    if (!this.receivingSources && checkPower) {
      this.log('[' + this.name + '] Starting channel scan...');
      const that = this;
      this.inputSourceList = [];
      this.sources.forEach(function (sourceName) {
        that.inputSourceList.push(new InputSource(sourceName, getSourceType(sourceName)));
      });
      if (!isNull(this.tvsource)) {
        this.inputSourceList.push(new InputSource(this.tvsource, getSourceType(this.tvsource)));
      }

      this.receivingSources = true;
      this.scannedChannels = [];
      this.receiveNextSources();
    } else {
      if (this.debug) this.log('[' + this.name + '] Skipping scan — receivingSources=' + this.receivingSources + ', checkPower=' + checkPower);
    }
    if (this.channelupdaterate)
      setTimeout(this.receiveSources.bind(this), this.channelupdaterate);
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
        // Persist full scan results for the web UI (unlimited list)
        if (this.scannedChannels && this.scannedChannels.length > this.maxInputSources) {
          this.saveFullScanCache(this.scannedChannels);
        }
        // If the user saved a selection, only publish those channels to HomeKit
        this.applySelectionFilterToScannedChannels();
        this.syncAccessory();
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
            that.scannedChannels.push([source.title, source.uri, sourceType]);
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
          if (that.debug) that.log('[' + that.name + '] ERROR: Can\'t load sources for ' + sourceName + ' at index ' + startIndex);
          if (that.debug) that.log('[' + that.name + '] ERROR: TV response: ' + data);
        }
      } catch (e) {
        that.log('[' + that.name + '] ERROR processing channels: ' + e);
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
      if (that.debug) that.log('[' + that.name + '] ERROR loading apps: ' + err);
      if (that.debug)
        that.log(err);
      that.appsLoaded = true;
      // Persist full scan (channels + apps) for the web UI
      if (that.scannedChannels && that.scannedChannels.length > that.maxInputSources) {
        that.saveFullScanCache(that.scannedChannels);
      }
      // If the user saved a selection, only publish those channels to HomeKit
      that.applySelectionFilterToScannedChannels();
      that.syncAccessory();
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
      // Persist full scan (channels + apps) for the web UI
      if (that.scannedChannels && that.scannedChannels.length > that.maxInputSources) {
        that.saveFullScanCache(that.scannedChannels);
      }
      // If the user saved a selection, only publish those channels to HomeKit
      that.applySelectionFilterToScannedChannels();
      that.syncAccessory();
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
  // Homebridge callback to set current channel/input
  setActiveIdentifier(identifier, callback) {
    if (this.debug) this.log('[' + this.name + '] setActiveIdentifier called with identifier: ' + identifier);
    var inputSource = this.inputSourceMap.get(identifier);
    if (inputSource && inputSource.testCharacteristic(Characteristic.InputSourceType)) {
      var sourceName = inputSource.getCharacteristic(Characteristic.ConfiguredName).value;
      var sourceType = inputSource.getCharacteristic(Characteristic.InputSourceType).value;
      if (this.debug) this.log('[' + this.name + '] Switching to: ' + sourceName + ' (type: ' + sourceType + ')');
      
      if (sourceType == Characteristic.InputSourceType.APPLICATION) {
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
      if (state === true && this.power === false) {
        this.recentlyWokenAt = Date.now();
        if (this.debug) this.log('[' + this.name + '] [POWER] OFF→ON transition detected, recentlyWokenAt=now');
      }
      this.power = state;
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
      var post_req = http.request(post_options, function (res) {
        post_req.__responded = true;
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
    var post_options = null;
    if (that.comp == 'true') {
      post_options = {
        host: 'closure-compiler.appspot.com',
        port: '80',
        path: url,
        method: 'POST',
        headers: {}
      };
    } else {
      post_options = {
        host: that.ip,
        port: that.port,
        path: url,
        method: 'POST',
        headers: {}
      };
    }
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
          that.cookie = cookiestr.toString().split(';')[0];
          that.saveCookie(that.cookie);
        } catch (e) {}
      });
    }
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
const paired = (self.authok === true) || ((cookieExists || hasCookieInMemory) && self.awaitingPin !== true);
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
        const paired = (self.authok === true) || ((cookieExists || hasCookieInMemory) && self.awaitingPin !== true);
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
      self.log('[' + self.name + '] Web ERROR: ' + err);
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
    
    if (fs.existsSync(this.fullScanCachePath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(this.fullScanCachePath, 'utf8'));
        let formatted = this.formatChannelsForWeb(cached.channels);
        formatted = this.appendApplicationsToWebChannels(formatted);
        return this.sendJSON(res, { success: true, channels: formatted, maxChannels: this.maxInputSources, totalFound: formatted.length });
      } catch (e) {}
    }
    
    if (this.scannedChannels.length > 0) {
      let formatted = this.formatChannelsForWeb(this.scannedChannels);
       formatted = this.appendApplicationsToWebChannels(formatted);
       return this.sendJSON(res, { success: true, channels: formatted, maxChannels: this.maxInputSources, totalFound: formatted.length });
    }
    
    let formatted = [];
     formatted = this.appendApplicationsToWebChannels(formatted);
     this.sendJSON(res, { success: true, channels: formatted, maxChannels: this.maxInputSources, totalFound: formatted.length });
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
        return this.sendJSON(res, { success: true, selection: uris });
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
        
        if (data.channels.length > self.maxInputSources) {
          return self.sendJSON(res, { success: false, error: 'Too many channels' });
        }
        
        const saveData = { tv: data.tv, channels: data.channels, savedAt: new Date().toISOString() };
        fs.writeFileSync(self.selectedChannelsPath, JSON.stringify(saveData, null, 2));

        // Respond immediately so the browser UI doesn't hang if syncAccessory is slow or throws.
        self.sendJSON(res, { success: true, message: 'Saved', channelCount: data.channels.length });

        // Apply selection asynchronously to avoid blocking the HTTP response.
        setTimeout(() => {
          try {
            self.scannedChannels = data.channels.map(ch => [ch.name, ch.uri, ch.sourceType]);
            self.syncAccessory();
          } catch (e) {
            self.log('[' + self.name + '] ERROR applying selection: ' + e.toString());
          }
        }, 10);
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
  
  sendJSON(res, data) {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
  }
  
  formatChannelsForWeb(channels) {
    return channels.map(ch => ({
      name: ch[0],
      uri: ch[1],
      sourceType: ch[2],
      channelNumber: this.extractChannelNumber(ch[1]) || 'N/A',
      type: ch[2] === 2 ? 'tv' : (ch[2] === 10 ? 'app' : 'hdmi')
    }));
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

  // If a selection exists, filter a scanned channel list to ONLY the user-selected ones.
  // Keeps the selection order if possible.
  applySelectionFilterToScannedChannels() {
    const selectedUris = this.getSelectedChannelUris();
    if (!selectedUris || selectedUris.length === 0) {
      return;
    }
    // Primary lookup: exact URI match
    const byUri = new Map(this.scannedChannels.map(ch => [ch[1], ch]));
    // Fallback lookup: title match (case-insensitive, trimmed). Used to recover
    // selections saved with the legacy synthetic "appControl:<title>" URI from
    // versions <= 1.4.5, where the web UI listed configured apps with a fake URI
    // that never matched the real one returned by the TV (e.g. "preset://wifi-display").
    const norm = (s) => String(s || '').toLowerCase().trim();
    const byTitle = new Map(this.scannedChannels.map(ch => [norm(ch[0]), ch]));

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
    // If some selected URIs weren't in the scan, keep what we have.
    this.scannedChannels = filtered;
    this.log('[' + this.name + '] Applied channel selection: ' + this.scannedChannels.length + ' channels');
  }

  // Save the full scan (unlimited list) so the web UI can display all channels even when HomeKit is limited.
  saveFullScanCache(channels) {
    try {
      const payload = { tv: this.name, savedAt: new Date().toISOString(), channels: channels };
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