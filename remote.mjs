/**
 * remote.mjs — «مرورگر تصویری (ریموت)» — ماژول مشترک ورکر کلودفلر و سرور نود
 *
 * ایده: سرور آدرس را باز می‌کند، از صفحه عکس می‌گیرد (با زنجیره‌ی سرویس‌های
 * عکس‌گیر رایگان + کش)، و همه‌ی لینک‌های صفحه را به‌ترتیبِ ظاهرشدن شماره‌گذاری
 * می‌کند. کاربر شماره‌ی لینک دلخواه را در کادر زیر عکس می‌زند → همان لینک
 * باز و عکسش برمی‌گردد. مثل یک «ریموت» برای وب.
 *
 * نکته‌ی صادقانه: خودِ ورکر کلودفلر (پلن رایگان) مرورگر ندارد و نمی‌تواند
 * رندر بگیرد؛ عکس‌ها را سرویس‌های خارجی رایگان می‌گیرند:
 *   ۱) mshots (وردپرس) — سریع، ولی آدرس تازه تا چند ثانیه عکس جای‌نگهدار می‌دهد
 *      (تشخیص: image/gif یا حجم < ۱۲KB → تلاش مجدد با فاصله)
 *   ۲) thum.io — پشتیبان اول، fullpage هم دارد
 *   ۳) microlink — پشتیبان آخر (بعضی وقت‌ها 429 می‌دهد)
 *
 * مسیرها: GET /remote (صفحه) · GET /api/nav?url= (JSON لینک‌ها) · GET /shot?url=&full=
 */

import { UA, isBlockedHost, normalizeTarget } from './lib.mjs';

/* ---------------------------- ابزارهای کوچک ---------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tSignal(ms) {
  // AbortSignal.timeout همیشه موجود نیست (Node قدیمی) — کنترلر دستی امن‌تر است
  try {
    const ac = new AbortController();
    const t = setTimeout(() => { try { ac.abort(); } catch (_) {} }, ms);
    if (typeof t === 'object' && t && typeof t.unref === 'function') t.unref();
    return ac.signal;
  } catch (_) { return undefined; }
}

function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

function textResp(msg, status) {
  return new Response(msg, {
    status: status || 400,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

/* --- رمزگشایی موجودیت‌های HTML و تمیزکردن متن --- */

const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', zwnj: '\u200c',
  lrm: '', rlm: '', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', times: '×', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d',
};

function decodeEnt(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return ' '; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (_) { return ' '; } })
    .replace(/&([a-z][a-z0-9]*);/gi, (m, n) => (n in ENT ? ENT[n] : ' '));
}

function cleanText(s) {
  return decodeEnt(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/[\s\u00a0\u200f\u200e]+/g, ' ').trim();
}

/* --- مقصد امن (SSRF): فقط http/https عمومی، بدون userinfo --- */

function safeTarget(raw) {
  const t = normalizeTarget(String(raw || '').trim());
  if (!t || t.length > 2000) return null;
  let u;
  try { u = new URL(t); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (isBlockedHost(u.hostname)) return null;
  return u.href;
}

/* ---------------------- استخراج عنوان/لینک/متن از HTML ---------------------- */

const MAX_LINKS = 200;

export function extractNav(html, baseUrl) {
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = cleanText(tm ? tm[1] : '').slice(0, 120);

  const links = [];
  const seen = new Set();
  const are = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = are.exec(html)) !== null && links.length < MAX_LINKS) {
    const attrs = m[1];
    const inner = m[2];
    const hm = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/i.exec(attrs);
    if (!hm) continue;
    let href = (hm[1] !== undefined ? hm[1] : hm[2] !== undefined ? hm[2] : hm[3]) || '';
    href = decodeEnt(href).trim();
    if (!href || href.length > 1800) continue;
    let abs;
    try { abs = new URL(href, baseUrl).href; } catch (_) { continue; }
    if (seen.has(abs) || abs === baseUrl) continue;
    let pu;
    try { pu = new URL(abs); } catch (_) { continue; }
    if ((pu.protocol !== 'http:' && pu.protocol !== 'https:') || pu.username || pu.password) continue;
    if (isBlockedHost(pu.hostname)) continue;
    // لینکِ فقط-لنگر (#top) و لینک به خودِ صفحه برای «ریموت» بی‌فایده است
    try {
      if (pu.href.split('#')[0] === new URL(baseUrl).href.split('#')[0]) continue;
    } catch (_) { /* بی‌اهمیت */ }
    seen.add(abs);
    let t = cleanText(inner);
    if (!t) {
      const am = /(?:aria-label|title|alt)\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
      if (am) t = cleanText(am[1] !== undefined ? am[1] : am[2]);
    }
    if (!t) t = pu.hostname.replace(/^www\./, '') + (pu.pathname && pu.pathname !== '/' ? ' — ' + decodeEnt(pu.pathname).slice(0, 40) : '');
    links.push({ n: links.length + 1, u: abs, t: t.slice(0, 90) });
  }

  // متن صفحه (برای حالتِ عکس‌نیامدن / خواندن و کپی)
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const hm2 = /<head[\s\S]*?<\/head>/i.exec(body);
  if (hm2) body = body.replace(hm2[0], ' ');
  const text = cleanText(body).slice(0, 1600);

  return { title, links, text };
}

/* ------------------------- دریافت صفحه + ریدایرکت‌ها ------------------------- */

const NAV_TIMEOUT = 20000;
const NAV_HOPS = 6;
const NAV_MAX_BYTES = 3 * 1024 * 1024;

export async function navInfo(raw) {
  const t0 = Date.now();
  const target = safeTarget(raw);
  if (!target) return { ok: false, error: 'آدرس نامعتبر است — فقط http/https از سایت‌های عمومی.', ms: 0 };

  let u = target;
  let resp = null;
  let err = '';

  for (let hop = 0; hop <= NAV_HOPS; hop++) {
    const safe = safeTarget(u); // هر پرشِ ریدایرکت هم از نظر SSRF چک می‌شود
    if (!safe) { err = 'مقصد ریدایرکت مجاز نیست.'; break; }
    u = safe;
    let r;
    try {
      r = await fetch(u, {
        redirect: 'manual',
        headers: {
          'user-agent': UA,
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'fa,fa-IR;q=0.9,en;q=0.8',
        },
        signal: tSignal(NAV_TIMEOUT),
      });
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
      err = aborted ? 'پاسخ سایت بیش از ۲۰ ثانیه طول کشید.' : 'اتصال به سایت برقرار نشد.';
      break;
    }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) { resp = r; break; }
      try { u = new URL(loc, u).href; } catch (_) { err = 'آدرس ریدایرکت خراب است.'; break; }
      continue;
    }
    resp = r;
    break;
  }

  if (!resp) return { ok: false, error: err || 'دریافت صفحه ممکن نشد.', url: target, ms: Date.now() - t0 };

  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  let buf;
  try { buf = await resp.arrayBuffer(); } catch (_) { return { ok: false, error: 'بدنه‌ی پاسخ خوانده نشد.', url: target, ms: Date.now() - t0 }; }
  if (buf.byteLength > NAV_MAX_BYTES) buf = buf.slice(0, NAV_MAX_BYTES);

  // رمزگشایی: اول charset از هدر، بعد از <meta>
  const td = (enc) => { try { return new TextDecoder(enc, { fatal: false }).decode(buf); } catch (_) { return null; } };
  let cs = /charset=([\w-]+)/.exec(ct);
  let html = '';
  if (cs) html = td(cs[1]) || '';
  if (!html) {
    const probe = td('utf-8') || '';
    if (!cs) {
      const mm = /<meta[^>]+charset=["']?([\w-]+)/i.exec(probe.slice(0, 4000)) ||
                 /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(probe.slice(0, 4000));
      if (mm && !/^utf-?8$/i.test(mm[1])) html = td(mm[1]) || probe;
      else html = probe;
    } else html = probe;
  }

  const looksHtml = /text\/html|application\/xhtml|application\/xml|\+xml/.test(ct) || /<\s*(html|body|head|a[\s>]|meta|div)/i.test(html.slice(0, 6000));
  if (!looksHtml) {
    return {
      ok: true, url: target, finalUrl: u, title: '',
      links: [],
      text: 'این آدرس صفحه‌ی HTML نیست (نوع محتوا: ' + (ct || 'نامشخص') + '). اگر فایل قابل‌عکسباشد، عکسش نمایش داده می‌شود.',
      note: 'کد پاسخ: ' + resp.status,
      ms: Date.now() - t0,
    };
  }

  const nav = extractNav(html, u);
  return {
    ok: true,
    url: target,
    finalUrl: u,
    title: nav.title,
    links: nav.links,
    text: nav.text,
    note: (resp.status !== 200 ? 'کد پاسخ سایت: ' + resp.status : ''),
    ms: Date.now() - t0,
  };
}

/* --------------------------- عکس‌گیرها (زنجیره‌ی fallback) --------------------------- */

const MIN_REAL = 12000; // عکس جای‌نگهدار mshots حدود ۸.۷KB است — زیر این یعنی هنوز آماده نشده

const shotMem = new Map(); // کلید -> {buf, ct, src, at}
const SHOT_TTL = 10 * 60 * 1000;
const SHOT_MAX_ITEMS = 36;
const SHOT_MAX_BYTES = 24 * 1024 * 1024;
let shotBytes = 0;

function shotMemGet(k) {
  const v = shotMem.get(k);
  if (!v) return null;
  if (Date.now() - v.at > SHOT_TTL) { shotMem.delete(k); shotBytes -= v.buf.byteLength; return null; }
  return v;
}

function shotMemSet(k, v) {
  const old = shotMem.get(k);
  if (old) shotBytes -= old.buf.byteLength;
  while (shotMem.size >= SHOT_MAX_ITEMS || (shotBytes + v.buf.byteLength > SHOT_MAX_BYTES && shotMem.size)) {
    const first = shotMem.keys().next().value;
    shotBytes -= shotMem.get(first).buf.byteLength;
    shotMem.delete(first);
  }
  shotMem.set(k, v);
  shotBytes += v.buf.byteLength;
}

// کش edge کلودفلر — فقط در ورکر هست؛ در نود و تست، بی‌اثر
const EDGE = (typeof caches !== 'undefined' && caches && caches.default) ? caches.default : null;

function edgeKeyUrl(origin, k) {
  let h = 5381;
  for (let i = 0; i < k.length; i++) h = ((h << 5) + h + k.charCodeAt(i)) >>> 0;
  try { return new URL('/__shot/' + h.toString(16) + '.bin', origin).href; } catch (_) { return null; }
}

async function edgeGet(ku) {
  if (!EDGE || !ku) return null;
  try { const r = await EDGE.match(ku); if (r && r.ok) return r; } catch (_) {}
  return null;
}

async function edgePut(ku, buf, ct, src) {
  if (!EDGE || !ku) return;
  try {
    await EDGE.put(ku, new Response(buf, {
      headers: { 'content-type': ct, 'cache-control': 'public, max-age=600', 'x-shot-src': src },
    }));
  } catch (_) {}
}

async function tryMShots(target, full) {
  const u = 'https://s0.wp.com/mshots/v1/' + encodeURIComponent(target) + (full ? '?w=900&h=2800' : '?w=900&h=1200');
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(u, {
        headers: { 'user-agent': UA, 'accept': 'image/avif,image/webp,image/png,image/jpeg,*/*' },
        redirect: 'follow',
        signal: tSignal(15000),
      });
      if (r.ok) {
        const ct = r.headers.get('content-type') || '';
        const buf = await r.arrayBuffer();
        if (!/gif/i.test(ct) && buf.byteLength >= MIN_REAL) {
          return { buf, ct: /^image\//i.test(ct) ? ct : 'image/jpeg', src: 'mshots' };
        }
      }
    } catch (_) { /* تلاش بعدی */ }
    if (i < 4) await sleep(800 + i * 600);
  }
  return null;
}

async function tryThum(target, full) {
  const u = 'https://image.thum.io/get/width/900/' + (full ? 'fullpage/' : 'crop/1350/') + 'noanimate/' + target;
  try {
    const r = await fetch(u, { headers: { 'user-agent': UA }, signal: tSignal(30000) });
    if (r.ok) {
      const ct = r.headers.get('content-type') || '';
      const buf = await r.arrayBuffer();
      if (buf.byteLength > 4000) return { buf, ct: /^image\//i.test(ct) ? ct : 'image/png', src: 'thum.io' };
    }
  } catch (_) {}
  return null;
}

async function tryMicrolink(target, full) {
  const u = 'https://api.microlink.io/?url=' + encodeURIComponent(target) + '&screenshot=true&meta=false' + (full ? '&screenshot.fullPage=true' : '');
  try {
    const r = await fetch(u, { headers: { 'user-agent': UA }, signal: tSignal(30000) });
    if (r.ok) {
      const j = await r.json();
      const su = j && j.data && j.data.screenshot && j.data.screenshot.url;
      if (su) {
        const r2 = await fetch(su, { signal: tSignal(30000) });
        if (r2.ok) {
          const ct = r2.headers.get('content-type') || 'image/jpeg';
          const buf = await r2.arrayBuffer();
          if (buf.byteLength > 4000) return { buf, ct: /^image\//i.test(ct) ? ct : 'image/jpeg', src: 'microlink' };
        }
      }
    }
  } catch (_) {}
  return null;
}

export async function shotImage(raw, full, origin) {
  const target = safeTarget(raw);
  if (!target) return { error: 400, msg: 'آدرس نامعتبر است.' };
  full = full ? 1 : 0;
  const k = target + '|' + full;

  const mc = shotMemGet(k);
  if (mc) return { buf: mc.buf, ct: mc.ct, src: mc.src, cached: 'mem' };

  const ku = edgeKeyUrl(origin || 'https://localhost', k);
  const ec = await edgeGet(ku);
  if (ec) {
    const buf = await ec.arrayBuffer();
    const ct = ec.headers.get('content-type') || 'image/jpeg';
    const src = ec.headers.get('x-shot-src') || 'edge';
    shotMemSet(k, { buf, ct, src, at: Date.now() });
    return { buf, ct, src, cached: 'edge' };
  }

  const chain = full ? [tryThum, tryMShots, tryMicrolink] : [tryMShots, tryThum, tryMicrolink];
  let out = null;
  for (const p of chain) {
    try { out = await p(target, full); } catch (_) { out = null; }
    if (out) break;
  }
  if (!out) return { error: 502, msg: 'هیچ عکس‌گیرِ پاسخگو نبود — کمی بعد دوباره امتحان کن.' };

  shotMemSet(k, { buf: out.buf, ct: out.ct, src: out.src, at: Date.now() });
  if (ku) await edgePut(ku, out.buf, out.ct, out.src);
  return { buf: out.buf, ct: out.ct, src: out.src, cached: 'miss' };
}

/* ------------------------------- مسیریابی ------------------------------- */

export function remotePage() {
  return new Response(REMOTE_HTML, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

/**
 * هندلر مشترک؛ اگر مسیر مالِ ما نبود null برمی‌گرداند.
 * @param {string} path مسیر decode شده (مثل /remote)
 * @param {URL} url شیء URL درخواست
 */
export async function handleRemote(path, url) {
  if (path === '/remote') return remotePage();

  if (path === '/api/nav') {
    const q = (url.searchParams.get('url') || '').trim();
    if (!q) return jsonResp({ ok: false, error: 'پارامتر url خالی است.' });
    const info = await navInfo(q);
    return jsonResp(info);
  }

  if (path === '/shot') {
    const q = (url.searchParams.get('url') || '').trim();
    if (!q) return textResp('پارامتر url خالی است.', 400);
    const full = url.searchParams.get('full') === '1';
    const out = await shotImage(q, full, url.origin);
    if (out.error) return textResp(out.msg, out.error);
    return new Response(out.buf, {
      status: 200,
      headers: {
        'content-type': out.ct,
        'cache-control': 'public, max-age=600',
        'x-shot-src': out.src,
        'x-shot-cache': out.cached || 'miss',
        'x-robots-tag': 'noindex',
      },
    });
  }

  return null;
}

/* --------------------------- صفحه‌ی رابط (فارسی، RTL) --------------------------- */

const REMOTE_HTML = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>مرورگر تصویری (ریموت)</title>
<link rel="icon" href="/favicon.ico">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%}
body{display:flex;flex-direction:column;background:#0b1220;color:#e7edf8;
  font-family:"Segoe UI",Tahoma,"Vazirmatn",sans-serif;font-size:14px;overflow:hidden}
#top{display:flex;align-items:center;gap:5px;padding:7px 10px;background:#0b1220;border-bottom:1px solid #1b2740}
.nbtn{width:34px;height:34px;border-radius:9px;border:0;background:transparent;color:#a9bcd9;
  cursor:pointer;font-size:15px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;font-family:inherit}
.nbtn:hover{background:#131f39;color:#e7edf8}
.nbtn.dis{opacity:.3;cursor:default}
.nbtn.dis:hover{background:transparent;color:#a9bcd9}
#addr{flex:1;min-width:60px;padding:9px 14px;border-radius:18px;border:1px solid #24334f;background:#0d1730;
  color:#e7edf8;font-size:13.5px;outline:none;direction:ltr;text-align:left;font-family:inherit;transition:border-color .15s}
#addr:focus{border-color:#38bdf8}
#bgo{padding:9px 17px;border-radius:18px;border:0;background:linear-gradient(135deg,#0ea5e9,#22d3ee);
  color:#04121f;font-weight:700;cursor:pointer;font-family:inherit;flex:0 0 auto;font-size:13.5px}
#bgo:hover{filter:brightness(1.1)}
#subbar{display:flex;align-items:center;gap:12px;padding:6px 13px;background:#080e1c;border-bottom:1px solid #1b2740;
  font-size:12px;color:#7f92b3}
.fl{display:flex;align-items:center;gap:6px;cursor:pointer;color:#c7d5ee;flex:0 0 auto;user-select:none}
#status{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#stage{flex:1;overflow:auto;padding:14px;scrollbar-width:thin}
#stage::-webkit-scrollbar{width:8px}
#stage::-webkit-scrollbar-thumb{background:#22304d;border-radius:4px}
/* --- خانه --- */
#landing{max-width:640px;margin:2vh auto 0;text-align:center}
.lgo{font-size:26px;font-weight:800;margin-bottom:4px}
.lgo span{color:#0ea5e9}
.lsub{color:#7f92b3;font-size:13px;margin-bottom:24px;line-height:2}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:11px;margin-bottom:22px}
.tile{display:flex;flex-direction:column;align-items:center;gap:8px;padding:13px 6px;border-radius:14px;
  background:rgba(17,26,46,.7);border:1px solid #1d2a44;cursor:pointer;color:#c7d5ee;font-size:11.5px;
  font-family:inherit;transition:transform .15s,border-color .15s}
.tile:hover{transform:translateY(-3px);border-color:#38bdf8;color:#fff}
.tile .ic{width:36px;height:36px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff}
.guide{margin-top:6px;text-align:right;background:rgba(13,23,48,.6);border:1px solid #1b2740;border-radius:12px;padding:13px 16px}
.guide b{color:#7dd3fc}
.guide li{margin:6px 22px 0;color:#8fa2c4;font-size:12.5px;line-height:2.1}
/* --- عکس --- */
#shotwrap{max-width:940px;margin:0 auto}
#shotbox{position:relative;border:1px solid #22304d;border-radius:14px;background:#0d1730;overflow:hidden;
  cursor:zoom-in;min-height:190px}
#shot{display:block;width:100%;min-height:190px;transition:opacity .35s}
.spin{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.spin:before{content:'';width:46px;height:46px;border-radius:50%;border:4px solid #1e2c4a;border-top-color:#38bdf8;
  animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
#shotmeta{margin:9px 4px 0;color:#8fa2c4;font-size:12.5px;text-align:center;word-break:break-word;line-height:1.9}
/* --- لینک‌ها --- */
h3{font-size:13.5px;color:#c7d5ee;margin:20px 2px 10px;display:flex;align-items:center;gap:8px}
#lcount{color:#5d7295;font-size:12px;font-weight:400}
#links{display:grid;grid-template-columns:repeat(auto-fill,minmax(235px,1fr));gap:8px}
.lnk{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:10px;background:#101a30;
  border:1px solid #1b2740;color:#c7d5ee;cursor:pointer;text-align:right;font-family:inherit;font-size:12.5px;min-width:0}
.lnk:hover{border-color:#38bdf8;color:#fff}
.lnk b{flex:0 0 auto;width:26px;height:26px;border-radius:8px;background:#1d2a44;color:#7dd3fc;
  display:inline-flex;align-items:center;justify-content:center;font-size:12.5px}
.lnk .lt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lnk .lu{flex:0 0 auto;max-width:36%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:#5d7295;font-size:10.5px;direction:ltr}
/* --- متن --- */
#textsec{margin-top:18px;border:1px solid #1b2740;border-radius:12px;background:#0d1730}
#textsec summary{padding:11px 14px;cursor:pointer;color:#c7d5ee;font-size:13px;user-select:none}
#textsec summary:hover{color:#fff}
#text{padding:2px 16px 16px;color:#a9bcd9;font-size:13px;line-height:2.1;white-space:pre-wrap;word-break:break-word}
/* --- کادر شماره (زیر عکس، همیشه‌نمایان) --- */
#numbar{display:flex;align-items:center;gap:8px;padding:9px 12px;background:#0e1729;border-top:1px solid #1b2740}
#numbar .lbl{color:#8fa2c4;font-size:12.5px;flex:0 0 auto}
#num{flex:1;min-width:60px;padding:11px 15px;border-radius:12px;border:1px solid #24334f;background:#0d1730;
  color:#e7edf8;font-size:15px;outline:none;text-align:center;font-family:inherit;transition:border-color .15s}
#num:focus{border-color:#38bdf8;box-shadow:0 0 0 3px rgba(56,189,248,.15)}
#bnum{padding:11px 20px;border-radius:12px;border:0;background:linear-gradient(135deg,#0ea5e9,#22d3ee);
  color:#04121f;font-weight:700;font-size:13.5px;cursor:pointer;font-family:inherit;flex:0 0 auto}
#bnum:hover{filter:brightness(1.1)}
/* --- بزرگ‌نمایی --- */
#zoom{position:fixed;inset:0;background:rgba(4,8,18,.94);z-index:50;overflow:auto;cursor:zoom-out;text-align:center}
#zoom img{max-width:none;width:100%;display:inline-block}
#zoom .zh{color:#7f92b3;font-size:12px;padding:9px;position:sticky;top:0;background:rgba(4,8,18,.9)}
@media(max-width:620px){
  .lnk .lu{display:none}
  #numbar .lbl{display:none}
  #stage{padding:10px}
  #links{grid-template-columns:1fr 1fr}
}
</style>
</head>
<body>
<header id="top">
  <button class="nbtn" id="bback" title="عقب">‹</button>
  <button class="nbtn" id="bfwd" title="جلو">›</button>
  <button class="nbtn" id="breload" title="بارگیری مجدد">⟳</button>
  <button class="nbtn" id="bhome" title="خانه">⌂</button>
  <input id="addr" placeholder="آدرس سایت یا جستجو…" autocomplete="off" spellcheck="false">
  <button id="bgo">برو</button>
</header>
<div id="subbar">
  <label class="fl"><input type="checkbox" id="full"> کل صفحه</label>
  <span id="status">آماده — آدرس را وارد کن یا یکی از کاشی‌ها را بزن</span>
</div>
<main id="stage">
  <div id="landing">
    <div class="lgo">مرورگر <span>تصویری</span></div>
    <div class="lsub">سرور سایت را باز می‌کند، از آن عکس می‌گیرد و لینک‌هایش را شماره‌گذاری می‌کند.<br>شماره‌ی لینک دلخواه را در کادرِ پایینِ صفحه بزن — مثل کنترل از راهِ دور.</div>
    <div class="tiles" id="tiles"></div>
    <div class="guide">
      <b>چطور کار می‌کند؟</b>
      <ul>
        <li>آدرس سایت را در نوار بالا وارد کن (یا متن جستجو — در بینگ جستجو می‌شود).</li>
        <li>عکس صفحه بالا می‌آید و همه‌ی لینک‌هایش زیرش با <b>شماره</b> فهرست می‌شوند.</li>
        <li>شماره‌ی لینک دلخواه (مثلاً ۳ یا ۱۲) را در کادر سفیدِ پایین بزن و «برو» را لمس کن.</li>
        <li>همان لینک روی سرور باز و عکسش می‌آید — و لینک‌های آن صفحه هم شماره می‌خورند. همین‌طور جلو برو.</li>
        <li>روی عکس ضربه بزن تا تمام‌صفحه شود.</li>
      </ul>
      <ul>
        <li>محدودیت‌های صادقانه: بار اول هر عکس چند ثانیه (تا ~۲۰ ثانیه) طول می‌کشد؛ دفعه‌ی بعد از کش فوری می‌آید.</li>
        <li>سایت‌هایی که ورود/لاگین می‌خواهند یا ربات‌ها را می‌بندند، درست رندر نمی‌شوند.</li>
      </ul>
    </div>
  </div>
  <div id="shotwrap" hidden>
    <div id="shotbox">
      <img id="shot" alt="عکس صفحه‌ی سایت">
      <div id="shotspin" class="spin" hidden></div>
    </div>
    <div id="shotmeta"></div>
  </div>
  <section id="linkssec" hidden>
    <h3>لینک‌های این صفحه <span id="lcount"></span></h3>
    <div id="links"></div>
  </section>
  <details id="textsec" hidden>
    <summary>متن صفحه (برای خواندن و کپی — وقتی عکس نیامد هم کارتان را راه می‌اندازد)</summary>
    <div id="text"></div>
  </details>
</main>
<footer id="numbar">
  <span class="lbl">شماره‌ی لینک یا آدرس:</span>
  <input id="num" placeholder="مثلاً ۳ یا ۱۲…" autocomplete="off">
  <button id="bnum">برو ▸</button>
</footer>
<div id="zoom" hidden><div class="zh">برای بستن ضربه بزن</div><img id="zimg" alt=""></div>
<script>
(function(){
'use strict';
function $(id){return document.getElementById(id);}
var addr=$('addr'),num=$('num'),img=$('shot'),statusEl=$('status');
var cur={url:'',links:[],title:''};
var hist=[],hi=-1,full=false,shotTimer=null,shotDone=true;

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}

function fa2en(s){
  var p='۰۱۲۳۴۵۶۷۸۹',a='٠١٢٣٤٥٦٧٨٩';
  return String(s==null?'':(s||'')).replace(/[۰-۹٠-٩]/g,function(c){
    var i=p.indexOf(c);if(i>=0)return ''+i;
    i=a.indexOf(c);return i>=0?''+i:c;});
}

function setStatus(t){statusEl.textContent=t;}

function resolveInput(v){
  v=fa2en(String(v==null?'':v)).trim();
  if(!v)return '';
  if(/^\\d{1,3}$/.test(v)){
    var n=parseInt(v,10),L=null;
    for(var i=0;i<cur.links.length;i++)if(cur.links[i].n===n){L=cur.links[i];break;}
    if(!L){setStatus('شماره '+n+' در فهرست نیست — شماره‌ها از ۱ تا '+cur.links.length+'اند');return '';}
    return L.u;
  }
  if(/^[a-z][a-z0-9+.\\-]*:\\/\\//i.test(v))return v;
  if(/^[\\w.\\-]+\\.[a-z]{2,}(:\\d+)?([\\\/?#].*)?$/i.test(v))return 'https://'+v;
  return 'https://www.bing.com/search?q='+encodeURIComponent(v);
}

function go(v,push){
  var u=resolveInput(v);
  if(!u)return;
  if(push!==false){hist=hist.slice(0,hi+1);hist.push(u);hi=hist.length-1;}
  load(u);
}

function load(u){
  cur={url:u,links:[],title:''};
  $('landing').hidden=true;
  $('shotwrap').hidden=false;
  $('linkssec').hidden=true;
  $('textsec').hidden=true;
  $('textsec').open=false;
  $('text').textContent='';
  $('shotmeta').textContent='';
  addr.value=u;
  document.title='در حال بارگیری…';
  updateNav();
  // عکس فوراً شروع می‌شود (موازی با دریافت لینک‌ها) — کل رفت‌وبرگشت را کوتاه می‌کند
  shotDone=false;
  img.removeAttribute('src');
  img.style.opacity=.22;
  $('shotspin').hidden=false;
  setStatus('در حال گرفتن عکس و لینک‌ها… بار اول ممکن است تا ~۲۰ ثانیه طول بکشد');
  clearTimeout(shotTimer);
  shotTimer=setTimeout(function(){
    if(!shotDone)setStatus('گیرنده‌ی عکس هنوز جواب نداده… کمی صبر کن یا «بارگیری مجدد» را بزن');
  },22000);
  img.src='/shot?url='+encodeURIComponent(u)+(full?'&full=1':'');
  // دریافت لینک‌ها
  fetch('/api/nav?url='+encodeURIComponent(u))
    .then(function(r){return r.json();})
    .then(function(d){
      if(cur.url!==u)return;
      if(!d.ok){
        $('shotmeta').textContent='فهرست لینک‌ها دریافت نشد: '+(d.error||'؟');
        setStatus('فهرست لینک‌ها نیامد — عکس اگر بیاید، همان را ببین');
        return;
      }
      cur={url:d.finalUrl||u,links:d.links||[],title:d.title||''};
      addr.value=cur.url;
      document.title=(cur.title?cur.title+' — ':'')+'مرورگر تصویری';
      $('shotmeta').textContent=(cur.title||cur.url)+(d.note?' · '+d.note:'');
      renderLinks();
      if(d.text){$('textsec').hidden=false;$('text').textContent=d.text;}
      if(shotDone)setStatus('آماده — '+cur.links.length+' لینک شماره‌گذاری شد؛ شماره را در کادر پایین بزن');
      updateNav();
    })
    .catch(function(e){
      if(cur.url!==u)return;
      setStatus('خطا در دریافت فهرست لینک‌ها — دوباره تلاش کن');
    });
}

function renderLinks(){
  var box=$('links');
  box.innerHTML='';
  $('lcount').textContent='('+cur.links.length+' عدد — لمس یا شماره‌اش را در کادر پایین بزن)';
  if(!cur.links.length){$('linkssec').hidden=true;return;}
  $('linkssec').hidden=false;
  for(var i=0;i<cur.links.length;i++){
    (function(L){
      var b=document.createElement('button');
      b.className='lnk';
      b.innerHTML='<b>'+L.n+'</b><span class="lt">'+esc(L.t)+'</span><span class="lu">'+esc(L.u)+'</span>';
      b.onclick=function(e){e.stopPropagation();go(String(L.n));};
      box.appendChild(b);
    })(cur.links[i]);
  }
  box.scrollIntoView=box.scrollIntoView||function(){};
}

function updateNav(){
  $('bback').classList.toggle('dis',hi<=0);
  $('bfwd').classList.toggle('dis',hi>=hist.length-1);
}

function home(){
  cur={url:'',links:[],title:''};
  hist=[];hi=-1;
  $('landing').hidden=false;
  $('shotwrap').hidden=true;
  $('linkssec').hidden=true;
  $('textsec').hidden=true;
  img.removeAttribute('src');
  $('shotspin').hidden=true;
  setStatus('آماده — آدرس را وارد کن یا یکی از کاشی‌ها را بزن');
  document.title='مرورگر تصویری (ریموت)';
  addr.value='';num.value='';
  updateNav();
}

img.onload=function(){
  shotDone=true;
  img.style.opacity=1;
  $('shotspin').hidden=true;
  clearTimeout(shotTimer);
  setStatus('آماده — '+cur.links.length+' لینک شماره‌گذاری شد؛ شماره را در کادر پایین بزن');
};
img.onerror=function(){
  shotDone=true;
  $('shotspin').hidden=true;
  clearTimeout(shotTimer);
  setStatus('عکس گرفته نشد — «متن صفحه» و فهرست لینک‌ها را باز کن یا «بارگیری مجدد» را بزن');
};

$('bgo').onclick=function(){go(addr.value);};
addr.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();go(addr.value);}});
$('bnum').onclick=function(){go(num.value);num.value='';};
num.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();go(num.value);num.value='';}});
$('bback').onclick=function(){if(hi>0){hi--;load(hist[hi]);}};
$('bfwd').onclick=function(){if(hi<hist.length-1){hi++;load(hist[hi]);}};
$('breload').onclick=function(){if(cur.url)load(cur.url);};
$('bhome').onclick=home;
$('full').addEventListener('change',function(){full=this.checked;if(cur.url)load(cur.url);});

$('shotbox').onclick=function(){if(!img.src)return;$('zimg').src=img.src;$('zoom').hidden=false;};
$('zoom').onclick=function(){this.hidden=true;$('zimg').removeAttribute('src');};

var TILES=[
  ['بی‌بی‌سی فارسی','https://www.bbc.com/persian','#b91c1c','B'],
  ['ویکی‌پدیا','https://fa.wikipedia.org/','#334155','W'],
  ['DW فارسی','https://www.dw.com/fa/','#1d4ed8','D'],
  ['رادیو فردا','https://www.radiofarda.com/','#c2410c','ر'],
  ['ایران اینتل','https://www.iranintl.com/','#0e7490','I'],
  ['گاردین','https://www.theguardian.com/','#1e3a8a','G'],
  ['گوگل','https://www.google.com/','#374151','g'],
  ['یوتیوب','https://www.youtube.com/','#f43f5e','▶']
];
var box=$('tiles');
for(var i=0;i<TILES.length;i++){
  (function(t){
    var b=document.createElement('button');
    b.className='tile';
    b.innerHTML='<span class="ic" style="background:'+t[2]+'">'+t[3]+'</span><span>'+t[0]+'</span>';
    b.onclick=function(){go(t[1]);};
    box.appendChild(b);
  })(TILES[i]);
}

// لینک مستقیم: /remote?url=…
try{
  var q0=new URLSearchParams(location.search).get('url');
  if(q0)go(q0);
}catch(e){}
})();
</script>
</body>
</html>`;
