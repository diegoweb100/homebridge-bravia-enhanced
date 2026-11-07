'use strict';
// Deterministic Italian question parser for the TV guide (no AI, no cloud).
// It understands a small, explicit grammar: time words (adesso, stasera,
// domani, "dopo le 21"), a channel name, a genre (film, calcio, serie,
// notizie, documentari) or "quando inizia/fanno <titolo>". It only reports
// programmes present in the guide; when the question is unclear it asks
// for clarification instead of guessing.

const NUM = { uno: '1', due: '2', tre: '3', quattro: '4', cinque: '5', sei: '6', sette: '7', otto: '8', nove: '9', dieci: '10', venti: '20' };

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[’']/g, ' ').replace(/[^a-z0-9: ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function key(s) {
  return fold(s).split(' ').map((w) => NUM[w] || w).join(' ')
    .replace(/\b(hd|fhd|uhd|sd)\b/g, '').replace(/[^a-z0-9]/g, '');
}
function hm(ms) { const d = new Date(ms); return d.getHours() + (d.getMinutes() ? ':' + String(d.getMinutes()).padStart(2, '0') : ''); }
function dayStart(t, add) { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + (add || 0)); return d.getTime(); }

const GENRES = [
  { word: /\b(film|films|cinema|pellicol\w*)\b/, test: (p) => /\b(film|cinema)\b/i.test(cats(p)), say: 'film' },
  { word: /\b(calcio|partit\w*|serie a|champions|europa league|coppa italia)\b/, test: (p) => /calcio|football|soccer/i.test(cats(p) + ' ' + p.title) || /\b(serie a|champions league|europa league|coppa italia)\b/i.test(p.title), say: 'partite di calcio' },
  { word: /\b(sport\w*)\b/, test: (p) => /sport|calcio|tennis|formula|motogp|ciclismo|basket|volley/i.test(cats(p)), say: 'programmi sportivi' },
  { word: /\b(telefilm|serie tv|serie|fiction)\b/, test: (p) => /serie|fiction|telefilm|series/i.test(cats(p)), say: 'serie e fiction' },
  { word: /\b(notizi\w*|telegiornal\w*|tg)\b/, test: (p) => /notizie|news|telegiornale|informazione/i.test(cats(p)) || /^tg\b/i.test(p.title), say: 'notiziari' },
  { word: /\b(documentar\w*)\b/, test: (p) => /documentar/i.test(cats(p)), say: 'documentari' },
  { word: /\b(cartoni|cartoon\w*|bambini|ragazzi)\b/, test: (p) => /bambini|ragazzi|cartoni|animazione|kids/i.test(cats(p)), say: 'programmi per bambini' }
];
function cats(p) { return (p.cat || []).join(' '); }

// channels: [{ name, lcn, programmes:[{start,stop,title,...}] }]
function answer(question, channels0, now) {
  now = now || Date.now();
  // Same name + same guide channel listed twice on the TV (e.g. TV8 on 8 and
  // 108): keep one, the lowest channel number.
  const seen = {}; const channels = [];
  (channels0 || []).slice().sort((a, b) => lcn(a) - lcn(b)).forEach((c) => {
    const k = key(c.name) + '|' + (c.xmltvId || '');
    if (!seen[k]) { seen[k] = 1; channels.push(c); }
  });
  const q = fold(question);
  if (!q) return clarify('Chiedimi per esempio: cosa c\'è stasera su Rai 1?');

  // --- day and time window ---------------------------------------------
  let day = 0;
  if (/\bdopodomani\b/.test(q)) day = 2; else if (/\bdomani\b/.test(q)) day = 1;
  const base = dayStart(now, day);
  let from; let to; let mode = 'now'; let label = 'adesso';
  const after = /\b(dopo|dalle|a partire dalle)\s+(?:le\s+)?(\d{1,2})(?:[:. ](\d{2}))?\b/.exec(q);
  const at = /\b(alle|verso le)\s+(\d{1,2})(?:[:. ](\d{2}))?\b/.exec(q);
  if (after) {
    from = base + (+after[2]) * 3600e3 + (+(after[3] || 0)) * 60e3; to = base + 24 * 3600e3 + 2 * 3600e3;
    mode = 'starting'; label = (day ? dayWord(day) + ' ' : '') + 'dopo le ' + after[2] + (after[3] ? ':' + after[3] : '');
  } else if (at) {
    from = base + (+at[2]) * 3600e3 + (+(at[3] || 0)) * 60e3; to = from + 1; mode = 'onair';
    label = (day ? dayWord(day) + ' ' : '') + 'alle ' + at[2] + (at[3] ? ':' + at[3] : '');
  } else if (/\b(stasera|stanotte|prima serata|questa sera|sera)\b/.test(q)) {
    from = base + 21 * 3600e3 + 40 * 60e3; to = from + 1; mode = 'onair'; label = day ? dayWord(day) + ' sera' : 'stasera'; var evening = true;
  } else if (/\b(pomeriggio)\b/.test(q)) {
    from = base + 15 * 3600e3; to = from + 1; mode = 'onair'; label = (day ? dayWord(day) + ' ' : 'oggi ') + 'pomeriggio';
  } else if (/\b(mattina|stamattina)\b/.test(q)) {
    from = base + 9 * 3600e3; to = from + 1; mode = 'onair'; label = (day ? dayWord(day) + ' ' : 'stamattina ').trim() + (day ? ' mattina' : '');
  } else if (/\b(oggi|stamani)\b/.test(q) || day) {
    from = day ? base : now; to = base + 24 * 3600e3; mode = 'starting'; label = day ? dayWord(day) : 'oggi';
  } else {
    from = now; to = now + 1; mode = 'onair'; label = 'adesso';
  }

  // --- channel ------------------------------------------------------------
  // Words of the question with number words as digits ("rai uno" -> "rai 1").
  const qw = q.split(' ').map((w) => NUM[w] || w);
  const keys = channels.map((c) => ({ c: c, k: key(c.name) })).filter((x) => x.k);
  const exact = (phrase) => keys.filter((x) => x.k === phrase).map((x) => x.c);
  let channel = null;
  // 1) explicit target after "su/sul/sulla": "su canale 5 stasera"
  const tm = /\b(?:su|sul|sulla|sui)\s+(.+?)(?:\s+(?:stasera|stanotte|oggi|domani|dopodomani|adesso|ora|alle|verso|dopo|dalle|sera|pomeriggio|mattina|in onda)\b|$)/.exec(qw.join(' '));
  if (tm) {
    let target = tm[1].replace(/^(canale|rete tv)\s+(?=\D)/, '').trim();
    const num = /^(?:(?:canale|numero)\s+)?(\d+)$/.exec(tm[1]);
    if (num) {
      const byLcn = channels.filter((c) => String(c.lcn) === num[1]);
      if (byLcn.length === 1) channel = byLcn[0];
    }
    if (!channel) {
      const tk = key(target);
      const ex = exact(tk);
      if (ex.length === 1) channel = ex[0];
      else if (ex.length > 1) return clarify('Quale canale intendi: ' + ex.slice(0, 4).map((c) => c.name).join(', ') + '?');
      else if (tk.length >= 2) {
        const pre = keys.filter((x) => x.k.indexOf(tk) === 0).map((x) => x.c);
        if (pre.length === 1) channel = pre[0];
        else if (pre.length > 1) return clarify('Quale canale intendi: ' + pre.slice(0, 5).map((c) => c.name).join(', ') + '?');
        else if (!num) return clarify('Non trovo il canale ' + tm[1] + ' tra quelli della TV.');
      }
    }
  }
  // 2) otherwise any word sequence equal to a channel name ("rai uno stasera")
  if (!channel) {
    let found = [];
    for (let n = 4; n >= 1 && !found.length; n--) {
      for (let i = 0; i + n <= qw.length; i++) {
        const ex = exact(key(qw.slice(i, i + n).join(' ')));
        ex.forEach((c) => { if (found.indexOf(c) < 0) found.push(c); });
      }
    }
    if (found.length > 1) return clarify('Quale canale intendi: ' + found.slice(0, 4).map((c) => c.name).join(', ') + '?');
    if (found.length === 1) channel = found[0];
  }
  const genre = GENRES.find((g) => g.word.test(q)) || null;

  const timeWord = /\b(adesso|ora|stasera|stanotte|sera|oggi|domani|dopodomani|pomeriggio|mattina|stamattina|alle|dopo|dalle|verso)\b/.test(q);
  const generic = /\b(cosa|cos|che|programm\w*|danno|fanno|trasmett\w*|onda|guida|vedere|guardare|c e|quando|ora)\b/.test(q);
  if (!channel && !genre && !timeWord && !generic) return clarify('Non ho capito. Prova a chiedere: cosa c\'è stasera su Rai 1?');

  // --- "quando inizia / quando fanno <titolo>" -----------------------------
  const when = /\b(quando|a che ora|che ora)\b.*?\b(?:inizia|comincia|fanno|danno|trasmettono|c e|va in onda|e)\s+(.+)$/.exec(q);
  if (when && !genre) {
    let title = when[2].replace(/\b(su|sul|sulla|in tv|stasera|oggi|domani)\b.*$/, '').replace(/^(il|lo|la|i|gli|le|l)\s+/, '').trim();
    if (channel) title = title.replace(new RegExp(key(channel.name), 'g'), '').trim();
    if (title.length < 3) return clarify('Di quale programma vuoi sapere l\'orario?');
    const tk = fold(title);
    const found = [];
    (channel ? [channel] : channels).forEach((c) => c.programmes.forEach((p) => {
      if (p.stop > now && fold(p.title).indexOf(tk) >= 0) found.push({ c: c, p: p });
    }));
    found.sort((a, b) => a.p.start - b.p.start);
    if (!found.length) return done('Non trovo "' + title + '" nella guida dei prossimi giorni.', []);
    const f = found[0];
    const onAir = f.p.start <= now;
    const when2 = onAir ? 'è in onda adesso' : 'inizia ' + dayLabel(f.p.start, now) + 'alle ' + hm(f.p.start);
    return done(f.p.title + ' ' + when2 + ' su ' + f.c.name + '.' + (found.length > 1 && !onAir ? ' Poi di nuovo ' + dayLabel(found[1].p.start, now) + 'alle ' + hm(found[1].p.start) + ' su ' + found[1].c.name + '.' : ''), found.slice(0, 5));
  }

  // --- listing --------------------------------------------------------------
  const pool = channel ? [channel] : channels;
  let items = [];
  pool.forEach((c) => {
    c.programmes.forEach((p) => {
      const ok = mode === 'onair' ? (p.start <= from && p.stop > from) : (p.start >= from && p.start < to);
      if (ok && (!genre || genre.test(p))) items.push({ c: c, p: p });
    });
  });
  items.sort((a, b) => a.p.start - b.p.start || lcn(a.c) - lcn(b.c));
  if (mode === 'onair' && !genre) items.sort((a, b) => lcn(a.c) - lcn(b.c));
  const what = genre ? genre.say : 'programmi';
  if (!items.length) {
    return done('Non trovo ' + what + (channel ? ' su ' + channel.name : '') + ' ' + label + ' nella guida.', []);
  }
  if (channel && typeof evening !== 'undefined' && !genre) {
    const eve0 = from - 70 * 60e3; const eve1 = base + 24 * 3600e3;
    const line = channel.programmes.filter((p) => p.stop > eve0 && p.start < eve1 && (p.start >= eve0 || p.stop > from)).slice(0, 4);
    if (line.length) return done(cap(label) + ' su ' + channel.name + ': ' + line.map((p) => 'alle ' + hm(p.start) + ' ' + p.title).join(', ') + '.', line.map((p) => ({ c: channel, p: p })));
  }
  if (channel && mode === 'onair') {
    const it = items[0];
    return done(label.charAt(0).toUpperCase() + label.slice(1) + ' su ' + channel.name + ' c\'è ' + it.p.title + ', dalle ' + hm(it.p.start) + ' alle ' + hm(it.p.stop) + '.', items);
  }
  if (channel) {
    const list = items.slice(0, 5).map((x) => 'alle ' + hm(x.p.start) + ' ' + x.p.title).join(', ');
    return done('Su ' + channel.name + ' ' + label + ': ' + list + '.', items.slice(0, 5));
  }
  const max = genre ? 6 : 5;
  const list = items.slice(0, max).map((x) => (mode === 'onair' ? '' : 'alle ' + hm(x.p.start) + ' ') + 'su ' + x.c.name + ' ' + x.p.title).join('; ');
  const more = items.length > max ? ' e altri ' + (items.length - max) + '.' : '.';
  return done((genre ? cap(what) + ' ' + label : cap(label)) + ': ' + list + more, items.slice(0, max));
}

function lcn(c) { const n = parseInt(c.lcn, 10); return isNaN(n) ? 1e6 : n; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function dayWord(d) { return d === 1 ? 'domani' : 'dopodomani'; }
function dayLabel(t, now) {
  const d = Math.round((dayStart(t) - dayStart(now)) / 86400e3);
  return d === 0 ? 'oggi ' : d === 1 ? 'domani ' : d === 2 ? 'dopodomani ' : '';
}
function done(text, items) {
  return { success: true, clarification: false, spokenResponse: text,
    items: items.map((x) => ({ channel: x.c.name, lcn: x.c.lcn || null, title: x.p.title, start: x.p.start, stop: x.p.stop })) };
}
function clarify(text) { return { success: true, clarification: true, spokenResponse: text, items: [] }; }

module.exports = { answer, _fold: fold };
