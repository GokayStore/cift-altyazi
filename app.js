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
  if (dur <= 7 && tokens.join(' ').length <= 84) return [{ s: start, e: end, de: tokens.join(' ') }];
  const ranges = pieceRanges(tokens);
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
function normalizeCues(raw) {
  const out = [];
  for (const c of raw) {
    const text = String(c.text || c.de || '').replace(/\s+/g, ' ').trim();
    if (!text || !isFinite(c.s)) continue;
    const e = isFinite(c.e) && c.e > c.s ? c.e : c.s + 3;
    for (const p of splitCue(text, c.s, e)) out.push(p);
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
  const cues = [];
  let cur = null;
  const only = /^((?:\d+:)?\d{1,2}:\d{2})$/;
  const inline = /^((?:\d+:)?\d{1,2}:\d{2})\s+(\S.*)$/;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = line.match(only))) { cur = { s: parseTimeStr(m[1]), text: '' }; cues.push(cur); }
    else if ((m = line.match(inline))) { cur = { s: parseTimeStr(m[1]), text: m[2] }; cues.push(cur); }
    else if (cur) cur.text += (cur.text ? ' ' : '') + line;
  }
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pieceRanges, splitCue, fixCues, normalizeCues, parseTimeStr, parseSubtitleFile, parsePasted, youtubeId, parseTranslation, findCueIndex, usageCost, fmtDur, fmtHMS, fmtMoney };
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
        const r = indexedDB.open('cift-altyazi', 1);
        r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('videos', { keyPath: 'id' }); d.createObjectStore('files'); };
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
      del: async id => { await tx('videos', 'readwrite', s => s.delete(id)); await tx('files', 'readwrite', s => s.delete(id)); }
    };
  })();

  const SKEY = 'ciftaltyazi.ayar.v2';
  const defaults = { anthropic: '', model: 'claude-haiku-5-5', proxy: '', fontSize: 22, showDe: true, showTr: true, blurTr: false };
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
      if (rec.usage && (rec.usage.i || rec.usage.o)) meta.push('maliyet ' + fmtMoney(usageCost(rec.usage, rec.model)));
      let body;
      if (job) {
        body = `<div class="bar"><i style="width:${Math.round((job.frac || 0) * 100)}%"></i></div><p class="state">${esc(job.text)}</p>
                <div class="row"><button data-act="cancel" data-id="${rec.id}" class="ghost">Durdur</button></div>`;
      } else {
        body = `${!rec.hasFile ? '<p class="state">Video uygulamaya kaydedilemedi. Oynatırken dosyayı seçeceksin.</p>' : ''}
                <div class="row"><button data-act="play" data-id="${rec.id}" class="primary">Oynat</button>
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
      <p class="hint">Anahtar yalnızca bu telefonda saklanır ve doğrudan Anthropic'e gönderilir. Sunucu adresi boşsa YouTube linki yerine altyazı metnini yapıştırırsın.</p>
      <div class="row"><button id="sSave" class="primary">Kaydet</button><button id="sCancel" class="ghost">Kapat</button></div>`, b => {
      b.querySelector('#sSave').onclick = () => {
        settings.anthropic = b.querySelector('#kAnth').value.trim();
        settings.model = b.querySelector('#kModel').value;
        settings.proxy = b.querySelector('#kProxy').value.trim().replace(/\/+$/, '');
        saveSettings(); closeSheet(); toast('Kaydedildi.');
      };
      b.querySelector('#sCancel').onclick = closeSheet;
    });
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
    const existing = await DB.get(id).catch(() => null);
    if (existing) { toast('Bu video zaten ekli.'); return openPlayer(id); }
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
    return askFile('"' + rec.name + '" uygulamaya kaydedilmemiş. Aynı videoyu Dosyalar\'dan bir kez seç.');
  }

  /* --- oynatıcı --- */
  const P = { rec: null, url: '', idx: -1, loop: -1, raf: 0, offset: 0, wake: null, hideT: 0, userScrollUntil: 0, favOnly: false };
  const vid = () => $('vid');

  function buildList() {
    const rec = P.rec;
    $('tlist').innerHTML = rec.cues.map((c, i) => `
      <div class="cue${rec.fav && rec.fav[i] ? ' fav' : ''}" data-i="${i}">
        <div class="cmeta"><span class="ts">${fmtHMS(c.s)}</span><button class="heart" data-heart="${i}" aria-label="Cümleyi kaydet"><svg viewBox="0 0 24 24"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.5 8 3.6 5 6.7 5c2 0 3.4 1 5.3 3 1.9-2 3.3-3 5.3-3 3.1 0 5.2 3 4 6.3-1.8 4.6-9.3 9.2-9.3 9.2z"/></svg></button></div>
        <p class="de">${esc(c.de)}</p><p class="tr">${esc(c.tr || '')}</p>
      </div>`).join('');
  }
  function trText(i) { const c = P.rec.cues[i]; return c.tr || (TR.pending.has(i) ? '…' : ''); }
  function setCueText(i) {
    if (!P.rec) return;
    const el = $('tlist').children[i];
    if (el) el.querySelector('.tr').textContent = trText(i);
    if (i === P.idx) $('ovTr').textContent = trText(i);
  }

  async function openPlayer(id) {
    const rec = await DB.get(id);
    if (!rec) return;
    const blob = await getBlob(rec);
    if (!blob) return;
    P.rec = rec; P.idx = -1; P.loop = -1; P.offset = rec.offset || 0; P.favOnly = false;
    rec.fav = rec.fav || {};
    TR.pending.clear(); TR.cool = 0;
    if (P.url) URL.revokeObjectURL(P.url);
    P.url = URL.createObjectURL(blob);
    buildList();
    const v = vid();
    v.src = P.url; v.playbackRate = 1; $('bSpeed').textContent = '1×';
    $('pTitle').textContent = rec.name;
    $('playerView').hidden = false; $('libraryView').hidden = true;
    document.body.classList.add('playing');
    $('bLoop').classList.remove('on'); $('tlist').classList.remove('favonly'); $('bFav').classList.remove('on');
    applyView(); showUI(); renderSubs(true); tick();
    if (rec.pos) v.addEventListener('loadedmetadata', () => { v.currentTime = rec.pos; }, { once: true });
  }

  async function closePlayer() {
    const v = vid();
    if (P.rec) { P.rec.pos = v.currentTime; P.rec.offset = P.offset; DB.put(P.rec).catch(() => {}); }
    v.pause(); cancelAnimationFrame(P.raf); releaseWake();
    v.removeAttribute('src'); v.load();
    if (P.url) { URL.revokeObjectURL(P.url); P.url = ''; }
    $('playerView').hidden = true; $('libraryView').hidden = false;
    document.body.classList.remove('playing');
    $('pop').hidden = true;
    P.rec = null;
    refresh();
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
      $('ovDe').textContent = c ? c.de : '';
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
    $('ovTr').addEventListener('click', () => { if (settings.blurTr) $('ovl').classList.toggle('revealed'); });

    const list = $('tlist');
    ['touchstart', 'wheel', 'pointerdown'].forEach(ev => list.addEventListener(ev, () => { P.userScrollUntil = Date.now() + 4500; }, { passive: true }));
    list.addEventListener('click', e => {
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

  function init() {
    $('btnSettings').onclick = () => openSettings();
    const pick = $('filePick');
    $('btnAdd').onclick = () => pick.click();
    pick.onchange = e => { const f = e.target.files[0]; pick.value = ''; if (f) onFilePicked(f); };
    $('sheet').addEventListener('click', e => { if (e.target.id === 'sheet' && $('sheet').dataset.dismiss !== '0') closeSheet(); });
    $('list').addEventListener('click', async e => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const id = b.dataset.id, act = b.dataset.act;
      if (act === 'play') openPlayer(id);
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
    applyView();
    refresh();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) { /* boş */ }
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  document.addEventListener('DOMContentLoaded', init);
})();
