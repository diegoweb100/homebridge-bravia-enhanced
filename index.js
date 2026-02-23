'use strict';
var http = require('http');
var url = require('url');
var base64 = require('base-64');
var wol = require('wake_on_lan');
var fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

// Base identifier for TV tuner channels to avoid collisions with HDMI/App identifiers.
const TV_IDENTIFIER_BASE = 1000;

var Service, Characteristic, Accessory, UUIDGen, STORAGE_PATH;

class BraviaPlatform {
  constructor(log, config, api) {
    if (!config || !api) {
      log('[Bravia] Config or API not provided, exiting');
      return;
    }
    this.log = log;
    this.config = config;
    this.api = api;
    
    log('[Bravia] Platform initializing');
    
    if (!config.tvs) {
      log('[Bravia] Warning: Bravia plugin not configured - no TVs in config');
      return;
    }
    
    log('[Bravia] Found ' + config.tvs.length + ' TV(s) in config');
    
    this.devices = [];
    const self = this;
    api.on('didFinishLaunching', function () {
      if (self.debug) self.log('[Bravia] Platform launched');
      self.config.tvs.forEach(function (tv) {
        if (self.devices.find(device => device.name === tv.name) == undefined) {
          if (self.debug) self.log('[Bravia] Registering TV: ' + tv.name);
          self.devices.push(new SonyTV(self, tv));
        } else {
          if (self.debug) self.log('[Bravia] TV ' + tv.name + ' already registered, skipping');
        }
      });
      if (self.debug) self.log('[Bravia] Starting all TV devices...');
      self.devices.forEach(device => {
        if (self.debug) self.log('[Bravia] Starting device: ' + device.name);
        device.start();
      });
      if (self.debug) self.log('[Bravia] All devices started');
    });
  }
  // Called by Homebridge when a device is restored from cache
  configureAccessory(accessory) {
    const self = this;
    if (this.debug) this.log('[Bravia] Restoring cached accessory: ' + accessory.displayName);
    
    if (!this.config || !this.config.tvs) { // happens if plugin is disabled and still active accessories
      this.log('[Bravia] Config not available, cannot restore accessory');
      return;
    }
    
    var existingConfig = this.config.tvs.find(tv => tv.name === accessory.context.config.name);
    
    if (existingConfig === undefined) {
      this.log('[Bravia] Removing TV ' + accessory.displayName + ' from HomeKit (not in config)');
      this.api.on('didFinishLaunching', function () {
        if (!accessory.context.isexternal) {
          self.api.unregisterPlatformAccessories('homebridge-bravia', 'BraviaPlatform', [accessory]);
        } else {
          // TODO: delete context file? not here, we're not called
        }
      });
    } else {
      this.log('[Bravia] Restoring ' + accessory.displayName + ' from HomeKit');
      // if its restored its registered
      if (this.debug) this.log('[Bravia] Creating TV instance from cache');
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
      
      if (this.debug) this.log('[Bravia] ========================================');
      if (this.debug) this.log('[Bravia] Constructing TV: ' + config.name);
      if (this.debug) this.log('[Bravia] Config debug: ' + config.debug);
      
      // Assign debug flag from config
      this.debug = config.debug;
      if (this.debug) this.log('[Bravia] Debug mode: ' + this.debug);
      if (this.debug) this.log('[Bravia] ========================================');
    
    this.config = config;
    this.name = config.name;
    this.ip = config.ip;
    this.mac = config.mac || null;
    this.woladdress = config.woladdress || '255.255.255.255';
    this.port = config.port || '80';
    this.tvsource = config.tvsource || null;
    this.soundoutput = config.soundoutput || 'speaker';
    this.updaterate = config.updaterate || 5000;
    this.channelupdaterate = config.channelupdaterate === undefined ? 30000 : config.channelupdaterate;
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
    this.fullScanCachePath = STORAGE_PATH + '/sonytv-fullscan-' + this.name + '.json';
    
    // HomeKit has a hardcoded limit of 100 services per accessory
    // This includes: 1 TV service + 1 Speaker service + N Input Sources
    // Maximum input sources = 100 - 2 = 98
    // User can configure a lower limit if desired
    this.maxInputSources = config.maxInputSources || 98;
    if (this.maxInputSources > 98) {
      this.log('[Bravia] ⚠️  WARNING: maxInputSources set to ' + this.maxInputSources + ' but HomeKit limit is 98');
      this.log('[Bravia] ⚠️  Reducing to 98 to avoid crashes');
      this.maxInputSources = 98;
    }
    
    if (this.debug) this.log('[Bravia] TV Source configured: ' + this.tvsource);
    if (this.debug) this.log('[Bravia] Channel update rate: ' + this.channelupdaterate + 'ms');
    if (this.debug) this.log('[Bravia] Max input sources: ' + this.maxInputSources + ' (HomeKit limit: 98)');

    // Authentication and state variables
    this.cookie = null;
    this.pwd = config.pwd || null;
    this.registercheck = false;
    this.authok = false;
    this.appsLoaded = false;
    if (!this.useApps)
      this.appsLoaded = true;

    this.power = false; // Initially assume TV is off
    if (this.debug) this.log('[Bravia] Initial power state: false');

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
    if (this.debug) this.log('[Bravia] Context path: ' + contextPath);
    
      if (accessory != null) {
        // RESTORE PATH 1: Dynamic plugin with configureAccessory restore
        if (this.debug) this.log('[Bravia] Restoring from HomeKit cache');
        this.accessory = accessory;
        this.accessory.category = this.platform.api.hap.Categories.TELEVISION; // 31;
        this.grabServices(accessory);
        this.applyCallbacks();
        if (this.debug) this.log('[Bravia] Services restored from cache');
        
      } else if (this.config.externalaccessory && fs.existsSync(contextPath)) {
        // RESTORE PATH 2: External accessory from context file
        if (this.debug) this.log('[Bravia] External accessory context file found');
        const rawdata = fs.readFileSync(contextPath);
        const accessoryContext = JSON.parse(rawdata);
        var uuid = UUIDGen.generate(this.name + '-SonyTV');
        this.accessory = new Accessory(this.name, uuid, this.platform.api.hap.Categories.TELEVISION);
        this.accessory.context.uuid = accessoryContext.uuid;
        this.accessory.context.isexternal = true;
        // not registered - needs to be added
        // this.accessory.context.isRegisteredInHomeKit = accessoryContext.isRegisteredInHomeKit;
        this.accessory.context.config = this.config;
        this.log('[Bravia] Cached external TV ' + this.name + ' restored');
        this.createServices();
        this.applyCallbacks();
        if (this.debug) this.log('[Bravia] Loading channels from file...');
        this.loadChannelsFromFile();
        if (this.debug) this.log('[Bravia] Channels loaded from file');
        
      } else {
        // NEW ACCESSORY PATH: Create brand new accessory
        var uuid = UUIDGen.generate(this.name + '-SonyTV');
        this.log('[Bravia] Creating new accessory for ' + this.name);
        this.accessory = new Accessory(this.name, uuid, this.platform.api.hap.Categories.TELEVISION);
        this.accessory.context.config = config;
        this.accessory.context.uuid = uuidv4();
        this.log('[Bravia] New TV ' + this.name + ' → will scan channels and register in HomeKit');
        this.accessory.context.isexternal = this.config.externalaccessory;
        this.createServices();
        this.applyCallbacks();
        if (this.debug) this.log('[Bravia] New accessory created');
      }
    } catch (e) {
      this.log('[Bravia] ERROR Exception in constructor: ' + e);
      this.log('[Bravia] ERROR Stack: ' + e.stack);
    }
    if (this.debug) this.log('[Bravia] Constructor done for ' + this.name);
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
    if (this.debug) this.log('[Bravia] start() called for ' + this.name);
    
    // Start permanent web server
    if (this.enableChannelSelector) {
      try {
        this.log('[Bravia] Starting web server on port ' + this.channelSelectorPort);
        this.startWebServer();
      } catch (e) {
        this.log('[Bravia] ERROR Failed to start web server: ' + e);
      }
    }
    if (this.debug) this.log('[Bravia] Current state - authok: ' + this.authok + ', power: ' + this.power + ', receivingSources: ' + this.receivingSources);
    if (this.debug) this.log('[Bravia] Accessory registered: ' + this.accessory.context.isRegisteredInHomeKit);
    
    // CRITICAL: Ensure accessory is always published to HomeKit
    // Even if TV is powered off, we need the accessory visible so user can turn it on
    if (!this.accessory.context.isRegisteredInHomeKit && this.channelServices.length > 0) {
      this.log('[Bravia] ⚠️  Accessory not registered but has channels - registering now');
      this.syncAccessory();
    }
    
    this.checkRegistration();
    this.updateStatus();
    if (this.debug) this.log('[Bravia] Auth + status polling started');
  }
  // Get the services (TV service, channels) from a restored HomeKit accessory
  grabServices(accessory) {
    const self = this;
    if (this.debug) this.log('[Bravia] grabServices() called, recovering services from cached accessory');
    if (this.debug) this.log('[Bravia] Accessory has ' + accessory.services.length + ' services');
    
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
    
    if (this.debug) this.log('[Bravia] Recovered ' + channelCount + ' channel services');
    if (this.debug) this.log('[Bravia] inputSourceMap size: ' + this.inputSourceMap.size);
    
    this.services = [];
    this.tvService = accessory.getService(Service.Television);
    this.services.push(this.tvService);
    this.speakerService = accessory.getService(Service.TelevisionSpeaker);
    this.services.push(this.speakerService);
    
    if (this.debug) this.log('[Bravia] ✓ Services grabbed successfully');
    return this.services;
  }
  // Create the television service for a new TV accessory
  createServices() {
    if (this.debug) this.log('[Bravia] createServices() called, creating new TV and Speaker services');
    /// sony/system/
    // ["getSystemInformation",[],["{\"product\":\"string\", \"region\":\"string\", \"language\":\"string\", \"model\":\"string\", \"serial\":\"string\", \"macAddr\":\"string\", \"name\":\"string\", \"generation\":\"string\", \"area\":\"string\", \"cid\":\"string\"}"],"1.0"]
    this.tvService = new Service.Television(this.name);
    this.services.push(this.tvService);
    this.speakerService = new Service.TelevisionSpeaker();
    this.services.push(this.speakerService);
    if (this.debug) this.log('[Bravia] ✓ Created TV and Speaker services');
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
  updateStatus() {
    var that = this;
    if (this.debug) this.log('[Bravia] Polling status, next in ' + this.updaterate + 'ms');
    setTimeout(function () {
      that.getPowerState(null);
      that.pollPlayContent();
      that.updateStatus();
    }, this.updaterate);
  }
  // Check if we already registered with the TV and authenticate if needed
  checkRegistration() {
    const self = this;
    if (this.debug) this.log('[Bravia] checkRegistration() called');
    if (this.debug) this.log('[Bravia] registercheck: ' + this.registercheck + ', authok: ' + this.authok);
    
    this.registercheck = true;
    var clientId = 'HomeBridge-Bravia' + ':' + this.accessory.context.uuid;
    var post_data = '{"id":8,"method":"actRegister","version":"1.0","params":[{"clientid":"' + clientId + '","nickname":"homebridge"},[{"clientid":"' + clientId + '","value":"yes","nickname":"homebridge","function":"WOL"}]]}';
    
    if (this.debug) this.log('[Bravia] Sending registration check to ' + this.ip);
    
    var onError = function (err) {
      self.log('[Bravia] Auth error: ' + err);
      return false;
    };
    
    var onSucces = function (chunk) {
      if (self.debug) self.log('[Bravia] Auth response received');
      if (chunk.indexOf('"error"') >= 0) {
        if (self.debug)
          self.log('[Bravia] Auth error in response: ' + chunk);
      }
      if (chunk.indexOf('[]') < 0) {
        self.log('[Bravia] Pairing required');
        // If the user removed pairing on the TV side, an old cookie may still exist on disk.
        // In that case, clear it so the UI does not incorrectly report "Already paired".
        try {
          const hadCookie = (!!self.cookie && String(self.cookie).length > 0) || fs.existsSync(self.cookiepath);
          if (hadCookie) {
            self.cookie = null;
            try { fs.unlinkSync(self.cookiepath); } catch (e) {}
            self.log('[Bravia] ⚠️  Stored cookie rejected by TV — pairing required again');
          }
        } catch (e) {}

        self.log('Please enter the PIN that appears on your TV at http://' + os.hostname() + ':' + self.serverPort);
        self.awaitingPin = true;
        // Reuse the permanent web server (Channel Selector) for PIN entry.
        self.log('[Bravia] 🔑 Pairing: http://' + os.hostname() + ':' + self.serverPort + '/pair?tv=' + encodeURIComponent(self.name));
        self.log('[Bravia] 📺 Channels: http://' + os.hostname() + ':' + self.serverPort + '/  (available after pairing)');
      } else {
        self.log('[Bravia] ✓ Paired successfully');
        self.authok = true;
        self.awaitingPin = false;
        self.log('[Bravia] ✅ Channel Selector: http://' + os.hostname() + ':' + self.serverPort + '/');
        if (self.debug) self.log('[Bravia] Starting channel scan');
        self.receiveSources(true);
      }
    };
    self.makeHttpRequest(onError, onSucces, '/sony/accessControl/', post_data, false);
  }
  // Creates HomeKit service for TV input source (channel, HDMI, app, etc.)
  addInputSource(name, uri, type, configuredName = null, identifier = null) {
    if (this.debug) this.log('[Bravia] addInputSource called for: ' + name);
    if (this.debug) this.log('[Bravia] URI: ' + uri + ', Type: ' + type);
    
    // FIXME: Using subtype to store URI, hack!
    if (identifier === null) {
      if (type === Characteristic.InputSourceType.TUNER) {
        // TV channels: keep identifiers stable and away from HDMI/App ids.
        identifier = TV_IDENTIFIER_BASE + this.tvChannelCounter;
        this.tvChannelCounter += 1;
        if (this.debug) this.log('[Bravia] Using TV-range identifier ' + identifier + ' for: ' + name);
      } else {
        identifier = this.getFreeIdentifier();
        if (this.debug) this.log('[Bravia] Using sequential identifier ' + identifier + ' for: ' + name);
      }
    } else {
      // If a provided identifier collides, fall back to a free one.
      if (this.inputSourceMap && this.inputSourceMap.has(identifier)) {
        if (this.debug) this.log('[Bravia] ⚠️ Provided identifier ' + identifier + ' already in use. Using sequential for: ' + name);
        identifier = this.getFreeIdentifier();
      }
      if (this.debug) this.log('[Bravia] Using provided identifier ' + identifier + ' for: ' + name);
    }
    

    
    if (configuredName === null)
      configuredName = name;
      
    if (this.debug) this.log('[Bravia] Creating InputSource service with identifier=' + identifier);
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
    if (this.debug) this.log('[Bravia] ✓ Added input ' + name + ' with identifier ' + identifier);
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
    if (this.debug) this.log('[Bravia] saveChannelsToFile() called');
    if (this.debug) this.log('[Bravia] channelServices count: ' + this.channelServices.length);
    
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
    
    if (this.debug) this.log('[Bravia] Prepared ' + storeObject.length + ' channels to save');
    
    try {
      const data = JSON.stringify(storeObject);
      const channelsPath = STORAGE_PATH + '/sonytv-channels-' + this.name + '.json';
      fs.writeFileSync(channelsPath, data);
      this.log('[Bravia] ✓ Saved ' + storeObject.length + ' channels in external storage: ' + channelsPath);
      if (this.debug)
        this.log('[Bravia] Channels saved to file');
    } catch (e) {
      this.log('[Bravia] ERROR saving channels: ' + e);
    }
  }
  // load channels from file for external accessories
  loadChannelsFromFile() {
    const self = this;
    const channelsPath = STORAGE_PATH + '/sonytv-channels-' + this.name + '.json';
    if (this.debug) this.log('[Bravia] Checking cache: ' + channelsPath);
    // If the user has saved a channel selection via the web UI, prefer that over the HomeKit cache.
    try {
      if (fs.existsSync(this.selectedChannelsPath)) {
        this.log('[Bravia] Loading saved channel selection: ' + this.selectedChannelsPath);
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
              if (this.debug) this.log('[Bravia] Identifiers persisted to selection file');
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
      this.log('[Bravia] ERROR loading selection, falling back to cache: ' + e);
    }
    try {
      if (fs.existsSync(channelsPath)) {
        if (this.debug) this.log('[Bravia] Loading channels from cache');
        const rawdata = fs.readFileSync(channelsPath);
        const storeObject = JSON.parse(rawdata);
        this.log('[Bravia] Loaded ' + storeObject.length + ' channels from cache');
        storeObject.forEach(source => {
          self.scannedChannels.push([source.name, source.uri, source.type]);
          self.addInputSource(source.name, source.uri, source.type, source.configuredName, source.identifier);
        });
        if (this.debug)
          this.log('[Bravia] Channels loaded from external storage');
        
        // CRITICAL: If accessory not yet registered, register it now with cached channels
        // This ensures TV is visible in HomeKit even when powered off at startup
        if (!this.accessory.context.isRegisteredInHomeKit) {
          if (this.debug) this.log('[Bravia] Registering accessory with cached channels');
          this.syncAccessory();
        }
      } else {
        this.log('[Bravia] No channel cache — will scan TV');
        // No cache, need to scan TV
        this.authok = true;
        this.receiveSources(true);
      }
    } catch (e) {
      this.log('[Bravia] ERROR (cache): ' + e);
      this.log('[Bravia] ERROR (cache): Will attempt to scan TV');
      this.authok = true;
      this.receiveSources(true);
    }
  }
  // Syncs the channels and publishes/updates the TV accessory for HomeKit
  syncAccessory() {
    const self = this;
    if (this.debug) this.log('[Bravia] syncAccessory() called');
    if (this.debug) this.log('[Bravia] scannedChannels count: ' + this.scannedChannels.length);
    if (this.debug) this.log('[Bravia] channelServices count: ' + this.channelServices.length);
    if (this.debug) this.log('[Bravia] inputSourceMap size: ' + this.inputSourceMap.size);
    
    var changeDone = false;
    
    // HomeKit limit: max 100 services per accessory (HAP specification)
    // This includes: 1 TV service + 1 Speaker service + N Input Sources
    // Maximum input sources = 100 - 2 = 98
    // User can configure via maxInputSources in config.json
    const MAX_CHANNELS = this.maxInputSources;
    
    // Add new channels discovered during scan
    if (this.debug) this.log('[Bravia] Adding new channels...');
    if (this.debug) this.log('[Bravia] HomeKit limit: maximum ' + MAX_CHANNELS + ' channel services allowed');
    
    var addedCount = 0;
    var skippedCount = 0;
    this.scannedChannels.forEach(channel => {
      // Check if we're at the limit
      if (self.channelServices.length >= MAX_CHANNELS) {
        if (addedCount === 0 && skippedCount === 0) {
          self.log('[Bravia] ⚠️  WARNING: Reached configured limit of ' + MAX_CHANNELS + ' services!');
          self.log('[Bravia] ⚠️  Cannot add more channels. Total scanned: ' + self.scannedChannels.length);
          self.log('[Bravia] ⚠️  Currently have: ' + self.channelServices.length + ' services');
          self.log('[Bravia] ⚠️  Skipping remaining ' + (self.scannedChannels.length - self.channelServices.length) + ' channels');
          self.log('[Bravia] ⚠️  To increase limit, set "maxInputSources" in config.json (max 98)');
        }
        skippedCount++;
        return; // Skip this channel
      }
      
      if (!self.haveInputSource(channel[0], channel[1], channel[2])) {
        if (self.debug) {
          self.log('[Bravia] Adding channel #' + (self.channelServices.length + 1) + ': ' + channel[0]);
        } else {
          if (self.debug) self.log('[Bravia] Adding channel: ' + channel[0]);
        }
        self.addInputSource(channel[0], channel[1], channel[2], null, (channel.length > 3 ? channel[3] : null));
        changeDone = true;
        addedCount++;
      }
    });
    
    if (skippedCount > 0) {
      this.log('[Bravia] ⚠️  Skipped ' + skippedCount + ' channels (HomeKit limit)');
    }
    this.log('[Bravia] ✓ Added ' + addedCount + ' new channels');
    this.log('[Bravia] Total channels now: ' + this.channelServices.length + ' / ' + MAX_CHANNELS);
    
    // Remove channels that no longer exist on TV
    if (this.debug) this.log('[Bravia] Removing stale channels...');
    this.channelServices.forEach((service, idx, obj) => {
      if (!self.haveChannel(service)) {
        // TODO: make this function?
        self.tvService.removeLinkedService(service);
        self.accessory.removeService(service);
        self.inputSourceMap.delete(service.getCharacteristic(Characteristic.Identifier).value);
        self.uriToInputSource.delete(service.subtype);
        self.log('[Bravia] Removing channel: ' + service.getCharacteristic(Characteristic.ConfiguredName).value);
        obj.splice(idx, 1);
        changeDone = true;
      }
    });
    
    if (!this.accessory.context.isRegisteredInHomeKit) {
      if (this.debug) this.log('[Bravia] Registering accessory in HomeKit');
      // add base services that haven't been added yet
      this.services.forEach(service => {
        try {
          if (!self.accessory.services.includes(service)) {
            if (self.debug) self.log('[Bravia] Adding base service');
            self.accessory.addService(service);
            changeDone = true;
          }
        } catch (e) {
          self.log('[Bravia] ERROR adding service: ' + e);
        }
      });
      this.log('[Bravia] Registering accessory for ' + this.name);
      this.accessory.context.isRegisteredInHomeKit = true;
      if (!this.accessory.context.isexternal) {
        if (this.debug) this.log('[Bravia] Registered as platform accessory');
        this.platform.api.registerPlatformAccessories('homebridge-bravia', 'BraviaPlatform', [this.accessory]);
      } else {
        this.log('[Bravia] Publishing as external accessory');
        try {
          const data = JSON.stringify(this.accessory.context);
          const contextPath = STORAGE_PATH + '/sonytv-context-' + this.accessory.context.config.name + '.json';
          fs.writeFileSync(contextPath, data);
          if (this.debug) this.log('[Bravia] Context saved to: ' + contextPath);
        } catch (e) {
          this.log('[Bravia] ERROR saving context: ' + e);
        }
        this.platform.api.publishExternalAccessories('homebridge-bravia', [this.accessory]);
      }
    } else if (changeDone) {
      if (this.debug) this.log('[Bravia] Updating accessory for ' + this.name);
      this.platform.api.updatePlatformAccessories([this.accessory]);
    }
    if (this.accessory.context.isexternal) {
      if (this.debug) this.log('[Bravia] External accessory, calling saveChannelsToFile()');
      this.saveChannelsToFile();
    } else {
      if (this.debug) this.log('[Bravia] Non-external accessory, skipping saveChannelsToFile()');
    }
    this.receivingSources = false;
    if (this.debug) this.log('[Bravia] syncAccessory() complete');
  }
  // initialize a scan for new sources
  receiveSources(checkPower = null) {
    if (this.debug) this.log('[Bravia] receiveSources checkPower=' + checkPower + ', this.power=' + this.power + ', this.receivingSources=' + this.receivingSources);
    if (checkPower === null)
      checkPower = this.power;
    if (this.debug) this.log('[Bravia] checkPower=' + checkPower);
    if (!this.receivingSources && checkPower) {
      this.log('[Bravia] Starting channel scan...');
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
      if (this.debug) this.log('[Bravia] Skipping scan — receivingSources=' + this.receivingSources + ', checkPower=' + checkPower);
    }
    if (this.channelupdaterate)
      setTimeout(this.receiveSources.bind(this), this.channelupdaterate);
  }
  // Process next source in the queue, or finish scanning and sync accessory
  receiveNextSources() {
    if (this.debug) this.log('[Bravia] Processing sources queue, remaining: ' + this.inputSourceList.length);
    
    if (this.inputSourceList.length == 0) {
      if (this.debug) this.log('[Bravia] All sources processed');
      if (this.useApps && !this.appsLoaded) {
        if (this.debug) this.log('[Bravia] Loading applications...');
        this.receiveApplications();
      } else {
        if (this.debug) this.log('[Bravia] Finalizing scan...');
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
      if (this.debug) this.log('[Bravia] Processing source: ' + source.name + ' (type: ' + source.type + ')');
      this.receiveSource(source.name, source.type);
    } else {
      if (this.debug) this.log('[Bravia] Source was null, skipping');
    }
  }
  // TV http call to receive input list for source
  receiveSource(sourceName, sourceType, startIndex = 0) {
    const that = this;
    if (that.debug) that.log('[Bravia] Fetching source: ' + sourceName + ' with startIndex=' + startIndex);
    
    var onError = function (err) {
      if (that.debug) that.log('[Bravia] Error loading source: ' + sourceName + ' at index ' + startIndex);
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
          
          if (that.debug) that.log('[Bravia] Found ' + foundChannels + ' channels for ' + sourceName + ' at startIndex ' + startIndex);
          
          // If we got exactly 50 channels, there might be more - request next batch
          if (foundChannels === 50) {
            if (that.debug) that.log('[Bravia] Paginating channels for ' + sourceName + ', next startIndex: ' + (startIndex + 50));
            that.receiveSource(sourceName, sourceType, startIndex + 50);
            return; // Don't call receiveNextSources yet
          } else {
            that.log('[Bravia] Loaded all channels for ' + sourceName + ', total channels: ' + (startIndex + foundChannels));
          }
        } else {
          if (that.debug) that.log('[Bravia] ERROR: Can\'t load sources for ' + sourceName + ' at index ' + startIndex);
          if (that.debug) that.log('[Bravia] ERROR: TV response: ' + data);
        }
      } catch (e) {
        that.log('[Bravia] ERROR processing channels: ' + e);
      }
      that.receiveNextSources();
    };
    var post_data = '{"id":13,"method":"getContentList","version":"1.0","params":[{ "source":"' + sourceName + '","stIdx": ' + startIndex + '}]}';
    if (that.debug) that.log('[Bravia] API request: ' + post_data);
    that.makeHttpRequest(onError, onSucces, '/sony/avContent', post_data, false);
  }
  
  // Extract channel number from URI
  extractChannelNumber(uri) {
    if (this.debug) this.log('[Bravia] Attempting to extract channel number from URI: ' + uri);
    // Try to extract channel number from URI
    // Example URIs: "tv:dvbt?trip=29.512.70&srvName=..." 
    // We want to extract the last number before "&" (70 in this case)
    var match = uri.match(/trip=[\d\.]+\.(\d+)/);
    if (match && match[1]) {
      if (this.debug) this.log('[Bravia] Successfully extracted channel number: ' + match[1] + ' using trip pattern');
      return parseInt(match[1]);
    }
    // Fallback: try to extract any number from the URI
    match = uri.match(/(\d+)/);
    if (match && match[1]) {
      if (this.debug) this.log('[Bravia] Extracted number using fallback pattern: ' + match[1]);
      return parseInt(match[1]);
    }
    if (this.debug) this.log('[Bravia] Failed to extract channel number from URI');
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
    if (that.debug) that.log('[Bravia] receiveApplications() called');
    if (that.debug) that.log('[Bravia] Configured applications filter: ' + JSON.stringify(that.applications));
    
    var onError = function (err) {
      if (that.debug) that.log('[Bravia] ERROR loading apps: ' + err);
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
          that.log('[Bravia] Found ' + reslt.length + ' apps on TV');
          var addedCount = 0;
          
          reslt.sort((a, b) => (a.title || '').localeCompare(b.title || '')).forEach(function (source) {
            if (that.applications.length == 0 || that.applications.map(app => app.title).filter(title => source.title.includes(title)).length > 0) {
              if (that.debug) that.log('[Bravia] Adding app: ' + source.title);
              that.scannedChannels.push([source.title, source.uri, Characteristic.InputSourceType.APPLICATION]);
              addedCount++;
            } else {
              if (that.debug)
                if (that.debug) that.log('[Bravia] Skipping app: ' + source.title);
            }
          });
          
          that.log('[Bravia] ✓ Added ' + addedCount + ' apps');
        } else {
          if (that.debug) that.log('[Bravia] ERROR (apps): Can\'t load applications');
          if (that.debug) {
            if (that.debug) that.log('TV response:');
            if (that.debug) that.log(data);
          }
        }
      } catch (e) {
        if (that.debug) that.log('[Bravia] ERROR (apps): Exception parsing applications: ' + e);
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
    var post_data = '{"id":13,"method":"getApplicationList","version":"1.0","params":[]}';
    that.makeHttpRequest(onError, onSucces, '/sony/appControl', post_data, false);
  }
  // TV HTTP call to poll currently playing content
  pollPlayContent() {
    // TODO: check app list if no play content for currentUri
    const that = this;
    var post_data = '{"id":13,"method":"getPlayingContentInfo","version":"1.0","params":[]}';
    var onError = function (err) {
      if (that.debug)
        that.log('[Bravia] Error polling play content: ' + err);
      if (!isNull(that.currentUri)) {
        that.currentUri = null;
        that.tvService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(0);
      }
    };
    var onSucces = function (chunk) {
      if (chunk.indexOf('"error"') >= 0) {
        // happens when TV display is off
        if (that.debug)
          that.log('[Bravia] TV display is off');
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
                that.log('[Bravia] Current content changed to URI: ' + uri);
              that.currentUri = uri;
              var inputSource = that.uriToInputSource.get(uri) || that.uriToInputSource.get(that.normalizeUri(uri));
              if (inputSource) {
                var id = inputSource.getCharacteristic(Characteristic.Identifier).value;
                if (!isNull(inputSource)) {
                  if (that.debug)
                    that.log('[Bravia] Updating active identifier to: ' + id);
                  that.tvService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(id);
                }
              } else {
                if (that.debug)
                  that.log('[Bravia] Warning: URI not found in input sources: ' + uri);
              }
            }
          }
        } catch (e) {
          if (!isNull(that.currentUri)) {
            that.currentUri = null;
            that.tvService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(0);
          }
          if (that.debug)
            that.log('[Bravia] Can\'t poll play content: ' + e);
        }
      }
    };
    that.makeHttpRequest(onError, onSucces, '/sony/avContent/', post_data, false);
  }
  // TV HTTP call to set play content (change channel/input)
  setPlayContent(uri) {
    const that = this;
    that.log('[Bravia] Switching to: ' + uri);
    var post_data = '{"id":13,"method":"setPlayContent","version":"1.0","params":[{ "uri": "' + uri + '" }]}';
    var onError = function (err) {
      if (that.debug) that.log('[Bravia] ERROR setting play content: ' + err);
    };
    var onSucces = function (chunk) {
      if (that.debug) that.log('[Bravia] ✓ Content switched');
    };
    that.makeHttpRequest(onError, onSucces, '/sony/avContent/', post_data, true);
  }
  // TV http call to set the active app
  setActiveApp(uri) {
    const that = this;
    that.log('[Bravia] Launching app: ' + uri);
    var post_data = '{"id":13,"method":"setActiveApp","version":"1.0","params":[{"uri":"' + uri + '"}]}';
    var onError = function (err) {
      if (that.debug) that.log('[Bravia] ERROR launching app: ' + err);
    };
    var onSucces = function (data) {
      if (that.debug) that.log('[Bravia] ✓ App launched');
    };
    that.makeHttpRequest(onError, onSucces, '/sony/appControl', post_data, true);
  }
  // Homebridge callback to get current channel identifier
  getActiveIdentifier(callback) {
    if (this.debug)
      this.log('[Bravia] getActiveIdentifier called, currentUri: ' + this.currentUri);
    
    var uri = this.currentUri;
    if (!isNull(uri)) {
      var inputSource = this.uriToInputSource.get(uri);
      if (inputSource) {
        var id = inputSource.getCharacteristic(Characteristic.Identifier).value;
        if (!isNull(inputSource)) {
          if (this.debug)
            this.log('[Bravia] Returning identifier: ' + id);
          if (!isNull(callback))
            callback(null, id);
          return;
        }
      }
    }
    if (this.debug)
      this.log('[Bravia] No active input, returning 0');
    if (!isNull(callback))
      callback(null, 0);
  }
  // Homebridge callback to set current channel/input
  setActiveIdentifier(identifier, callback) {
    if (this.debug) this.log('[Bravia] setActiveIdentifier called with identifier: ' + identifier);
    var inputSource = this.inputSourceMap.get(identifier);
    if (inputSource && inputSource.testCharacteristic(Characteristic.InputSourceType)) {
      var sourceName = inputSource.getCharacteristic(Characteristic.ConfiguredName).value;
      var sourceType = inputSource.getCharacteristic(Characteristic.InputSourceType).value;
      if (this.debug) this.log('[Bravia] Switching to: ' + sourceName + ' (type: ' + sourceType + ')');
      
      if (sourceType == Characteristic.InputSourceType.APPLICATION) {
        if (this.debug) this.log('[Bravia] Type is APPLICATION, calling setActiveApp');
        this.setActiveApp(inputSource.subtype);
      } else {
        if (this.debug) this.log('[Bravia] Type is not APPLICATION, calling setPlayContent');
        this.setPlayContent(inputSource.subtype);
      }
    } else {
      if (this.debug) this.log('[Bravia] Warning: inputSource not found for identifier ' + identifier);
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
    var post_data = '{"id":4,"method":"getVolumeInformation","version":"1.0","params":[]}';
    var onError = function (err) {
      if (that.debug)
        if (that.debug) that.log('[Bravia] ERROR: ' + err);
      if (!isNull(callback))
        callback(null, false);
    };
    var onSucces = function (chunk) {
      if (chunk.indexOf('"error"') >= 0) {
        if (that.debug)
          that.log('[Bravia] ERROR response: ' + chunk);
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
    var post_data = '{"id":13,"method":"setAudioMute","version":"1.0","params":[{"status":' + merterd + '}]}';
    var onError = function (err) {
      if (that.debug)
        if (that.debug) that.log('[Bravia] ERROR: ' + err);
      if (!isNull(callback))
        callback(null);
    };
    var onSucces = function (chunk) {
      if (chunk.indexOf('"error"') >= 0) {
        if (that.debug)
          that.log('[Bravia] ERROR response: ' + chunk);
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
    var post_data = '{"id":4,"method":"getVolumeInformation","version":"1.0","params":[]}';
    var onError = function (err) {
      if (that.debug)
        if (that.debug) that.log('[Bravia] ERROR: ' + err);
      if (!isNull(callback))
        callback(null, 0);
    };
    var onSucces = function (chunk) {
      if (chunk.indexOf('"error"') >= 0) {
        if (that.debug)
          that.log('[Bravia] ERROR response: ' + chunk);
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
    var post_data = '{"id":13,"method":"setAudioVolume","version":"1.0","params":[{"target":"' + that.soundoutput + '","volume":"' + volume + '"}]}';
    var onError = function (err) {
      if (that.debug)
        if (that.debug) that.log('[Bravia] ERROR: ' + err);
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
        that.log('[Bravia] ERROR getting power: ' + err);
      if (!isNull(callback))
        callback(null, false);
      that.updatePowerState(false);
    };
    var onSucces = function (chunk) {
      var _json = null;
      try {
        _json = JSON.parse(chunk);
        if (!isNull(_json) && !isNull(_json.result[0]) && _json.result[0].status === 'active') {
          if (that.debug) that.log('[Bravia] TV is ON');
          that.updatePowerState(true);
          if (!isNull(callback))
            callback(null, true);
        } else {
          if (that.debug) that.log('[Bravia] TV is OFF');
          that.updatePowerState(false);
          if (!isNull(callback))
            callback(null, false);
        }
      } catch (e) {
        if (that.debug)
          if (that.debug) that.log('[Bravia] ERROR (power): ' + e);
        that.updatePowerState(false);
        if (!isNull(callback))
          callback(null, false);
      }
    };
    try {
      var post_data = '{"id":2,"method":"getPowerStatus","version":"1.0","params":[]}';
      that.makeHttpRequest(onError, onSucces, '/sony/system/', post_data, false);
    } catch (globalExcp) {
      if (that.debug)
        if (that.debug) that.log('[Bravia] ERROR (power global): ' + globalExcp);
      that.updatePowerState(false);
      if (!isNull(callback))
        callback(null, false);
    }
  }
  // homebridge callback to set power state
  setPowerState(state, callback) {
    var that = this;
    var onError = function (err) {
      if (that.debug)
        if (that.debug) that.log('[Bravia] ERROR (power set): ' + err);
      if (!isNull(callback))
        callback(null);
    };
    var onSucces = function (chunk) {
      if (!isNull(callback))
        callback(null);
    };
    var onWol = function (error) {
      if (error)
        that.log('[Bravia] ERROR sending WOL:', error);
      if (!isNull(callback))
        callback(null);
    };
    if (state) {
      if (!isNull(this.mac)) {
        wol.wake(this.mac, {address: this.woladdress}, onWol);
      } else {
        var post_data = '{"id":2,"method":"setPowerStatus","version":"1.0","params":[{"status":true}]}';
        that.makeHttpRequest(onError, onSucces, '/sony/system/', post_data, false);
      }
    } else {
      if (!isNull(this.mac)) {
        var post_data = this.createIRCC('AAAAAQAAAAEAAAAvAw==');
        this.makeHttpRequest(onError, onSucces, '', post_data, false);
      } else {
        var post_data = '{"id":2,"method":"setPowerStatus","version":"1.0","params":[{"status":false}]}';
        that.makeHttpRequest(onError, onSucces, '/sony/system/', post_data, false);
      }
    }
  }
  // Sends the current power state to HomeKit
  updatePowerState(state) {
    if (this.power != state) {
      this.log('[Bravia] Power: ' + this.power + ' -> ' + state);
      this.power = state;
      this.tvService.getCharacteristic(Characteristic.Active).updateValue(this.power);
    }
  }
  // Make HTTP request to TV
  makeHttpRequest(errcallback, resultcallback, url, post_data, canTurnTvOn) {
    var that = this;
    var data = '';
    if (isNull(canTurnTvOn)) {canTurnTvOn = false;}
    
    if (!that.power && canTurnTvOn) {
      if (that.debug) that.log('[Bravia] TV off, will power on first');
      that.setPowerState(true, null);
      var timeout = that.starttimeout;
      setTimeout(function () {
        that.makeHttpRequest(errcallback, resultcallback, url, post_data, false);
      }, timeout);
      return;
    }
    
    if (that.debug)
      that.log('[Bravia] HTTP request to ' + url);
    
    var post_options = that.getPostOptions(url);
    var post_req = http.request(post_options, function (res) {
      that.setCookie(res.headers);
      res.setEncoding('utf8');
      res.on('data', function (chunk) {
        data += chunk;
      });
      res.on('end', function () {
        if (that.debug)
          that.log('[Bravia] HTTP response (' + data.length + ' bytes)');
        if (!isNull(resultcallback)) {
          resultcallback(data);
        }
      });
    });
    try {
      post_req.on('error', function (err) {
        if (that.debug) that.log('[Bravia] HTTP error: ' + err);
        if (!isNull(errcallback)) {
          errcallback(err);
        }
      });
      post_req.write(post_data);
      post_req.end();
    } catch (e) {
      that.log('[Bravia] HTTP exception: ' + e);
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
      if (that.debug) that.log('[Bravia] Saving cookie to: ' + this.cookiepath);
      var stream = fs.createWriteStream(this.cookiepath);
      stream.on('error', function (err) {
        that.log('[Bravia] ERROR writing cookie to ' + this.cookiepath + '. Add a cookiepath parameter to config.json to specify the path. Note that you specify the FILE path, not the folder.');
        process.exit(1);
      });
      stream.once('open', function (fd) {
        stream.write(cookie);
        stream.end();
        if (that.debug) that.log('[Bravia] ✓ Cookie saved');
      });
    }
  }
  // Helper function to load cookie from disk
  loadCookie() {
    var that = this;
    if (this.debug) this.log('[Bravia] Loading cookie from: ' + this.cookiepath);
    fs.readFile(this.cookiepath, function (err, data) {
      if (err) {
        if (that.debug) that.log('[Bravia] No cookie at ' + that.cookiepath);
        if (that.debug)
          that.log('[Bravia] Cookie error: ' + err);
        return;
      }
      if (that.debug) that.log('[Bravia] ✓ Cookie loaded from ' + that.cookiepath);
      if (that.debug)
        that.log('[Bravia] Cookie loaded from ' + that.cookiepath);
      that.cookie = data.toString();
    
      that.awaitingPin = false;
});
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEB SERVER - Permanent server for channel selection and PIN entry
  // ══════════════════════════════════════════════════════════════════════════
  
  startWebServer() {
    const self = this;
    const path = require('path');

    
    if (this.webServer) {
      if (this.debug) this.log('[Bravia] Web server already running');
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
            self.log('[Bravia] PIN received via web UI, retrying auth');
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
      
      if (pathname === '/api/tvs') {
        self.apiGetTVs(req, res);
      } else if (pathname === '/api/scan') {
        self.apiScanChannels(req, res);
      } else if (pathname === '/api/selection') {
        self.apiGetSelection(req, res);
      } else if (pathname === '/api/save') {
        self.apiSaveSelection(req, res);
      } else if (pathname === '/channel-selector.js') {
        self.serveFile(res, path.join(__dirname, 'web', 'channel-selector.js'), 'application/javascript');
      } else {
        // Default landing page:
        // - If the TV is not paired (no valid cookie / awaiting PIN), redirect to the Pairing page.
        // - Otherwise show the Channel Selector.
        const cookieExists = (() => { try { return fs.existsSync(self.cookiepath); } catch (e) { return false; } })();
        const hasCookieInMemory = (!!self.cookie && String(self.cookie).length > 0);
        const paired = (self.authok === true) || ((cookieExists || hasCookieInMemory) && self.awaitingPin !== true);
        if (!paired) {
          res.writeHead(302, { 'Location': '/pair?tv=' + encodeURIComponent(self.name) });
          res.end();
          return;
        }
        self.serveFile(res, path.join(__dirname, 'web', 'channel-selector.html'), 'text/html');
      }
    });
    
    this.webServer.listen(this.channelSelectorPort, () => {
      self.log('[Bravia] ════════════════════════════════════════════════════════');
      self.log('[Bravia] 🌐 Bravia Web UI - ACTIVE (Channel Selector + Pairing)');
      self.log('[Bravia] ════════════════════════════════════════════════════════');
      self.log('[Bravia] 📺 Channels: http://' + os.hostname() + ':' + self.channelSelectorPort + '/');
      self.log('[Bravia] 🔑 Pairing : http://' + os.hostname() + ':' + self.channelSelectorPort + '/pair?tv=' + encodeURIComponent(self.name));
      self.log('[Bravia] 🛰️  Scan API: http://' + os.hostname() + ':' + self.channelSelectorPort + '/api/scan?tv=' + encodeURIComponent(self.name));
      self.log('[Bravia] ════════════════════════════════════════════════════════');
    });
    
    this.webServer.on('error', (err) => {
      self.log('[Bravia] Web ERROR: ' + err);
    });
  }
  
  serveFile(res, filepath, contentType) {
    fs.readFile(filepath, (err, data) => {
      if (err) {
        if (this.debug) this.log('[Bravia] File not found: ' + filepath);
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
    this.log('[Bravia] PIN received: ' + pin);
    this.registercheck = false;
    this.checkRegistration();
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end('<html><body><h1>✓ PIN Received!</h1><p>Authenticating...</p><script>setTimeout(()=>location.href="/",2000)</script></body></html>');
  }
  
  apiGetTVs(req, res) {
    this.sendJSON(res, { success: true, tvs: [{ name: this.name, ip: this.ip }] });
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
            self.log('[Bravia] ERROR applying selection: ' + e.toString());
          }
        }, 10);
      } catch (e) {
        self.sendJSON(res, { success: false, error: e.toString() });
      }
    });
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
  appendApplicationsToWebChannels(formattedChannels) {
    try {
      if (!Array.isArray(formattedChannels)) return formattedChannels;
      const apps = Array.isArray(this.applications) ? this.applications : [];
      if (apps.length === 0) return formattedChannels;

      const existing = new Set(formattedChannels.map(c => c && c.uri).filter(Boolean));
      apps.forEach(app => {
        const title = (app && (app.title || app.name)) ? (app.title || app.name) : null;
        if (!title) return;
        const uri = 'appControl:' + title;
        if (existing.has(uri)) return;
        formattedChannels.push({
          name: title,
          uri,
          sourceType: 10,
          channelNumber: 'APP',
          type: 'app'
        });
        existing.add(uri);
      });
      return formattedChannels;
    } catch (e) {
      if (this.debug) this.log('[Bravia] ERROR appending apps to web list: ' + e.toString());
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
      this.log('[Bravia] ERROR reading channel selection: ' + e);
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
    const byUri = new Map(this.scannedChannels.map(ch => [ch[1], ch]));
    const filtered = [];
    selectedUris.forEach(uri => {
      const ch = byUri.get(uri);
      if (ch) filtered.push(ch);
    });
    // If some selected URIs weren't in the scan, keep what we have.
    this.scannedChannels = filtered;
    this.log('[Bravia] Applied channel selection: ' + this.scannedChannels.length + ' channels');
  }

  // Save the full scan (unlimited list) so the web UI can display all channels even when HomeKit is limited.
  saveFullScanCache(channels) {
    try {
      const payload = { tv: this.name, savedAt: new Date().toISOString(), channels: channels };
      fs.writeFileSync(this.fullScanCachePath, JSON.stringify(payload, null, 2));
      if (this.debug) this.log('[Bravia] ✓ Full scan cache saved: ' + this.fullScanCachePath + ' (' + channels.length + ' items)');
    } catch (e) {
      this.log('[Bravia] ERROR saving scan cache: ' + e);
    }
  }

}

function isNull(object) {
  return object === undefined || object === null;
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
  homebridge.registerPlatform('homebridge-bravia', 'BraviaPlatform', BraviaPlatform, true);
};