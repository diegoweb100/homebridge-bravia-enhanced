'use strict';
// Deterministic question parser for the TV guide (no AI, no cloud) in
// Italian, German, English and French. Each language defines a small,
// explicit grammar (time words, "after 21", "at 22", a channel name or
// number, a genre, "when does <title> start") and its spoken sentences.
// Only programmes present in the guide are reported; unclear questions get
// a clarification instead of a guess.

// ---------------------------------------------------------------------------
// Helpers shared by all languages
// ---------------------------------------------------------------------------
function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ß/g, 'ss').replace(/[’']/g, ' ').replace(/[^a-z0-9: ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function keyWith(num) {
  return (s) => fold(s).split(' ').map((w) => num[w] || w).join(' ')
    .replace(/\b(hd|fhd|uhd|sd)\b/g, '').replace(/[^a-z0-9]/g, '');
}
function dayStart(t, add) { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + (add || 0)); return d.getTime(); }
function lcn(c) { const n = parseInt(c.lcn, 10); return isNaN(n) ? 1e6 : n; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function cats(p) { return (p.cat || []).join(' '); }
function hhmm(h, m) { return String(+h) + (m && +m ? ':' + String(m).padStart(2, '0') : ''); }

// Genre detection on guide data is language independent (Italian, Swiss,
// German or French guides use different category words).
const G = {
  film: (p) => /\b(film|films|cinema|movie|movies|spielfilm|kinofilm|long metrage)\b/i.test(cats(p)),
  football: (p) => /calcio|football|soccer|fussball|fußball/i.test(cats(p) + ' ' + p.title) || /\b(serie a|champions league|europa league|coppa italia|bundesliga|ligue 1|premier league|super league)\b/i.test(p.title),
  sport: (p) => /sport|calcio|fussball|fußball|football|tennis|formula|motogp|ciclismo|radsport|cyclisme|basket|volley|ski|hockey/i.test(cats(p)),
  series: (p) => /serie|fiction|telefilm|series|feuilleton/i.test(cats(p)),
  news: (p) => /notizie|news|telegiornale|informazione|nachrichten|information|actualit|journal|tagesschau/i.test(cats(p)) || /^(tg\d?|tagesschau|heute|journal|news)\b/i.test(p.title),
  docs: (p) => /documentar|dokument|doku|documentaire/i.test(cats(p)),
  kids: (p) => /bambini|ragazzi|cartoni|animazione|kids|kinder|enfants|jeunesse|children|animation|zeichentrick/i.test(cats(p))
};

// ---------------------------------------------------------------------------
// Language packs
// ---------------------------------------------------------------------------
const LANGS = {
  it: {
    num: { uno: '1', due: '2', tre: '3', quattro: '4', cinque: '5', sei: '6', sette: '7', otto: '8', nove: '9', dieci: '10', venti: '20' },
    dayAfter: /\bdopodomani\b/, tomorrow: /\bdomani\b/,
    after: /\b(?:dopo|dalle|a partire dalle)\s+(?:le\s+)?(\d{1,2})(?:[:. ](\d{2}))?\b/,
    at: /\b(?:alle|verso le)\s+(\d{1,2})(?:[:. ](\d{2}))?\b/,
    evening: /\b(stasera|stanotte|prima serata|questa sera|sera)\b/,
    afternoon: /\b(pomeriggio)\b/, morning: /\b(mattina|stamattina)\b/, today: /\b(oggi|stamani)\b/,
    onPrep: /\b(?:su|sul|sulla|sui)\s+(.+?)(?:\s+(?:stasera|stanotte|oggi|domani|dopodomani|adesso|ora|alle|verso|dopo|dalle|sera|pomeriggio|mattina|in onda)\b|$)/,
    chanWord: /^(canale|rete tv)\s+(?=\D)/, chanNum: /^(?:(?:canale|numero)\s+)?(\d+)$/,
    timeWord: /\b(adesso|ora|stasera|stanotte|sera|oggi|domani|dopodomani|pomeriggio|mattina|stamattina|alle|dopo|dalle|verso)\b/,
    generic: /\b(cosa|cos|che|programm\w*|danno|fanno|trasmett\w*|onda|guida|vedere|guardare|c e|quando|ora)\b/,
    when: /\b(quando|a che ora|che ora)\b.*?\b(?:inizia|comincia|fanno|danno|trasmettono|c e|va in onda|e)\s+(.+)$/,
    titleTail: /\b(su|sul|sulla|in tv|stasera|oggi|domani)\b.*$/, article: /^(il|lo|la|i|gli|le|l)\s+/,
    genres: [
      [/\b(film|films|cinema|pellicol\w*)\b/, G.film, 'film'],
      [/\b(calcio|partit\w*|serie a|champions|europa league|coppa italia)\b/, G.football, 'partite di calcio'],
      [/\b(sport\w*)\b/, G.sport, 'programmi sportivi'],
      [/\b(telefilm|serie tv|serie|fiction)\b/, G.series, 'serie e fiction'],
      [/\b(notizi\w*|telegiornal\w*|tg)\b/, G.news, 'notiziari'],
      [/\b(documentar\w*)\b/, G.docs, 'documentari'],
      [/\b(cartoni|cartoon\w*|bambini|ragazzi)\b/, G.kids, 'programmi per bambini']
    ],
    t: {
      now: 'adesso', today: 'oggi', tomorrow: 'domani', dayAfter: 'dopodomani',
      evening: (d) => d ? d + ' sera' : 'stasera', afternoon: (d) => (d || 'oggi') + ' pomeriggio', morning: (d) => d ? d + ' mattina' : 'stamattina',
      after: (d, h, m) => (d ? d + ' ' : '') + 'dopo le ' + hhmm(h, m), at: (d, h, m) => (d ? d + ' ' : '') + 'alle ' + hhmm(h, m),
      time: (h) => 'alle ' + h, on: 'su', programmes: 'programmi',
      example: 'Chiedimi per esempio: cosa c\'è stasera su Rai 1?',
      notUnderstood: 'Non ho capito. Prova a chiedere: cosa c\'è stasera su Rai 1?',
      which: (l) => 'Quale canale intendi: ' + l + '?',
      noChannel: (x) => 'Non trovo il canale ' + x + ' tra quelli della TV.',
      whichProgramme: 'Di quale programma vuoi sapere l\'orario?',
      titleNotFound: (x) => 'Non trovo "' + x + '" nella guida dei prossimi giorni.',
      onAirNow: 'è in onda adesso', starts: (d, h) => 'inizia ' + d + 'alle ' + h, again: (d, h, c) => ' Poi di nuovo ' + d + 'alle ' + h + ' su ' + c + '.',
      dayLabel: ['oggi ', 'domani ', 'dopodomani '],
      nothing: (what, ch, label) => 'Non trovo ' + what + (ch ? ' su ' + ch : '') + ' ' + label + ' nella guida.',
      channelNow: (label, ch, title, a, b) => cap(label) + ' su ' + ch + ' c\'è ' + title + ', dalle ' + a + ' alle ' + b + '.',
      more: (n) => '. E altri ' + n + ': chiedimi un canale per i dettagli.'
    }
  },
  de: {
    num: { eins: '1', zwei: '2', drei: '3', vier: '4', funf: '5', sechs: '6', sieben: '7', acht: '8', neun: '9', zehn: '10', zwanzig: '20' },
    dayAfter: /\bubermorgen\b/, tomorrow: /(?<!heute )\bmorgen\b/,
    after: /\b(?:nach|ab)\s+(\d{1,2})(?:[:. ](\d{2}))?(?:\s*uhr)?\b/,
    at: /\b(?:um|gegen)\s+(\d{1,2})(?:[:. ](\d{2}))?(?:\s*uhr)?\b/,
    evening: /\b(heute abend|abends?|heute nacht|primetime)\b/,
    afternoon: /\b(nachmittags?)\b/, morning: /\b(heute morgen|vormittags?|morgens|fruh)\b/, today: /\b(heute)\b/,
    onPrep: /\b(?:auf|im|bei)\s+(.+?)(?:\s+(?:heute|morgen|ubermorgen|jetzt|gerade|um|gegen|nach|ab|abends?|nachmittags?|vormittags?|fruh|im fernsehen)\b|$)/,
    chanWord: /^(kanal|sender|programm)\s+(?=\D)/, chanNum: /^(?:(?:kanal|sender|programm|nummer|platz)\s+)?(\d+)$/,
    timeWord: /\b(jetzt|gerade|heute|morgen|ubermorgen|abends?|nachmittags?|vormittags?|fruh|um|nach|ab|gegen)\b/,
    generic: /\b(was|welche\w*|lauft|laufen|kommt|kommen|gibt|sendung\w*|programm|fernsehen|tv|wann|zeigt)\b/,
    when: /\b(wann|um wie viel uhr|wie spat)\b.*?\b(?:beginnt|startet|lauft|kommt|fangt)\s+(.+?)(?:\s+an)?$/,
    titleTail: /\b(auf|im|heute|morgen|im fernsehen)\b.*$/, article: /^(der|die|das|den)\s+/,
    genres: [
      [/\b(film\w*|spielfilm\w*|kino)\b/, G.film, 'Filme'],
      [/\b(fussball\w*|bundesliga|champions league|spiele?)\b/, G.football, 'Fußballspiele'],
      [/\b(sport\w*)\b/, G.sport, 'Sportsendungen'],
      [/\b(serie\w*|krimiserie\w*)\b/, G.series, 'Serien'],
      [/\b(nachrichten|tagesschau|news)\b/, G.news, 'Nachrichten'],
      [/\b(doku\w*|dokumentation\w*)\b/, G.docs, 'Dokumentationen'],
      [/\b(kinder\w*|zeichentrick\w*)\b/, G.kids, 'Kindersendungen']
    ],
    t: {
      now: 'jetzt', today: 'heute', tomorrow: 'morgen', dayAfter: 'übermorgen',
      evening: (d) => d ? d + ' Abend' : 'heute Abend', afternoon: (d) => (d || 'heute') + ' Nachmittag', morning: (d) => d ? d + ' früh' : 'heute Morgen',
      after: (d, h, m) => (d ? d + ' ' : '') + 'nach ' + hhmm(h, m) + ' Uhr', at: (d, h, m) => (d ? d + ' ' : '') + 'um ' + hhmm(h, m) + ' Uhr',
      time: (h) => 'um ' + h, on: 'auf', programmes: 'Sendungen',
      example: 'Frag mich zum Beispiel: Was läuft heute Abend auf SRF 1?',
      notUnderstood: 'Das habe ich nicht verstanden. Frag zum Beispiel: Was läuft heute Abend auf SRF 1?',
      which: (l) => 'Welchen Sender meinst du: ' + l + '?',
      noChannel: (x) => 'Den Sender ' + x + ' finde ich nicht unter den Sendern des Fernsehers.',
      whichProgramme: 'Für welche Sendung möchtest du die Uhrzeit wissen?',
      titleNotFound: (x) => '"' + x + '" finde ich nicht im Programm der nächsten Tage.',
      onAirNow: 'läuft gerade', starts: (d, h) => 'beginnt ' + d + 'um ' + h, again: (d, h, c) => ' Danach wieder ' + d + 'um ' + h + ' auf ' + c + '.',
      dayLabel: ['heute ', 'morgen ', 'übermorgen '],
      nothing: (what, ch, label) => 'Ich finde ' + label + ' keine ' + what + (ch ? ' auf ' + ch : '') + ' im Programm.',
      channelNow: (label, ch, title, a, b) => cap(label) + ' läuft auf ' + ch + ' ' + title + ', von ' + a + ' bis ' + b + '.',
      more: (n) => '. Und ' + n + ' weitere: frag mich nach einem Sender für Details.'
    }
  },
  en: {
    num: { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', twenty: '20' },
    dayAfter: /\bday after tomorrow\b/, tomorrow: /\btomorrow\b/,
    after: /\b(?:after|from)\s+(\d{1,2})(?:[:. ](\d{2}))?\s*(am|pm)?\b/,
    at: /\b(?:at|around)\s+(\d{1,2})(?:[:. ](\d{2}))?\s*(am|pm)?\b/,
    evening: /\b(tonight|this evening|evening|prime time)\b/,
    afternoon: /\b(afternoon)\b/, morning: /\b(morning)\b/, today: /\b(today)\b/,
    onPrep: /\b(?:on)\s+(.+?)(?:\s+(?:tonight|today|tomorrow|now|at|around|after|from|this|in the|evening|afternoon|morning)\b|$)/,
    chanWord: /^(channel)\s+(?=\D)/, chanNum: /^(?:(?:channel|number)\s+)?(\d+)$/,
    timeWord: /\b(now|tonight|today|tomorrow|evening|afternoon|morning|at|after|from|around)\b/,
    generic: /\b(what|whats|which|on|show\w*|programme\w*|program\w*|tv|guide|watch|when|playing)\b/,
    when: /\b(when|what time)\b.*?\b(?:does|is|do)\s+(.+?)(?:\s+(?:start|begin|on|air))*$/,
    titleTail: /\b(on|tonight|today|tomorrow)\b.*$/, article: /^(the|a|an)\s+/,
    genres: [
      [/\b(films?|movies?|cinema)\b/, G.film, 'films'],
      [/\b(football|soccer|match\w*|games?)\b/, G.football, 'football matches'],
      [/\b(sports?)\b/, G.sport, 'sports programmes'],
      [/\b(series|tv shows?|drama\w*)\b/, G.series, 'series'],
      [/\b(news)\b/, G.news, 'news programmes'],
      [/\b(documentar\w*|docs?)\b/, G.docs, 'documentaries'],
      [/\b(kids|children\w*|cartoons?)\b/, G.kids, 'children\'s programmes']
    ],
    t: {
      now: 'now', today: 'today', tomorrow: 'tomorrow', dayAfter: 'the day after tomorrow',
      evening: (d) => d ? d + ' evening' : 'tonight', afternoon: (d) => d ? d + ' afternoon' : 'this afternoon', morning: (d) => d ? d + ' morning' : 'this morning',
      after: (d, h, m) => (d ? d + ' ' : '') + 'after ' + hhmm(h, m), at: (d, h, m) => (d ? d + ' ' : '') + 'at ' + hhmm(h, m),
      time: (h) => 'at ' + h, on: 'on', programmes: 'programmes',
      example: 'Ask me for example: what\'s on tonight on BBC One?',
      notUnderstood: 'Sorry, I didn\'t understand. Try asking: what\'s on tonight on BBC One?',
      which: (l) => 'Which channel do you mean: ' + l + '?',
      noChannel: (x) => 'I can\'t find the channel ' + x + ' among the TV channels.',
      whichProgramme: 'Which programme do you want the time for?',
      titleNotFound: (x) => 'I can\'t find "' + x + '" in the guide for the next days.',
      onAirNow: 'is on now', starts: (d, h) => 'starts ' + d + 'at ' + h, again: (d, h, c) => ' Then again ' + d + 'at ' + h + ' on ' + c + '.',
      dayLabel: ['today ', 'tomorrow ', 'the day after tomorrow '],
      nothing: (what, ch, label) => 'I can\'t find any ' + what + (ch ? ' on ' + ch : '') + ' ' + label + ' in the guide.',
      channelNow: (label, ch, title, a, b) => cap(label) + ' on ' + ch + ': ' + title + ', from ' + a + ' to ' + b + '.',
      more: (n) => '. And ' + n + ' more: ask me about a channel for details.'
    }
  },
  fr: {
    num: { un: '1', une: '1', deux: '2', trois: '3', quatre: '4', cinq: '5', six: '6', sept: '7', huit: '8', neuf: '9', dix: '10', vingt: '20' },
    dayAfter: /\bapres demain\b/, tomorrow: /\bdemain\b/,
    after: /\b(?:apres|a partir de|des)\s+(\d{1,2})(?:\s*(?:h|heures?)\s*(\d{2})?|[:.](\d{2}))?\b/,
    at: /\b(?:a|vers)\s+(\d{1,2})(?:\s*(?:h|heures?)\s*(\d{2})?|[:.](\d{2}))?\b/,
    evening: /\b(ce soir|soir|soiree|cette nuit)\b/,
    afternoon: /\b(apres midi)\b/, morning: /\b(ce matin|matin|matinee)\b/, today: /\b(aujourd hui|aujourdhui)\b/,
    onPrep: /\b(?:sur)\s+(.+?)(?:\s+(?:ce soir|ce matin|cet|aujourd|demain|apres|maintenant|a|vers|des|soir|matin)\b|$)/,
    chanWord: /^(la chaine|chaine)\s+(?=\D)/, chanNum: /^(?:(?:la chaine|chaine|numero|canal)\s+)?(\d+)$/,
    timeWord: /\b(maintenant|en ce moment|ce soir|soir|aujourd hui|demain|apres|matin|vers|des)\b/,
    generic: /\b(qu|que|quoi|quels?|quelles?|programme\w*|passe|emission\w*|tele|tv|regarder|quand|heure)\b/,
    when: /\b(quand|a quelle heure)\b.*?\b(?:commence|passe|est|debute|diffuse)\s+(.+)$/,
    titleTail: /\b(sur|ce soir|aujourd|demain)\b.*$/, article: /^(le|la|les|l|un|une|des)\s+/,
    genres: [
      [/\b(films?|cinema)\b/, G.film, 'films'],
      [/\b(foot|football|match\w*)\b/, G.football, 'matchs de football'],
      [/\b(sports?)\b/, G.sport, 'émissions sportives'],
      [/\b(series?|feuilletons?)\b/, G.series, 'séries'],
      [/\b(infos?|journal|actualites?)\b/, G.news, 'journaux télévisés'],
      [/\b(documentaires?)\b/, G.docs, 'documentaires'],
      [/\b(enfants|dessins animes|jeunesse)\b/, G.kids, 'programmes pour enfants']
    ],
    t: {
      now: 'en ce moment', today: 'aujourd\'hui', tomorrow: 'demain', dayAfter: 'après-demain',
      evening: (d) => d ? d + ' soir' : 'ce soir', afternoon: (d) => d ? d + ' après-midi' : 'cet après-midi', morning: (d) => d ? d + ' matin' : 'ce matin',
      after: (d, h, m) => (d ? d + ' ' : '') + 'après ' + h + ' h' + (m && +m ? ' ' + m : ''), at: (d, h, m) => (d ? d + ' ' : '') + 'à ' + h + ' h' + (m && +m ? ' ' + m : ''),
      time: (h) => 'à ' + h, on: 'sur', programmes: 'programmes',
      example: 'Demande-moi par exemple : qu\'est-ce qu\'il y a ce soir sur RTS 1 ?',
      notUnderstood: 'Je n\'ai pas compris. Essaie : qu\'est-ce qu\'il y a ce soir sur RTS 1 ?',
      which: (l) => 'Quelle chaîne veux-tu dire : ' + l + ' ?',
      noChannel: (x) => 'Je ne trouve pas la chaîne ' + x + ' parmi celles du téléviseur.',
      whichProgramme: 'Pour quelle émission veux-tu connaître l\'horaire ?',
      titleNotFound: (x) => 'Je ne trouve pas « ' + x + ' » dans le programme des prochains jours.',
      onAirNow: 'passe en ce moment', starts: (d, h) => 'commence ' + d + 'à ' + h, again: (d, h, c) => ' Puis de nouveau ' + d + 'à ' + h + ' sur ' + c + '.',
      dayLabel: ['aujourd\'hui ', 'demain ', 'après-demain '],
      nothing: (what, ch, label) => 'Je ne trouve pas de ' + what + (ch ? ' sur ' + ch : '') + ' ' + label + ' dans le programme.',
      channelNow: (label, ch, title, a, b) => cap(label) + ' sur ' + ch + ' : ' + title + ', de ' + a + ' à ' + b + '.',
      more: (n) => '. Et ' + n + ' autres : demande-moi une chaîne pour les détails.'
    }
  }
};

// Language from an explicit code, otherwise guessed from typical words.
function pickLang(lang, q) {
  const l = String(lang || '').slice(0, 2).toLowerCase();
  if (LANGS[l]) return l;
  const score = {
    it: /\b(cosa|stasera|adesso|domani|danno|fanno|canale|quando|oggi|c e|ci sono|dopo le|alle)\b/g,
    de: /\b(was|lauft|laufen|welche|heute|abend|jetzt|morgen|sender|wann|kommt|uhr|nach|filme|gibt es)\b/g,
    en: /\b(what|whats|which|tonight|now|tomorrow|channel|when|on|after|movies|pm|am)\b/g,
    fr: /\b(qu|quoi|quels?|quelles?|ce soir|maintenant|demain|chaine|quand|sur|il y a|apres|heures?|passe)\b/g
  };
  let best = 'it'; let n = 0;
  Object.keys(score).forEach((k) => { const c = (q.match(score[k]) || []).length; if (c > n) { n = c; best = k; } });
  return best;
}

// English "9 pm" -> 21
function hour24(h, ampm) {
  h = +h;
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return h;
}

// channels: [{ name, lcn, xmltvId, programmes:[{start,stop,title,...}] }]
function answer(question, channels0, now, lang) {
  now = now || Date.now();
  const q = fold(question);
  const code = pickLang(lang, q);
  const L = LANGS[code]; const T = L.t;
  const key = keyWith(L.num);
  const hm = (ms) => { const d = new Date(ms); return hhmm(d.getHours(), d.getMinutes()); };
  const dayLabel = (t) => { const d = Math.round((dayStart(t) - dayStart(now)) / 86400e3); return T.dayLabel[d] || ''; };
  const done = (text, items) => ({ success: true, clarification: false, lang: code, spokenResponse: text,
    items: items.map((x) => ({ channel: x.c.name, lcn: x.c.lcn || null, title: x.p.title, start: x.p.start, stop: x.p.stop })) });
  const clarify = (text) => ({ success: true, clarification: true, lang: code, spokenResponse: text, items: [] });

  // Same name + same guide channel listed twice on the TV (e.g. TV8 on 8 and
  // 108): keep one, the lowest channel number. Spoken name without HD suffix;
  // guide placeholders ("No Data") are skipped.
  const seen = {}; const channels = [];
  (channels0 || []).slice().sort((a, b) => lcn(a) - lcn(b)).forEach((c) => {
    const k = key(c.name) + '|' + (c.xmltvId || '');
    if (seen[k]) return;
    seen[k] = 1;
    channels.push(Object.assign({}, c, {
      name: String(c.name).replace(/\s+(hd|fhd|uhd)$/i, ''),
      programmes: (c.programmes || []).filter((p) => p.title && !/^(no data|n\/a|to be announced|tba)$/i.test(p.title.trim()))
    }));
  });
  if (!q) return clarify(T.example);

  // --- day and time window ---------------------------------------------
  let day = 0;
  if (L.dayAfter.test(q)) day = 2; else if (L.tomorrow.test(q)) day = 1;
  const dWord = day === 2 ? T.dayAfter : day === 1 ? T.tomorrow : '';
  const base = dayStart(now, day);
  let from; let to; let mode; let label; let evening = false;
  const after = L.after.exec(q); const at = L.at.exec(q);
  const hmOf = (m) => ({ h: hour24(m[1], m[3] === 'am' || m[3] === 'pm' ? m[3] : null), m: (m[2] && /^\d+$/.test(m[2]) ? m[2] : (m[3] && /^\d+$/.test(m[3]) ? m[3] : '')) });
  if (after) {
    const t = hmOf(after);
    from = base + t.h * 3600e3 + (+(t.m || 0)) * 60e3; to = base + 26 * 3600e3;
    mode = 'starting'; label = T.after(dWord, t.h, t.m);
  } else if (at) {
    const t = hmOf(at);
    from = base + t.h * 3600e3 + (+(t.m || 0)) * 60e3; to = from + 1; mode = 'onair'; label = T.at(dWord, t.h, t.m);
  } else if (L.evening.test(q)) {
    from = base + 21 * 3600e3 + 40 * 60e3; to = from + 1; mode = 'onair'; label = T.evening(dWord); evening = true;
  } else if (L.afternoon.test(q)) {
    from = base + 15 * 3600e3; to = from + 1; mode = 'onair'; label = T.afternoon(dWord);
  } else if (L.morning.test(q)) {
    from = base + 9 * 3600e3; to = from + 1; mode = 'onair'; label = T.morning(dWord);
  } else if (L.today.test(q) || day) {
    from = day ? base : now; to = base + 24 * 3600e3; mode = 'starting'; label = day ? dWord : T.today;
  } else {
    from = now; to = now + 1; mode = 'onair'; label = T.now;
  }

  // --- channel ------------------------------------------------------------
  const qw = q.split(' ').map((w) => L.num[w] || w);
  const keys = channels.map((c) => ({ c: c, k: key(c.name) })).filter((x) => x.k);
  const exact = (phrase) => keys.filter((x) => x.k === phrase).map((x) => x.c);
  const names = (list, n) => list.slice(0, n).map((c) => c.name).join(', ');
  let channel = null;
  // 1) explicit target after the preposition ("su", "auf", "on", "sur")
  const tm = L.onPrep.exec(qw.join(' '));
  if (tm) {
    const target = tm[1].replace(L.chanWord, '').trim();
    const num = L.chanNum.exec(tm[1]);
    if (num) {
      const byLcn = channels.filter((c) => String(c.lcn) === num[1]);
      if (byLcn.length === 1) channel = byLcn[0];
    }
    if (!channel) {
      const tk = key(target);
      const ex = exact(tk);
      if (ex.length === 1) channel = ex[0];
      else if (ex.length > 1) return clarify(T.which(names(ex, 4)));
      else if (tk.length >= 2) {
        const pre = keys.filter((x) => x.k.indexOf(tk) === 0).map((x) => x.c);
        if (pre.length === 1) channel = pre[0];
        else if (pre.length > 1) return clarify(T.which(names(pre, 5)));
        else if (!num && code !== 'en') return clarify(T.noChannel(tm[1]));
      }
    }
  }
  // 2) otherwise any word sequence equal to a channel name ("rai uno stasera")
  if (!channel) {
    const found = [];
    for (let n = 4; n >= 1 && !found.length; n--) {
      for (let i = 0; i + n <= qw.length; i++) {
        exact(key(qw.slice(i, i + n).join(' '))).forEach((c) => { if (found.indexOf(c) < 0) found.push(c); });
      }
    }
    if (found.length > 1) return clarify(T.which(names(found, 4)));
    if (found.length === 1) channel = found[0];
  }
  const g = L.genres.find((x) => x[0].test(q));
  const genre = g ? { test: g[1], say: g[2] } : null;

  if (!channel && !genre && !L.timeWord.test(q) && !L.generic.test(q)) return clarify(T.notUnderstood);

  // --- "when does <title> start" -------------------------------------------
  const when = L.when.exec(q);
  if (when && !genre) {
    let title = when[2].replace(L.titleTail, '').replace(L.article, '').trim();
    if (channel) title = title.replace(new RegExp(key(channel.name), 'g'), '').trim();
    if (title.length < 3) return clarify(T.whichProgramme);
    const tk = fold(title);
    const found = [];
    (channel ? [channel] : channels).forEach((c) => c.programmes.forEach((p) => {
      if (p.stop > now && fold(p.title).indexOf(tk) >= 0) found.push({ c: c, p: p });
    }));
    found.sort((a, b) => a.p.start - b.p.start);
    if (!found.length) return done(T.titleNotFound(title), []);
    const f = found[0]; const onAir = f.p.start <= now;
    const w = onAir ? T.onAirNow : T.starts(dayLabel(f.p.start), hm(f.p.start));
    return done(f.p.title + ' ' + w + ' ' + T.on + ' ' + f.c.name + '.' +
      (found.length > 1 && !onAir ? T.again(dayLabel(found[1].p.start), hm(found[1].p.start), found[1].c.name) : ''), found.slice(0, 5));
  }

  // --- listing --------------------------------------------------------------
  const pool = channel ? [channel] : channels;
  const items = [];
  pool.forEach((c) => c.programmes.forEach((p) => {
    const ok = mode === 'onair' ? (p.start <= from && p.stop > from) : (p.start >= from && p.start < to);
    if (ok && (!genre || genre.test(p))) items.push({ c: c, p: p });
  }));
  items.sort((a, b) => a.p.start - b.p.start || lcn(a.c) - lcn(b.c));
  if (mode === 'onair' && !genre) items.sort((a, b) => lcn(a.c) - lcn(b.c));
  const what = genre ? genre.say : T.programmes;
  if (!items.length) return done(T.nothing(what, channel && channel.name, label), []);
  if (channel && evening && !genre) {
    const eve0 = from - 70 * 60e3; const eve1 = base + 24 * 3600e3;
    const line = channel.programmes.filter((p) => p.stop > eve0 && p.start < eve1 && (p.start >= eve0 || p.stop > from)).slice(0, 4);
    if (line.length) return done(cap(label) + ' ' + T.on + ' ' + channel.name + ': ' + line.map((p) => T.time(hm(p.start)) + ' ' + p.title).join(', ') + '.', line.map((p) => ({ c: channel, p: p })));
  }
  if (channel && mode === 'onair') {
    const it = items[0];
    return done(T.channelNow(label, channel.name, it.p.title, hm(it.p.start), hm(it.p.stop)), items);
  }
  if (channel) {
    return done(cap(T.on) + ' ' + channel.name + ' ' + label + ': ' + items.slice(0, 5).map((x) => T.time(hm(x.p.start)) + ' ' + x.p.title).join(', ') + '.', items.slice(0, 5));
  }
  // Whole line-up for "now" / "tonight" (the user's own channel selection, in
  // remote order); genre searches are capped at 10 results. One sentence per
  // channel so Siri pauses between them.
  const max = genre ? 10 : items.length;
  const shown = items.slice(0, max);
  const list = shown.map((x) => (mode === 'onair' ? '' : cap(T.time(hm(x.p.start))) + ', ') + x.c.name + ', ' + x.p.title).join('. ');
  const more = items.length > max ? T.more(items.length - max) : '.';
  return done((genre ? cap(what) + ' ' + label : cap(label)) + '. ' + list + more, shown);
}

const SERVICE = {
  disabled: { it: 'Le domande vocali non sono attive: imposta il token Siri nelle impostazioni del plugin.', de: 'Sprachfragen sind nicht aktiv: setze das Siri-Token in den Plugin-Einstellungen.', en: 'Voice questions are off: set the Siri token in the plugin settings.', fr: 'Les questions vocales ne sont pas actives : définis le jeton Siri dans les réglages du plugin.' },
  badToken: { it: 'Token non valido.', de: 'Ungültiges Token.', en: 'Invalid token.', fr: 'Jeton non valide.' },
  tooMany: { it: 'Troppe richieste, riprova tra un minuto.', de: 'Zu viele Anfragen, versuche es in einer Minute erneut.', en: 'Too many requests, try again in a minute.', fr: 'Trop de demandes, réessaie dans une minute.' },
  noGuide: { it: 'La guida non è ancora stata scaricata.', de: 'Das Programm wurde noch nicht heruntergeladen.', en: 'The guide has not been downloaded yet.', fr: 'Le programme n\'a pas encore été téléchargé.' },
  error: { it: 'Non sono riuscito a rispondere.', de: 'Ich konnte nicht antworten.', en: 'I could not answer.', fr: 'Je n\'ai pas pu répondre.' }
};
function message(id, lang, question) { const l = pickLang(lang, fold(question)); return (SERVICE[id] || SERVICE.error)[l]; }

module.exports = { answer, message, languages: Object.keys(LANGS), _fold: fold };
