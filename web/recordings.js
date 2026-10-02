// Recordings — homebridge-bravia-enhanced v1.4.21 (diegoweb100)
// Talks to: GET /api/recordings ; POST /api/recordings/{play|protect|delete}
// Everything here needs a USB drive connected to the TV and set up for recording.
(function () {
  'use strict';
  var B = window.BUI, esc = B.esc, icon = B.icon;
  B.hydrate();
  var $ = function (id) { return document.getElementById(id); };
  var S = { recs: [], sort: 'date', q: '', busy: {} };

  function dur(sec) {
    sec = sec || 0;
    var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? h + ' h ' + (m < 10 ? '0' : '') + m + ' min' : m + ' min';
  }
  // TV dates come as "2026-03-19T21:30:00" (local, no zone) or with +0200 / +0000.
  function when(s) {
    if (!s) return '';
    var d = new Date(String(s).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
    if (isNaN(d.getTime())) return String(s).replace('T', ' ').slice(0, 16);
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  function emptyBox(ic, title, text) {
    return '<div class="empty"><div class="big">' + icon(ic) + '</div><h3>' + esc(title) + '</h3><p>' + text + '</p></div>';
  }

  function load() {
    $('rec-refresh').disabled = true;
    return B.fetchJson('/api/recordings').then(function (d) {
      if (!d.success) throw new Error(d.message || 'error');
      ['rec-cards', 'rec-tools'].forEach(function (id) { $(id).classList.add('hidden'); });
      $('sched-panel').classList.add('hidden'); $('hist-panel').classList.add('hidden');
      if (!d.tvOn) {
        $('rec-sub').textContent = 'The TV is off.';
        $('rec-list').innerHTML = emptyBox('power', 'Switch the TV on', 'The recordings are read live from the USB drive, so the TV has to be on.' +
          (d.usb ? ' A recording drive was seen the last time the TV was on.' : ''));
        return;
      }
      if (!d.usb) {
        $('rec-sub').textContent = 'No recording drive found.';
        $('rec-list').innerHTML = emptyBox('usb', 'No USB recording drive', 'Connect a USB hard drive to the TV and register it for recording in the TV menu, then press <b>Refresh</b>. Recordings, “Record now” and this page work only while the drive is connected.');
        return;
      }
      S.recs = d.recordings || [];
      $('rec-sub').textContent = 'USB drive connected · ' + S.recs.length + ' recording' + (S.recs.length === 1 ? '' : 's') + '.';
      renderStats(d);
      renderList();
      renderSchedules(d.schedules || []);
      renderHistory(d.history || []);
      $('rec-cards').classList.remove('hidden');
      if (S.recs.length) $('rec-tools').classList.remove('hidden');
    }).catch(function (e) {
      $('rec-list').innerHTML = emptyBox('alert', 'Could not read the recordings', esc(e.message));
      B.toast('error', 'Error', e.message);
    }).then(function () { $('rec-refresh').disabled = false; });
  }

  function renderStats(d) {
    var tot = 0, prot = 0, fresh = 0;
    S.recs.forEach(function (r) { tot += r.durationSec || 0; if (r.isProtected) prot++; if (!r.isAlreadyPlayed) fresh++; });
    $('k-n').textContent = S.recs.length;
    $('k-new').textContent = fresh ? fresh + ' not watched yet' : 'all watched';
    $('k-len').textContent = dur(tot);
    $('k-prot').textContent = prot;
    var rec = d.status && d.status !== 'notStarted';
    $('k-st').textContent = rec ? 'Recording now' : 'Idle';
    $('k-st-card').className = 'card ' + (rec ? 'bad' : 'good');
    var n = (d.schedules || []).length;
    $('k-sched').textContent = n ? n + ' scheduled' : 'nothing scheduled';
  }

  function sorted() {
    var q = S.q;
    var arr = S.recs.filter(function (r) {
      return !q || (r.title || '').toLowerCase().indexOf(q) >= 0 || (r.channelName || '').toLowerCase().indexOf(q) >= 0;
    });
    arr.sort(function (a, b) {
      if (S.sort === 'title') return (a.title || '').localeCompare(b.title || '');
      if (S.sort === 'len') return (b.durationSec || 0) - (a.durationSec || 0);
      return String(b.startDateTime || '').localeCompare(String(a.startDateTime || ''));
    });
    return arr;
  }

  function rowHtml(r) {
    var busy = !!S.busy[r.uri];
    var pills = (r.isAlreadyPlayed ? '' : '<span class="pill acc">New</span>') + (r.isProtected ? '<span class="pill warn">' + icon('lock') + 'Protected</span>' : '');
    return '<div class="rrow' + (busy ? ' busy' : '') + '" data-uri="' + esc(r.uri) + '">' +
      '<button class="rplay" data-act="play" title="Play on the TV" aria-label="Play ' + esc(r.title) + '">' + icon('play') + '</button>' +
      '<div class="rmain"><b>' + esc(r.title || 'Untitled') + '</b>' +
        '<small>' + (r.channelName ? '<span>' + icon('antenna') + esc(r.channelName) + '</span>' : '') +
        '<span>' + icon('clock') + esc(when(r.startDateTime)) + '</span><span>' + esc(dur(r.durationSec)) + '</span></small></div>' +
      '<div class="rpills">' + pills + '</div>' +
      '<div class="racts">' +
        '<button class="btn btn-ghost" data-act="protect" title="' + (r.isProtected ? 'Remove protection' : 'Protect from deletion') + '">' + icon(r.isProtected ? 'unlock' : 'lock') + '<span>' + (r.isProtected ? 'Unprotect' : 'Protect') + '</span></button>' +
        '<button class="btn btn-danger" data-act="delete"' + (r.isProtected ? ' disabled title="Protected: remove the protection first"' : ' title="Delete from the USB drive"') + '>' + icon('trash') + '<span>Delete</span></button>' +
      '</div></div>';
  }

  function renderList() {
    if (!S.recs.length) {
      $('rec-list').innerHTML = emptyBox('rec', 'No recordings yet', 'The USB drive is connected but empty. Record from the TV guide, or add <b>Record now</b> to the inputs in <a href="/">Channels &amp; inputs</a> to start one from the Home app.');
      return;
    }
    var arr = sorted();
    $('rec-list').innerHTML = arr.length ? '<div class="rlist">' + arr.map(rowHtml).join('') + '</div>' : emptyBox('search', 'Nothing matches', 'Change the search.');
  }

  function renderSchedules(list) {
    if (!list.length) return;
    $('sched-list').innerHTML = '<div class="rlist">' + list.map(function (s) {
      return '<div class="rrow ro"><div class="rplay ro">' + icon('clock') + '</div><div class="rmain"><b>' + esc(s.title || '') + '</b><small>' +
        (s.channelName ? '<span>' + icon('antenna') + esc(s.channelName) + '</span>' : '') +
        '<span>' + esc(when(s.startDateTime)) + '</span><span>' + esc(dur(s.durationSec)) + '</span>' +
        (s.repeatType && s.repeatType !== 'none' ? '<span class="pill">' + esc(s.repeatType) + '</span>' : '') + '</small></div></div>';
    }).join('') + '</div>';
    $('sched-panel').classList.remove('hidden');
  }

  function renderHistory(list) {
    if (!list.length) return;
    $('hist-list').innerHTML = '<div class="rlist">' + list.slice(0, 20).map(function (h) {
      return '<div class="rrow ro"><div class="rplay ro bad">' + icon('alert') + '</div><div class="rmain"><b>' + esc(h.title || '') + '</b><small>' +
        (h.channelName ? '<span>' + icon('antenna') + esc(h.channelName) + '</span>' : '') +
        '<span>' + esc(when(h.startDateTime)) + '</span></small>' +
        (h.reasonMsg ? '<small class="why">' + esc(h.reasonMsg) + '</small>' : '') + '</div></div>';
    }).join('') + '</div>';
    $('hist-panel').classList.remove('hidden');
  }

  function act(uri, action) {
    var r = S.recs.filter(function (x) { return x.uri === uri; })[0];
    if (!r || S.busy[uri]) return;
    if (action === 'delete') {
      if (r.isProtected) return;
      if (!confirm('Delete “' + r.title + '” from the USB drive?\nThis cannot be undone.')) return;
    }
    var body = { uri: uri };
    if (action === 'protect') body.isProtected = !r.isProtected;
    S.busy[uri] = true; renderList();
    B.fetchJson('/api/recordings/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (d) {
        if (!d.success) throw new Error(d.message || 'The TV refused the request');
        if (action === 'play') B.toast('success', 'Playing on the TV', r.title);
        if (action === 'protect') { r.isProtected = body.isProtected; B.toast('success', r.isProtected ? 'Protected' : 'Protection removed', r.title); }
        if (action === 'delete') { S.recs = S.recs.filter(function (x) { return x.uri !== uri; }); B.toast('success', 'Deleted', r.title); }
      })
      .catch(function (e) { B.toast('error', 'Not done', e.message); })
      .then(function () {
        delete S.busy[uri];
        var p = 0, t = 0; S.recs.forEach(function (x) { if (x.isProtected) p++; t += x.durationSec || 0; });
        $('k-prot').textContent = p; $('k-n').textContent = S.recs.length; $('k-len').textContent = dur(t);
        renderList();
      });
  }

  $('rec-list').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    var row = b.closest('.rrow');
    if (row) act(row.getAttribute('data-uri'), b.getAttribute('data-act'));
  });
  $('rec-q').addEventListener('input', function () { S.q = this.value.trim().toLowerCase(); renderList(); });
  $('rec-sort').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    S.sort = b.getAttribute('data-s');
    this.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
    renderList();
  });
  $('rec-refresh').addEventListener('click', load);

  B.header({ active: 'recordings', title: 'Recordings', sub: 'What the TV recorded on its USB hard drive.' }).then(function () {
    B.footer();
    return load();
  });
})();
