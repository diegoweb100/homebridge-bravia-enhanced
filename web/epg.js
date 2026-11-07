(function () {
  'use strict';
  var B = window.BUI, esc = B.esc;
  var tvq = location.search || '';
  var state = null, ctyOn = null, gch = null, editing = null, covFilter = 'all';

  function hm(ms) { var d = new Date(ms); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function $(id) { return document.getElementById(id); }
  function range() {
    var v = $('range').value, now = Date.now(), d = new Date();
    if (v === 'now') return { from: now, to: now + 3 * 3600e3 };
    if (v === 'tonight') {
      var a = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 20, 0).getTime();
      var b = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59).getTime();
      return { from: Math.max(a, now), to: b };
    }
    return { from: now, to: now + (+v) * 3600e3 };
  }
  function load() {
    var r = range(), sep = tvq ? '&' : '?';
    fetch('/api/epg' + tvq + sep + 'from=' + r.from + '&to=' + r.to + (ctyOn ? '&country=' + ctyOn : ''))
      .then(function (x) { return x.json(); })
      .then(function (j) { state = j; renderGuide(); renderCoverage(); })
      .catch(function (e) { $('epg').innerHTML = '<p class="epg-muted">Error: ' + esc(String(e)) + '</p>'; });
  }

  // ---- Guide -------------------------------------------------------------
  function programmeCard(p, now, uri) {
    var live = p.start <= now && p.stop > now, extra = '';
    if (live) {
      var pct = Math.max(0, Math.min(100, (now - p.start) / Math.max(1, p.stop - p.start) * 100));
      var left = Math.max(0, Math.round((p.stop - now) / 60000));
      extra = '<div class="epg-prog" title="' + Math.round(pct) + '%"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
        '<div class="t">' + (left >= 60 ? Math.floor(left / 60) + ' h ' + (left % 60) + ' min' : left + ' min') + ' left</div>';
    }
    return '<div class="epg-p' + (live ? ' now' : '') + (uri ? ' can-play' : '') + '"' + (uri ? ' data-play="' + esc(uri) + '"' : '') +
      ' title="' + esc((p.desc ? p.desc + '\n\n' : '') + (uri ? 'Double-click to watch this channel on the TV' : '')) + '">' +
      '<div class="t">' + hm(p.start) + '–' + hm(p.stop) + (live ? ' · now' : '') + '</div>' +
      '<div class="n">' + esc(p.title) + '</div>' + extra +
      (p.sub ? '<div class="t">' + esc(p.sub) + '</div>' : '') +
      '<div class="d">' + esc(p.desc || (p.cat || []).join(', ')) + '</div></div>';
  }
  function renderGuide() {
    var j = state, el = $('epg');
    if (!j) return;
    var now = Date.now();
    $('cty').innerHTML = '<button class="cty' + (!ctyOn ? ' on' : '') + '" data-cty="">My TV</button>' +
      (j.countries || []).map(function (k) {
        return '<button class="cty' + (ctyOn === k.code ? ' on' : '') + '" data-cty="' + esc(k.code) + '">' + esc(k.code) + ' <small>' + k.channels + '</small></button>';
      }).join('') + '<span class="epg-clock">' + hm(now) + '</span>';
    if (!j.enabled) {
      el.innerHTML = '<p class="epg-muted">The TV guide is not configured. Add one or more XMLTV URLs in the plugin settings (Homebridge UI → Bravia Enhanced → TV guide (EPG)) and restart Homebridge.</p>';
      return;
    }
    var q = $('q').value.trim().toLowerCase(), nowOnly = $('range').value === 'now', html = '';
    j.channels.forEach(function (c) {
      var list = c.programmes.filter(function (p) {
        return !q || (p.title + ' ' + p.sub + ' ' + p.desc + ' ' + (p.cat || []).join(' ')).toLowerCase().indexOf(q) >= 0;
      });
      if (nowOnly) list = list.filter(function (p) { return p.stop > now; }).slice(0, 2);
      if (!list.length) return;
      html += '<div class="epg-ch' + (c.playing ? ' playing' : '') + '"><div class="epg-name">' +
        '<div class="epg-nl"><b>' + esc(c.name) + '</b>' + (c.lcn ? '<span class="epg-lcn">LCN ' + esc(c.lcn) + '</span>' : '') + '</div>' +
        (c.playing ? '<small>▶ on the TV now</small>' : '') + (c.manual ? '<small>linked manually</small>' : '') +
        '</div><div class="epg-list">' + list.map(function (p) { return programmeCard(p, now, c.uri); }).join('') + '</div></div>';
    });
    el.innerHTML = html || '<p class="epg-muted">' + (j.updated ? 'No programmes for this selection.' : 'The guide has not been downloaded yet (first download starts about 15 s after Homebridge starts).') + '</p>';
  }

  // ---- Coverage / channel matching ---------------------------------------
  var STATUS = {
    auto: ['Automatic', 'ok'], manual: ['Manual', 'man'], none: ['No match', 'bad'], ambiguous: ['Ambiguous', 'bad']
  };
  function lcnNum(r) { var n = parseInt(r.lcn, 10); return isNaN(n) ? 1e9 : n; }
  function renderCoverage() {
    var j = state, cov = $('cov');
    if (!j) return;
    if (!j.enabled) { cov.innerHTML = '<p class="epg-muted">–</p>'; return; }
    if (!j.coverage) {
      cov.innerHTML = '<p class="epg-muted">Whole guide for ' + esc(j.country) + ': ' + j.channels.length + ' channels with programmes in this time range. Channel matching refers to the My TV view.</p>';
      return;
    }
    var c = j.coverage, t = c.table || [];
    var bad = t.filter(function (r) { return r.status === 'none' || r.status === 'ambiguous'; }).length;
    var man = t.filter(function (r) { return r.status === 'manual'; }).length;
    var pct = c.selected ? Math.round(c.matched / c.selected * 100) : 0;
    var rows = t.filter(function (r) {
      return covFilter === 'all' || (covFilter === 'todo' ? (r.status === 'none' || r.status === 'ambiguous') : r.status === 'manual');
    }).sort(function (a, b) {
      var wa = (a.status === 'none' || a.status === 'ambiguous') ? 0 : 1, wb = (b.status === 'none' || b.status === 'ambiguous') ? 0 : 1;
      return wa - wb || lcnNum(a) - lcnNum(b) || a.name.localeCompare(b.name);
    });
    var html = '<div class="cv-sum"><div class="cv-big"><b>' + c.matched + '</b> of ' + c.selected + ' TV channels have a guide</div>' +
      '<div class="cv-meter"><i style="width:' + pct + '%"></i></div>' +
      '<div class="epg-muted">' + (j.tvCountry ? 'TV country: ' + esc(j.tvCountry) + ' (preferred when a name exists in several countries) · ' : '') +
      'Last update: ' + (j.updated ? esc(new Date(j.updated).toLocaleString()) : 'never') + (j.loading ? ' (updating…)' : '') + '</div></div>';
    html += '<div class="cv-tabs">' +
      tab('all', 'All', t.length) + tab('todo', 'Needs attention', bad) + tab('manual', 'Manual', man) + '</div>';
    html += '<div class="cv-table">' + (rows.length ? rows.map(row).join('') : '<p class="epg-muted">Nothing to show.</p>') + '</div>';
    html += '<details class="cv-src"><summary>Guide sources (' + (j.sources || []).length + ')</summary>' +
      (j.sources || []).map(function (s) {
        return '<div><span class="cv-dot ' + (s.ok ? 'ok' : 'bad') + '"></span>' + esc(s.label) + ': ' +
          (s.ok ? s.programmes + ' programmes, ' + s.channels + ' channels' : 'error: ' + esc(s.error)) + '</div>';
      }).join('') + '</details>';
    cov.innerHTML = html;
    if (editing) { var inp = cov.querySelector('input[data-uri="' + CSS.escape(editing) + '"]'); if (inp) inp.focus(); }
  }
  function tab(k, label, n) {
    return '<button class="cty' + (covFilter === k ? ' on' : '') + '" data-cov="' + k + '">' + label + ' <small>' + n + '</small></button>';
  }
  function row(r) {
    var st = STATUS[r.status] || ['?', 'bad'];
    var guide = r.xmltvId ? esc(r.guideName) + ' <small class="epg-muted">' + esc(r.xmltvId) + '</small>' :
      (r.status === 'ambiguous' ? '<span class="epg-muted">several guide channels with this name</span>' : '<span class="epg-muted">—</span>');
    var u = esc(r.uri);
    var act = editing === r.uri
      ? '<div class="cv-edit"><input list="gch" data-uri="' + u + '" placeholder="Search guide channel…" value="">' +
        '<button class="btn btn-primary" data-save="' + u + '">Save</button>' +
        (r.status === 'manual' ? '<button class="btn" data-unlink="' + u + '">Use automatic</button>' : '') +
        '<button class="btn" data-cancel="1">Cancel</button></div>'
      : '<button class="btn" data-edit="' + u + '">' + (r.status === 'none' || r.status === 'ambiguous' ? 'Link' : 'Change') + '</button>';
    return '<div class="cv-row">' +
      '<div class="cv-lcn">' + (r.lcn ? esc(r.lcn) : '') + '</div>' +
      '<div class="cv-tv">' + esc(r.name) + '</div>' +
      '<div class="cv-guide">' + guide + '</div>' +
      '<div><span class="cv-badge ' + st[1] + '">' + st[0] + '</span></div>' +
      '<div class="cv-act">' + act + '</div></div>';
  }
  function fillGuide() {
    var dl = $('gch');
    var put = function () {
      dl.innerHTML = gch.map(function (g) { return '<option value="' + esc(g.id) + '">' + esc(g.name + (g.cc ? ' (' + g.cc + ')' : '')) + '</option>'; }).join('');
    };
    if (gch) return put();
    fetch('/api/epg/guide-channels' + tvq).then(function (x) { return x.json(); }).then(function (l) { gch = l; put(); });
  }
  function post(uri, id) {
    fetch('/api/epg/map' + tvq, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uri: uri, id: id }) })
      .then(function (x) { return x.json(); })
      .then(function (r) { if (!r.success) alert(r.message || 'Error'); editing = null; load(); });
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('button'); if (!t) return;
    var d = t.dataset;
    if (d.cty !== undefined && t.classList.contains('cty') && !d.cov) { ctyOn = d.cty || null; load(); return; }
    if (d.cov) { covFilter = d.cov; renderCoverage(); return; }
    if (d.edit) { editing = d.edit; fillGuide(); renderCoverage(); return; }
    if (d.cancel) { editing = null; renderCoverage(); return; }
    if (d.unlink) { post(d.unlink, ''); return; }
    if (d.save) {
      var inp = document.querySelector('input[data-uri="' + CSS.escape(d.save) + '"]');
      var v = (inp && inp.value || '').trim();
      if (!gch || !gch.some(function (g) { return g.id === v; })) { if (inp) { inp.setCustomValidity('Pick a channel from the list'); inp.reportValidity(); } return; }
      post(d.save, v);
    }
  });
  document.addEventListener('dblclick', function (e) {
    var card = e.target.closest && e.target.closest('[data-play]'); if (!card) return;
    var sel = window.getSelection && window.getSelection(); if (sel) sel.removeAllRanges();
    card.classList.add('sending');
    fetch('/api/epg/play' + tvq, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uri: card.dataset.play }) })
      .then(function (x) { return x.json(); })
      .then(function (r) {
        card.classList.remove('sending');
        if (B.toast) B.toast(r.success ? 'success' : 'error', r.success ? 'TV' : 'Error', r.message || '', 3500);
        if (r.success) setTimeout(load, 4000);
      }).catch(function () { card.classList.remove('sending'); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.matches && e.target.matches('.cv-edit input')) {
      var b = e.target.parentNode.querySelector('[data-save]'); if (b) b.click();
    }
    if (e.key === 'Escape' && editing) { editing = null; renderCoverage(); }
  });
  document.addEventListener('input', function (e) { if (e.target.setCustomValidity) e.target.setCustomValidity(''); });

  B.header({ active: 'epg', title: 'TV guide', sub: 'Programmes for the TV channels selected for this TV.' }).then(function () {
    $('range').addEventListener('change', load);
    $('refresh').addEventListener('click', function () {
      var b = this; b.disabled = true;
      fetch('/api/epg/refresh', { method: 'POST' }).then(function (x) { return x.json(); }).then(function (j) {
        b.textContent = j.message; setTimeout(function () { b.disabled = false; b.textContent = 'Download guide now'; load(); }, 8000);
      }).catch(function () { b.disabled = false; });
    });
    $('q').addEventListener('input', renderGuide);
    load();
    setInterval(function () { if (!editing) load(); }, 5 * 60e3);
    setInterval(renderGuide, 30e3); // progress bars and clock; leaves the matching panel untouched
  });
})();
