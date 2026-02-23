// Channel Selector JavaScript
// VERSION: channel-selector.js v1.0.0 (homebridge-bravia-enhanced by diegoweb100)
(function () {
  'use strict';

  const VERSION = 'v1.0.0';

  // State
  const state = {
    tvs: [],
    selectedTV: null,
    channels: [],
    selectedChannels: new Set(),
    maxChannels: 98,
    isScanning: false,
    isBusy: false
  };

  // DOM Elements
  const el = {
    tvSelect: document.getElementById('tv-select'),
    pairingBtn: document.getElementById('pairing-btn'),
    statusContainer: document.getElementById('status-container'),
    toastContainer: document.getElementById('toast-container'),
    statsBar: document.getElementById('stats-bar'),
    controls: document.getElementById('controls'),
    channelListContainer: document.getElementById('channel-list-container'),
    channelList: document.getElementById('channel-list'),
    loading: document.getElementById('loading'),
    emptyState: document.getElementById('empty-state'),
    initialScan: document.getElementById('initial-scan'),
    saveSection: document.getElementById('save-section'),
    scanBtn: document.getElementById('scan-btn'),
    rescanBtn: document.getElementById('rescan-btn'),
    saveBtn: document.getElementById('save-btn'),
    saveBtnTop: document.getElementById('save-btn-top'),
    searchInput: document.getElementById('search-input'),
    typeFilter: document.getElementById('type-filter'),
    selectAllBtn: document.getElementById('select-all'),
    selectNoneBtn: document.getElementById('select-none'),
    selectHDBtn: document.getElementById('select-hd'),
    selectTop20Btn: document.getElementById('select-top20'),
    selectedCount: document.getElementById('selected-count'),
    maxCount: document.getElementById('max-count'),
    totalCount: document.getElementById('total-count')
  };

  function log(...args) { console.log('[BraviaChannelSelector]', ...args); }

  // Toasts
  function toast(kind, title, msg, ms = 3800) {
    if (!el.toastContainer) return;
    const div = document.createElement('div');
    div.className = `toast ${kind}`;
    div.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div><div class="toast-msg">${escapeHtml(msg)}</div>`;
    el.toastContainer.appendChild(div);
    setTimeout(() => {
      div.style.transition = 'opacity .2s ease, transform .2s ease';
      div.style.opacity = '0';
      div.style.transform = 'translateY(-6px)';
      setTimeout(() => div.remove(), 250);
    }, ms);
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function setButtonsDisabled(disabled) {
    const ids = ['scanBtn', 'rescanBtn', 'saveBtn', 'saveBtnTop', 'selectAllBtn', 'selectNoneBtn', 'selectHDBtn', 'selectTop20Btn'];
    ids.forEach(k => { if (el[k]) el[k].disabled = disabled; });
    if (el.tvSelect) el.tvSelect.disabled = disabled;
    if (el.searchInput) el.searchInput.disabled = disabled;
    if (el.typeFilter) el.typeFilter.disabled = disabled;
  }

  function showSection(sec, show) {
    if (!sec) return;
    sec.classList.toggle('hidden', !show);
  }

  function updateSaveButtonsVisibility() {
    const hasChannels = state.channels && state.channels.length > 0;
    const show = hasChannels;
    showSection(el.saveSection, show);
    showSection(el.saveBtnTop, show);
  }

  // Pairing visibility: show "Pairing PIN" only if pin is required
  async function updatePairingButtonVisibility() {
    if (!el.pairingBtn) return;

    if (!state.selectedTV) {
      el.pairingBtn.classList.add('hidden');
      el.pairingBtn.disabled = true;
      return;
    }

    try {
      const r = await fetch(`/api/pairing-status?tv=${encodeURIComponent(state.selectedTV)}`, { cache: 'no-store' });
      const data = await r.json();
      const pinRequired = !!(data && data.success && data.pinRequired);

      if (pinRequired) {
        el.pairingBtn.classList.remove('hidden');
        el.pairingBtn.disabled = false;
      } else {
        el.pairingBtn.classList.add('hidden');
        el.pairingBtn.disabled = true;
      }
    } catch (e) {
      // If pairing status endpoint fails, don't block UI.
      log('pairing-status failed', e);
      el.pairingBtn.classList.add('hidden');
      el.pairingBtn.disabled = true;
    }
  }

  // Load TVs
  async function loadTVs() {
    try {
      const response = await fetch('/api/tvs', { cache: 'no-store' });
      const data = await response.json();

      if (data.success) {
        state.tvs = data.tvs || [];
        populateTVSelector();
      } else {
        toast('error', 'Error', 'Failed to load TVs: ' + (data.error || data.message || 'Unknown error'));
      }
    } catch (error) {
      toast('error', 'Error', 'Error connecting to server: ' + error.message);
    }
  }

  function populateTVSelector() {
    el.tvSelect.innerHTML = '';
    if (state.tvs.length === 0) {
      el.tvSelect.innerHTML = '<option value="">No TVs configured</option>';
      return;
    }

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a TV...';
    el.tvSelect.appendChild(placeholder);

    state.tvs.forEach(tv => {
      const option = document.createElement('option');
      option.value = tv.name;
      option.textContent = `${tv.name} (${tv.ip})`;
      el.tvSelect.appendChild(option);
    });
  }

  // Scan
  async function scanTV(isRescan = false) {
    if (state.isBusy) return;

    // IMPORTANT: never leave isBusy=true on early returns
    state.isBusy = true;
    setButtonsDisabled(true);

    try {
      if (!state.selectedTV) {
        toast('error', 'Missing TV', 'Please select a TV first');
        return;
      }

      await updatePairingButtonVisibility();
      if (el.pairingBtn && !el.pairingBtn.classList.contains('hidden')) {
        toast('warn', 'Pairing required', 'Click "Pairing PIN" and enter the PIN shown on the TV (first time only).');
        return;
      }

      if (state.isScanning) {
        toast('info', 'Scan already running', 'Please wait...');
        return;
      }

      state.isScanning = true;
      showSection(el.loading, true);
      showSection(el.emptyState, false);
      showSection(el.channelListContainer, false);
      showSection(el.controls, false);
      showSection(el.statsBar, false);
      showSection(el.saveSection, false);
      showSection(el.saveBtnTop, false);

      const response = await fetch(`/api/scan?tv=${encodeURIComponent(state.selectedTV)}${isRescan ? '&rescan=1' : ''}`, { cache: 'no-store' });
      const data = await response.json();

      if (!data.success) {
        toast('error', 'Scan failed', data.error || data.message || 'Unknown error');
        showSection(el.emptyState, true);
        return;
      }

      state.channels = data.channels || [];
      state.maxChannels = data.maxChannels || 98;

      el.maxCount.textContent = String(state.maxChannels);
      el.totalCount.textContent = String(state.channels.length);

      await loadSavedSelection();
      renderChannels();

      showSection(el.controls, true);
      showSection(el.statsBar, true);
      showSection(el.channelListContainer, true);
      updateSaveButtonsVisibility();

      toast('success', 'Scan complete', `Found ${state.channels.length} channels`);
    } catch (e) {
      toast('error', 'Scan error', e.message || String(e));
      showSection(el.emptyState, true);
    } finally {
      state.isScanning = false;
      showSection(el.loading, false);
      state.isBusy = false;
      setButtonsDisabled(false);
    }
  }

  async function loadSavedSelection() {
    try {
      const response = await fetch(`/api/selection?tv=${encodeURIComponent(state.selectedTV)}`, { cache: 'no-store' });
      const data = await response.json();

      state.selectedChannels.clear();
      const selection = data && data.success ? (data.selection || []) : [];
      selection.forEach(uri => state.selectedChannels.add(uri));

      updateStats();
    } catch (e) {
      log('loadSavedSelection error', e);
    }
  }

  // Save
  async function saveSelection() {
    if (state.isBusy) return;

    state.isBusy = true;
    setButtonsDisabled(true);

    try {
      if (!state.selectedTV) {
        toast('error', 'Missing TV', 'No TV selected');
        return;
      }

      const selectedChannelData = state.channels.filter(ch => state.selectedChannels.has(ch.uri));

      if (selectedChannelData.length === 0) {
        toast('warn', 'Nothing selected', 'Please select at least one channel');
        return;
      }
      if (selectedChannelData.length > state.maxChannels) {
        toast('error', 'Too many channels', `Selected ${selectedChannelData.length}/${state.maxChannels}`);
        return;
      }

      if (el.saveBtn) { el.saveBtn.textContent = '💾 Saving...'; }
      if (el.saveBtnTop) { el.saveBtnTop.textContent = '💾 Saving...'; }

      const response = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tv: state.selectedTV, channels: selectedChannelData })
      });

      const data = await response.json();

      if (data.success) {
        toast('success', 'Saved', `Saved ${selectedChannelData.length} channels. Homebridge will restart to apply changes.`);
      } else {
        toast('error', 'Save failed', data.error || data.message || 'Unknown error');
      }
    } catch (e) {
      toast('error', 'Save error', e.message || String(e));
    } finally {
      if (el.saveBtn) { el.saveBtn.textContent = '💾 Save Selection'; }
      if (el.saveBtnTop) { el.saveBtnTop.textContent = '💾 Save Selection'; }
      state.isBusy = false;
      setButtonsDisabled(false);
    }
  }

  // Rendering
  function normalizeType(ch) {
    // server may send type/sourceType; normalize to tv/app/hdmi
    if (ch.type) return ch.type;
    if (ch.sourceType === 2) return 'tv';
    if (ch.sourceType === 10) return 'app';
    return 'hdmi';
  }

  function renderChannels() {
    el.channelList.innerHTML = '';
    const filterText = (el.searchInput?.value || '').trim().toLowerCase();
    const filterType = el.typeFilter?.value || 'all';

    let list = state.channels.slice();
    if (filterText) list = list.filter(ch => (ch.name || '').toLowerCase().includes(filterText));
    if (filterType !== 'all') list = list.filter(ch => normalizeType(ch) === filterType);

    if (list.length === 0) {
      el.channelList.innerHTML = '<div class="empty-state" style="padding:16px;text-align:center">No channels match your filters</div>';
      updateStats(0);
      return;
    }

    const items = document.createElement('div');
    items.className = 'channel-items';

    // Option A: show separate sections (TV / HDMI / Applications) inside the same scroll list.
    const order = ['tv', 'hdmi', 'app'];
    const labels = { tv: 'TV Channels', hdmi: 'Inputs', app: 'Applications' };
    const groups = new Map();
    list.forEach(ch => {
      const t = normalizeType(ch);
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(ch);
    });

    let renderedCount = 0;
    order.forEach(t => {
      const arr = groups.get(t);
      if (!arr || arr.length === 0) return;

      const h = document.createElement('div');
      h.className = 'section-header';
      h.textContent = labels[t] || t.toUpperCase();
      items.appendChild(h);

      arr.forEach(ch => {
        items.appendChild(createChannelItem(ch));
        renderedCount++;
      });
    });

    // Render any other types we didn't expect
    groups.forEach((arr, t) => {
      if (order.includes(t)) return;
      const h = document.createElement('div');
      h.className = 'section-header';
      h.textContent = (labels[t] || t).toUpperCase();
      items.appendChild(h);
      arr.forEach(ch => {
        items.appendChild(createChannelItem(ch));
        renderedCount++;
      });
    });

    el.channelList.appendChild(items);
    updateStats(renderedCount);
  }

  function createChannelItem(channel) {
    const type = normalizeType(channel);
    const uri = channel.uri;

    const row = document.createElement('div');
    row.className = 'channel-item' + (state.selectedChannels.has(uri) ? ' selected' : '');

    const left = document.createElement('div');
    left.className = 'channel-left';

    const name = document.createElement('div');
    name.className = 'channel-name';
    name.textContent = channel.name || uri;

    left.appendChild(name);

    const badge = document.createElement('div');
    badge.className = 'badge ' + type;
    badge.textContent = type.toUpperCase();

    row.appendChild(left);
    row.appendChild(badge);

    row.addEventListener('click', () => toggleChannel(uri));
    return row;
  }

  function toggleChannel(uri) {
    if (state.selectedChannels.has(uri)) state.selectedChannels.delete(uri);
    else {
      if (state.selectedChannels.size >= state.maxChannels) {
        toast('warn', 'Limit reached', `Maximum ${state.maxChannels} channels allowed`);
        return;
      }
      state.selectedChannels.add(uri);
    }
    renderChannels();
    updateSaveButtonsVisibility();
  }

  function updateStats(filteredCount) {
    if (el.selectedCount) el.selectedCount.textContent = String(state.selectedChannels.size);
    if (el.maxCount) el.maxCount.textContent = String(state.maxChannels);
    if (el.totalCount) el.totalCount.textContent = String(state.channels.length);
  }

  // Quick selects
  function selectAll() {
    state.channels.forEach(ch => {
      if (state.selectedChannels.size < state.maxChannels) state.selectedChannels.add(ch.uri);
    });
    renderChannels();
    updateSaveButtonsVisibility();
  }
  function selectNone() {
    state.selectedChannels.clear();
    renderChannels();
    updateSaveButtonsVisibility();
  }
  function selectHD() {
    state.selectedChannels.clear();
    state.channels
      .filter(ch => (ch.name || '').toUpperCase().includes('HD'))
      .slice(0, state.maxChannels)
      .forEach(ch => state.selectedChannels.add(ch.uri));
    renderChannels();
    updateSaveButtonsVisibility();
  }
  function selectTop20() {
    state.selectedChannels.clear();
    state.channels.slice(0, Math.min(20, state.maxChannels)).forEach(ch => state.selectedChannels.add(ch.uri));
    renderChannels();
    updateSaveButtonsVisibility();
  }

  function attachEventListeners() {
    el.tvSelect?.addEventListener('change', async () => {
      state.selectedTV = el.tvSelect.value || null;
      state.channels = [];
      state.selectedChannels.clear();
      updateStats(0);

      showSection(el.controls, false);
      showSection(el.statsBar, false);
      showSection(el.channelListContainer, false);
      showSection(el.saveSection, false);
      showSection(el.saveBtnTop, false);

      await updatePairingButtonVisibility();

      if (state.selectedTV) {
        showSection(el.emptyState, true);
        toast('info', 'TV selected', `Selected ${state.selectedTV}. Click "Scan TV Channels".`, 2200);
      } else {
        showSection(el.emptyState, true);
      }
    });

    el.scanBtn?.addEventListener('click', () => scanTV(false));
    el.rescanBtn?.addEventListener('click', () => scanTV(true));

    el.saveBtn?.addEventListener('click', saveSelection);
    el.saveBtnTop?.addEventListener('click', saveSelection);

    el.searchInput?.addEventListener('input', renderChannels);
    el.typeFilter?.addEventListener('change', renderChannels);

    el.selectAllBtn?.addEventListener('click', selectAll);
    el.selectNoneBtn?.addEventListener('click', selectNone);
    el.selectHDBtn?.addEventListener('click', selectHD);
    el.selectTop20Btn?.addEventListener('click', selectTop20);

    el.pairingBtn?.addEventListener('click', () => {
      if (!state.selectedTV) return;
      window.location.href = `/pair?tv=${encodeURIComponent(state.selectedTV)}`;
    });
  }

  function init() {
    log('Loaded', VERSION);
    // Make it impossible to confuse cached/old assets in browser: log version and disable cache for fetch.
    loadTVs();
    attachEventListeners();
    updatePairingButtonVisibility();
  }

  init();
})();