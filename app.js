'use strict';
/* =====================================================================
   Çift Altyazı v2
   Video telefonda dosya olarak durur. Almanca altyazı YouTube'dan (link, yapıştırma veya .srt/.vtt) gelir.
   Türkçe çeviri sadece izlenen cümle ve ilerisi için Claude ile yapılır, telefona kaydedilir.
   Bölüm 1: saf yardımcılar (Node'da test edilebilir)
   Bölüm 2: ağ, depolama, ayarlar
   Bölüm 3: altyazı alma ve çeviri
   Bölüm 4: arayüz ve oynatıcı
   ===================================================================== */

/* ---------- Bölüm 1: saf yardımcılar ---------- */
const MODELS = {
  'claude-haiku-5-5': { label: 'Haiku 5.5 (ucuz, hızlı)', i: 0.10, o: 0.50 },
  'claude-sonnet-5-5': { label: 'Sonnet 5.5 (daha iyi çeviri)', i: 2, o: 10 }
};
function usageCost(usage, modelId) {
  const m = MODELS[modelId] || MODELS['claude-haiku-5-5'];
  return ((usage.i || 0) * m.i + (usage.o || 0) * m.o) / 1e6;
}
function fmtMoney(x) { return (x < 0.01 ? '<0,01' : x.toFixed(2).replace('.', ',')) + ' $'; }
function fmtDur(sec) {
  if (!isFinite(sec)) return '--:--';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}
function fmtHMS(sec) {
  sec = Math.max(0, Math.floor(sec));
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`;
}
function fmtSize(b) { return b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB'; }

function pieceRanges(tokens, maxChars, minChars) {
  maxChars = maxChars || 84; minChars = minChars || 22;
  const ranges = [];
  let startIdx = 0, len = 0, lastSoft = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    len += (len ? 1 : 0) + t.length;
    if (/[,;:–—]$/.test(t)) lastSoft = i;
    const hard = /[.!?…]["»”']?$/.test(t);
    if (i === tokens.length - 1) { ranges.push([startIdx, i]); break; }
    if (hard && len >= minChars) { ranges.push([startIdx, i]); startIdx = i + 1; len = 0; lastSoft = -1; continue; }
    const nextLen = len + 1 + tokens[i + 1].length;
    if (nextLen > maxChars) {
      const cut = (lastSoft >= startIdx && lastSoft > startIdx + 1) ? lastSoft : i;
      ranges.push([startIdx, cut]);
      startIdx = cut + 1;
      len = tokens.slice(startIdx, i + 1).join(' ').length;
      lastSoft = -1;
    }
  }
  if (ranges.length > 1) {
    const last = ranges[ranges.length - 1], prev = ranges[ranges.length - 2];
    const lastLen = tokens.slice(last[0], last[1] + 1).join(' ').length;
    const prevLen = tokens.slice(prev[0], prev[1] + 1).join(' ').length;
    if (lastLen < 12 && prevLen + 1 + lastLen <= maxChars + 20) { ranges.pop(); prev[1] = last[1]; }
  }
  return ranges;
}
/* Uzun bir satırı, süreyi harf sayısına orantılı bölüştürerek parçalar */
function splitCue(text, start, end) {
  const tokens = String(text).split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const dur = end - start;
  if (dur <= 7.5 && tokens.join(' ').length <= 100) return [{ s: start, e: end, de: tokens.join(' ') }];
  const ranges = pieceRanges(tokens, 100);
  const totalChars = tokens.join(' ').length;
  let acc = 0;
  return ranges.map(([a, b]) => {
    const piece = tokens.slice(a, b + 1).join(' ');
    const s = start + dur * (acc / totalChars);
    acc += piece.length + 1;
    const e = start + dur * Math.min(1, (acc - 1) / totalChars);
    return { s, e, de: piece };
  });
}
function fixCues(cues) {
  cues = cues.slice().sort((a, b) => a.s - b.s);
  const out = [];
  let repeat = 0;
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (prev && prev.de === c.de) { repeat++; if (repeat >= 2) continue; } else repeat = 0;
    out.push({ s: c.s, e: c.e, de: c.de });
  }
  for (let i = 0; i < out.length; i++) {
    const c = out[i], next = out[i + 1];
    if (c.e - c.s < 0.9) c.e = c.s + 1.4;
    if (next && c.e > next.s - 0.02) c.e = Math.max(c.s + 0.25, next.s - 0.02);
  }
  return out;
}
/* Yarım bölünmüş cümleleri birleştirir ("…gehst du in die" + "Muckibude?"). Çeviri tam cümlede daha iyi olur. */
function mergeFragments(raw) {
  const out = [];
  const special = t => /^[\[♪(]/.test(t);
  for (const c of raw) {
    const text = String(c.text || c.de || '').replace(/\s+/g, ' ').trim();
    if (!text || !isFinite(c.s)) continue;
    const e = isFinite(c.e) && c.e > c.s ? c.e : c.s + 3;
    const prev = out[out.length - 1];
    if (prev && !/[.!?…:"»”]$/.test(prev.text) && !special(prev.text) && !special(text)
      && c.s - prev.e < 1.2 && prev.text.length + 1 + text.length <= 96 && e - prev.s <= 7.5) {
      prev.text += ' ' + text; prev.e = e;
    } else out.push({ s: c.s, e, text });
  }
  return out;
}
function normalizeCues(raw) {
  const out = [];
  for (const c of mergeFragments(raw)) {
    for (const p of splitCue(c.text, c.s, c.e)) out.push(p);
  }
  return fixCues(out);
}

function parseTimeStr(s) {
  const m = String(s).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return NaN;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? +('0.' + m[4]) : 0);
}
function cleanText(t) {
  return String(t).replace(/<[^>]*>/g, '').replace(/\{\\an\d\}/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
/* .srt ve .vtt (YouTube'un kayan otomatik altyazı biçimi dahil) */
function parseSubtitleFile(text) {
  text = String(text).replace(/\r/g, '').replace(/^﻿/, '');
  const tre = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
  const cues = [];
  let prevLast = '';
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const ti = lines.findIndex(l => tre.test(l));
    if (ti < 0) continue;
    const m = lines[ti].match(tre);
    const body = lines.slice(ti + 1).map(cleanText).filter(Boolean);
    if (body.length > 1 && body[0] === prevLast) body.shift();
    if (body.length === 1 && body[0] === prevLast) continue;
    if (!body.length) continue;
    prevLast = body[body.length - 1];
    cues.push({ s: parseTimeStr(m[1]), e: parseTimeStr(m[2]), text: body.join(' ') });
  }
  return cues;
}
/* Yapıştırılan metin: SRT/VTT ya da YouTube'un "0:40 / cümle" transkript biçimi */
function parsePasted(text) {
  text = String(text).replace(/\r/g, '').trim();
  if (/-->/.test(text)) return parseSubtitleFile(text);
  // [0:17] biçimindeki zaman damgaları aynı satıra yapışmış olsa bile ayrı satıra ayır
  text = text.replace(/\s*(\[(?:\d+:)?\d{1,2}:\d{2}\])/g, '\n$1');
  const cues = [];
  let cur = null;
  const only = /^[\[(]?((?:\d+:)?\d{1,2}:\d{2})[\])]?$/;
  const inline = /^[\[(]?((?:\d+:)?\d{1,2}:\d{2})[\])]?[\s\-–—:]*(\S.*)$/;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = line.match(only))) { cur = { s: parseTimeStr(m[1]), text: '' }; cues.push(cur); }
    else if ((m = line.match(inline))) { cur = { s: parseTimeStr(m[1]), text: m[2] }; cues.push(cur); }
    else if (cur) cur.text += (cur.text ? ' ' : '') + line;
  }
  // kopyalama yarıda kesildiyse sondaki "[0:4" gibi artıkları at
  cues.forEach(c => { c.text = c.text.replace(/\s*[\[(][\d:]*$/, '').trim(); });
  const good = cues.filter(c => c.text && isFinite(c.s));
  good.forEach((c, i) => {
    const next = good[i + 1];
    c.e = next ? Math.min(next.s - 0.05, c.s + 8) : c.s + 4;
    if (c.e <= c.s) c.e = c.s + 1;
  });
  return good;
}
function youtubeId(url) {
  const m = String(url).trim().match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : (/^[A-Za-z0-9_-]{11}$/.test(String(url).trim()) ? String(url).trim() : '');
}

function parseTranslation(text) {
  const map = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*[|\t]\s*(.*\S)\s*$/);
    if (m) map.set(Number(m[1]), m[2].trim());
  }
  return map;
}
function findCueIndex(cues, t) {
  let lo = 0, hi = cues.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].s <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/* ---------- Kelime defteri: saf yardımcılar ---------- */
const WORD_RE = /[\p{L}\p{M}]+(?:[’'\-][\p{L}\p{M}]+)*/gu;
function tokenizeDe(text) {
  const out = []; let last = 0; text = String(text);
  text.replace(WORD_RE, (m, off) => {
    if (off > last) out.push({ t: text.slice(last, off), w: false });
    out.push({ t: m, w: true }); last = off + m.length; return m;
  });
  if (last < text.length) out.push({ t: text.slice(last), w: false });
  return out;
}
function parseWordInfo(text) {
  const s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let j; try { j = JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
  if (!j || typeof j !== 'object') return null;
  const str = k => (typeof j[k] === 'string' ? j[k].trim() : '');
  const tr = str('tr'); if (!tr) return null;
  let article = str('article').toLowerCase(); if (!['der', 'die', 'das'].includes(article)) article = '';
  return { lemma: str('lemma'), pos: str('pos'), article, plural: str('plural'), forms: str('forms'), tr, other: str('other'), note: str('note') };
}
const REVIEW_DAYS = [0, 1, 3, 7, 14, 30, 90];
const DAY_MS = 864e5;
function nextReview(card, grade, now) {
  const last = REVIEW_DAYS.length - 1;
  const step0 = Math.max(0, Math.min(last, card.step || 0));
  let step, due, lapses = card.lapses || 0;
  if (grade === 'again') { step = 0; due = now + 10 * 60000; lapses++; }
  else if (grade === 'hard') { step = step0; due = now + Math.max(1, REVIEW_DAYS[step0]) * DAY_MS; }
  else { step = Math.min(last, step0 + 1); due = now + REVIEW_DAYS[step] * DAY_MS; }
  return { step, due, lapses, reps: (card.reps || 0) + 1, last: now };
}
function intervalLabel(card, grade, now) {
  const d = nextReview(card, grade, now).due - now;
  return d < 36e5 ? Math.round(d / 6e4) + ' dk' : d < 2 * DAY_MS ? '1 gün' : Math.round(d / DAY_MS) + ' gün';
}
function isDue(w, now) { return (w.due || 0) <= now; }

/* ---------- Yedek: birleştirme yardımcıları ---------- */
function mergeVideoRecord(ex, inc) {
  const out = Object.assign({}, ex);
  if (Array.isArray(ex.cues) && Array.isArray(inc.cues) && ex.cues.length === inc.cues.length) {
    out.cues = ex.cues.map((c, i) => (!c.tr && inc.cues[i].tr) ? Object.assign({}, c, { tr: inc.cues[i].tr }) : c);
  }
  out.fav = Object.assign({}, inc.fav || {}, ex.fav || {});
  return out;
}
function mergeWord(a, b) { return (b.reps || 0) > (a.reps || 0) ? b : a; }
function nextOffset(range, fallback) { const m = /bytes=0-(\d+)/.exec(range || ''); return m ? Number(m[1]) + 1 : fallback; }
function validBackup(j) {
  return !!j && j.app === 'cift-altyazi' && Array.isArray(j.videos) && Array.isArray(j.words);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { nextOffset, mergeVideoRecord, mergeWord, validBackup, tokenizeDe, parseWordInfo, nextReview, intervalLabel, isDue, mergeFragments, pieceRanges, splitCue, fixCues, normalizeCues, parseTimeStr, parseSubtitleFile, parsePasted, youtubeId, parseTranslation, findCueIndex, usageCost, fmtDur, fmtHMS, fmtMoney };
}

if (typeof window !== 'undefined') (function () {

  /* ---------- Bölüm 2: ağ, depolama, ayarlar ---------- */
  const sleep = (ms, signal) => new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Durduruldu', 'AbortError')); }, { once: true });
  });

  async function fetchRetry(url, init, signal, tries) {
    tries = tries || 3;
    let lastErr;
    for (let a = 0; a < tries; a++) {
      try {
        const r = await fetch(url, Object.assign({}, init, { signal }));
        if (r.ok) return r;
        const body = await r.text().catch(() => '');
        let msg = body;
        try { const j = JSON.parse(body); msg = (j.error && j.error.message) || j.error || j.message || body; } catch (_) { /* düz metin */ }
        const err = new Error(r.status + ': ' + String(msg).slice(0, 220));
        err.status = r.status;
        if ([408, 429, 500, 502, 503, 504, 529].includes(r.status) && a < tries - 1) {
          lastErr = err; await sleep(1200 * Math.pow(2, a), signal); continue;
        }
        throw err;
      } catch (e) {
        if (e.name === 'AbortError' || e.status) throw e;
        lastErr = e;
        if (a < tries - 1) { await sleep(1200 * Math.pow(2, a), signal); continue; }
        throw new Error('Bağlantı kurulamadı. İnternetin açık mı?');
      }
    }
    throw lastErr;
  }

  const TR_SYSTEM = 'You are a professional subtitle translator. Translate German subtitle lines into natural, spoken Turkish for on-screen subtitles: concise, idiomatic, matching the speaker\'s tone and register (child-friendly if it sounds like a kids\' show). Keep proper names unchanged. Keep music symbols like ♪ as they are and translate sound-effect labels such as [Musik]. Never merge, split, skip or reorder lines: output exactly one line per input line.';

  async function claudeTranslate(batch, context, key, model, signal) {
    const ctx = context.length ? 'Preceding lines, for context only. Do NOT output them:\n' + context.map(c => '- ' + c).join('\n') + '\n\n' : '';
    const user = ctx + 'Translate the following numbered German lines into Turkish.\nOutput format: one line per input, written as <number>|<Turkish translation>. No other text, no commentary.\n\n' + batch.map(b => b.id + '|' + b.de).join('\n');
    const r = await fetchRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model, max_tokens: 4000, system: TR_SYSTEM, messages: [{ role: 'user', content: user }] })
    }, signal);
    const j = await r.json();
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    return { text, usage: { i: (j.usage && j.usage.input_tokens) || 0, o: (j.usage && j.usage.output_tokens) || 0 } };
  }

  const DB = (function () {
    let dbp;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open('cift-altyazi', 2);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('videos')) d.createObjectStore('videos', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
          if (!d.objectStoreNames.contains('words')) d.createObjectStore('words', { keyPath: 'id' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return dbp;
    }
    async function tx(store, mode, fn) {
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => res(req ? req.result : undefined);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error('Depolama işlemi iptal oldu'));
      });
    }
    return {
      all: () => tx('videos', 'readonly', s => s.getAll()),
      get: id => tx('videos', 'readonly', s => s.get(id)),
      put: v => tx('videos', 'readwrite', s => s.put(v)),
      putFile: (id, f) => tx('files', 'readwrite', s => s.put(f, id)),
      getFile: id => tx('files', 'readonly', s => s.get(id)),
      allWords: () => tx('words', 'readonly', s => s.getAll()),
      putWord: w => tx('words', 'readwrite', s => s.put(w)),
      delWord: id => tx('words', 'readwrite', s => s.delete(id)),
      del: async id => { await tx('videos', 'readwrite', s => s.delete(id)); await tx('files', 'readwrite', s => s.delete(id)); }
    };
  })();

  const SKEY = 'ciftaltyazi.ayar.v2';
  const defaults = { anthropic: '', model: 'claude-haiku-5-5', proxy: '', gClient: '', fontSize: 22, showDe: true, showTr: true, blurTr: false };
  let settings = Object.assign({}, defaults);
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SKEY) || '{}')); } catch (_) { /* boş */ }
  function saveSettings() { try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch (_) { /* özel mod */ } }

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let videos = [];
  const jobs = new Map(); // id -> { ctl, text, frac }  (hepsini önceden çevir)

  let toastTimer;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 4200);
  }
  function explain(e) {
    const m = String(e.message || e);
    if (/^401/.test(m)) return 'Claude API anahtarı geçersiz. Ayarlardan kontrol et. (' + m + ')';
    if (/^402|credit|billing|quota/i.test(m)) return 'Bakiye veya kota sorunu. API hesabını kontrol et. (' + m + ')';
    if (/^429/.test(m)) return 'İstek sınırına takıldı. Biraz sonra yine dene.';
    return m;
  }

  /* ---------- Bölüm 3: çeviri ---------- */
  function applyTranslations(rec, ids, map) {
    const missing = [];
    for (const i of ids) { const t = map.get(i + 1); if (t) rec.cues[i].tr = t; else missing.push(i); }
    return missing;
  }
  async function translateIdx(rec, ids, signal) {
    const cues = rec.cues;
    let pending = ids.slice();
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      const ctxLines = [];
      for (let k = Math.max(0, pending[0] - 4); k < pending[0]; k++) ctxLines.push(cues[k].de);
      const res = await claudeTranslate(pending.map(i => ({ id: i + 1, de: cues[i].de })), ctxLines, settings.anthropic, rec.model || settings.model, signal);
      rec.usage = rec.usage || { i: 0, o: 0 };
      rec.usage.i += res.usage.i; rec.usage.o += res.usage.o;
      pending = applyTranslations(rec, pending, parseTranslation(res.text));
    }
    for (const i of pending) cues[i].tr = cues[i].de; // çevrilemeyen satır Almanca kalır
  }

  /* Oynatırken: mevcut cümle + ilerisi */
  const TR = { pending: new Set(), chain: Promise.resolve(), cool: 0, saveT: 0, warned: false };
  const AHEAD = 24;
  function ensureTranslated() {
    const rec = P.rec;
    if (!rec || !settings.anthropic || !navigator.onLine || Date.now() < TR.cool) return;
    const cues = rec.cues, from = Math.max(0, P.idx), to = Math.min(cues.length, from + AHEAD);
    const need = [];
    for (let i = from; i < to; i++) if (!cues[i].tr && !TR.pending.has(i)) need.push(i);
    if (!need.length) return;
    need.forEach(i => TR.pending.add(i));
    const groups = [need.slice(0, 6)];
    for (let k = 6; k < need.length; k += 15) groups.push(need.slice(k, k + 15));
    for (const g of groups) {
      TR.chain = TR.chain.then(async () => {
        try {
          await translateIdx(rec, g);
          TR.warned = false;
        } catch (e) {
          TR.cool = Date.now() + 15000;
          if (!TR.warned) { TR.warned = true; toast('Çeviri alınamadı: ' + explain(e)); }
        } finally {
          g.forEach(i => { TR.pending.delete(i); if (P.rec === rec) setCueText(i); });
          clearTimeout(TR.saveT); TR.saveT = setTimeout(() => DB.put(rec).catch(() => {}), 2500);
        }
      });
    }
    need.forEach(i => setCueText(i));
  }

  /* Önceden hepsini çevir (internetli, uçuş öncesi gibi) */
  async function translateAll(rec) {
    if (!settings.anthropic) { openSettings('Önce Claude API anahtarını gir.'); return; }
    if (jobs.has(rec.id)) return;
    const ctl = new AbortController();
    jobs.set(rec.id, { ctl, text: 'Başlıyor…', frac: 0 });
    renderList();
    const BATCH = 50, PAR = 3, cues = rec.cues;
    const todo = [];
    for (let i = 0; i < cues.length; i += BATCH) {
      const idx = [];
      for (let j = i; j < Math.min(cues.length, i + BATCH); j++) if (!cues[j].tr) idx.push(j);
      if (idx.length) todo.push(idx);
    }
    let done = cues.filter(c => c.tr).length, next = 0, failure = null;
    const total = cues.length;
    async function worker() {
      while (next < todo.length && !failure) {
        const idx = todo[next++];
        try {
          await translateIdx(rec, idx, ctl.signal);
          done += idx.length;
          const j = jobs.get(rec.id);
          if (j) { j.text = `Türkçeye çevriliyor (${Math.min(done, total)}/${total})…`; j.frac = done / total; renderList(); }
          await DB.put(rec);
        } catch (e) { failure = failure || e; }
      }
    }
    await Promise.all(Array.from({ length: PAR }, worker));
    jobs.delete(rec.id);
    await DB.put(rec).catch(() => {});
    if (failure) {
      if (failure.name === 'AbortError') toast('Durduruldu. Çevrilenler kaydedildi.');
      else toast('Çeviri yarım kaldı: ' + explain(failure));
    } else toast('Tüm cümleler çevrildi.');
    await refresh();
  }

  /* ---------- Bölüm 4: arayüz ---------- */
  async function refresh() {
    try { videos = (await DB.all()).sort((a, b) => b.createdAt - a.createdAt); } catch (e) { videos = []; toast('Depolama açılamadı: ' + e.message); }
    renderList();
  }

  function renderList() {
    $('emptyHint').hidden = videos.length > 0;
    $('list').innerHTML = videos.map(rec => {
      const job = jobs.get(rec.id);
      const n = rec.cues ? rec.cues.length : 0, tr = rec.cues ? rec.cues.filter(c => c.tr).length : 0;
      const meta = [fmtDur(rec.duration), fmtSize(rec.size), `çevrilen ${tr}/${n}`];
      if (settings.gClient) meta.push(rec.driveId ? 'Drive\'da' : 'Drive\'da yok');
      if (rec.usage && (rec.usage.i || rec.usage.o)) meta.push('maliyet ' + fmtMoney(usageCost(rec.usage, rec.model)));
      let body;
      if (job) {
        body = `<div class="bar"><i style="width:${Math.round((job.frac || 0) * 100)}%"></i></div><p class="state">${esc(job.text)}</p>
                <div class="row"><button data-act="cancel" data-id="${rec.id}" class="ghost">Durdur</button></div>`;
      } else {
        const away = !rec.hasFile && rec.driveId;
        body = `${!rec.hasFile ? (away ? '<p class="state">Video Drive\'da duruyor, bu cihazda yok.</p>' : '<p class="state">Video bu cihazda kayıtlı değil. Oynatırken dosyayı seçeceksin.</p>') : ''}
                <div class="row"><button data-act="play" data-id="${rec.id}" class="primary">Oynat</button>
                ${away ? `<button data-act="dl" data-id="${rec.id}" class="ghost">Cihaza indir</button>` : ''}
                ${tr < n ? `<button data-act="all" data-id="${rec.id}" class="ghost">Hepsini çevir</button>` : ''}
                <button data-act="del" data-id="${rec.id}" class="ghost danger">Sil</button></div>`;
      }
      return `<article class="card"><h3>${esc(rec.name)}</h3><p class="meta">${meta.join(' · ')}</p>${body}</article>`;
    }).join('');
  }

  function openSheet(html, mount, dismissible) {
    $('sheetBody').innerHTML = html;
    $('sheet').hidden = false;
    $('sheet').dataset.dismiss = dismissible === false ? '0' : '1';
    if (mount) mount($('sheetBody'));
  }
  let sheetClose = null;
  function closeSheet() { $('sheet').hidden = true; $('sheetBody').innerHTML = ''; if (sheetClose) { const f = sheetClose; sheetClose = null; f(); } }

  function openSettings(note) {
    openSheet(`
      <h2>Ayarlar</h2>
      ${note ? `<p class="state err">${esc(note)}</p>` : ''}
      <label class="field"><span>Claude API anahtarı (çeviri için)</span>
        <input id="kAnth" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(settings.anthropic)}"></label>
      <label class="field"><span>Çeviri modeli</span>
        <select id="kModel">${Object.entries(MODELS).map(([k, m]) => `<option value="${k}" ${settings.model === k ? 'selected' : ''}>${m.label}</option>`).join('')}</select></label>
      <label class="field"><span>YouTube altyazı sunucusu adresi (isteğe bağlı)</span>
        <input id="kProxy" type="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://…workers.dev" value="${esc(settings.proxy)}"></label>
      <div class="field"><span>Yedek (telefon ve bilgisayar arasında taşımak için)</span>
        <div class="row"><button id="bkOut" class="ghost">Yedek dosyası oluştur</button><label class="btn ghost">Yedekten yükle<input id="bkIn" type="file" accept=".json,application/json" hidden></label></div>
        <p class="hint">Altyazılar, çeviriler, kaydedilen kelimeler ve cümleler dosyaya girer. Videolar ve API anahtarı girmez.</p></div>
      <label class="field"><span>Google Drive istemci kimliği (Client ID, isteğe bağlı)</span>
        <input id="kGoogle" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="123456-abc….apps.googleusercontent.com" value="${esc(settings.gClient)}"></label>
      <p class="hint">Anahtar yalnızca bu cihazda saklanır ve doğrudan Anthropic'e gönderilir. Sunucu adresi boşsa YouTube linki yerine altyazı metnini yapıştırırsın.</p>
      <div class="row"><button id="sSave" class="primary">Kaydet</button><button id="sCancel" class="ghost">Kapat</button></div>`, b => {
      b.querySelector('#sSave').onclick = () => {
        settings.anthropic = b.querySelector('#kAnth').value.trim();
        settings.model = b.querySelector('#kModel').value;
        settings.proxy = b.querySelector('#kProxy').value.trim().replace(/\/+$/, '');
        settings.gClient = b.querySelector('#kGoogle').value.trim();
        saveSettings(); closeSheet(); toast('Kaydedildi.'); syncVisibility();
      };
      b.querySelector('#sCancel').onclick = closeSheet;
      b.querySelector('#bkOut').onclick = exportBackup;
      b.querySelector('#bkIn').onchange = e => { const f = e.target.files[0]; if (f) importBackup(f); };
    });
  }

  async function buildBackup() {
    const vs = await DB.all(), ws = await DB.allWords();
    return { app: 'cift-altyazi', v: 1, exportedAt: Date.now(), videos: vs, words: ws };
  }
  async function mergeBackup(j) {
    let addV = 0, mergedV = 0, addW = 0;
    const have = await DB.all();
    for (const inc of j.videos) {
      if (!inc || !inc.id || !Array.isArray(inc.cues)) continue;
      const ex = have.find(v => v.id === inc.id || (v.name === inc.name && v.size === inc.size));
      if (ex) { const m = mergeVideoRecord(ex, inc); if (!m.driveId && inc.driveId) m.driveId = inc.driveId; await DB.put(m); mergedV++; }
      else { const rec = Object.assign({}, inc, { hasFile: false }); await DB.put(rec); have.push(rec); addV++; }
    }
    const haveW = new Map((await DB.allWords()).map(w => [w.id, w]));
    for (const inc of j.words) {
      if (!inc || !inc.id) continue;
      const ex = haveW.get(inc.id);
      if (!ex) { await DB.putWord(inc); addW++; } else { const m = mergeWord(ex, inc); if (m !== ex) await DB.putWord(m); }
    }
    return { addV, mergedV, addW };
  }

  async function exportBackup() {
    try {
      const data = JSON.stringify(await buildBackup());
      const name = 'cift-altyazi-yedek-' + new Date().toISOString().slice(0, 10) + '.json';
      const file = new File([data], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: name }); toast('Yedek hazır.'); return; }
        catch (e) { if (e.name === 'AbortError') return; }
      }
      const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('Yedek dosyası indirildi: ' + name);
    } catch (e) { toast('Yedek alınamadı: ' + e.message); }
  }

  async function importBackup(file) {
    try {
      let j; try { j = JSON.parse(await file.text()); } catch (_) { throw new Error('Bu dosya okunamadı.'); }
      if (!validBackup(j)) throw new Error('Bu bir Çift Altyazı yedeği değil.');
      const { addV, mergedV, addW } = await mergeBackup(j);
      await refresh(); await loadWords(); closeSheet();
      toast(`Yüklendi: ${addV} yeni video, ${addW} yeni kelime${mergedV ? ', ' + mergedV + ' video birleştirildi' : ''}. Videoyu ilk oynatışta bir kez seçeceksin.`);
    } catch (e) { toast(e.message); }
  }

  function askFile(message) {
    return new Promise(resolve => {
      let picked = false;
      sheetClose = () => { if (!picked) resolve(null); };
      openSheet(`<h2>Videoyu seç</h2><p>${esc(message)}</p>
        <label class="btn primary">Dosyalardan seç<input id="afInput" type="file" accept="video/*,.mp4,.mov,.m4v" hidden></label>
        <div class="row"><button id="afCancel" class="ghost">Vazgeç</button></div>`, b => {
        b.querySelector('#afInput').onchange = e => { const f = e.target.files[0]; if (f) { picked = true; closeSheet(); resolve(f); } };
        b.querySelector('#afCancel').onclick = closeSheet;
      });
    });
  }

  function probeDuration(file) {
    return new Promise(res => {
      const v = document.createElement('video'), u = URL.createObjectURL(file);
      let done = false;
      const fin = d => { if (done) return; done = true; URL.revokeObjectURL(u); res(d); };
      v.preload = 'metadata'; v.muted = true;
      v.onloadedmetadata = () => fin(v.duration);
      v.onerror = () => fin(NaN);
      setTimeout(() => fin(NaN), 10000);
      v.src = u;
    });
  }
  const idOf = f => (f.name + '|' + f.size + '|' + f.lastModified).replace(/[^\w|.-]/g, '_');

  async function fetchFromProxy(videoId) {
    if (!settings.proxy) throw new Error('Altyazı sunucusu adresi girilmemiş. Ayarlardan ekle ya da altyazı metnini yapıştır.');
    const r = await fetchRetry(settings.proxy + '/?v=' + encodeURIComponent(videoId) + '&lang=de', {}, undefined, 2);
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return (j.cues || []).map(c => ({ s: c.s, e: c.e, text: c.text }));
  }

  async function onFilePicked(file) {
    const id = idOf(file);
    const existing = await DB.get(id).catch(() => null) || videos.find(v => v.name === file.name && v.size === file.size);
    if (existing) {
      if (!existing.hasFile) {
        try { await DB.putFile(existing.id, file); existing.hasFile = true; await DB.put(existing); await refresh(); toast('Video eklendi, altyazı hazırdı.'); }
        catch (_) { toast('Video uygulamaya sığmadı.'); }
        return;
      }
      toast('Bu video zaten ekli.'); return openPlayer(existing.id);
    }
    const dur = await probeDuration(file);
    if (!isFinite(dur) || dur <= 0) { toast('Bu dosya Safari\'de açılamıyor. Videoyu MP4 (H.264) olarak indir.'); return; }
    openSheet(`
      <h2>Altyazıyı ekle</h2>
      <p class="fname">${esc(file.name)}</p>
      <p class="meta">${fmtDur(dur)} · ${fmtSize(file.size)}</p>
      <label class="field"><span>YouTube linki</span>
        <input id="iLink" type="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://youtu.be/…"></label>
      <label class="field"><span>veya altyazı metnini yapıştır</span>
        <textarea id="iPaste" rows="4" placeholder="0:40&#10;Viel Glück, Junge.&#10;0:42&#10;…"></textarea></label>
      <label class="field"><span>veya altyazı dosyası (.srt, .vtt)</span>
        <input id="iFile" type="file" accept=".srt,.vtt,.txt,text/plain,text/vtt"></label>
      <p id="iStatus" class="state"></p>
      <div class="row"><button id="iGo" class="primary">Hazırla</button><button id="iNo" class="ghost">Vazgeç</button></div>`, b => {
      const status = t => { b.querySelector('#iStatus').textContent = t; };
      b.querySelector('#iNo').onclick = closeSheet;
      b.querySelector('#iGo').onclick = async () => {
        const go = b.querySelector('#iGo'); go.disabled = true;
        try {
          const link = b.querySelector('#iLink').value.trim(), pasted = b.querySelector('#iPaste').value.trim(), f = b.querySelector('#iFile').files[0];
          let raw;
          if (link) {
            const vid = youtubeId(link);
            if (!vid) throw new Error('Bu bir YouTube linkine benzemiyor.');
            status('YouTube altyazısı alınıyor…');
            raw = await fetchFromProxy(vid);
          } else if (pasted) raw = parsePasted(pasted);
          else if (f) raw = parseSubtitleFile(await f.text());
          else throw new Error('Link gir, metin yapıştır ya da dosya seç.');
          const cues = normalizeCues(raw);
          if (cues.length < 3) throw new Error('Altyazı okunamadı. Zaman damgalı bir metin olmalı (ör. 0:40 ve altında cümle).');
          const rec = { id, name: file.name, size: file.size, lastModified: file.lastModified, createdAt: Date.now(), stage: 'ready', duration: dur, cues, hasFile: false, model: settings.model, usage: { i: 0, o: 0 }, fav: {}, offset: 0 };
          status('Video telefona kaydediliyor…');
          try { await DB.putFile(id, file); rec.hasFile = true; } catch (e) { toast('Video uygulamaya sığmadı. Oynatırken dosyayı yine seçmen gerekecek.'); }
          await DB.put(rec);
          closeSheet(); await refresh();
          toast(`${cues.length} cümle eklendi.`);
        } catch (e) { status(explain(e)); b.querySelector('#iStatus').classList.add('err'); go.disabled = false; }
      };
    });
  }

  async function getBlob(rec) {
    const blob = await DB.getFile(rec.id).catch(() => null);
    if (blob) return blob;
    const f = await askFile('"' + rec.name + '" bu cihazda kayıtlı değil. Aynı videoyu bir kez seç, bir daha sorulmaz.');
    if (!f) return null;
    try { await DB.putFile(rec.id, f); rec.hasFile = true; await DB.put(rec); }
    catch (_) { toast('Video uygulamaya sığmadı. Her açışta yine seçmen gerekecek.'); }
    return f;
  }

  /* --- oynatıcı --- */
  const P = { rec: null, url: '', idx: -1, loop: -1, raf: 0, offset: 0, wake: null, hideT: 0, userScrollUntil: 0, favOnly: false };
  const vid = () => $('vid');

  const deHtml = text => tokenizeDe(text).map(p => p.w ? '<span class="w">' + esc(p.t) + '</span>' : esc(p.t)).join('');
  function buildList() {
    const rec = P.rec;
    $('tlist').innerHTML = rec.cues.map((c, i) => `
      <div class="cue${rec.fav && rec.fav[i] ? ' fav' : ''}" data-i="${i}">
        <div class="cmeta"><span class="ts">${fmtHMS(c.s)}</span><button class="heart" data-heart="${i}" aria-label="Cümleyi kaydet"><svg viewBox="0 0 24 24"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.5 8 3.6 5 6.7 5c2 0 3.4 1 5.3 3 1.9-2 3.3-3 5.3-3 3.1 0 5.2 3 4 6.3-1.8 4.6-9.3 9.2-9.3 9.2z"/></svg></button></div>
        <p class="de">${deHtml(c.de)}</p><p class="tr">${esc(c.tr || '')}</p>
      </div>`).join('');
  }
  function trText(i) { const c = P.rec.cues[i]; return c.tr || (TR.pending.has(i) ? '…' : ''); }
  function setCueText(i) {
    if (!P.rec) return;
    const el = $('tlist').children[i];
    if (el) el.querySelector('.tr').textContent = trText(i);
    if (i === P.idx) $('ovTr').textContent = trText(i);
  }

  async function openPlayer(id, opts) {
    opts = opts || {};
    const rec = await DB.get(id);
    if (!rec) return;
    const blob = await getBlob(rec);
    if (!blob) return;
    P.rec = rec; P.idx = -1; P.loop = -1; P.offset = rec.offset || 0; P.favOnly = false; P.from = opts.from || 'library';
    rec.fav = rec.fav || {};
    TR.pending.clear(); TR.cool = 0;
    if (P.url) URL.revokeObjectURL(P.url);
    P.url = URL.createObjectURL(blob);
    buildList();
    const v = vid();
    v.src = P.url; v.playbackRate = 1; $('bSpeed').textContent = '1×';
    $('pTitle').textContent = rec.name;
    $('playerView').hidden = false; $('libraryView').hidden = true; $('wordsView').hidden = true;
    document.body.classList.add('playing');
    $('bLoop').classList.remove('on'); $('tlist').classList.remove('favonly'); $('bFav').classList.remove('on');
    applyView(); showUI(); renderSubs(true); tick();
    const at = typeof opts.cueStart === 'number' ? opts.cueStart + P.offset : rec.pos;
    if (at) v.addEventListener('loadedmetadata', () => { v.currentTime = at; }, { once: true });
  }

  async function closePlayer() {
    const v = vid();
    if (P.rec) { P.rec.pos = v.currentTime; P.rec.offset = P.offset; DB.put(P.rec).catch(() => {}); }
    v.pause(); cancelAnimationFrame(P.raf); releaseWake();
    v.removeAttribute('src'); v.load();
    if (P.url) { URL.revokeObjectURL(P.url); P.url = ''; }
    $('playerView').hidden = true;
    const back = P.from === 'words' ? 'words' : 'library';
    document.body.classList.remove('playing');
    $('pop').hidden = true;
    P.rec = null;
    await refresh();
    showView(back);
  }

  function applyView() {
    document.documentElement.style.setProperty('--sub-size', settings.fontSize + 'px');
    $('playerView').classList.toggle('no-de', !settings.showDe);
    $('playerView').classList.toggle('no-tr', !settings.showTr);
    $('playerView').classList.toggle('blur', settings.blurTr);
    $('bBlur').classList.toggle('on', settings.blurTr);
    $('offVal').textContent = (P.offset >= 0 ? '+' : '') + P.offset.toFixed(1) + ' sn';
    $('szVal').textContent = settings.fontSize + ' px';
    $('swDe').checked = settings.showDe; $('swTr').checked = settings.showTr; $('swBlur').checked = settings.blurTr;
  }

  function scrollToActive() {
    if (Date.now() < P.userScrollUntil) return;
    const el = $('tlist').children[P.idx]; if (!el) return;
    const list = $('tlist');
    const top = el.offsetTop - list.offsetTop - 6;
    try { list.scrollTo({ top, behavior: 'smooth' }); } catch (_) { list.scrollTop = top; }
  }

  function renderSubs(force) {
    if (!P.rec) return;
    const v = vid(), cues = P.rec.cues;
    const t = v.currentTime - P.offset;
    const i = findCueIndex(cues, t);
    if (i !== P.idx || force) {
      const list = $('tlist');
      const old = list.children[P.idx]; if (old) old.classList.remove('active');
      P.idx = i;
      const el = list.children[i];
      if (el) { el.classList.add('active'); scrollToActive(); }
      const c = cues[i];
      $('ovDe').innerHTML = c ? deHtml(c.de) : ''; $('ovDe').dataset.i = i;
      $('ovTr').textContent = c ? trText(i) : '';
      $('ovl').classList.remove('revealed');
      ensureTranslated();
    }
    const c = cues[P.idx];
    $('ovl').classList.toggle('stale', !c || t > c.e + 0.5);
    if (P.loop >= 0 && cues[P.loop] && t >= cues[P.loop].e) v.currentTime = cues[P.loop].s + P.offset;
  }

  function tick() {
    const v = vid();
    renderSubs(false);
    const d = v.duration;
    if (isFinite(d) && d > 0) {
      $('seek').value = Math.round((v.currentTime / d) * 1000);
      $('seek').style.setProperty('--p', ((v.currentTime / d) * 100).toFixed(2) + '%');
      $('tNow').textContent = fmtDur(v.currentTime); $('tAll').textContent = fmtDur(d);
    }
    if (!v.paused) P.raf = requestAnimationFrame(tick);
  }

  async function takeWake() { try { if (navigator.wakeLock) P.wake = await navigator.wakeLock.request('screen'); } catch (_) { /* izin yok */ } }
  function releaseWake() { try { if (P.wake) P.wake.release(); } catch (_) { /* boş */ } P.wake = null; }

  function showUI() {
    const p = $('playerView'); p.classList.add('ui');
    clearTimeout(P.hideT);
    if (!vid().paused) P.hideT = setTimeout(() => p.classList.remove('ui'), 3200);
  }

  function seekCue(dir) {
    const cues = P.rec.cues, v = vid(), t = v.currentTime - P.offset;
    const i = findCueIndex(cues, t);
    let target;
    if (dir < 0) target = (i >= 0 && t - cues[i].s > 1.5) ? i : Math.max(0, i - 1);
    else target = Math.min(cues.length - 1, i + 1);
    if (!cues[target]) return;
    v.currentTime = cues[target].s + P.offset;
    if (P.loop >= 0) P.loop = target;
    P.userScrollUntil = 0;
    renderSubs(true);
  }

  function bindPlayer() {
    const v = vid();
    v.addEventListener('play', () => { $('bPlay').classList.add('playing'); takeWake(); tick(); showUI(); });
    v.addEventListener('pause', () => { $('bPlay').classList.remove('playing'); releaseWake(); showUI(); tick(); if (P.rec) { P.rec.pos = v.currentTime; DB.put(P.rec).catch(() => {}); } });
    v.addEventListener('seeked', () => { renderSubs(true); tick(); });
    v.addEventListener('ended', () => { $('bPlay').classList.remove('playing'); });
    v.addEventListener('error', () => toast('Video oynatılamadı. Safari bu biçimi açamıyor olabilir.'));
    $('vwrap').addEventListener('click', () => { if ($('playerView').classList.contains('ui') && !v.paused) $('playerView').classList.remove('ui'); else showUI(); });
    $('bPlay').onclick = () => { v.paused ? v.play() : v.pause(); };
    $('bPrev').onclick = () => { seekCue(-1); showUI(); };
    $('bNext').onclick = () => { seekCue(1); showUI(); };
    $('bLoop').onclick = () => {
      if (P.loop >= 0) { P.loop = -1; $('bLoop').classList.remove('on'); }
      else {
        const i = findCueIndex(P.rec.cues, v.currentTime - P.offset);
        if (i < 0) return;
        P.loop = i; $('bLoop').classList.add('on');
        v.currentTime = P.rec.cues[i].s + P.offset; v.play();
      }
      showUI();
    };
    const speeds = [0.75, 1, 1.25, 1.5];
    $('bSpeed').onclick = () => {
      const k = (speeds.indexOf(v.playbackRate) + 1) % speeds.length;
      v.playbackRate = speeds[k]; $('bSpeed').textContent = speeds[k] + '×'; showUI();
    };
    $('seek').addEventListener('input', e => { if (v.duration) { v.currentTime = (e.target.value / 1000) * v.duration; P.userScrollUntil = 0; showUI(); } });
    $('pBack').onclick = closePlayer;
    const togglePop = () => { $('pop').hidden = !$('pop').hidden; showUI(); };
    $('pMenu').onclick = togglePop; $('bAa').onclick = togglePop;
    $('bBlur').onclick = () => { settings.blurTr = !settings.blurTr; saveSettings(); applyView(); };
    $('bFav').onclick = () => { P.favOnly = !P.favOnly; $('tlist').classList.toggle('favonly', P.favOnly); $('bFav').classList.toggle('on', P.favOnly); if (!P.favOnly) { P.userScrollUntil = 0; scrollToActive(); } };
    $('bAll').onclick = () => { if (P.rec) { const rec = P.rec; closePlayer().then(() => translateAll(rec)); } };
    $('szMinus').onclick = () => { settings.fontSize = Math.max(14, settings.fontSize - 2); saveSettings(); applyView(); };
    $('szPlus').onclick = () => { settings.fontSize = Math.min(40, settings.fontSize + 2); saveSettings(); applyView(); };
    $('offMinus').onclick = () => { P.offset = Math.round((P.offset - 0.2) * 10) / 10; applyView(); renderSubs(true); };
    $('offPlus').onclick = () => { P.offset = Math.round((P.offset + 0.2) * 10) / 10; applyView(); renderSubs(true); };
    $('swDe').onchange = e => { settings.showDe = e.target.checked; saveSettings(); applyView(); };
    $('swTr').onchange = e => { settings.showTr = e.target.checked; saveSettings(); applyView(); };
    $('swBlur').onchange = e => { settings.blurTr = e.target.checked; saveSettings(); applyView(); };
    $('ovDe').addEventListener('click', e => {
      const wEl = e.target.closest('.w');
      if (wEl) { e.stopPropagation(); openWord(wEl.textContent, Number($('ovDe').dataset.i)); }
    });
    $('ovTr').addEventListener('click', () => { if (settings.blurTr) $('ovl').classList.toggle('revealed'); });

    const list = $('tlist');
    ['touchstart', 'wheel', 'pointerdown'].forEach(ev => list.addEventListener(ev, () => { P.userScrollUntil = Date.now() + 4500; }, { passive: true }));
    list.addEventListener('click', e => {
      const wEl = e.target.closest('.w');
      if (wEl) { const cueEl = wEl.closest('.cue'); if (cueEl) openWord(wEl.textContent, Number(cueEl.dataset.i)); return; }
      const heart = e.target.closest('[data-heart]');
      if (heart) {
        const i = Number(heart.dataset.heart), rec = P.rec;
        rec.fav = rec.fav || {};
        if (rec.fav[i]) delete rec.fav[i]; else rec.fav[i] = 1;
        heart.closest('.cue').classList.toggle('fav', !!rec.fav[i]);
        DB.put(rec).catch(() => {});
        return;
      }
      const tr = e.target.closest('.tr');
      if (tr && settings.blurTr) { tr.classList.toggle('revealed'); return; }
      const cue = e.target.closest('.cue');
      if (cue) {
        const c = P.rec.cues[Number(cue.dataset.i)];
        v.currentTime = c.s + P.offset; P.userScrollUntil = 0;
        if (v.paused) v.play();
      }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !vid().paused) takeWake(); });
  }

  /* ---------- Bölüm 5: kelime defteri, kelime anlamı, tekrar kartları ---------- */
  let words = [];
  const lookups = new Map();
  const wordId = s => String(s).trim().toLowerCase();
  async function loadWords() { try { words = await DB.allWords(); } catch (_) { words = []; } updateDue(); }
  function updateDue() {
    const n = words.filter(w => isDue(w, Date.now())).length, b = $('dueBadge');
    if (b) { b.textContent = n; b.hidden = !n; }
  }
  function speak(text) {
    try {
      const u = new SpeechSynthesisUtterance(text); u.lang = 'de-DE'; u.rate = 0.85;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch (_) { toast('Bu cihaz sesli okumayı desteklemiyor.'); }
  }
  const artHtml = a => a ? `<span class="art art-${a}">${a}</span>` : '';
  function hlHtml(text, surfaces) {
    const set = new Set((surfaces || []).map(x => x.toLowerCase()));
    return tokenizeDe(text).map(p => p.w && set.has(p.t.toLowerCase()) ? '<mark>' + esc(p.t) + '</mark>' : esc(p.t)).join('');
  }

  const WORD_SYSTEM = 'You are a German-Turkish dictionary for a Turkish learner of German. Reply with exactly one JSON object and nothing else.';
  async function claudeWord(word, cue, key, model, signal) {
    const user = 'Sentence: "' + cue.de + '"\n' + (cue.tr ? 'Its Turkish translation: "' + cue.tr + '"\n' : '') + 'Tapped word: "' + word + '"\n\n' +
      'Return one JSON object with these keys (use "" when not applicable):\n' +
      '"lemma": dictionary form (nouns capitalised, singular; verbs in infinitive; if the tapped word belongs to a separable verb, give the full verb),\n' +
      '"pos": part of speech in Turkish (isim, fiil, sıfat, zarf, edat, bağlaç, zamir, ünlem, ...),\n' +
      '"article": der, die or das for nouns only,\n' +
      '"plural": plural form for nouns only,\n' +
      '"forms": for verbs: "er/sie/es Präsens · Präteritum · Partizip II" (e.g. "hilft · half · geholfen"),\n' +
      '"tr": Turkish meaning of the word AS USED in this sentence, 1 to 4 words,\n' +
      '"other": other common Turkish meanings, very short,\n' +
      '"note": one short useful tip in Turkish (separable verb, case it takes, idiom, false friend), at most one sentence.';
    const r = await fetchRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model, max_tokens: 500, system: WORD_SYSTEM, messages: [{ role: 'user', content: user }] })
    }, signal);
    const j = await r.json();
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    return { info: parseWordInfo(text), usage: { i: (j.usage && j.usage.input_tokens) || 0, o: (j.usage && j.usage.output_tokens) || 0 } };
  }

  async function openWord(word, idx) {
    const rec = P.rec; if (!rec) return;
    const cue = rec.cues[idx]; if (!cue) return;
    if (!settings.anthropic) {
      const v0 = vid(); v0.pause();
      openSettings('Kelime anlamı için Claude API anahtarı gerekli.'); return;
    }
    const v = vid(), wasPlaying = !v.paused; v.pause();
    const lc = word.toLowerCase(), ckey = rec.id + '|' + idx + '|' + lc;
    const ctl = new AbortController();
    sheetClose = () => { ctl.abort(); if (wasPlaying && P.rec) v.play(); };
    let info = lookups.get(ckey) || null, note = '';
    const savedHere = words.find(w => w.src && w.src.vid === rec.id && w.src.cue === idx && (w.surface || []).includes(lc));
    if (!info && savedHere) info = { lemma: savedHere.de, pos: savedHere.pos, article: savedHere.article, plural: savedHere.plural, forms: savedHere.forms, tr: savedHere.tr, other: savedHere.other, note: savedHere.note };

    const paint = () => {
      const id = wordId(info.lemma || word);
      const isSaved = words.some(w => w.id === id);
      const meta = [info.pos, info.plural ? 'çoğul: ' + info.plural : ''].filter(Boolean).map(esc).join(' · ');
      openSheet(`
        <h2 class="wword">${artHtml(info.article)}${esc(info.lemma || word)}</h2>
        ${meta ? `<p class="meta">${meta}</p>` : ''}
        <p class="wmean">${esc(info.tr)}</p>
        ${info.forms ? `<p class="hint">${esc(info.forms)}</p>` : ''}
        ${info.other ? `<p class="hint">Diğer anlamlar: ${esc(info.other)}</p>` : ''}
        ${info.note ? `<p class="state">💡 ${esc(info.note)}</p>` : ''}
        ${note ? `<p class="state">${esc(note)}</p>` : ''}
        <p class="wctx">${hlHtml(cue.de, [lc])}</p>
        <div class="row"><button id="wSave" class="${isSaved ? 'ghost' : 'primary'}">${isSaved ? 'Defterden çıkar' : 'Deftere kaydet'}</button>
        <button id="wSpeak" class="ghost" aria-label="Sesli oku">🔊</button><button id="wClose" class="ghost">Kapat</button></div>`, b => {
        b.querySelector('#wClose').onclick = closeSheet;
        b.querySelector('#wSpeak').onclick = () => speak(info.lemma || word);
        b.querySelector('#wSave').onclick = async () => {
          try {
            if (isSaved) {
              await DB.delWord(id); words = words.filter(w => w.id !== id); toast('Defterden çıkarıldı.');
            } else {
              const now = Date.now();
              const w = { id, de: info.lemma || word, article: info.article, pos: info.pos, plural: info.plural, forms: info.forms, tr: info.tr, other: info.other, note: info.note,
                surface: [lc], ex: cue.de, exTr: cue.tr || '', src: { vid: rec.id, cue: idx, t: cue.s, name: rec.name }, createdAt: now, due: now, step: 0, reps: 0, lapses: 0 };
              await DB.putWord(w); words.push(w); toast('Deftere kaydedildi.');
            }
            updateDue(); paint();
          } catch (e) { toast('Kaydedilemedi: ' + e.message); }
        };
      });
    };

    if (info) { paint(); return; }
    openSheet(`<h2 class="wword">${esc(word)}</h2><p class="state">Anlamı bulunuyor…</p><div class="row"><button id="wClose" class="ghost">Kapat</button></div>`, b => { b.querySelector('#wClose').onclick = closeSheet; });
    try {
      const res = await claudeWord(word, cue, settings.anthropic, settings.model, ctl.signal);
      rec.usage = rec.usage || { i: 0, o: 0 }; rec.usage.i += res.usage.i; rec.usage.o += res.usage.o;
      DB.put(rec).catch(() => {});
      if (!res.info) throw new Error('Cevap okunamadı. Tekrar dene.');
      info = res.info; lookups.set(ckey, info); paint();
    } catch (e) {
      if (e.name === 'AbortError') return;
      const old = words.find(w => (w.surface || []).includes(lc) || wordId(w.de) === lc);
      if (old) {
        info = { lemma: old.de, pos: old.pos, article: old.article, plural: old.plural, forms: old.forms, tr: old.tr, other: old.other, note: old.note };
        note = 'İnternet yok. Defterdeki kayıtlı anlam gösteriliyor, bu cümledeki anlamı farklı olabilir.'; paint();
      } else {
        openSheet(`<h2 class="wword">${esc(word)}</h2><p class="state err">${esc(explain(e))}</p><div class="row"><button id="wClose" class="ghost">Kapat</button></div>`, b => { b.querySelector('#wClose').onclick = closeSheet; });
      }
    }
  }

  /* --- defter ekranı --- */
  let wTab = 'w', openWordId = '';
  function showView(name) {
    $('libraryView').hidden = name !== 'library';
    $('wordsView').hidden = name !== 'words';
    if (name === 'words') renderWords();
    if (name === 'library') updateDue();
  }
  function dueText(w) {
    const d = (w.due || 0) - Date.now();
    if (d <= 0) return 'tekrar zamanı';
    if (d < 36e5) return Math.ceil(d / 6e4) + ' dk sonra';
    if (d < 864e5) return Math.ceil(d / 36e5) + ' saat sonra';
    return Math.ceil(d / 864e5) + ' gün sonra';
  }
  function collectFavs() {
    const out = [];
    videos.forEach(rec => Object.keys(rec.fav || {}).forEach(k => {
      const c = rec.cues && rec.cues[k]; if (c) out.push({ vid: rec.id, name: rec.name, i: Number(k), c });
    }));
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.c.s - b.c.s);
  }
  function renderWords() {
    const favs = collectFavs(), q = $('wSearch').value.trim().toLowerCase();
    $('tabW').classList.toggle('on', wTab === 'w'); $('tabS').classList.toggle('on', wTab === 's');
    $('cntW').textContent = words.length; $('cntS').textContent = favs.length;
    const due = words.filter(w => isDue(w, Date.now())).length;
    $('btnReview').hidden = wTab !== 'w' || !words.length;
    $('btnReview').textContent = due ? 'Tekrar et (' + due + ')' : 'Şu an tekrar yok';
    $('btnReview').disabled = !due;
    let html = '', empty = '';
    if (wTab === 'w') {
      const list = words.filter(w => !q || (w.de + ' ' + w.tr + ' ' + (w.surface || []).join(' ')).toLowerCase().includes(q)).sort((a, b) => b.createdAt - a.createdAt);
      html = list.map(w => {
        const open = w.id === openWordId;
        const meta = [w.pos, w.plural ? 'çoğul: ' + w.plural : '', dueText(w)].filter(Boolean).map(esc).join(' · ');
        return `<article class="card wcard" data-id="${esc(w.id)}">
          <div class="wh"><b class="wde">${artHtml(w.article)}${esc(w.de)}</b><span class="wtr">${esc(w.tr)}</span></div>
          <p class="meta">${meta}</p>
          ${open ? `<p class="wctx">${hlHtml(w.ex, w.surface)}</p>${w.exTr ? `<p class="state">${esc(w.exTr)}</p>` : ''}
            ${w.forms ? `<p class="hint">${esc(w.forms)}</p>` : ''}${w.other ? `<p class="hint">Diğer anlamlar: ${esc(w.other)}</p>` : ''}${w.note ? `<p class="state">💡 ${esc(w.note)}</p>` : ''}
            <div class="row"><button data-wa="show" class="ghost">Videoda göster</button><button data-wa="speak" class="ghost" aria-label="Sesli oku">🔊</button><button data-wa="del" class="ghost danger">Sil</button></div>` : ''}
        </article>`;
      }).join('');
      empty = words.length ? (list.length ? '' : 'Eşleşen kelime yok.') : 'Henüz kelime yok. Videoyu izlerken Almanca bir kelimeye dokun, anlamı çıkınca "Deftere kaydet"e bas.';
    } else {
      const list = favs.filter(f => !q || (f.c.de + ' ' + (f.c.tr || '')).toLowerCase().includes(q));
      html = list.map(f => `<article class="card" data-vid="${esc(f.vid)}" data-i="${f.i}">
          <p class="wde">${esc(f.c.de)}</p><p class="wtr" style="text-align:left">${esc(f.c.tr || '')}</p>
          <p class="meta">${esc(f.name)} · ${fmtHMS(f.c.s)}</p>
          <div class="row"><button data-sa="show" class="ghost">Videoda göster</button><button data-sa="del" class="ghost danger">Çıkar</button></div>
        </article>`).join('');
      empty = favs.length ? (list.length ? '' : 'Eşleşen cümle yok.') : 'Henüz cümle yok. Videoda cümlenin yanındaki kalbe dokunursan burada toplanır.';
    }
    $('wList').innerHTML = html;
    $('wEmpty').textContent = empty; $('wEmpty').hidden = !empty;
  }
  function showInVideo(vidId, t) {
    if (!videos.some(v => v.id === vidId)) { toast('Bu video silinmiş.'); return; }
    openPlayer(vidId, { from: 'words', cueStart: t });
  }

  /* --- tekrar kartları --- */
  const R = { q: [], n: 0, done: 0, shown: false };
  function startReview() {
    const now = Date.now();
    R.q = words.filter(w => isDue(w, now)).sort((a, b) => (a.due || 0) - (b.due || 0)).slice(0, 30);
    R.n = R.q.length; R.done = 0; R.shown = false;
    if (!R.q.length) { toast('Şu an tekrar edilecek kelime yok.'); return; }
    $('reviewView').hidden = false; paintReview();
  }
  function paintReview() {
    const body = $('rBody'), act = $('rActions');
    $('rCount').textContent = R.done + ' / ' + R.n;
    const card = R.q[0];
    if (!card) {
      body.innerHTML = `<p class="rword">Tamam 🎉</p><p class="rctx">${R.n} kelime tekrar edildi.</p>`;
      act.innerHTML = '<button id="rEnd" class="primary show">Bitir</button>';
      $('rEnd').onclick = closeReview; $('rSpeak').hidden = true; return;
    }
    $('rSpeak').hidden = false;
    const ctx = `<p class="rctx">${hlHtml(card.ex, card.surface)}</p>`;
    if (!R.shown) {
      body.innerHTML = `<p class="rword">${esc(card.de)}</p>${ctx}<p class="hint">Anlamını ve artikelini düşün.</p>`;
      act.innerHTML = '<button id="rShow" class="primary show">Göster</button>';
      $('rShow').onclick = () => { R.shown = true; paintReview(); };
    } else {
      const meta = [card.pos, card.plural ? 'çoğul: ' + card.plural : ''].filter(Boolean).map(esc).join(' · ');
      body.innerHTML = `<p class="rword">${artHtml(card.article)}${esc(card.de)}</p>
        <p class="wmean">${esc(card.tr)}</p>${meta ? `<p class="meta">${meta}</p>` : ''}${card.forms ? `<p class="hint">${esc(card.forms)}</p>` : ''}
        ${ctx}${card.exTr ? `<p class="hint">${esc(card.exTr)}</p>` : ''}${card.note ? `<p class="state">💡 ${esc(card.note)}</p>` : ''}`;
      const now = Date.now();
      act.innerHTML = [['again', 'Bilmedim'], ['hard', 'Zordu'], ['good', 'Biliyordum']]
        .map(([g, label]) => `<button data-g="${g}">${label}<small>${intervalLabel(card, g, now)}</small></button>`).join('');
      act.querySelectorAll('[data-g]').forEach(b => { b.onclick = () => rate(b.dataset.g); });
    }
    body.scrollTop = 0;
  }
  function rate(grade) {
    const card = R.q.shift(); if (!card) return;
    Object.assign(card, nextReview(card, grade, Date.now()));
    DB.putWord(card).catch(() => toast('Kaydedilemedi.'));
    if (grade === 'again') R.q.push(card); else R.done++;
    R.shown = false; updateDue(); paintReview();
  }
  function closeReview() { $('reviewView').hidden = true; try { speechSynthesis.cancel(); } catch (_) { /* boş */ } renderWords(); updateDue(); }

  function bindWords() {
    $('btnWords').onclick = () => showView('words');
    $('wBack').onclick = () => showView('library');
    $('tabW').onclick = () => { wTab = 'w'; renderWords(); };
    $('tabS').onclick = () => { wTab = 's'; renderWords(); };
    $('wSearch').addEventListener('input', renderWords);
    $('btnReview').onclick = startReview;
    $('rClose').onclick = closeReview;
    $('rSpeak').onclick = () => { if (R.q[0]) speak(R.q[0].de); };
    $('wList').addEventListener('click', async e => {
      const art = e.target.closest('article'); if (!art) return;
      const wa = e.target.closest('[data-wa]'), sa = e.target.closest('[data-sa]');
      if (sa) {
        const id = art.dataset.vid, i = Number(art.dataset.i), rec = videos.find(v => v.id === id); if (!rec) return;
        if (sa.dataset.sa === 'show') showInVideo(id, rec.cues[i].s);
        else { try { delete rec.fav[i]; await DB.put(rec); } catch (err) { toast('Kaydedilemedi: ' + err.message); } renderWords(); }
        return;
      }
      const w = words.find(x => x.id === art.dataset.id); if (!w) return;
      if (wa) {
        if (wa.dataset.wa === 'show') showInVideo(w.src.vid, w.src.t);
        else if (wa.dataset.wa === 'speak') speak(w.de);
        else if (wa.dataset.wa === 'del') {
          openSheet(`<h2>Silinsin mi?</h2><p>"${esc(w.de)}" defterden silinir.</p>
            <div class="row"><button id="dYes" class="primary danger">Sil</button><button id="dNo" class="ghost">Vazgeç</button></div>`, bb => {
            bb.querySelector('#dNo').onclick = closeSheet;
            bb.querySelector('#dYes').onclick = async () => { closeSheet(); await DB.delWord(w.id).catch(() => {}); words = words.filter(x => x.id !== w.id); openWordId = ''; renderWords(); updateDue(); };
          });
        }
        return;
      }
      openWordId = openWordId === w.id ? '' : w.id; renderWords();
    });
  }

  /* ---------- Bölüm 6: Google Drive eşitleme ---------- */
  const GSCOPE = 'https://www.googleapis.com/auth/drive.file';
  const GFOLDER = 'Çift Altyazı', GMETA = 'ciftaltyazi-meta.json', CHUNK = 8 * 1024 * 1024;
  const G = { token: '', exp: 0 };
  let syncing = false;

  function syncVisibility() { const b = $('btnSync'); if (b) b.hidden = !settings.gClient; }
  function setSync(t) { const e = $('syncState'); if (e) { e.textContent = t || ''; e.hidden = !t; } }

  function loadGis() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
    return new Promise((res, rej) => {
      const msg = 'Google\'a ulaşılamadı. İnternet açık mı?';
      const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      const t = setTimeout(() => rej(new Error(msg)), 10000);
      s.onload = () => { clearTimeout(t); res(); };
      s.onerror = () => { clearTimeout(t); rej(new Error(msg)); };
      document.head.appendChild(s);
    });
  }
  function gAuth() {
    if (G.token && Date.now() < G.exp - 60000) return Promise.resolve(G.token);
    if (!settings.gClient) return Promise.reject(new Error('Önce Ayarlar\'a Google Drive istemci kimliğini gir.'));
    return new Promise((res, rej) => {
      loadGis().then(() => {
        const client = window.google.accounts.oauth2.initTokenClient({
          client_id: settings.gClient, scope: GSCOPE,
          callback: r => {
            if (r.error) rej(new Error('Google girişi olmadı: ' + (r.error_description || r.error)));
            else { G.token = r.access_token; G.exp = Date.now() + (Number(r.expires_in) || 3600) * 1000; res(G.token); }
          },
          error_callback: e => rej(new Error('Google girişi iptal oldu ya da engellendi' + (e && e.type ? ' (' + e.type + ')' : '') + '.'))
        });
        client.requestAccessToken();
      }, rej);
    });
  }
  async function gFetch(token, url, init, signal) {
    const h = Object.assign({ Authorization: 'Bearer ' + token }, (init && init.headers) || {});
    try { return await fetchRetry(url, Object.assign({}, init, { headers: h }), signal); }
    catch (e) {
      if (/^401/.test(e.message)) { G.token = ''; throw new Error('Google oturumu bitti. Tekrar dene.'); }
      if (/^403/.test(e.message) && /accessNotConfigured|has not been used|Drive API/i.test(e.message)) throw new Error('Google Drive API açık değil. Kurulumda "Google Drive API"yi etkinleştir.');
      throw e;
    }
  }
  const gq = encodeURIComponent;
  async function gFolder(token) {
    const r = await gFetch(token, 'https://www.googleapis.com/drive/v3/files?fields=files(id)&q=' + gq("mimeType='application/vnd.google-apps.folder' and name='" + GFOLDER + "' and trashed=false"));
    const j = await r.json();
    if (j.files && j.files[0]) return j.files[0].id;
    const c = await gFetch(token, 'https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: GFOLDER, mimeType: 'application/vnd.google-apps.folder' }) });
    return (await c.json()).id;
  }
  async function gList(token, folderId) {
    const out = []; let page = '';
    do {
      const r = await gFetch(token, 'https://www.googleapis.com/drive/v3/files?pageSize=200&fields=' + gq('nextPageToken,files(id,name,size,mimeType)') +
        '&q=' + gq("'" + folderId + "' in parents and trashed=false") + (page ? '&pageToken=' + gq(page) : ''));
      const j = await r.json(); out.push(...(j.files || [])); page = j.nextPageToken || '';
    } while (page);
    return out;
  }
  async function gPutMeta(token, folderId, existingId, text) {
    if (existingId) {
      await gFetch(token, 'https://www.googleapis.com/upload/drive/v3/files/' + existingId + '?uploadType=media', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: text });
      return existingId;
    }
    const b = 'ca' + Math.random().toString(36).slice(2);
    const body = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name: GMETA, parents: [folderId] }) +
      '\r\n--' + b + '\r\nContent-Type: application/json\r\n\r\n' + text + '\r\n--' + b + '--';
    const r = await gFetch(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'content-type': 'multipart/related; boundary=' + b }, body });
    return (await r.json()).id;
  }

  async function gUpload(token, folderId, rec, file, onProgress, signal) {
    const mime = file.type || 'video/mp4';
    const init = await gFetch(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(file.size) },
      body: JSON.stringify({ name: rec.name, parents: [folderId], mimeType: mime })
    }, signal);
    const url = init.headers.get('Location');
    if (!url) throw new Error('Drive yükleme adresi verilmedi.');
    let off = 0;
    while (off < file.size) {
      const end = Math.min(off + CHUNK, file.size);
      let res, lastErr;
      for (let a = 0; a < 3; a++) {
        try {
          res = await fetch(url, { method: 'PUT', headers: { 'Content-Range': 'bytes ' + off + '-' + (end - 1) + '/' + file.size }, body: file.slice(off, end), signal });
          break;
        } catch (e) { if (e.name === 'AbortError') throw e; lastErr = e; await sleep(1500 * (a + 1), signal); }
      }
      if (!res) throw new Error('Bağlantı koptu: ' + (lastErr && lastErr.message));
      if (res.status === 200 || res.status === 201) { onProgress(1); return (await res.json()).id; }
      if (res.status === 308) { off = Math.max(off, Math.min(nextOffset(res.headers.get('Range'), end), end)); onProgress(off / file.size); continue; }
      if (res.status === 401) { G.token = ''; throw new Error('Google oturumu bitti. Tekrar dene.'); }
      throw new Error('Drive yüklemesi başarısız: ' + res.status);
    }
    throw new Error('Drive yüklemesi tamamlanmadı.');
  }

  async function gDownload(token, fileId, size, mime, onProgress, signal) {
    const url = 'https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media';
    const parts = []; let off = 0;
    try {
      while (off < size) {
        const end = Math.min(off + CHUNK, size) - 1;
        const r = await gFetch(token, url, { headers: { Range: 'bytes=' + off + '-' + end } }, signal);
        const b = await r.blob(); if (!b.size) throw new Error('Boş parça geldi.');
        parts.push(b); off += b.size; onProgress(Math.min(1, off / size));
      }
    } catch (e) {
      if (e.name === 'AbortError' || off > 0 || !(e instanceof TypeError)) throw e;
      const r = await gFetch(token, url, {}, signal);
      parts.length = 0; parts.push(await r.blob()); onProgress(1);
    }
    return new Blob(parts, { type: mime || 'video/mp4' });
  }

  async function patchRec(id, fn) { const cur = await DB.get(id); if (!cur) return; fn(cur); await DB.put(cur); }

  function confirmUploads(list) {
    return new Promise(resolve => {
      let done = false;
      sheetClose = () => { if (!done) resolve(false); };
      const total = list.reduce((a, r) => a + (r.size || 0), 0);
      openSheet(`<h2>Drive'a yüklensin mi?</h2>
        <p>${list.length} video yüklenecek, toplam ${fmtSize(total)}:</p>
        <p class="hint">${list.map(r => esc(r.name)).join('<br>')}</p>
        <p class="hint">Yükleme internet harcar. Wi-Fi'da olduğundan emin ol. Yüklenirken uygulamayı açık tut.</p>
        <div class="row"><button id="cuYes" class="primary">Yükle</button><button id="cuNo" class="ghost">Şimdilik atla</button></div>`, b => {
        b.querySelector('#cuYes').onclick = () => { done = true; closeSheet(); resolve(true); };
        b.querySelector('#cuNo').onclick = closeSheet;
      });
    });
  }

  async function driveSync() {
    if (syncing) return;
    if (!settings.gClient) { openSettings('Önce Google Drive istemci kimliğini gir.'); return; }
    syncing = true; $('btnSync').disabled = true;
    try {
      setSync('Google\'a bağlanılıyor…');
      const token = await gAuth();
      setSync('Drive klasörü kontrol ediliyor…');
      const folderId = await gFolder(token);
      let files = await gList(token, folderId);
      const metaFile = files.find(f => f.name === GMETA);
      let added = '';
      if (metaFile) {
        setSync('Drive\'daki liste okunuyor…');
        const r = await gFetch(token, 'https://www.googleapis.com/drive/v3/files/' + metaFile.id + '?alt=media');
        let j = null; try { j = JSON.parse(await r.text()); } catch (_) { /* bozuk */ }
        if (validBackup(j)) { const m = await mergeBackup(j); added = m.addV ? m.addV + ' yeni video listeye eklendi. ' : ''; }
      }
      await refresh(); await loadWords();
      // Drive'daki dosyalarla eşleştir
      for (const rec of videos) {
        const f = files.find(x => x.name !== GMETA && x.name === rec.name && Number(x.size) === rec.size);
        if (f && (rec.driveId !== f.id || !rec.mime)) await patchRec(rec.id, c => { c.driveId = f.id; c.mime = f.mimeType || c.mime; });
      }
      await refresh();
      // bu cihazda olup Drive'da olmayanlar
      const ups = videos.filter(r => r.hasFile && !r.driveId);
      let uploaded = 0, failed = '';
      if (ups.length && await confirmUploads(ups)) {
        for (const rec of ups) {
          const file = await DB.getFile(rec.id).catch(() => null);
          if (!file) continue;
          const ctl = new AbortController();
          jobs.set(rec.id, { ctl, text: 'Drive\'a yükleniyor… %0', frac: 0 }); renderList();
          try {
            const id = await gUpload(token, folderId, rec, file, f => { const j = jobs.get(rec.id); if (j) { j.frac = f; j.text = 'Drive\'a yükleniyor… %' + Math.round(f * 100); renderList(); } }, ctl.signal);
            await patchRec(rec.id, c => { c.driveId = id; c.mime = file.type || 'video/mp4'; }); uploaded++;
          } catch (e) { if (e.name === 'AbortError') { failed = 'Yükleme durduruldu. '; break; } failed = 'Yükleme yarıda kaldı: ' + explain(e) + ' '; break; }
          finally { jobs.delete(rec.id); renderList(); }
        }
        await refresh();
      }
      setSync('Liste Drive\'a yazılıyor…');
      files = metaFile ? files : await gList(token, folderId);
      const mf = metaFile || files.find(f => f.name === GMETA);
      await gPutMeta(token, folderId, mf && mf.id, JSON.stringify(await buildBackup()));
      const away = videos.filter(r => !r.hasFile && r.driveId).length;
      toast(`${failed}Eşitlendi. ${added}${uploaded ? uploaded + ' video Drive\'a yüklendi. ' : ''}${away ? away + ' video bu cihazda yok, "Cihaza indir"e bas.' : ''}`.trim());
    } catch (e) { toast('Eşitlenemedi: ' + explain(e)); }
    finally { syncing = false; $('btnSync').disabled = false; setSync(''); await refresh(); }
  }

  async function driveDownload(rec, thenPlay) {
    if (jobs.has(rec.id)) return;
    let token;
    try { token = await gAuth(); } catch (e) { toast(explain(e)); return; }
    const ctl = new AbortController();
    jobs.set(rec.id, { ctl, text: 'Drive\'dan indiriliyor… %0', frac: 0 }); renderList();
    let ok = false;
    try {
      const blob = await gDownload(token, rec.driveId, rec.size, rec.mime, f => { const j = jobs.get(rec.id); if (j) { j.frac = f; j.text = 'Drive\'dan indiriliyor… %' + Math.round(f * 100); renderList(); } }, ctl.signal);
      if (blob.size !== rec.size) throw new Error('Dosya eksik indi (' + blob.size + ' / ' + rec.size + ' bayt). Tekrar dene.');
      await DB.putFile(rec.id, blob);
      await patchRec(rec.id, c => { c.hasFile = true; });
      ok = true; toast('Video bu cihaza indirildi.');
    } catch (e) { if (e.name !== 'AbortError') toast('İndirilemedi: ' + explain(e)); }
    finally { jobs.delete(rec.id); await refresh(); }
    if (ok && thenPlay) openPlayer(rec.id);
  }

  function init() {
    $('btnSettings').onclick = () => openSettings();
    const pick = $('filePick');
    $('btnAdd').onclick = () => pick.click();
    pick.onchange = e => { const f = e.target.files[0]; pick.value = ''; if (f) onFilePicked(f); };
    $('sheet').addEventListener('click', e => { if (e.target.id === 'sheet' && $('sheet').dataset.dismiss !== '0') closeSheet(); });
    $('list').addEventListener('click', async e => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const id = b.dataset.id, act = b.dataset.act;
      if (act === 'play') {
        const rec = videos.find(v => v.id === id);
        if (rec && !rec.hasFile && rec.driveId && settings.gClient) {
          openSheet(`<h2>Video bu cihazda yok</h2><p class="fname">${esc(rec.name)}</p><p class="meta">Drive'da duruyor · ${fmtSize(rec.size)}</p>
            <p class="hint">İndirmek internet harcar, Wi-Fi'da olduğundan emin ol.</p>
            <div class="row"><button id="pDl" class="primary">Drive'dan indir ve oynat</button><button id="pPick" class="ghost">Dosyadan seç</button><button id="pNo" class="ghost">Vazgeç</button></div>`, bb => {
            bb.querySelector('#pNo').onclick = closeSheet;
            bb.querySelector('#pPick').onclick = () => { closeSheet(); openPlayer(id); };
            bb.querySelector('#pDl').onclick = () => { closeSheet(); driveDownload(rec, true); };
          });
        } else openPlayer(id);
      }
      else if (act === 'dl') { const rec = videos.find(v => v.id === id); if (rec) driveDownload(rec, false); }
      else if (act === 'cancel') { const j = jobs.get(id); if (j) j.ctl.abort(); }
      else if (act === 'all') { const rec = await DB.get(id); if (rec) translateAll(rec); }
      else if (act === 'del') {
        const rec = videos.find(v => v.id === id);
        openSheet(`<h2>Silinsin mi?</h2><p>"${esc(rec ? rec.name : '')}" ve altyazıları telefondan silinir.</p>
          <div class="row"><button id="dYes" class="primary danger">Sil</button><button id="dNo" class="ghost">Vazgeç</button></div>`, bb => {
          bb.querySelector('#dNo').onclick = closeSheet;
          bb.querySelector('#dYes').onclick = async () => { closeSheet(); await DB.del(id); await refresh(); };
        });
      }
    });
    bindPlayer();
    bindWords();
    $('btnSync').onclick = driveSync;
    syncVisibility();
    if (settings.gClient) loadGis().catch(() => {});
    applyView();
    refresh();
    loadWords();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) { /* boş */ }
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  document.addEventListener('DOMContentLoaded', init);
})();
