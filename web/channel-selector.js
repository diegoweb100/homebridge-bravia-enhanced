// Channel Selector — homebridge-bravia-enhanced v1.4.21 (diegoweb100)
// Talks to: GET /api/status, /api/scan[?rescan=1], /api/selection, /api/inputs ; POST /api/save
(function () {
  'use strict';
  var B = window.BUI, icon = B.icon, esc = B.esc;
  B.hydrate();

  var S = {
    tv: null, max: 97,
    channels: [],            // [{name, uri, sourceType, type, channelNumber}]
    saved: new Map(),        // uri -> saved object (with identifier)
    sel: new Set(),          // currently ticked uris
    inputs: new Map(),       // uri -> {connection,label}
    type: 'all', q: '', onlySel: false, busy: false
  };
  var $ = function (id) { return document.getElementById(id); };

  var TYPES = {
    tv: { label: 'TV channels', ic: 'antenna' },
    radio: { label: 'Radio', ic: 'radio' },
    hdmi: { label: 'Inputs', ic: 'hdmi' },
    fn: { label: 'TV functions', ic: 'spark' },
    rec: { label: 'Recordings on the USB drive', ic: 'rec' },
    app: { label: 'Apps', ic: 'app' }
  };
  function typeOf(ch) {
    if (ch.type === 'radio' || ch.type === 'fn' || ch.type === 'rec') return ch.type;
    if (typeof ch.uri === 'string' && ch.uri.indexOf('usb:recStorage') === 0) return 'rec';
    if (typeof ch.uri === 'string' && ch.uri.indexOf('ircc:') === 0) return 'fn';
    if (ch.type === 'tv' || ch.sourceType === 2) return 'tv';
    if (ch.type === 'app' || ch.sourceType === 10) return 'app';
    return 'hdmi';
  }

  // Apps / TV functions / recordings can live in their own Home tiles
  // (appsAccessory, functionsAccessory, recordingsAccessory): they then do not
  // count towards the TV's input limit.
  var SPLIT = { app: 'apps', fn: 'functions', rec: 'recordings' };
  var TILE = { app: 'Apps', fn: 'Functions', rec: 'Recordings' };
  function separate(t) { var ti = (B.status && B.status.tiles) || {}; return !!(SPLIT[t] && ti[SPLIT[t]]); }
  function tvName() { return (B.status && B.status.tv && B.status.tv.name) || S.tv; }
  function mainCount() {
    var n = 0;
    S.channels.forEach(function (c) { if (S.sel.has(c.uri) && !separate(typeOf(c))) n++; });
    return n;
  }
  function chOf(uri) { for (var i = 0; i < S.channels.length; i++) if (S.channels[i].uri === uri) return S.channels[i]; return null; }

  // ── Data ────────────────────────────────────────────────────────────────
  function tvParam() { return 'tv=' + encodeURIComponent(S.tv); }

  function loadAll(rescan) {
    S.busy = true;
    renderSkeleton(rescan);
    return Promise.all([
      B.fetchJson('/api/scan?' + tvParam() + (rescan ? '&rescan=1' : '')),
      B.fetchJson('/api/selection?' + tvParam()),
      B.fetchJson('/api/inputs?' + tvParam()).catch(function () { return null; })
    ]).then(function (r) {
      var scan = r[0], sel = r[1], inp = r[2];
      if (!scan.success) throw new Error(scan.error || scan.message || 'scan failed');
      S.channels = scan.channels || [];
      S.max = scan.maxChannels || 97;
      S.saved = new Map();
      var savedList = (sel && sel.success) ? (sel.channels || (sel.selection || []).map(function (u) { return { uri: u }; })) : [];
      savedList.forEach(function (c) { if (c && c.uri) S.saved.set(c.uri, c); });
      S.sel = new Set(S.saved.keys());
      S.inputs = new Map();
      if (inp && inp.success) (inp.inputs || []).forEach(function (i) { S.inputs.set(i.uri, i); });
      if (rescan && scan.rescan) {
        if (scan.rescan === 'done') B.toast('success', 'Rescan complete', S.channels.length + ' items found on the TV');
        else if (scan.rescan === 'tv-off') B.toast('warn', 'TV is off', 'Switch the TV on to read a fresh list. Showing the last scan.');
        else if (scan.rescan === 'timeout') B.toast('warn', 'Still scanning', 'The TV is slow to answer; showing the last scan. Try again in a moment.');
      }
      if (S.channels.length === 0) {
        renderEmpty();
      } else {
        render();
      }
    }).catch(function (e) {
      $('list').innerHTML = '<div class="empty"><div class="big">' + icon('alert') + '</div><h3>Could not load the channel list</h3><p>' + esc(e.message) + '</p></div>';
      B.toast('error', 'Error', e.message);
    }).then(function () { S.busy = false; syncButtons(); });
  }

  // ── Rendering ───────────────────────────────────────────────────────────
  function renderSkeleton(rescan) {
    var h = '<div class="group-h">' + (rescan ? '<span class="spin"></span> Asking the TV for a fresh list… this can take ~20 s' : 'Loading…') + '<span class="line"></span></div><div class="tiles">';
    for (var i = 0; i < 12; i++) h += '<div class="skel"></div>';
    $('list').innerHTML = h + '</div>';
  }

  function renderEmpty() {
    $('list').innerHTML = '<div class="empty"><div class="big">' + icon('tv') + '</div><h3>No channels yet</h3>' +
      '<p>The plugin has not been able to read the list from the TV. Switch the TV on and press <b>Rescan TV</b>.</p></div>';
    updateStats();
  }

  function visible(ch) {
    var t = typeOf(ch);
    if (S.type !== 'all' && t !== S.type && !(S.type === 'hdmi' && t === 'fn') && !(S.type === 'tv' && t === 'rec')) return false;
    if (S.onlySel && !S.sel.has(ch.uri)) return false;
    if (S.q && (ch.name || '').toLowerCase().indexOf(S.q) === -1) return false;
    return true;
  }

  function tileHtml(ch) {
    var t = typeOf(ch), uri = ch.uri, sel = S.sel.has(uri);
    var changed = sel !== S.saved.has(uri);
    var badge, sub;
    if (t === 'tv' || t === 'radio') {
      var num = (ch.channelNumber && ch.channelNumber !== 'N/A') ? String(ch.channelNumber) : '';
      badge = num && num.length <= 4 ? esc(num) : icon(t === 'radio' ? 'radio' : 'antenna');
      var q = /\b(4K|UHD)\b/i.test(ch.name || '') ? '<span class="pill good" style="padding:0 6px">4K</span> '
            : (/\bHD\b/i.test(ch.name || '') ? '<span class="pill acc" style="padding:0 6px">HD</span> ' : '');
      sub = t === 'radio' ? 'Digital radio' : q + 'Digital TV';
    } else if (t === 'fn') {
      badge = icon(uri === 'ircc:Rec' ? 'rec' : 'spark');
      sub = uri === 'ircc:Rec' ? 'Remote key · needs the USB drive' : 'Remote key on the TV';
    } else if (t === 'rec') {
      badge = icon('rec');
      var m = ch.rec || {};
      var bits = [];
      if (m.channelName) bits.push(esc(m.channelName));
      if (m.startDateTime) bits.push(esc(String(m.startDateTime).slice(0, 10)));
      if (m.durationSec) bits.push(Math.round(m.durationSec / 60) + ' min');
      sub = bits.length ? bits.join(' · ') : 'Recording (USB drive)';
    } else if (t === 'app') {
      badge = icon('app');
      sub = 'App';
    } else {
      badge = icon('hdmi');
      var st = S.inputs.get(uri);
      if (st) {
        sub = '<span class="conn' + (st.connection ? ' on' : '') + '"></span>' + (st.connection ? (st.label ? esc(st.label) + ' · connected' : 'Connected') : 'Nothing connected');
      } else {
        sub = 'External input';
      }
    }
    return '<div class="tile ' + t + (sel ? ' sel' : '') + (changed ? ' changed' : '') + '" data-uri="' + esc(uri) + '" role="checkbox" aria-checked="' + sel + '" tabindex="0" title="' + esc(ch.name) + '">' +
      '<div class="ti">' + badge + '</div>' +
      '<div class="tn"><b>' + esc(ch.name || uri) + '</b><small>' + sub + '</small></div>' +
      '<div class="ck">' + icon('check') + '</div></div>';
  }

  function render() {
    var groups = { tv: [], radio: [], hdmi: [], fn: [], app: [], rec: [] };
    var counts = { all: 0, tv: 0, radio: 0, hdmi: 0, fn: 0, app: 0, rec: 0 };
    S.channels.forEach(function (ch) {
      var t = typeOf(ch);
      counts[t]++; counts.all++;
      if (visible(ch)) groups[t].push(ch);
    });
    ['all', 'tv', 'radio', 'hdmi', 'app'].forEach(function (k) { var e = $('n-' + k); if (e) e.textContent = counts[k] + (k === 'hdmi' ? counts.fn : 0) + (k === 'tv' ? counts.rec : 0); });

    // Inputs and apps first: they are few and usually the most wanted.
    var order = ['hdmi', 'fn', 'app', 'rec', 'tv', 'radio'];
    var html = '';
    order.forEach(function (t) {
      var arr = groups[t];
      if (!arr.length) return;
      if (t === 'rec' && separate('rec')) {
        html += '<div class="group-h">' + icon(TYPES[t].ic) + TYPES[t].label + ' <span class="cnt">' + arr.length + '</span><span class="line"></span></div>' +
          '<div class="sep-note">' + icon('home') + '<div><b>All ' + arr.length + ' recordings are in the “' + esc(tvName()) + ' Recordings” tile</b>' +
          '<span>Added and removed automatically, newest first, while the USB drive is connected. Manage them on the <a href="/recordings">Recordings</a> page.</span></div></div>';
        return;
      }
      var nSel = arr.filter(function (c) { return S.sel.has(c.uri); }).length;
      html += '<div class="group-h">' + icon(TYPES[t].ic) + TYPES[t].label + ' <span class="cnt">' + nSel + ' / ' + arr.length + ' selected</span><span class="line"></span>' +
        '<button class="btn btn-ghost gact" data-gsel="' + t + '">Select all</button><button class="btn btn-ghost gact" data-gclr="' + t + '">None</button></div>' +
        (separate(t) ? '<div class="sep-note">' + icon('home') + '<div><b>Shown in the separate “' + esc(tvName()) + ' ' + TILE[t] + '” tile</b><span>' +
          (t === 'fn' ? 'One button per function. ' : 'Pick one in that tile to launch it on the TV. ') + 'They do not count towards the TV limit. If none is ticked, all of them appear.</span></div></div>' : '') +
        (t === 'rec' ? '<p class="note" style="margin:-4px 0 10px">Available only while the USB drive is connected to the TV. Each selected recording becomes an input in the Home app that plays it.</p>' : '') +
        '<div class="tiles">' + arr.map(tileHtml).join('') + '</div>';
    });
    if (!html) html = '<div class="empty"><div class="big">' + icon('search') + '</div><h3>Nothing matches</h3><p>Change the search or the filter.</p></div>';
    $('list').innerHTML = html;
    updateStats();
  }

  function diffCount() {
    var n = 0;
    S.sel.forEach(function (u) { if (!S.saved.has(u)) n++; });
    S.saved.forEach(function (_, u) { if (!S.sel.has(u)) n++; });
    return n;
  }

  function updateStats() {
    var n = mainCount(), d = diffCount();
    $('c-sel').textContent = n;
    $('c-max').textContent = S.max; $('max-inline').textContent = S.max;
    var nSaved = 0; S.saved.forEach(function (_, u) { var c = chOf(u); if (!(c && separate(typeOf(c)))) nSaved++; });
    $('c-saved').textContent = nSaved;
    $('c-total').textContent = S.channels.length;
    $('c-chg').textContent = d;
    $('c-chg-s').textContent = d ? 'not saved yet' : 'everything saved';
    $('c-chg-card').className = 'card' + (d ? ' warn' : ' good');
    var left = S.max - n;
    $('c-sel-s').innerHTML = 'of <span id="c-max">' + S.max + '</span> allowed' + (left <= 5 ? ' · <b style="color:var(--warn)">' + Math.max(0, left) + ' left</b>' : '');
    B.setMeter(n, S.max);
    var lbl = document.querySelector('#h-meter .l'); if (lbl) lbl.textContent = 'Selected for HomeKit';
    $('savebar').classList.toggle('show', d > 0);
    $('sb-msg').innerHTML = d + (d === 1 ? ' unsaved change' : ' unsaved changes') + '<span class="sbx"> · ' + n + ' selected</span>';
    syncButtons();
  }

  function syncButtons() {
    var d = diffCount();
    ['save-btn', 'save-btn-top'].forEach(function (id) { $(id).disabled = S.busy || d === 0; });
    $('rescan-btn').disabled = S.busy;
    $('discard-btn').disabled = S.busy || d === 0;
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  function toggle(uri) {
    if (S.sel.has(uri)) S.sel.delete(uri);
    else {
      var c0 = chOf(uri);
      if (!(c0 && separate(typeOf(c0))) && mainCount() >= S.max) { B.toast('warn', 'HomeKit limit reached', 'A TV can show at most ' + S.max + ' inputs. Remove something first.'); return; }
      S.sel.add(uri);
    }
    render();
  }

  function addMany(list) {
    var skipped = 0;
    list.forEach(function (c) {
      if (S.sel.has(c.uri)) return;
      if (!separate(typeOf(c)) && mainCount() >= S.max) { skipped++; return; }
      S.sel.add(c.uri);
    });
    if (skipped) B.toast('warn', 'HomeKit limit reached', skipped + ' item(s) not added: the limit is ' + S.max + '.');
    render();
  }

  function save() {
    if (S.busy) return;
    var chosen = S.channels.filter(function (c) { return S.sel.has(c.uri); });
    if (!chosen.length) { B.toast('warn', 'Nothing selected', 'Select at least one item.'); return; }
    if (mainCount() > S.max) { B.toast('error', 'Too many', mainCount() + ' / ' + S.max); return; }
    // Keep the HomeKit identifier of items that were already saved, so the
    // Home app keeps their names/order and automations keep pointing to them.
    var payload = chosen.map(function (c) {
      var o = { name: c.name, uri: c.uri, sourceType: c.sourceType, channelNumber: c.channelNumber, type: typeOf(c) };
      var prev = S.saved.get(c.uri);
      if (prev && prev.identifier != null) o.identifier = prev.identifier;
      return o;
    });
    S.busy = true; syncButtons();
    $('save-btn').innerHTML = '<span class="spin"></span>Saving…';
    B.fetchJson('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tv: S.tv, channels: payload }) })
      .then(function (d) {
        if (!d.success) throw new Error(d.error || d.message || 'save failed');
        S.saved = new Map(payload.map(function (c) { return [c.uri, c]; }));
        B.toast('success', 'Saved', payload.length + ' inputs applied to HomeKit.');
        if (B.status) B.status.homekitInputs = payload.length;
      })
      .catch(function (e) { B.toast('error', 'Save failed', e.message); })
      .then(function () {
        S.busy = false;
        $('save-btn').innerHTML = icon('save') + 'Save<span class="sbx">&nbsp;selection</span>';
        render();
      });
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  $('list').addEventListener('click', function (e) {
    var g = e.target.closest('[data-gsel],[data-gclr]');
    if (g) {
      var t = g.getAttribute('data-gsel') || g.getAttribute('data-gclr');
      var arr = S.channels.filter(function (c) { return typeOf(c) === t && visible(c); });
      if (g.hasAttribute('data-gsel')) addMany(arr);
      else { arr.forEach(function (c) { S.sel.delete(c.uri); }); render(); }
      return;
    }
    var tile = e.target.closest('.tile');
    if (tile) toggle(tile.getAttribute('data-uri'));
  });
  $('list').addEventListener('keydown', function (e) {
    if ((e.key === ' ' || e.key === 'Enter') && e.target.classList.contains('tile')) {
      e.preventDefault(); var u = e.target.getAttribute('data-uri'); toggle(u);
      var again = document.querySelector('.tile[data-uri="' + CSS.escape(u) + '"]'); if (again) again.focus();
    }
  });
  $('type-seg').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-t]'); if (!b) return;
    S.type = b.getAttribute('data-t');
    this.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
    render();
  });
  var qT = null;
  $('search-input').addEventListener('input', function () {
    var v = this.value; clearTimeout(qT);
    qT = setTimeout(function () { S.q = v.trim().toLowerCase(); render(); }, 120);
  });
  $('only-sel').addEventListener('click', function () {
    S.onlySel = !S.onlySel;
    this.setAttribute('aria-pressed', S.onlySel);
    this.classList.toggle('btn-primary', S.onlySel);
    render();
  });
  $('select-hd').addEventListener('click', function () {
    addMany(S.channels.filter(function (c) { return typeOf(c) === 'tv' && /\b(HD|4K|UHD)\b/i.test(c.name || ''); }));
  });
  $('select-visible').addEventListener('click', function () { addMany(S.channels.filter(visible)); });
  $('select-none').addEventListener('click', function () {
    if (S.sel.size && !confirm('Clear the whole selection? (nothing changes in HomeKit until you save)')) return;
    S.sel.clear(); render();
  });
  $('discard-btn').addEventListener('click', function () { S.sel = new Set(S.saved.keys()); render(); B.toast('info', 'Changes discarded', 'Back to the saved selection.'); });
  $('save-btn').addEventListener('click', save);
  $('save-btn-top').addEventListener('click', save);
  $('rescan-btn').addEventListener('click', function () {
    if (diffCount() && !confirm('You have unsaved changes. Rescan anyway? They will be lost.')) return;
    loadAll(true);
  });
  window.addEventListener('beforeunload', function (e) { if (diffCount()) { e.preventDefault(); e.returnValue = ''; } });

  // ── Init ────────────────────────────────────────────────────────────────
  B.header({ active: 'channels', title: 'Channels & inputs', sub: 'Choose which TV channels, HDMI inputs and apps appear in the Home app.', meter: true })
    .then(function (s) {
      B.footer();
      return B.fetchJson('/api/tvs').then(function (d) {
        var tvs = (d && d.tvs) || [];
        var want = B.qs('tv');
        var tv = tvs.find(function (t) { return t.name === want; }) || tvs[0];
        if (!tv) throw new Error('No TV configured');
        S.tv = tv.name;
        $('go-pair').href = '/pair?tv=' + encodeURIComponent(S.tv);
        if (s && s.authMode !== 'psk' && !s.paired) {
          $('need-pair').classList.remove('hidden');
          $('summary').classList.add('hidden');
          $('list-panel').classList.add('hidden');
          return;
        }
        return loadAll(false);
      });
    })
    .catch(function (e) { B.toast('error', 'Error', e.message); });
})();
