/* Bravia Enhanced — shared UI helpers (v1.4.21)
   - SVG icon sprite (no external assets)
   - toast notifications
   - fetchJson with a clear error when the server is outdated
   - hero header + tabs filled from /api/status
   Exposes window.BUI. */
(function () {
  'use strict';

  var P = {
    tv: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    antenna: '<path d="M12 12v9M8 21h8"/><circle cx="12" cy="10" r="2"/><path d="M7.8 5.8a6 6 0 0 0 0 8.4M16.2 5.8a6 6 0 0 1 0 8.4M4.9 2.9a10 10 0 0 0 0 14.2M19.1 2.9a10 10 0 0 1 0 14.2"/>',
    hdmi: '<path d="M3 8h18v5l-3 3H6l-3-3z"/><path d="M7 11h10"/>',
    app: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.9-4M4 4v4h4M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4"/>',
    save: '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    power: '<path d="M12 3v9"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
    shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l6-6"/><circle cx="12" cy="12" r="1"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z"/>',
    lan: '<rect x="9" y="2" width="6" height="5" rx="1"/><rect x="2" y="17" width="6" height="5" rx="1"/><rect x="16" y="17" width="6" height="5" rx="1"/><path d="M12 7v5M5 17v-3h14v3"/>',
    home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    hd: '<rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="M7 9v6M11 9v6M7 12h4M14 9h2a3 3 0 0 1 0 6h-2z"/>',
    star: '<path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.3l1.1-6.2L3 9.7l6.2-.9z"/>',
    eraser: '<path d="M20 20H9L3.5 14.5a2 2 0 0 1 0-2.8l8-8a2 2 0 0 1 2.8 0l5.2 5.2a2 2 0 0 1 0 2.8L12 19"/><path d="M7 11l6 6"/>',
    radio: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M7 8l10-5"/><circle cx="15.5" cy="14" r="2.5"/><path d="M6 12h4M6 15h4"/>',
    rec: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
    unlock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 7.7-1.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    usb: '<path d="M12 3v14M9 6l3-3 3 3M7 10v3l5 3M17 9v3l-5 3"/><circle cx="12" cy="19" r="2"/><rect x="15.5" y="7" width="3" height="2.5"/><circle cx="7" cy="9" r="1.3"/>',
    selall: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12l3 3 5-6"/>'
  };

  function icon(name, cls) {
    return '<svg class="ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (P[name] || P.info) + '</svg>';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Toasts ------------------------------------------------------------------
  var toastBox = null;
  function toast(kind, title, msg, ms) {
    if (!toastBox) {
      toastBox = document.createElement('div');
      toastBox.className = 'toasts';
      toastBox.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastBox);
    }
    var ic = { success: 'check', error: 'x', warn: 'alert', info: 'info' }[kind] || 'info';
    var t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.innerHTML = '<div class="ti">' + icon(ic) + '</div><div><b>' + esc(title) + '</b><span>' + esc(msg) + '</span></div>';
    toastBox.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .25s, transform .25s';
      t.style.opacity = '0'; t.style.transform = 'translateY(-6px)';
      setTimeout(function () { t.remove(); }, 260);
    }, ms || (kind === 'error' ? 7000 : 4200));
  }

  function fetchJson(url, opts) {
    opts = opts || {};
    if (!opts.cache) opts.cache = 'no-store';
    return fetch(url, opts).then(function (r) {
      var ct = r.headers.get('content-type') || '';
      if (ct.indexOf('application/json') === -1) {
        throw new Error('Server returned HTTP ' + r.status + ' (not JSON). Restart Homebridge or update the plugin.');
      }
      return r.json();
    });
  }

  function qs(name) {
    try { return new URL(window.location.href).searchParams.get(name) || ''; } catch (e) { return ''; }
  }

  // Header ------------------------------------------------------------------
  // opts: { active:'channels'|'pairing'|'discover', title, sub, meter:bool }
  function header(opts) {
    var root = document.getElementById('hdr');
    if (!root) return Promise.resolve(null);
    var tvQ = qs('tv');
    var link = function (p) { return p + (tvQ ? (p.indexOf('?') >= 0 ? '&' : '?') + 'tv=' + encodeURIComponent(tvQ) : ''); };
    root.innerHTML =
      '<header class="hero"><div class="in">' +
        '<div class="brand"><div class="logo">' + icon('tv') + '</div><div><b>Bravia Enhanced</b><small id="h-tvline">Homebridge plugin</small></div></div>' +
        '<div class="hero-row"><div>' +
          '<h1>' + esc(opts.title) + '</h1>' +
          '<div class="sub">' + esc(opts.sub || '') + '</div>' +
          '<div class="chips" id="h-chips"><span class="chip"><span class="spin"></span> Connecting…</span></div>' +
        '</div>' +
        (opts.meter ? '<div class="hero-meter" id="h-meter"><div class="l">HomeKit inputs</div><div class="v" id="h-mv">–</div><div class="bar" id="h-bar"><i style="width:0"></i></div></div>' : '') +
        '</div>' +
      '</div></header>' +
      '<nav class="tabs"><div class="in">' +
        '<a href="' + link('/') + '" class="' + (opts.active === 'channels' ? 'active' : '') + '">' + icon('list') + 'Channels &amp; inputs</a>' +
        '<a href="' + link('/pair') + '" class="' + (opts.active === 'pairing' ? 'active' : '') + '">' + icon('key') + 'Pairing &amp; device</a>' +
        '<a href="' + link('/recordings') + '" class="' + (opts.active === 'recordings' ? 'active' : '') + '">' + icon('rec') + 'Recordings</a>' +
        '<a href="' + link('/discover') + '" class="' + (opts.active === 'discover' ? 'active' : '') + '">' + icon('radar') + 'Discover TVs</a>' +
      '</div></nav>';

    // Four tabs do not fit a phone: keep the active one in view.
    var act = root.querySelector('nav.tabs a.active');
    if (act && act.parentNode.scrollWidth > act.parentNode.clientWidth) {
      act.parentNode.scrollLeft = act.offsetLeft - (act.parentNode.clientWidth - act.offsetWidth) / 2;
    }
    return fetchJson('/api/status').then(function (s) {
      if (!s || !s.success) throw new Error('status');
      BUI.status = s;
      var tv = s.tv || {};
      document.getElementById('h-tvline').textContent = (tv.name || '') + (tv.model ? ' · ' + tv.model : '') + (s.pluginVersion ? ' · v' + s.pluginVersion : '');
      document.title = (opts.title || 'Bravia Enhanced') + ' · ' + (tv.name || 'Bravia');
      // Pairing tab: the /pair page needs ?tv=
      var tabs = root.querySelectorAll('nav.tabs a');
      if (!tvQ && tv.name) {
        tabs[1].href = '/pair?tv=' + encodeURIComponent(tv.name);
      }
      var chips = [];
      chips.push('<span class="chip ' + (s.power ? 'on' : 'off') + '"><span class="dot"></span>' + (s.power ? 'TV on' : 'TV off / standby') + '</span>');
      if (s.authMode === 'psk') chips.push('<span class="chip on">' + icon('shield') + 'PSK authentication</span>');
      else chips.push('<span class="chip ' + (s.paired ? 'on' : 'bad') + '">' + icon('key') + (s.paired ? 'Paired' : 'Pairing required') + '</span>');
      if (tv.ip) chips.push('<span class="chip">' + icon('lan') + esc(tv.ip) + '</span>');
      document.getElementById('h-chips').innerHTML = chips.join('');
      if (opts.meter) setMeter(s.homekitInputs, s.maxInputSources);
      return s;
    }).catch(function () {
      document.getElementById('h-chips').innerHTML = '<span class="chip bad"><span class="dot"></span>Plugin not reachable</span>';
      return null;
    });
  }

  function setMeter(n, max) {
    var mv = document.getElementById('h-mv'), bar = document.getElementById('h-bar');
    if (!mv || !bar) return;
    n = n || 0; max = max || 97;
    mv.innerHTML = n + ' <small>/ ' + max + '</small>';
    var pct = Math.min(100, Math.round(n / max * 100));
    bar.firstChild.style.width = pct + '%';
    bar.className = 'bar' + (n >= max ? ' full' : (pct >= 85 ? ' warn' : ''));
  }

  function footer() {
    var f = document.createElement('footer');
    f.className = 'foot';
    var v = (BUI.status && BUI.status.pluginVersion) ? 'v' + BUI.status.pluginVersion : '';
    f.innerHTML = '<span>homebridge-bravia-enhanced ' + esc(v) + ' · LAN-only page, do not expose this port to the internet</span>' +
      '<a href="https://github.com/diegoweb100/homebridge-bravia-enhanced" target="_blank" rel="noopener">GitHub</a>';
    document.body.appendChild(f);
  }

  var BUI = window.BUI = { icon: icon, esc: esc, toast: toast, fetchJson: fetchJson, qs: qs, header: header, setMeter: setMeter, footer: footer, status: null };

  // Replace <i data-ic="name"></i> placeholders in static markup.
  function hydrate(root) {
    (root || document).querySelectorAll('i[data-ic]').forEach(function (el) {
      el.outerHTML = icon(el.getAttribute('data-ic'), el.getAttribute('data-cls'));
    });
  }
  BUI.hydrate = hydrate;
  document.addEventListener('DOMContentLoaded', function () { hydrate(); });
})();
