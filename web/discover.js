(function(){
  // ────────────────────────────────────────────────────────────────────────
  // Bravia Enhanced: Discover UI (v1.4.20)
  // Pure-vanilla JS, no build step. Talks to:
  //   GET    /api/discover
  //   GET    /api/managed-tvs
  //   POST   /api/managed-tvs
  //   PATCH  /api/managed-tvs/:mac
  //   DELETE /api/managed-tvs/:mac
  //   POST   /api/managed-tvs/clear
  // ────────────────────────────────────────────────────────────────────────

  var elToast = document.getElementById('toast-container');
  var elAutoscanPill = document.getElementById('autoscan-pill');
  var elBack = document.getElementById('back-btn');
  var elScanBtn = document.getElementById('scan-btn');
  var elScanStatus = document.getElementById('scan-status');
  var elScanResults = document.getElementById('scan-results');
  var elManagedList = document.getElementById('managed-list');
  var elClearBtn = document.getElementById('clear-btn');

  var elModal = document.getElementById('modal-backdrop');
  var elModalTitle = document.getElementById('modal-title');
  var elModalName = document.getElementById('m-name');
  var elModalIp = document.getElementById('m-ip');
  var elModalMac = document.getElementById('m-mac');
  var elModalMacNote = document.getElementById('m-mac-note');
  var elModalPsk = document.getElementById('m-psk');
  var elModalSource = document.getElementById('m-tvsource');
  var elModalHint = document.getElementById('modal-hint');
  var elModalCancel = document.getElementById('modal-cancel');
  var elModalSave = document.getElementById('modal-save');

  var modalContext = null; // { mode:'add'|'edit', prefill:{}, originalMac? }

  // ─── Utilities ─────────────────────────────────────────────────────────
  function escapeHtml(str){
    return String(str == null ? '' : str)
      .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
      .replaceAll('"','&quot;').replaceAll("'",'&#39;');
  }

  function showToast(kind, title, message){
    var t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.innerHTML = '<div class="toast-title">' + escapeHtml(title) + '</div><div class="toast-msg">' + escapeHtml(message) + '</div>';
    elToast.appendChild(t);
    var ttl = kind === 'error' ? 7000 : 4500;
    setTimeout(function(){
      t.style.opacity = '0';
      t.style.transition = 'opacity .25s ease';
      setTimeout(function(){ t.remove(); }, 260);
    }, ttl);
  }

  function fetchJson(url, options){
    options = options || {};
    return fetch(url, options).then(function(r){
      var ct = r.headers.get('content-type') || '';
      if (ct.indexOf('application/json') === -1) {
        throw new Error('Server returned HTTP ' + r.status + ' (not JSON). Plugin may need a restart or be outdated.');
      }
      return r.json();
    });
  }

  // ─── Back button ───────────────────────────────────────────────────────
  elBack.addEventListener('click', function(){
    // Try to go back to the channel selector. If there is no referrer or it's
    // not local, fall back to root.
    if (document.referrer && document.referrer.indexOf(window.location.origin) === 0) {
      window.history.back();
    } else {
      window.location.href = '/';
    }
  });

  // ─── Managed list rendering ─────────────────────────────────────────────
  function renderManaged(data){
    var list = (data && data.managedTvs) || [];
    if (list.length === 0) {
      elManagedList.innerHTML = '<div class="empty">No managed TVs yet. Run a scan above and add one.</div>';
      elClearBtn.classList.add('hidden');
      return;
    }
    elClearBtn.classList.remove('hidden');
    elManagedList.innerHTML = list.map(function(m){
      var d = m.discovered || {};
      var infoBits = [];
      if (d.model) infoBits.push('Model: <code>' + escapeHtml(d.model) + '</code>');
      if (d.interfaceVer) infoBits.push('Interface: <code>v' + escapeHtml(d.interfaceVer) + '</code>');
      if (d.serial) infoBits.push('Serial: <code>' + escapeHtml(d.serial) + '</code>');
      if (d.generation) infoBits.push('Generation: <code>' + escapeHtml(d.generation) + '</code>');
      if (d.fwVersion) infoBits.push('FW: <code>' + escapeHtml(d.fwVersion) + '</code>');

      var conflictBadge = '';
      if (m.conflictsWithConfig) {
        conflictBadge = ' <span class="pill warn">⚠ in config.json as "' + escapeHtml(m.conflictName || '?') + '"</span>';
      }
      var enabledTitle = m.enabled !== false ? 'Enabled: loaded at next restart' : 'Disabled: ignored at next restart';
      return (
        '<div class="tv-card' + (m.enabled === false ? ' disabled' : '') + '" data-mac="' + escapeHtml(m.mac || '') + '">' +
          '<div>' +
            '<div class="tv-title">' + escapeHtml(m.name || '(no name)') + conflictBadge + '</div>' +
            '<div class="tv-info">' +
              'IP: <code>' + escapeHtml(m.ip || '?') + '</code> &nbsp; MAC: <code>' + escapeHtml(m.mac || '?') + '</code>' +
              (m.psk ? ' &nbsp; <span class="pill ok">PSK</span>' : ' &nbsp; <span class="pill">cookie pairing</span>') +
              (m.tvsource ? ' &nbsp; Source: <code>' + escapeHtml(m.tvsource) + '</code>' : '') +
              (infoBits.length ? '<br/>' + infoBits.join(' &nbsp; ') : '') +
              (m.lastSeen ? '<br/><span style="color:rgba(255,255,255,.45)">Last seen: ' + new Date(m.lastSeen).toLocaleString() + '</span>' : '') +
            '</div>' +
          '</div>' +
          '<div class="tv-actions">' +
            '<label class="switch" title="' + escapeHtml(enabledTitle) + '">' +
              '<input type="checkbox" data-action="toggle" data-mac="' + escapeHtml(m.mac) + '" ' + (m.enabled !== false ? 'checked' : '') + '/>' +
              '<span class="slider"></span>' +
            '</label>' +
            '<button class="btn" data-action="edit" data-mac="' + escapeHtml(m.mac) + '">Edit</button>' +
            '<button class="btn btn-danger" data-action="delete" data-mac="' + escapeHtml(m.mac) + '">Delete</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  function refreshAutoscanPill(enabled){
    if (enabled === true) {
      elAutoscanPill.textContent = 'autoscan: ON';
      elAutoscanPill.className = 'pill ok';
    } else if (enabled === false) {
      elAutoscanPill.textContent = 'autoscan: OFF (set in config)';
      elAutoscanPill.className = 'pill warn';
    } else {
      elAutoscanPill.textContent = 'autoscan: ?';
      elAutoscanPill.className = 'pill';
    }
  }

  function loadManaged(){
    return fetchJson('/api/managed-tvs').then(function(data){
      if (!data.success) throw new Error(data.message || 'load failed');
      refreshAutoscanPill(data.autoscanEnabled);
      renderManaged(data);
      return data;
    }).catch(function(err){
      elManagedList.innerHTML = '<div class="empty">Error loading managed TVs: ' + escapeHtml(err.message) + '</div>';
      showToast('error', 'Error', err.message);
    });
  }

  // ─── Scan results rendering ────────────────────────────────────────────
  function renderScanResults(payload){
    var results = (payload && payload.results) || [];
    var meta = '';
    if (payload && payload.scannedHosts) {
      meta = '<div class="panel-meta">Scanned ' + payload.scannedHosts + ' host(s) on ' +
        (payload.ranges || []).map(escapeHtml).join(', ') +
        ' (' + escapeHtml(payload.source || '') + ').</div>';
    }
    if (results.length === 0) {
      elScanResults.innerHTML = meta + '<div class="empty">No Sony Bravia TVs found on this network range.<br/>' +
        'Tips: make sure the TV is on (or in Quick Start mode with NIC alive), ' +
        'and that <code>discoveryRange</code> matches the TV subnet.</div>';
      return;
    }
    elScanResults.innerHTML = meta + results.map(function(r){
      var stateBadge = '';
      var cardClass = 'tv-card';
      if (r.inConfig) {
        stateBadge = ' <span class="pill warn">in config.json as "' + escapeHtml(r.inConfigAs || '?') + '"</span>';
        cardClass += ' in-config';
      } else if (r.inManaged) {
        stateBadge = ' <span class="pill ok">already managed as "' + escapeHtml(r.inManagedAs || '?') + '"</span>';
        cardClass += ' in-managed';
      }
      var authHint = '';
      if (r.authHint === 'psk-recommended') authHint = ' <span class="pill warn">PSK recommended</span>';
      else if (r.authHint === 'cookie-pairing') authHint = ' <span class="pill">cookie pairing</span>';
      var macInfo = r.mac ? '<code>' + escapeHtml(r.mac) + '</code>' : '<span style="color:rgba(245,158,11,.85)">not resolvable from this host (provide manually)</span>';

      var actionLabel = r.inConfig ? 'Already in config' : (r.inManaged ? 'Update' : 'Add');
      var actionDisabled = r.inConfig ? 'disabled' : '';
      var actionClass = r.inConfig ? 'btn' : (r.inManaged ? 'btn btn-primary' : 'btn btn-success');

      return (
        '<div class="' + cardClass + '">' +
          '<div>' +
            '<div class="tv-title">' + escapeHtml(r.suggestedName || r.ip) + stateBadge + authHint + '</div>' +
            '<div class="tv-info">' +
              'IP: <code>' + escapeHtml(r.ip) + '</code> &nbsp; MAC: ' + macInfo +
              (r.modelName ? ' &nbsp; Model: <code>' + escapeHtml(r.modelName) + '</code>' : '') +
              (r.interfaceVersion ? ' &nbsp; Interface: <code>v' + escapeHtml(r.interfaceVersion) + '</code>' : '') +
            '</div>' +
          '</div>' +
          '<div class="tv-actions">' +
            '<button class="' + actionClass + '" data-action="add" ' +
              'data-ip="' + escapeHtml(r.ip) + '" ' +
              'data-mac="' + escapeHtml(r.mac || '') + '" ' +
              'data-name="' + escapeHtml(r.suggestedName || '') + '" ' +
              'data-model="' + escapeHtml(r.modelName || '') + '" ' +
              'data-prod="' + escapeHtml(r.productName || '') + '" ' +
              'data-iface="' + escapeHtml(r.interfaceVersion || '') + '" ' +
              'data-hint="' + escapeHtml(r.authHint || '') + '" ' +
              actionDisabled + '>' + actionLabel +
            '</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  // ─── Scan trigger ──────────────────────────────────────────────────────
  function runScan(){
    elScanBtn.disabled = true;
    elScanStatus.classList.remove('hidden');
    elScanStatus.innerHTML = '<span class="spinner"></span>scanning…';
    elScanResults.innerHTML = '';
    fetchJson('/api/discover').then(function(data){
      if (!data.success) throw new Error(data.message || 'discover failed');
      renderScanResults(data);
      var n = (data.results || []).length;
      showToast(n > 0 ? 'success' : 'info', 'Scan complete', n + ' TV(s) found on ' + (data.ranges || []).join(', '));
    }).catch(function(err){
      elScanResults.innerHTML = '<div class="empty">Error: ' + escapeHtml(err.message) + '</div>';
      showToast('error', 'Scan error', err.message);
    }).finally(function(){
      elScanBtn.disabled = false;
      elScanStatus.classList.add('hidden');
    });
  }

  elScanBtn.addEventListener('click', runScan);

  // ─── Modal logic ───────────────────────────────────────────────────────
  function openAddModal(prefill){
    modalContext = { mode: 'add', prefill: prefill || {} };
    elModalTitle.textContent = prefill && prefill.inManaged ? 'Update managed TV' : 'Add TV to managed list';
    elModalName.value = prefill.name || '';
    elModalIp.value = prefill.ip || '';
    elModalMac.value = prefill.mac || '';
    elModalMac.disabled = false;
    elModalMacNote.textContent = prefill.mac ? '(resolved from scan)' : '(required, not auto-resolvable)';
    elModalPsk.value = '';
    elModalSource.value = '';
    // Hint based on interface version.
    var hint = '';
    if (prefill.hint === 'psk-recommended') {
      hint = 'This TV (interface v' + (prefill.iface || '6.x') + ') typically requires PSK. ' +
             'Set the same PSK on the TV under Settings → Network → IP control → Authentication → Pre-Shared Key. ' +
             'Without a PSK, serial/MAC enrichment will be skipped.';
    } else if (prefill.hint === 'cookie-pairing') {
      hint = 'This TV (interface v' + (prefill.iface || '<6.x') + ') uses PIN+cookie pairing and does not expose its MAC over an unauthenticated API. ' +
             'You must enter the MAC manually: find it on the TV under Settings → Network → Network Setup → View Network Setup, ' +
             'or in your router DHCP table. You can leave PSK empty; pairing runs from the Pairing page after Homebridge restart.';
    }
    elModalHint.textContent = hint;
    elModal.classList.remove('hidden');
    setTimeout(function(){ elModalName.focus(); }, 50);
  }

  function openEditModal(entry){
    modalContext = { mode: 'edit', originalMac: entry.mac, prefill: entry };
    elModalTitle.textContent = 'Edit managed TV';
    elModalName.value = entry.name || '';
    elModalIp.value = entry.ip || '';
    elModalMac.value = entry.mac || '';
    elModalMac.disabled = true; // MAC is the primary key, not editable
    elModalMacNote.textContent = '(primary key, not editable)';
    elModalPsk.value = entry.psk || '';
    elModalSource.value = entry.tvsource || '';
    elModalHint.textContent = 'Editing an existing managed TV. To change the MAC, delete and re-add.';
    elModal.classList.remove('hidden');
    setTimeout(function(){ elModalName.focus(); }, 50);
  }

  function closeModal(){
    elModal.classList.add('hidden');
    modalContext = null;
  }

  elModalCancel.addEventListener('click', closeModal);
  elModal.addEventListener('click', function(e){
    if (e.target === elModal) closeModal();
  });

  elModalSave.addEventListener('click', function(){
    if (!modalContext) return;
    var name = (elModalName.value || '').trim();
    var ip = (elModalIp.value || '').trim();
    var mac = (elModalMac.value || '').trim();
    var psk = (elModalPsk.value || '').trim();
    var tvsource = elModalSource.value || null;
    if (!name) { showToast('warn', 'Missing field', 'Name is required'); return; }
    if (!ip) { showToast('warn', 'Missing field', 'IP is required'); return; }

    elModalSave.disabled = true;

    if (modalContext.mode === 'add') {
      var body = { name: name, ip: ip };
      if (mac) body.mac = mac;
      if (psk) body.psk = psk;
      if (tvsource) body.tvsource = tvsource;
      // Forward discovery enrichment hints so the saved entry retains them.
      var pf = modalContext.prefill || {};
      if (pf.model) body.modelName = pf.model;
      if (pf.prod) body.productName = pf.prod;
      if (pf.iface) body.interfaceVersion = pf.iface;

      fetchJson('/api/managed-tvs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function(data){
        if (!data.success) throw new Error(data.message || 'add failed');
        showToast('success', 'TV saved', 'Restart Homebridge to load it.');
        if (data.enrichmentError && psk) {
          showToast('warn', 'Enrichment skipped', 'PSK call failed: ' + data.enrichmentError + '. Entry saved without serial.');
        }
        closeModal();
        loadManaged();
        // Re-render scan results so the "already managed" badge appears.
        runScan();
      }).catch(function(err){
        showToast('error', 'Save error', err.message);
      }).finally(function(){
        elModalSave.disabled = false;
      });
    } else if (modalContext.mode === 'edit') {
      var patch = { name: name, ip: ip, tvsource: tvsource };
      if (psk !== (modalContext.prefill.psk || '')) patch.psk = psk || null;
      fetchJson('/api/managed-tvs/' + encodeURIComponent(modalContext.originalMac), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      }).then(function(data){
        if (!data.success) throw new Error(data.message || 'patch failed');
        showToast('success', 'TV updated', 'Restart Homebridge to apply.');
        closeModal();
        loadManaged();
      }).catch(function(err){
        showToast('error', 'Update error', err.message);
      }).finally(function(){
        elModalSave.disabled = false;
      });
    }
  });

  // ─── Delegated handlers for scan + managed cards ───────────────────────
  elScanResults.addEventListener('click', function(e){
    var btn = e.target.closest('[data-action="add"]');
    if (!btn) return;
    openAddModal({
      ip: btn.dataset.ip,
      mac: btn.dataset.mac || '',
      name: btn.dataset.name,
      model: btn.dataset.model,
      prod: btn.dataset.prod,
      iface: btn.dataset.iface,
      hint: btn.dataset.hint,
      inManaged: btn.textContent.trim() === 'Update'
    });
  });

  elManagedList.addEventListener('click', function(e){
    var editBtn = e.target.closest('[data-action="edit"]');
    if (editBtn) {
      var mac = editBtn.dataset.mac;
      // Fetch fresh data from server to ensure no staleness.
      fetchJson('/api/managed-tvs').then(function(d){
        var entry = (d.managedTvs || []).find(function(m){ return m.mac === mac; });
        if (entry) openEditModal(entry);
      });
      return;
    }
    var delBtn = e.target.closest('[data-action="delete"]');
    if (delBtn) {
      var dmac = delBtn.dataset.mac;
      if (!confirm('Delete managed TV with MAC ' + dmac + '?\nA backup of the managed file is saved automatically.')) return;
      fetchJson('/api/managed-tvs/' + encodeURIComponent(dmac), { method: 'DELETE' })
        .then(function(data){
          if (!data.success) throw new Error(data.message || 'delete failed');
          showToast('success', 'Deleted', dmac + ' removed. Restart Homebridge to apply.');
          loadManaged();
        })
        .catch(function(err){ showToast('error', 'Delete error', err.message); });
      return;
    }
  });

  elManagedList.addEventListener('change', function(e){
    var input = e.target.closest('input[data-action="toggle"]');
    if (!input) return;
    var mac = input.dataset.mac;
    var enabled = !!input.checked;
    input.disabled = true;
    fetchJson('/api/managed-tvs/' + encodeURIComponent(mac), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled })
    }).then(function(data){
      if (!data.success) throw new Error(data.message || 'toggle failed');
      showToast('success', enabled ? 'Enabled' : 'Disabled', 'Restart Homebridge to apply.');
      loadManaged();
    }).catch(function(err){
      // Revert visual state on error.
      input.checked = !enabled;
      showToast('error', 'Toggle error', err.message);
    }).finally(function(){
      input.disabled = false;
    });
  });

  // ─── Clear all ─────────────────────────────────────────────────────────
  elClearBtn.addEventListener('click', function(){
    if (!confirm('Remove ALL managed TVs?\n\nThis empties tvs-managed.json. A backup file is created automatically and can be restored manually.')) return;
    fetchJson('/api/managed-tvs/clear', { method: 'POST' })
      .then(function(data){
        if (!data.success) throw new Error(data.message || 'clear failed');
        showToast('success', 'Cleared', 'Removed ' + data.removed + ' entry/entries. Restart Homebridge to apply.');
        loadManaged();
      })
      .catch(function(err){ showToast('error', 'Clear error', err.message); });
  });

  // ─── Initial load ──────────────────────────────────────────────────────
  loadManaged();
})();
