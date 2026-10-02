// Discover TVs — homebridge-bravia-enhanced v1.4.21 (diegoweb100)
// Talks to: GET /api/discover ; GET/POST /api/managed-tvs ; PATCH/DELETE /api/managed-tvs/:mac ; POST /api/managed-tvs/clear
(function () {
  'use strict';
  var B = window.BUI, esc = B.esc, icon = B.icon;
  B.hydrate();
  var $ = function (id) { return document.getElementById(id); };

  var elScanBtn = $('scan-btn'), elScanStatus = $('scan-status'), elScanResults = $('scan-results');
  var elManagedList = $('managed-list'), elClearBtn = $('clear-btn'), elAutoscanPill = $('autoscan-pill');
  var elModal = $('modal-backdrop'), elModalTitle = $('modal-title'), elModalName = $('m-name'), elModalIp = $('m-ip'),
      elModalMac = $('m-mac'), elModalMacNote = $('m-mac-note'), elModalPsk = $('m-psk'), elModalSource = $('m-tvsource'),
      elModalHint = $('modal-hint'), elModalCancel = $('modal-cancel'), elModalSave = $('modal-save');
  var modalContext = null;

  // ── Managed list ────────────────────────────────────────────────────────
  function renderManaged(data) {
    var list = (data && data.managedTvs) || [];
    if (!list.length) {
      elManagedList.innerHTML = '<div class="empty"><div class="big">' + icon('tv') + '</div><h3>No managed TVs</h3><p>Scan the network above and add a TV with one click.</p></div>';
      elClearBtn.classList.add('hidden');
      return;
    }
    elClearBtn.classList.remove('hidden');
    elManagedList.innerHTML = list.map(function (m) {
      var d = m.discovered || {};
      var meta = [
        '<span>' + icon('lan') + esc(m.ip || '?') + '</span>',
        '<span class="mono">' + esc(m.mac || '?') + '</span>',
        m.hasPsk || m.psk ? '<span class="pill good">' + icon('shield') + 'PSK</span>' : '<span class="pill">PIN pairing</span>'
      ];
      if (d.model) meta.push('<span>' + icon('tv') + esc(d.model) + '</span>');
      if (d.interfaceVer) meta.push('<span>API v' + esc(d.interfaceVer) + '</span>');
      if (m.tvsource) meta.push('<span>' + icon('antenna') + esc(m.tvsource) + '</span>');
      if (m.lastSeen) meta.push('<span>seen ' + esc(new Date(m.lastSeen).toLocaleString()) + '</span>');
      var conflict = m.conflictsWithConfig ? ' <span class="pill warn">' + icon('alert') + 'also in config.json as “' + esc(m.conflictName || '?') + '”</span>' : '';
      var on = m.enabled !== false;
      return '<div class="tvc' + (on ? '' : ' off') + '" data-mac="' + esc(m.mac || '') + '">' +
        '<div class="tvi">' + icon('tv') + '</div>' +
        '<div class="grow"><h4>' + esc(m.name || '(no name)') + conflict + '</h4><div class="meta">' + meta.join('') + '</div></div>' +
        '<div class="acts">' +
          '<label class="switch" title="' + (on ? 'Enabled — loaded at next restart' : 'Disabled — ignored at next restart') + '"><input type="checkbox" data-action="toggle" data-mac="' + esc(m.mac) + '"' + (on ? ' checked' : '') + '><span class="sl"></span></label>' +
          '<button class="btn" data-action="edit" data-mac="' + esc(m.mac) + '">' + icon('edit') + 'Edit</button>' +
          '<button class="btn btn-danger" data-action="delete" data-mac="' + esc(m.mac) + '">' + icon('trash') + '</button>' +
        '</div></div>';
    }).join('');
  }

  function refreshAutoscanPill(enabled) {
    if (enabled === true) { elAutoscanPill.textContent = 'autoscan on'; elAutoscanPill.className = 'pill good'; }
    else if (enabled === false) { elAutoscanPill.textContent = 'autoscan off'; elAutoscanPill.className = 'pill warn'; elAutoscanPill.title = 'Set "autoscan": true in the plugin config to load managed TVs'; }
    else { elAutoscanPill.textContent = 'autoscan ?'; elAutoscanPill.className = 'pill'; }
  }

  function loadManaged() {
    return B.fetchJson('/api/managed-tvs').then(function (data) {
      if (!data.success) throw new Error(data.message || 'load failed');
      refreshAutoscanPill(data.autoscanEnabled);
      renderManaged(data);
      return data;
    }).catch(function (err) {
      elManagedList.innerHTML = '<div class="empty"><h3>Could not load managed TVs</h3><p>' + esc(err.message) + '</p></div>';
      B.toast('error', 'Error', err.message);
    });
  }

  // ── Scan ────────────────────────────────────────────────────────────────
  function renderScanResults(payload) {
    var results = (payload && payload.results) || [];
    var meta = payload && payload.scannedHosts
      ? '<p class="note" style="margin:14px 0 4px">Scanned ' + payload.scannedHosts + ' addresses on ' + (payload.ranges || []).map(esc).join(', ') + ' · ' + esc(payload.source || '') + '</p>'
      : '';
    if (!results.length) {
      elScanResults.innerHTML = meta + '<div class="empty"><div class="big">' + icon('search') + '</div><h3>No Bravia TV found</h3>' +
        '<p>Switch the TV on (or enable Quick Start so its network stays awake) and check that <code>discoveryRange</code> covers the TV subnet.</p></div>';
      return;
    }
    elScanResults.innerHTML = meta + results.map(function (r) {
      var badges = '';
      if (r.inConfig) badges += ' <span class="pill warn">in config.json as “' + esc(r.inConfigAs || '?') + '”</span>';
      else if (r.inManaged) badges += ' <span class="pill good">managed as “' + esc(r.inManagedAs || '?') + '”</span>';
      if (r.authHint === 'psk-recommended') badges += ' <span class="pill acc">PSK recommended</span>';
      var label = r.inConfig ? 'In config' : (r.inManaged ? 'Update' : 'Add');
      var cls = r.inConfig ? 'btn' : (r.inManaged ? 'btn btn-primary' : 'btn btn-good');
      return '<div class="tvc">' +
        '<div class="tvi">' + icon('tv') + '</div>' +
        '<div class="grow"><h4>' + esc(r.suggestedName || r.ip) + badges + '</h4><div class="meta">' +
          '<span>' + icon('lan') + esc(r.ip) + '</span>' +
          (r.mac ? '<span class="mono">' + esc(r.mac) + '</span>' : '<span style="color:var(--warn)">MAC not resolvable from here</span>') +
          (r.modelName ? '<span>' + icon('tv') + esc(r.modelName) + '</span>' : '') +
          (r.interfaceVersion ? '<span>API v' + esc(r.interfaceVersion) + '</span>' : '') +
        '</div></div>' +
        '<div class="acts"><button class="' + cls + '" data-action="add" data-ip="' + esc(r.ip) + '" data-mac="' + esc(r.mac || '') + '" data-name="' + esc(r.suggestedName || '') + '" data-model="' + esc(r.modelName || '') + '" data-prod="' + esc(r.productName || '') + '" data-iface="' + esc(r.interfaceVersion || '') + '" data-hint="' + esc(r.authHint || '') + '" data-managed="' + (r.inManaged ? '1' : '') + '"' + (r.inConfig ? ' disabled' : '') + '>' + icon(r.inConfig ? 'check' : 'plus') + label + '</button></div>' +
        '</div>';
    }).join('');
  }

  function runScan() {
    elScanBtn.disabled = true;
    elScanStatus.textContent = 'Scanning… up to ~20 s';
    elScanResults.innerHTML = '<div class="empty"><div class="radar"></div><h3>Looking for Bravia TVs…</h3><p>Only TVs that are on (or in Quick Start) can answer.</p></div>';
    B.fetchJson('/api/discover').then(function (data) {
      if (!data.success) throw new Error(data.message || 'discover failed');
      renderScanResults(data);
      var n = (data.results || []).length;
      B.toast(n ? 'success' : 'info', 'Scan complete', n + ' TV(s) found on ' + (data.ranges || []).join(', '));
    }).catch(function (err) {
      elScanResults.innerHTML = '<div class="empty"><h3>Scan failed</h3><p>' + esc(err.message) + '</p></div>';
      B.toast('error', 'Scan error', err.message);
    }).then(function () { elScanBtn.disabled = false; elScanStatus.textContent = ''; });
  }
  elScanBtn.addEventListener('click', runScan);

  // ── Modal ───────────────────────────────────────────────────────────────
  function openAddModal(p) {
    modalContext = { mode: 'add', prefill: p || {} };
    elModalTitle.textContent = p.inManaged ? 'Update managed TV' : 'Add TV';
    elModalName.value = p.name || ''; elModalIp.value = p.ip || ''; elModalMac.value = p.mac || '';
    elModalMac.disabled = false;
    elModalMacNote.textContent = p.mac ? '(found by the scan)' : '(required)';
    elModalPsk.value = ''; elModalPsk.placeholder = 'leave empty for PIN pairing';
    elModalSource.value = '';
    var hint = '';
    if (p.hint === 'psk-recommended') hint = 'This TV (API v' + (p.iface || '6.x') + ') usually needs a Pre-Shared Key: set the same key on the TV under Settings → Network → IP control → Authentication.';
    else if (p.hint === 'cookie-pairing') hint = 'This TV pairs with a PIN. Its MAC is not readable without authentication: copy it from the TV (Settings → Network → View network status) or from your router.';
    elModalHint.textContent = hint;
    elModal.classList.remove('hidden');
    setTimeout(function () { elModalName.focus(); }, 50);
  }

  function openEditModal(m) {
    modalContext = { mode: 'edit', originalMac: m.mac, prefill: m };
    elModalTitle.textContent = 'Edit ' + (m.name || 'TV');
    elModalName.value = m.name || ''; elModalIp.value = m.ip || ''; elModalMac.value = m.mac || '';
    elModalMac.disabled = true; elModalMacNote.textContent = '(cannot be changed)';
    // The API never returns the stored PSK: leave empty to keep it.
    elModalPsk.value = '';
    elModalPsk.placeholder = m.hasPsk ? 'PSK set — leave empty to keep it' : 'leave empty for PIN pairing';
    elModalSource.value = m.tvsource || '';
    elModalHint.textContent = 'To change the MAC, delete the TV and add it again.';
    elModal.classList.remove('hidden');
    setTimeout(function () { elModalName.focus(); }, 50);
  }

  function closeModal() { elModal.classList.add('hidden'); modalContext = null; }
  elModalCancel.addEventListener('click', closeModal);
  elModal.addEventListener('click', function (e) { if (e.target === elModal) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && modalContext) closeModal(); });

  elModalSave.addEventListener('click', function () {
    if (!modalContext) return;
    var name = elModalName.value.trim(), ip = elModalIp.value.trim(), mac = elModalMac.value.trim(), psk = elModalPsk.value.trim();
    var tvsource = elModalSource.value || null;
    if (!name) { B.toast('warn', 'Missing name', 'Give the TV a name.'); return; }
    if (!ip) { B.toast('warn', 'Missing IP', 'The IP address is required.'); return; }
    elModalSave.disabled = true;
    var req;
    if (modalContext.mode === 'add') {
      var body = { name: name, ip: ip };
      if (mac) body.mac = mac;
      if (psk) body.psk = psk;
      if (tvsource) body.tvsource = tvsource;
      var pf = modalContext.prefill || {};
      if (pf.model) body.modelName = pf.model;
      if (pf.prod) body.productName = pf.prod;
      if (pf.iface) body.interfaceVersion = pf.iface;
      req = B.fetchJson('/api/managed-tvs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (d) {
          if (!d.success) throw new Error(d.message || 'add failed');
          B.toast('success', 'TV saved', 'Restart Homebridge to load it.');
          if (d.enrichmentError && psk) B.toast('warn', 'Saved without details', 'The TV did not accept the PSK: ' + d.enrichmentError);
          closeModal(); loadManaged(); runScan();
        });
    } else {
      var patch = { name: name, ip: ip, tvsource: tvsource };
      if (psk) patch.psk = psk;
      req = B.fetchJson('/api/managed-tvs/' + encodeURIComponent(modalContext.originalMac), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
        .then(function (d) {
          if (!d.success) throw new Error(d.message || 'update failed');
          B.toast('success', 'TV updated', 'Restart Homebridge to apply.');
          closeModal(); loadManaged();
        });
    }
    req.catch(function (e) { B.toast('error', 'Save failed', e.message); }).then(function () { elModalSave.disabled = false; });
  });

  // ── Delegated actions ───────────────────────────────────────────────────
  elScanResults.addEventListener('click', function (e) {
    var b = e.target.closest('[data-action="add"]');
    if (!b || b.disabled) return;
    openAddModal({ ip: b.dataset.ip, mac: b.dataset.mac || '', name: b.dataset.name, model: b.dataset.model, prod: b.dataset.prod, iface: b.dataset.iface, hint: b.dataset.hint, inManaged: !!b.dataset.managed });
  });

  elManagedList.addEventListener('click', function (e) {
    var ed = e.target.closest('[data-action="edit"]');
    if (ed) {
      B.fetchJson('/api/managed-tvs').then(function (d) {
        var m = (d.managedTvs || []).find(function (x) { return x.mac === ed.dataset.mac; });
        if (m) openEditModal(m);
      });
      return;
    }
    var del = e.target.closest('[data-action="delete"]');
    if (del) {
      var mac = del.dataset.mac;
      if (!confirm('Remove the managed TV ' + mac + '?\nA backup of the file is kept automatically.')) return;
      B.fetchJson('/api/managed-tvs/' + encodeURIComponent(mac), { method: 'DELETE' })
        .then(function (d) { if (!d.success) throw new Error(d.message || 'delete failed'); B.toast('success', 'Removed', 'Restart Homebridge to apply.'); loadManaged(); })
        .catch(function (err) { B.toast('error', 'Delete failed', err.message); });
    }
  });

  elManagedList.addEventListener('change', function (e) {
    var inp = e.target.closest('input[data-action="toggle"]');
    if (!inp) return;
    var enabled = !!inp.checked; inp.disabled = true;
    B.fetchJson('/api/managed-tvs/' + encodeURIComponent(inp.dataset.mac), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enabled }) })
      .then(function (d) { if (!d.success) throw new Error(d.message || 'toggle failed'); B.toast('success', enabled ? 'Enabled' : 'Disabled', 'Restart Homebridge to apply.'); loadManaged(); })
      .catch(function (err) { inp.checked = !enabled; B.toast('error', 'Toggle failed', err.message); })
      .then(function () { inp.disabled = false; });
  });

  elClearBtn.addEventListener('click', function () {
    if (!confirm('Remove ALL managed TVs?\nA backup of tvs-managed.json is created automatically.')) return;
    B.fetchJson('/api/managed-tvs/clear', { method: 'POST' })
      .then(function (d) { if (!d.success) throw new Error(d.message || 'clear failed'); B.toast('success', 'Cleared', d.removed + ' removed. Restart Homebridge to apply.'); loadManaged(); })
      .catch(function (err) { B.toast('error', 'Clear failed', err.message); });
  });

  B.header({ active: 'discover', title: 'Discover TVs', sub: 'Find Bravia TVs on your network and add them without editing config.json.' })
    .then(function () { B.footer(); loadManaged(); });
})();
