/* YouTube altyazı sunucusu (Cloudflare Worker). DENENMEMİŞ, bu yüzden isteğe bağlı.
 *
 * Kurulum: dash.cloudflare.com → Workers & Pages → Create → Hello World → Deploy,
 * sonra Edit code → bu dosyanın içeriğini yapıştır → Deploy.
 * Verilen adresi (https://ad.hesap.workers.dev) uygulamada Ayarlar → "YouTube altyazı sunucusu adresi" alanına yaz.
 *
 * Kullanım: GET /?v=VIDEO_ID&lang=de  →  { lang, kind, cues: [{ s, e, text }] }
 *
 * Uyarı: YouTube, bulut sunucu adreslerinden gelen istekleri sık sık "bot" diye reddeder.
 * Hata verirse uygulamada altyazı metnini yapıştırma ya da .srt/.vtt dosyası yolunu kullan.
 */
export default {
  async fetch(req) {
    const u = new URL(req.url);
    const v = u.searchParams.get('v');
    const lang = (u.searchParams.get('lang') || 'de').toLowerCase();
    const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json; charset=utf-8' };
    const fail = (status, error) => new Response(JSON.stringify({ error }), { status, headers: head });
    if (!/^[A-Za-z0-9_-]{11}$/.test(v || '')) return fail(400, 'Geçersiz video kimliği.');

    try {
      const pr = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
          'x-youtube-client-name': '3',
          'x-youtube-client-version': '20.10.38'
        },
        body: JSON.stringify({
          context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34, hl: 'en', gl: 'US' } },
          videoId: v
        })
      });
      if (!pr.ok) return fail(502, 'YouTube yanıt vermedi (' + pr.status + ').');
      const info = await pr.json();
      const status = info.playabilityStatus && info.playabilityStatus.status;
      if (status && status !== 'OK') {
        return fail(403, 'YouTube bu isteği reddetti: ' + (info.playabilityStatus.reason || status));
      }
      const tracks = (((info.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks) || [];
      if (!tracks.length) return fail(404, 'Bu videoda altyazı yok.');

      const manual = tracks.find(t => t.languageCode === lang && t.kind !== 'asr');
      const auto = tracks.find(t => t.languageCode === lang);
      const track = manual || auto || tracks[0];

      const cr = await fetch(track.baseUrl + '&fmt=json3');
      if (!cr.ok) return fail(502, 'Altyazı dosyası alınamadı (' + cr.status + ').');
      const data = await cr.json();

      const cues = [];
      for (const ev of data.events || []) {
        if (!ev.segs) continue;
        const text = ev.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const s = (ev.tStartMs || 0) / 1000;
        cues.push({ s, e: s + (ev.dDurationMs || 3000) / 1000, text });
      }
      if (!cues.length) return fail(404, 'Altyazı boş geldi.');
      return new Response(JSON.stringify({ lang: track.languageCode, kind: track.kind || 'manual', cues }), { headers: head });
    } catch (e) {
      return fail(500, 'Sunucu hatası: ' + e.message);
    }
  }
};
