// Pairing & device — homebridge-bravia-enhanced v1.4.21 (diegoweb100)
// Talks to: GET /api/status, /api/pairing-status, /api/device-info, /api/diagnostics ;
//           POST /api/request-pin, /api/pin, /api/delete-cookie
(function () {
  'use strict';
  var B = window.BUI, esc = B.esc;
  B.hydrate();
  var $ = function (id) { return document.getElementById(id); };
  var tv = B.qs('tv');
  var otp = Array.prototype.slice.call(document.querySelectorAll('#otp input'));

  function step(n) {
    [1, 2, 3].forEach(function (i) {
      var el = $('st' + i);
      el.classList.toggle('act', i === n);
      el.classList.toggle('done', i < n);
    });
  }

  function pinValue() { return otp.map(function (i) { return i.value; }).join(''); }
  function updatePinBtn() { $('submit-pin').disabled = !/^\d{4}$/.test(pinValue()); }

  otp.forEach(function (inp, idx) {
    inp.addEventListener('input', function () {
      inp.value = inp.value.replace(/\D/g, '').slice(-1);
      if (inp.value && otp[idx + 1]) otp[idx + 1].focus();
      if (inp.value) step(3);
      updatePinBtn();
    });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !inp.value && otp[idx - 1]) otp[idx - 1].focus();
      if (e.key === 'Enter' && !$('submit-pin').disabled) submitPin();
    });
    inp.addEventListener('paste', function (e) {
      var t = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 4);
      if (!t) return;
      e.preventDefault();
      otp.forEach(function (o, i) { o.value = t[i] || ''; });
      (otp[Math.min(t.length, 3)]).focus();
      step(3); updatePinBtn();
    });
  });

  function refreshStatus() {
    if (B.status) renderCookie(B.status.cookie);
    if (!tv) { $('pin-card').classList.add('hidden'); return Promise.resolve(); }
    return B.fetchJson('/api/pairing-status?tv=' + encodeURIComponent(tv)).then(function (d) {
      if (!d.success) throw new Error(d.message || 'status failed');
      var s = B.status || {};
      var paired = d.paired && !d.pinRequired;
      $('paired-card').classList.toggle('hidden', !paired);
      $('pin-card').classList.toggle('hidden', paired);
      $('danger-card').classList.toggle('hidden', !paired || s.authMode === 'psk');
      if (paired) {
        if (s.authMode === 'psk') {
          $('ok-title').textContent = 'PSK authentication active';
          $('ok-sub').textContent = 'This TV uses a Pre-Shared Key: no PIN pairing is needed.';
        } else {
          $('ok-title').textContent = 'Paired with ' + (tv || 'the TV');
          $('ok-sub').textContent = s.authenticated ? 'Authenticated and connected.' : 'Pairing stored. The plugin reconnects as soon as the TV is on.';
        }
      } else {
        step(s.power ? 2 : 1);
        setTimeout(function () { otp[0].focus(); }, 50);
      }
    }).catch(function (e) { B.toast('error', 'Status error', e.message); });
  }

  function loadDeviceInfo() {
    return B.fetchJson('/api/device-info?tv=' + encodeURIComponent(tv)).then(function (r) {
      if (!r.success || !r.data) return;
      var d = r.data, s = B.status || {};
      var i = d.interface || {}, y = d.system || {};
      $('di-model').textContent = y.model || i.modelName || '–';
      $('di-product').textContent = i.productName || '';
      $('di-ip').textContent = d.ip || '–';
      $('di-mode').textContent = s.authMode === 'psk' ? 'Pre-Shared Key' : 'PIN + cookie';
      $('di-serial').textContent = y.serial || (i.modelName ? 'after pairing' : '–');
      $('di-interface').textContent = i.interfaceVersion ? 'v' + i.interfaceVersion : '–';
      $('di-firmware').textContent = y.generation ? 'generation ' + y.generation : '';
      var apis = d.apiVersions || {};
      var keys = Object.keys(apis).sort();
      $('di-apis').innerHTML = keys.length ? keys.map(function (k) { return '<span>' + esc(k) + ' <b>v' + esc(apis[k]) + '</b></span>'; }).join('') : '<span>not detected yet (TV off?)</span>';
      if (d.detectedAt) $('di-detected-at').textContent = 'What the TV reports about itself · last read ' + new Date(d.detectedAt).toLocaleString();
    }).catch(function () {});
  }

  function submitPin() {
    var pin = pinValue();
    if (!/^\d{4}$/.test(pin)) { B.toast('warn', 'PIN incomplete', 'Type the 4 digits shown on the TV.'); return; }
    var btn = $('submit-pin'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Pairing…';
    B.fetchJson('/api/pin?tv=' + encodeURIComponent(tv), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: pin }) })
      .then(function (d) {
        if (!d.success) throw new Error(d.message || 'PIN rejected');
        B.toast('success', 'PIN sent', 'Completing pairing…');
        otp.forEach(function (o) { o.value = ''; });
        // Poll a few times: the TV answers asynchronously.
        var tries = 0;
        var poll = function () {
          tries++;
          B.header(hdrOpts).then(refreshStatus).then(function () {
            if ($('pin-card').classList.contains('hidden')) { B.toast('success', 'Paired', 'You can now choose the channels.'); loadDeviceInfo(); }
            else if (tries < 5) setTimeout(poll, 1500);
            else B.toast('warn', 'Not paired yet', 'The TV did not accept the PIN. Show a new PIN and try again.');
          });
        };
        setTimeout(poll, 1200);
      })
      .catch(function (e) { B.toast('error', 'Rejected', e.message); })
      .then(function () { btn.innerHTML = B.icon('check') + 'Pair'; updatePinBtn(); });
  }

  function requestPin() {
    var btn = $('request-pin-btn'); btn.disabled = true;
    B.fetchJson('/api/request-pin?tv=' + encodeURIComponent(tv), { method: 'POST' })
      .then(function (d) {
        if (!d.success) throw new Error(d.message || 'Could not request PIN');
        // v1.4.22: a TV that still knows Homebridge re-pairs at once without
        // showing a PIN: check before asking the user to type one.
        return new Promise(function (r) { setTimeout(r, 2500); })
          .then(function () { return B.fetchJson('/api/pairing-status?tv=' + encodeURIComponent(tv)); })
          .then(function (st) {
            if (st && st.paired) {
              B.toast('success', 'Paired — no PIN needed', 'The TV still knows Homebridge and renewed the pairing on its own.');
              return B.header(hdrOpts).then(refreshStatus);
            }
            B.toast('success', 'Look at the TV', d.message || 'A PIN is now shown on the TV screen.');
            step(3); otp[0].focus();
          });
      })
      .catch(function (e) { B.toast('error', 'Error', e.message); })
      .then(function () { btn.disabled = false; });
  }

  function forceUnpair() {
    if (!confirm('Delete the stored cookie and pair again?\nThe TV will need to show a new PIN.')) return;
    var btn = $('force-unpair-btn'); btn.disabled = true;
    B.fetchJson('/api/delete-cookie?tv=' + encodeURIComponent(tv), { method: 'POST' })
      .then(function (d) {
        if (!d.success) throw new Error(d.message || 'Could not delete cookie');
        B.toast('success', 'Cookie deleted', 'Pair again: switch the TV on and show the PIN.');
        return B.header(hdrOpts).then(refreshStatus);
      })
      .catch(function (e) { B.toast('error', 'Error', e.message); })
      .then(function () { btn.disabled = false; });
  }

  // Pairing cookie validity (v1.4.22) ---------------------------------------------
  var RENEW = { renewed: 'renewed', accepted: 'accepted by the TV', 'pin-required': 'the TV asks for a new PIN', unreachable: 'TV not reachable', error: 'refused' };
  function fmtDate(ms) { return ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–'; }
  function renderCookie(ck) {
    if (!ck || ck.mode !== 'cookie' || !ck.present) { $('ck-box').classList.add('hidden'); return; }
    $('ck-box').classList.remove('hidden');
    var d = typeof ck.daysLeft === 'number' ? ck.daysLeft : null;
    var cls = d === null ? '' : (d < 0 || ck.refused ? 'bad' : (d <= 5 ? 'warn' : 'good'));
    $('ck-card').className = 'card ' + cls;
    $('ck-days').textContent = ck.refused ? 'Refused' : (d === null ? '?' : (d < 0 ? 'Expired' : Math.floor(d) + (Math.floor(d) === 1 ? ' day' : ' days')));
    $('ck-until').textContent = (ck.expiresAt ? (d < 0 ? 'expired ' : 'until ') + fmtDate(ck.expiresAt) : '') + (ck.estimated ? ' (estimated)' : '');
    $('ck-auto').textContent = ck.autoRenew ? 'On' : 'Paused — pair again';
    $('ck-renew-card').className = 'card ' + (ck.autoRenew ? 'good' : 'warn');
    $('ck-last').textContent = ck.lastRenewAttempt ? 'last: ' + fmtDate(ck.lastRenewAttempt) + ' · ' + (RENEW[ck.lastRenewResult] || ck.lastRenewResult || '') : 'not needed yet';
    B.setMeter && (function () {
      var bar = $('ck-bar'); var pct = d === null ? 0 : Math.max(0, Math.min(100, d / 14 * 100));
      bar.firstChild.style.width = pct + '%'; bar.className = 'bar' + (d !== null && d <= 2 ? ' full' : (d !== null && d <= 5 ? ' warn' : ''));
    })();
  }
  $('ck-renew-btn').addEventListener('click', function () {
    var btn = this; btn.disabled = true;
    B.fetchJson('/api/renew-cookie', { method: 'POST' }).then(function (r) {
      if (r.cookie) renderCookie(r.cookie);
      if (r.success) B.toast('success', 'Pairing renewed', r.result === 'renewed' ? 'New cookie from the TV.' : 'The TV accepted the pairing.');
      else B.toast('error', 'Not renewed', r.message || 'Error');
      return B.header(hdrOpts);
    }).catch(function (e) { B.toast('error', 'Error', e.message); }).then(function () { btn.disabled = false; });
  });

  // Diagnostics ---------------------------------------------------------------
  var SAVING = { off: 'Off', low: 'Low', high: 'High', pictureOff: 'Screen off' };
  var PRETTY = function (v) { return String(v || '').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/^./, function (c) { return c.toUpperCase(); }); };
  function card(cls, ic, title, value, sub, mono) {
    return '<div class="card ' + cls + '"><div class="ct">' + B.icon(ic) + esc(title) + '</div>' +
      '<div class="cv sm' + (mono ? ' mono' : '') + '">' + esc(value) + '</div><div class="cs">' + esc(sub || '') + '</div></div>';
  }
  function loadDiagnostics() {
    $('dg-refresh').disabled = true;
    return B.fetchJson('/api/diagnostics').then(function (d) {
      if (!d.success) throw new Error(d.message || 'error');
      if (!d.tvOn) {
        $('dg-cards').innerHTML = '<div class="card warn" style="grid-column:1/-1"><div class="ct">' + B.icon('power') + 'TV off</div><div class="cv sm">Switch the TV on to read its settings</div></div>';
        $('dg-modes').classList.add('hidden');
        return;
      }
      var n = d.network || {};
      var t = d.tvTime ? (typeof d.tvTime === 'string' ? d.tvTime : d.tvTime.dateTime) : '';
      var skew = '';
      if (t) {
        var diff = Math.round((new Date(t.replace(/([+-]\d\d)(\d\d)$/, '$1:$2')).getTime() - Date.now()) / 1000);
        if (!isNaN(diff)) skew = Math.abs(diff) < 90 ? 'in sync with Homebridge' : 'differs by ' + Math.round(diff / 60) + ' min';
      }
      var playing = d.playing ? (d.playing.title || d.playing.uri || '') : '';
      var html = '';
      html += card(d.wolEnabled ? 'good' : 'bad', 'power', 'Wake-on-LAN', d.wolEnabled === null ? 'unknown' : (d.wolEnabled ? 'Enabled' : 'Disabled'),
        d.wolEnabled === false ? 'Turn on “Remote start” on the TV, or HomeKit cannot switch it on' : 'the TV can be switched on from HomeKit');
      html += card('', 'lan', 'Network', (n.netif === 'eth0' ? 'Ethernet' : (n.netif === 'wlan0' ? 'Wi-Fi' : (n.netif || '–'))) + (n.ip ? ' · ' + n.ip : ''),
        (n.mac ? 'MAC ' + n.mac : '') + (n.gateway ? ' · gw ' + n.gateway : ''), false);
      html += card(d.powerSavingMode && d.powerSavingMode !== 'off' ? 'warn' : 'good', 'spark', 'Power saving', SAVING[d.powerSavingMode] || PRETTY(d.powerSavingMode) || '–',
        d.powerSavingMode === 'pictureOff' ? 'picture is off, sound only' : 'picture brightness setting');
      html += card('acc', 'hd', 'Picture mode', PRETTY(d.pictureMode) || '–', d.pictureModes.length ? d.pictureModes.length + ' modes available' : '');
      html += card(d.usbRecordingDrive ? 'good' : '', 'save', 'USB recording drive', d.usbRecordingDrive ? 'Connected' : 'Not connected',
        d.usbRecordingDrive ? 'recording status: ' + PRETTY(d.recordingStatus || 'unknown') : 'recordings need a USB drive registered on the TV');
      html += card('', 'info', 'TV clock', t ? t.replace('T', ' ').slice(0, 16) : '–', skew);
      html += card('', 'tv', 'Now playing', playing || '–', d.playing && d.playing.dispNum ? 'channel ' + parseInt(d.playing.dispNum, 10) : (d.playing && d.playing.source ? d.playing.source : ''));
      html += card(d.remoteKeys ? 'good' : 'warn', 'key', 'Remote keys', d.remoteKeys ? d.remoteKeys + ' keys' : 'not read yet', 'used by TV functions (Teletext, Guide…)');
      $('dg-cards').innerHTML = html;
      if (d.pictureModes.length) {
        $('dg-modelist').innerHTML = d.pictureModes.map(function (m) {
          return '<span>' + (m === d.pictureMode ? '<b>' + esc(m) + ' ✓</b>' : esc(m)) + '</span>';
        }).join('');
        $('dg-modes').classList.remove('hidden');
      }
    }).catch(function (e) {
      $('dg-cards').innerHTML = '<div class="card bad" style="grid-column:1/-1"><div class="ct">' + B.icon('alert') + 'Not available</div><div class="cv sm">' + esc(e.message) + '</div></div>';
    }).then(function () { $('dg-refresh').disabled = false; });
  }
  $('dg-refresh').addEventListener('click', loadDiagnostics);

  $('submit-pin').addEventListener('click', submitPin);
  $('request-pin-btn').addEventListener('click', requestPin);
  $('force-unpair-btn').addEventListener('click', forceUnpair);

  var hdrOpts = { active: 'pairing', title: 'Pairing & device', sub: 'Connect the plugin to the TV and check what it reports.' };
  B.header(hdrOpts).then(function (s) {
    if (!tv && s && s.tv) tv = s.tv.name;
    $('to-channels').href = '/?tv=' + encodeURIComponent(tv || '');
    if (!tv) { B.toast('error', 'Missing TV', 'Open this page from the plugin log link.'); return; }
    B.footer();
    renderCookie(s && s.cookie);
    return Promise.all([refreshStatus(), loadDeviceInfo(), loadDiagnostics()]);
  });
})();
