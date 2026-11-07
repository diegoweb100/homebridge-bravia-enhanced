'use strict';
// EPG (XMLTV) loader shared by all TVs of the platform.
// Sources are configured only in config.json (platform "epg" block), never
// through the plugin web server. Programme data is never invented: channels
// without a match in the XMLTV sources are reported as unmatched.
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 150 * 1024 * 1024;   // raw download cap per source
const KEEP_PAST_MS = 6 * 3600 * 1000;  // keep programmes that ended up to 6h ago
const KEEP_AHEAD_MS = 72 * 3600 * 1000; // and up to 3 days ahead

let cfg = { enabled: false, urls: [], refreshMs: 12 * 3600 * 1000 };
let log = function () {};
let cachePath = null;
let data = { channels: {}, programmes: {}, updated: null, sources: [] };
let timer = null;
let busy = false;

function download(url, redirects, cb) {
  let u;
  try { u = new URL(url); } catch (e) { return cb('invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return cb('only http/https URLs are allowed');
  const mod = u.protocol === 'https:' ? https : http;
  let done = false;
  const finish = (err, buf) => { if (!done) { done = true; cb(err, buf); } };
  const req = mod.get(u, { timeout: 60000, headers: { 'User-Agent': 'homebridge-bravia-enhanced', 'Accept-Encoding': 'gzip' } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if (redirects <= 0) return finish('too many redirects');
      return download(new URL(res.headers.location, u).toString(), redirects - 1, finish);
    }
    if (res.statusCode !== 200) { res.resume(); return finish('HTTP ' + res.statusCode); }
    const parts = []; let size = 0;
    res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(); finish('file larger than 150 MB'); } else parts.push(c); });
    res.on('end', () => finish(null, Buffer.concat(parts)));
    res.on('error', (e) => finish(e.message));
  });
  req.on('timeout', () => { req.destroy(); finish('timeout'); });
  req.on('error', (e) => finish(e.message));
}

function decode(buf, cb) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    zlib.gunzip(buf, (err, out) => err ? cb('gzip: ' + err.message) : cb(null, out.toString('utf8')));
  } else cb(null, buf.toString('utf8'));
}

function unescapeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
}

// XMLTV time: "YYYYMMDDhhmmss +HHMM" (offset optional, UTC when missing)
function parseTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-])?(\d{2})?(\d{2})?/.exec(String(s || '').trim());
  if (!m) return NaN;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (m[7]) t -= (m[7] === '-' ? -1 : 1) * ((+m[8]) * 60 + (+(m[9] || 0))) * 60000;
  return t;
}

function attr(attrs, name) {
  const m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"').exec(attrs) || new RegExp('\\b' + name + "\\s*=\\s*'([^']*)'").exec(attrs);
  return m ? unescapeXml(m[1]) : null;
}

function tagAll(body, tag) {
  const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'g');
  const out = []; let m;
  while ((m = re.exec(body))) out.push(unescapeXml(m[1]));
  return out;
}

// Parse one XMLTV document into target. Earlier sources win: a channel id that
// already has programmes from a higher-priority source is not overwritten.
function parseXmltv(xml, target, srcIndex, now) {
  let m; let nCh = 0; let nPr = 0;
  const reCh = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
  while ((m = reCh.exec(xml))) {
    const id = attr(m[1], 'id'); if (!id) continue;
    if (!target.channels[id]) {
      target.channels[id] = { id: id, names: tagAll(m[2], 'display-name'), src: srcIndex };
      nCh++;
    }
  }
  const owned = {};
  const rePr = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  while ((m = rePr.exec(xml))) {
    const ch = attr(m[1], 'channel'); if (!ch) continue;
    const start = parseTime(attr(m[1], 'start')); const stop = parseTime(attr(m[1], 'stop'));
    if (isNaN(start)) continue;
    const end = isNaN(stop) ? start : stop;
    if (end < now - KEEP_PAST_MS || start > now + KEEP_AHEAD_MS) continue;
    if (target.programmes[ch] && !owned[ch]) continue; // already provided by an earlier source
    owned[ch] = true;
    const desc = tagAll(m[2], 'desc')[0] || '';
    (target.programmes[ch] = target.programmes[ch] || []).push({
      start: start, stop: end,
      title: tagAll(m[2], 'title')[0] || '',
      sub: tagAll(m[2], 'sub-title')[0] || '',
      desc: desc.length > 400 ? desc.slice(0, 397) + '…' : desc,
      cat: tagAll(m[2], 'category')
    });
    nPr++;
  }
  return { channels: nCh, programmes: nPr };
}

function refresh() {
  if (busy || !cfg.enabled) return;
  busy = true;
  const now = Date.now();
  const next = { channels: {}, programmes: {}, updated: null, sources: [] };
  let i = 0;
  const step = () => {
    if (i >= cfg.urls.length) {
      busy = false;
      const ok = next.sources.some((s) => s.ok);
      // Keep the last valid EPG when every source failed.
      if (ok) {
        Object.keys(next.programmes).forEach((k) => next.programmes[k].sort((a, b) => a.start - b.start));
        next.updated = new Date().toISOString();
        data = next;
        try { fs.writeFileSync(cachePath, JSON.stringify(data)); } catch (e) { log('EPG: cannot write cache: ' + e.message); }
      } else {
        data.sources = next.sources;
      }
      log('EPG: ' + next.sources.map((s) => s.label + ' ' + (s.ok ? s.programmes + ' programmes' : 'ERROR ' + s.error)).join(' | '));
      return;
    }
    const idx = i++; const url = cfg.urls[idx];
    const label = 'source ' + (idx + 1);
    download(url, 3, (err, buf) => {
      if (err) { next.sources.push({ label: label, ok: false, error: err }); return setImmediate(step); }
      decode(buf, (err2, xml) => {
        if (err2) { next.sources.push({ label: label, ok: false, error: err2 }); return setImmediate(step); }
        if (!/<tv[\s>]/.test(xml.slice(0, 4096))) {
          const what = /^\s*#EXTM3U/.test(xml) ? 'this is an M3U playlist, not an XMLTV guide' : 'not an XMLTV file';
          next.sources.push({ label: label, ok: false, error: what }); return setImmediate(step);
        }
        try {
          const r = parseXmltv(xml, next, idx, now);
          next.sources.push({ label: label, ok: true, channels: r.channels, programmes: r.programmes });
        } catch (e) { next.sources.push({ label: label, ok: false, error: e.message }); }
        setImmediate(step);
      });
    });
  };
  step();
}

function configure(epgConfig, logger, storagePath) {
  log = typeof logger === 'function' ? logger : log;
  const c = epgConfig || {};
  const urls = (Array.isArray(c.urls) ? c.urls : (c.url ? [c.url] : [])).map((u) => String(u || '').trim()).filter(Boolean);
  const hours = Math.min(Math.max(parseInt(c.refreshHours, 10) || 12, 1), 168);
  const tok = typeof c.siriToken === 'string' ? c.siriToken.trim() : '';
  cfg = { enabled: c.enabled !== false && urls.length > 0, urls: urls, refreshMs: hours * 3600 * 1000, token: tok.length >= 12 ? tok : '' };
  if (tok && tok.length < 12) log('EPG: siriToken ignored, it must be at least 12 characters');
  cachePath = path.join(storagePath || '.', 'epg-cache.json');
  if (timer) { clearInterval(timer); timer = null; }
  if (!cfg.enabled) return;
  try { data = JSON.parse(fs.readFileSync(cachePath, 'utf8')); data.sources = data.sources || []; } catch (e) { /* no cache yet */ }
  setTimeout(refresh, 15000).unref();
  timer = setInterval(refresh, cfg.refreshMs); timer.unref();
}

function norm(s) {
  return String(s || '').replace(/^\s*[A-Z]{2}\s*[-:|]\s*/, '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\b(hd|fhd|uhd|4k|sd)\b/g, '').replace(/[^a-z0-9]/g, '');
}

// Build the view for the given selected TV channel names, between from and to (ms).
// Matching: exact normalized display-name; ambiguous names are not matched.
function guideName(id) {
  const c = data.channels[id];
  return c ? String(c.names[0] || id).replace(/^\s*[A-Z]{2}\s*[-:|]\s*/, '') : id;
}

// Automatic match for one TV channel name. Candidates are the guide channels
// whose normalized display name (or id without country suffix) equals it.
// Order: the TV's country first (when known), then source priority. Two
// different channels left at the same level are ambiguous: never guessed.
function autoMatch(byName, name, country) {
  let cands = byName[norm(name)] || [];
  if (!cands.length) return { status: 'none' };
  if (country) {
    const same = cands.filter((c) => c.cc === country);
    if (same.length) cands = same;
  }
  const best = Math.min.apply(null, cands.map((c) => c.src));
  const top = cands.filter((c) => c.src === best);
  const ids = top.map((c) => c.id).filter((v, i, a) => a.indexOf(v) === i);
  return ids.length === 1 ? { status: 'auto', id: ids[0] } : { status: 'ambiguous', ids: ids };
}

// Build the view for the selected TV channels, between from and to (ms).
function view(selected, from, to) {
  const byName = {};
  Object.keys(data.channels).forEach((id) => {
    if (!data.programmes[id]) return;
    const src = data.channels[id].src || 0; const cc = ccOf(id);
    const idName = id.replace(/\.[a-z]{2}(@.*)?$/i, '');
    data.channels[id].names.concat(idName !== id ? [idName] : []).forEach((n) => {
      const k = norm(n); if (!k) return;
      const list = byName[k] = byName[k] || [];
      if (!list.some((c) => c.id === id)) list.push({ id: id, src: src, cc: cc });
    });
  });
  // The TV's country: the most frequent country among channels that match a
  // single guide country without ambiguity (e.g. IT for an Italian TV).
  const votes = {};
  selected.forEach((ch) => {
    const ccs = (byName[norm(ch.name)] || []).map((c) => c.cc).filter((v, i, a) => v && a.indexOf(v) === i);
    if (ccs.length === 1) votes[ccs[0]] = (votes[ccs[0]] || 0) + 1;
  });
  const country = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0] || null;

  const rows = []; const table = []; const unmatched = []; const ambiguous = [];
  selected.forEach((ch0) => {
    // LCN without leading zeros ("007" -> "7")
    const ch = Object.assign({}, ch0, { lcn: ch0.lcn && /^\d+$/.test(String(ch0.lcn)) ? String(parseInt(ch0.lcn, 10)) : (ch0.lcn || null) });
    const manual = ch.map && data.programmes[ch.map] ? ch.map : null;
    const m = manual ? { status: 'manual', id: manual } : autoMatch(byName, ch.name, country);
    table.push({ name: ch.name, uri: ch.uri || null, lcn: ch.lcn || null, status: m.status,
      xmltvId: m.id || null, guideName: m.id ? guideName(m.id) : null,
      mapMissing: !!(ch.map && !manual) });
    if (m.status === 'none') { unmatched.push({ name: ch.name, uri: ch.uri || null }); return; }
    if (m.status === 'ambiguous') { ambiguous.push(ch.name); return; }
    const list = (data.programmes[m.id] || []).filter((p) => p.stop > from && p.start < to);
    rows.push({ name: ch.name, uri: ch.uri || null, lcn: ch.lcn || null, playing: !!ch.playing, manual: !!manual, xmltvId: m.id, programmes: list });
  });
  rows.sort((a, b) => (b.playing ? 1 : 0) - (a.playing ? 1 : 0));
  return {
    enabled: cfg.enabled, sourcesConfigured: cfg.urls.length, updated: data.updated, loading: busy,
    sources: data.sources, from: from, to: to, countries: countries(), tvCountry: country,
    coverage: { selected: selected.length, matched: rows.length, unmatched: unmatched, ambiguous: ambiguous, table: table },
    channels: rows
  };
}

let lastManual = 0;
function requestRefresh() {
  if (!cfg.enabled) return { success: false, message: 'TV guide not configured' };
  if (busy) return { success: true, message: 'Download already in progress' };
  const wait = 60000 - (Date.now() - lastManual);
  if (wait > 0) return { success: false, message: 'Please wait ' + Math.ceil(wait / 1000) + ' s before the next download' };
  lastManual = Date.now(); refresh();
  return { success: true, message: 'Download started' };
}
function isEnabled() { return cfg.enabled; }
function hasToken() { return !!cfg.token; }
function checkToken(t) {
  if (!cfg.token || typeof t !== 'string') return false;
  const a = Buffer.from(t); const b = Buffer.from(cfg.token);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}

function guideChannels() {
  return Object.keys(data.channels).filter((id) => data.programmes[id])
    .map((id) => ({ id: id, name: guideName(id), cc: ccOf(id) })).sort((a, b) => a.name.localeCompare(b.name) || String(a.cc).localeCompare(String(b.cc)));
}

function ccOf(id) { const m = /\.([a-z]{2})(@.*)?$/i.exec(id || ''); return m ? m[1].toUpperCase() : null; }
function countries() {
  const c = {}; Object.keys(data.channels).forEach((id) => { const k = ccOf(id); if (k && data.programmes[id]) c[k] = (c[k] || 0) + 1; });
  return Object.keys(c).sort().map((k) => ({ code: k, channels: c[k] }));
}
// Whole guide of one country (not limited to the TV selection), capped.
function viewCountry(cc, from, to) {
  const rows = Object.keys(data.channels).filter((id) => ccOf(id) === cc && data.programmes[id])
    .map((id) => ({ name: (data.channels[id].names[0] || id).replace(/^\s*[A-Z]{2}\s*[-:|]\s*/, ''), xmltvId: id,
      programmes: data.programmes[id].filter((p) => p.stop > from && p.start < to) }))
    .filter((r) => r.programmes.length).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 400);
  return { enabled: cfg.enabled, updated: data.updated, loading: busy, sources: data.sources, country: cc, countries: countries(), channels: rows };
}

module.exports = { hasToken, checkToken, countries, viewCountry, guideChannels, configure, refresh, requestRefresh, isEnabled, view, _parseXmltv: parseXmltv, _parseTime: parseTime, _norm: norm };
