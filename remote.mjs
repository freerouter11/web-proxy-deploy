/**
 * مرورگر تصویری «ریموت» — نسخه ۴٫۲
 *
 * ایده: سایت مقصد روی سرور دریافت می‌شود، از آن «عکس» گرفته می‌شود و همه‌ی
 * لینک‌های صفحه شماره می‌گیرند. کاربر شماره‌ی لینک موردنظر را در کادر زیر عکس
 * وارد می‌کند → همان لینک باز می‌شود → عکس بعدی می‌آید. مثل یک ریموت.
 *
 * سه مسیر جدید (روی هر دو نسخه‌ی Worker و Node):
 *   /remote            → صفحه‌ی رابط کاربری (فارسی، راست‌به‌چپ)
 *   /api/nav?url=…     → JSON: عنوان + متن صفحه + لینک‌های شماره‌گذاری‌شده
 *   /shot?url=…&full=… → عکس صفحه (JPEG/PNG)
 *
 * نکته‌ی صادقانه: کلادفلر ورکر (پلن رایگان) مرورگری برای رندر HTML به عکس ندارد؛
 * عکس‌ها از سرویس‌های عکس‌گیر رایگان گرفته می‌شوند (mShots وردپرس → thum.io →
 * microlink، به‌ترتیب). نتایج ۱۰ دقیقه کش می‌شوند (حافظه + کش لبه در ورکر).
 * صفحات نیازمند ورود/کوکی در این حالت درست رندر نمی‌شوند — برای آن‌ها حالت
 * عادی پروکسی هست.
 *
 * ماژول مشترک بین worker.js و server.js — نباید چیزی جز lib.mjs ایمپورت کند.
 */

import { UA, isBlockedHost } from './lib.mjs';

/* ------------------------------ تنظیمات ------------------------------ */

const MAX_LINKS = 200;              // سقف لینک‌های شماره‌گذاری‌شده
const MAX_HTML = 2 * 1024 * 1024;   // سقف خواندن HTML مقصد (۲MB)
const NAV_TIMEOUT_MS = 25000;       // مهلت دریافت صفحه
const SHOT_TTL = 10 * 60 * 1000;    // عمر کش عکس: ۱۰ دقیقه
const SHOT_MEM_MAX = 24;            // بیشترین عکس در کش حافظه
const SHOT_MAX_BYTES = 4.5 * 1024 * 1024; // رد کردن عکس‌های سنگین‌تر (بی‌فایده روی موبایل)

/* ------------------------------ ابزارها ------------------------------ */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fetchTimeout(url, ms, opts = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { redirect: 'follow', ...opts, signal: c.signal })
    .finally(() => clearTimeout(t));
}

function collapse(s) {
  return String(s || '').replace(/[\s\u00a0]+/g, ' ').trim();
}

const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷',
};

function decodeEnt(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, g) => {
    const k = g.toLowerCase();
    if (k[0] === '#') {
      const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return (code > 0 && code < 0x110000 && Number.isFinite(code)) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENT, k) ? ENT[k] : m;
  });
}

/* --------------------------- استخراج صفحه --------------------------- */

function attrOf(tag, name) {
  const m = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'<>`]+))', 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

function pageTitle(html) {
  let m = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,300})["']/i.exec(html)
       || /<meta[^>]+content=["']([^"']{1,300})["'][^>]+property=["']og:title["']/i.exec(html);
  if (m) return collapse(decodeEnt(m[1]));
  m = /<title[^>]*>([\s\S]{1,600}?)<\/title>/i.exec(html);
  return m ? collapse(decodeEnt(m[1].replace(/<[^>]*>/g, ''))) : '';
}

function bodyText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
       .replace(/<style[\s\S]*?<\/style>/gi, ' ')
       .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
       .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
       .replace(/<head[\s\S]*?<\/head>/gi, ' ')
       .replace(/<[^>]*>/g, ' ');
  return collapse(decodeEnt(s)).slice(0, 1500);
}

function extractLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < MAX_LINKS) {
    const href = attrOf(m[1], 'href');
    if (!href) continue;
    const h = href.trim();
    if (!h || h[0] === '#' || h[0] === '{') continue;
    if (/^(javascript|mailto|tel|sms|data|blob|file|about|ftp|ws|wss):/i.test(h)) continue;
    let abs, pu;
    try { abs = new URL(h, baseUrl); pu = abs; } catch { continue; }
    if (pu.protocol !== 'http:' && pu.protocol !== 'https:') continue;
    if (isBlockedHost(pu.hostname)) continue;
    if (seen.has(pu.href)) continue;
    seen.add(pu.href);
    let text = collapse(decodeEnt(String(m[2]).replace(/<[^>]*>/g, ' ')));
    if (!text) {
      text = pu.hostname.replace(/^www\./, '') +
             (pu.pathname && pu.pathname !== '/' ? pu.pathname.slice(0, 30) : '');
    }
    out.push({ n: out.length + 1, u: pu.href, t: text.slice(0, 90) });
  }
  return out;
}

/* تشخیص charset از هدر یا متا؛ پیش‌فرض utf-8 */
function decodeBody(bytes, ctHeader) {
  let enc = '';
  const mct = /charset=([\w-]+)/i.exec(ctHeader || '');
  if (mct) enc = mct[1].toLowerCase();
  if (!enc || enc === 'utf-8' || enc === 'utf8') {
    const head = new TextDecoder('utf-8').decode(bytes.slice(0, 2048));
    const mm = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)
            || /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head);
    if (mm) enc = mm[1].toLowerCase();
  }
  try { return new TextDecoder(enc === 'utf8' ? 'utf-8' : enc).decode(bytes); }
  catch { return new TextDecoder('utf-8').decode(bytes); }
}

/* ------------------------- دریافت و عکس‌گیری ------------------------- */

function resolveTarget(raw) {
  if (!raw) return { err: 'آدرسی داده نشده است.' };
  let u = String(raw).trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
  let t;
  try { t = new URL(u); } catch { return { err: 'آدرس واردشده معتبر نیست.' }; }
  if (t.protocol !== 'http:' && t.protocol !== 'https:') {
    return { err: 'فقط آدرس‌های http و https پشتیبانی می‌شوند.' };
  }
  if (isBlockedHost(t.hostname)) return { err: 'دسترسی به آدرس‌های داخلی/لوکال مجاز نیست.' };
  return { url: t.href };
}

export async function navInfo(target) {
  const r = await fetchTimeout(target, NAV_TIMEOUT_MS, {
    headers: {
      'user-agent': UA,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'fa,en;q=0.8',
    },
  });
  if (!r.ok) {
    return { ok: false, status: r.status, error: 'سایت مقصد پاسخ نداد (HTTP ' + r.status + ').' };
  }
  const ct = r.headers.get('content-type') || '';
  const buf = await r.arrayBuffer();
  const bytes = new Uint8Array(buf.slice(0, MAX_HTML));
  const html = decodeBody(bytes, ct);
  const finalUrl = r.url || target;
  const isHtml = /html|xml/i.test(ct) || /<html[\s>]|<body[\s>]|<a[\s>]/i.test(html);
  if (!isHtml) {
    return {
      ok: true, url: target, finalUrl,
      title: finalUrl, links: [], notHtml: true,
      text: 'این صفحه HTML نیست (' + (ct.split(';')[0] || 'نوع نامشخص') + ') — در حالت عادی پروکسی بازش کن.',
    };
  }
  return {
    ok: true, url: target, finalUrl,
    title: pageTitle(html) || finalUrl,
    links: extractLinks(html, finalUrl),
    text: bodyText(html),
  };
}

/* --- کش عکس: حافظه‌ی درون‌فرایندی (Worker و Node) + کش لبه (فقط Worker) --- */

const rmShotMem = new Map();

function shotKey(target, full) { return (full ? 'F|' : 'V|') + target; }

function rmMemGet(k) {
  const e = rmShotMem.get(k);
  if (!e) return null;
  if (Date.now() - e.at > SHOT_TTL) { rmShotMem.delete(k); return null; }
  return e;
}

function rmMemPut(k, v) {
  if (rmShotMem.size >= SHOT_MEM_MAX) rmShotMem.delete(rmShotMem.keys().next().value);
  rmShotMem.set(k, { at: Date.now(), ...v });
}

function edgeBase() {
  try {
    if (typeof self !== 'undefined' && self.location &&
        typeof caches !== 'undefined' && caches.default) {
      return new URL('/__shot', self.location.origin).href;
    }
  } catch { /* نه محیط ورکر */ }
  return null;
}

async function edgeGet(k) {
  const base = edgeBase();
  if (!base) return null;
  try {
    const r = await caches.default.match(base + '?k=' + encodeURIComponent(k));
    if (!r) return null;
    const ct = r.headers.get('content-type') || 'image/jpeg';
    return { buf: await r.arrayBuffer(), type: ct, src: r.headers.get('x-shot-src') || 'edge' };
  } catch { return null; }
}

async function edgePut(k, v) {
  const base = edgeBase();
  if (!base) return;
  try {
    await caches.default.put(base + '?k=' + encodeURIComponent(k), new Response(v.buf.slice(0), {
      headers: {
        'content-type': v.type || 'image/jpeg',
        'cache-control': 'public, max-age=' + Math.floor(SHOT_TTL / 1000),
        'x-shot-src': v.src || '',
      },
    }));
  } catch { /* کش لبه اجباری نیست */ }
}

/* --- زنجیره‌ی سرویس‌های عکس‌گیر (به‌ترتیب اولویت) --- */

async function fromMshots(target, full) {
  const u = 'https://s0.wp.com/mshots/v1/' + encodeURIComponent(target) +
            '?w=900&h=' + (full ? 2600 : 1300);
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetchTimeout(u, 15000, { headers: { 'user-agent': UA } });
      if (r.ok) {
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        const buf = await r.arrayBuffer();
        // عکس جای‌نگهدار mShots یک GIF کوچک است؛ عکس واقعی JPEG و بزرگ‌تر
        if (buf.byteLength > 12000 && ct.includes('jpeg')) return { buf, type: 'image/jpeg' };
      }
    } catch { /* تلاش بعدی */ }
    await sleep(1000 + i * 800);
  }
  return null;
}

async function fromThum(target, full) {
  const u = 'https://image.thum.io/get/width/900/' +
            (full ? 'fullpage/' : 'crop/1300/') + 'noanimate/' + target;
  const r = await fetchTimeout(u, 45000);
  if (!r.ok) return null;
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('image/')) return null;
  const buf = await r.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > SHOT_MAX_BYTES) return null;
  return { buf, type: ct.split(';')[0] };
}

async function fromMicrolink(target, full) {
  const api = 'https://api.microlink.io/?url=' + encodeURIComponent(target) +
              '&screenshot=true&meta=false&fullPage=' + (full ? 'true' : 'false');
  const r = await fetchTimeout(api, 25000);
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const su = j && j.data && j.data.screenshot && j.data.screenshot.url;
  if (!su) return null;
  const r2 = await fetchTimeout(su, 30000);
  if (!r2.ok) return null;
  const buf = await r2.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > SHOT_MAX_BYTES) return null;
  return { buf, type: 'image/png' };
}

export async function shotImage(target, full) {
  const chain = [
    ['mshots', fromMshots],
    ['thum', fromThum],
    ['microlink', fromMicrolink],
  ];
  for (const [name, fn] of chain) {
    try {
      const r = await fn(target, full);
      if (r && r.buf && r.buf.byteLength) return { ...r, src: name };
    } catch { /* سرویس بعدی */ }
  }
  return null;
}

export async function shotResponse(target, full, bust) {
  const k = shotKey(target, full);
  if (!bust) {
    const hit = rmMemGet(k) || (await edgeGet(k));
    if (hit) return imgRes(hit.buf, hit.type, hit.src, true);
  }
  const r = await shotImage(target, full);
  if (!r) {
    return jsonRes(502, {
      ok: false,
      error: 'هیچ سرویس عکس‌گیر پاسخ نداد؛ دوباره تلاش کن یا «کل صفحه» را تغییر بده.',
    });
  }
  rmMemPut(k, r);
  await edgePut(k, r);
  return imgRes(r.buf, r.type, r.src, false);
}

/* ------------------------------ پاسخ‌ها ------------------------------ */

function imgRes(buf, type, src, cached) {
  return new Response(buf, {
    status: 200,
    headers: {
      'content-type': type || 'image/jpeg',
      'cache-control': 'public, max-age=' + Math.floor(SHOT_TTL / 1000),
      'x-robots-tag': 'noindex',
      'x-shot-src': src || '',
      'x-shot-cache': cached ? 'HIT' : 'MISS',
    },
  });
}

function jsonRes(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

/* --------------------------- مسیریابی مشترک --------------------------- */

export async function handleRemote(url) {
  const path = url.pathname;

  if (path === '/remote') {
    return new Response(remotePage(), {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
      },
    });
  }

  if (path === '/api/nav') {
    const t = resolveTarget((url.searchParams.get('url') || '').trim());
    if (t.err) return jsonRes(400, { ok: false, error: t.err });
    const t0 = Date.now();
    try {
      const info = await navInfo(t.url);
      return jsonRes(200, { ...info, ms: Date.now() - t0 });
    } catch (e) {
      const msg = (e && e.name === 'AbortError') ? 'مهلت دریافت صفحه تمام شد' : 'خطای شبکه';
      return jsonRes(502, { ok: false, error: 'دریافت صفحه ممکن نشد: ' + msg + '.' });
    }
  }

  if (path === '/shot') {
    const t = resolveTarget((url.searchParams.get('url') || '').trim());
    if (t.err) return jsonRes(400, { ok: false, error: t.err });
    const full = url.searchParams.get('full') === '1';
    const bust = !!url.searchParams.get('_');
    try {
      return await shotResponse(t.url, full, bust);
    } catch (e) {
      const msg = (e && e.name === 'AbortError') ? 'مهلت عکس‌گیری تمام شد' : 'خطای شبکه';
      return jsonRes(502, { ok: false, error: 'عکس‌گیری ممکن نشد: ' + msg + '.' });
    }
  }

  return null;
}

/* ---------------------- صفحه‌ی رابط (فارسی، RTL) ---------------------- */

function remotePage() {
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>مرورگر تصویری — وب‌پروکسی</title>
<link rel="icon" href="/favicon.ico">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%}
body{display:flex;flex-direction:column;background:#0b1220;color:#e7edf8;
  font-family:"Segoe UI",Tahoma,"Vazirmatn",sans-serif;font-size:14px}
#bar{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#080e1c;
  border-bottom:1px solid #1b2740;flex-wrap:nowrap}
.nb{width:36px;height:36px;border-radius:9px;border:0;background:transparent;color:#a9bcd9;
  cursor:pointer;font-size:17px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center}
.nb:hover{background:#131f39;color:#e7edf8}
.nb:disabled{opacity:.3;cursor:default}
#fullWrap{display:flex;align-items:center;gap:6px;color:#8fa2c4;font-size:12px;flex:0 0 auto;
  padding:0 10px;height:34px;border-radius:9px;background:#0d1730;border:1px solid #24334f;
  cursor:pointer;user-select:none}
#fullWrap input{accent-color:#0ea5e9;width:15px;height:15px}
#stat{padding:8px 14px;font-size:12.5px;color:#8fa2c4;border-bottom:1px solid #16223c;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 0 auto;direction:rtl;text-align:right}
#stage{flex:1;overflow:auto;position:relative;background:#04070f}
#imgwrap{position:relative;min-height:200px;display:flex;align-items:flex-start;justify-content:center;
  padding:10px;overflow:auto}
#img{max-width:100%;width:auto;height:auto;display:none;background:#fff;border-radius:6px;
  box-shadow:0 10px 40px rgba(0,0,0,.5);cursor:zoom-in}
#img.big{max-width:none;width:170%;cursor:zoom-out}
#spin{position:absolute;inset:0;display:none;flex-direction:column;gap:12px;align-items:center;
  justify-content:center;color:#7dd3fc;font-size:12.5px;text-align:center;padding:0 20px}
#spin .ring{width:34px;height:34px;border-radius:50%;border:3px solid #1e3a5f;
  border-top-color:#38bdf8;animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
#fb{display:none;white-space:pre-wrap;padding:16px;color:#c7d5ee;font-size:13.5px;line-height:2;
  direction:rtl;text-align:right;max-width:820px;margin:0 auto}
#tiles{display:flex;gap:8px;overflow-x:auto;padding:10px;scrollbar-width:none;flex:0 0 auto}
#tiles::-webkit-scrollbar{display:none}
.tl{display:inline-flex;align-items:center;padding:8px 14px;border-radius:9px;flex:0 0 auto;
  background:#131f39;color:#c7d5ee;font-size:12.5px;cursor:pointer;border:1px solid #1d2a44}
.tl:hover{border-color:#38bdf8;color:#fff}
#pick{display:flex;gap:8px;padding:10px;background:#0a101f;border-top:1px solid #16223c;flex:0 0 auto}
#addr{flex:1;min-width:60px;padding:11px 16px;border-radius:12px;border:1px solid #24334f;background:#0d1730;
  color:#e7edf8;font-size:13.5px;outline:none;direction:ltr;text-align:left;font-family:inherit}
#addr:focus{border-color:#38bdf8}
#addr::placeholder{direction:rtl;text-align:right;color:#5d7295}
#go{padding:11px 24px;border-radius:12px;border:0;background:linear-gradient(135deg,#0ea5e9,#22d3ee);
  color:#04121f;font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit;flex:0 0 auto}
#lnks{max-height:32vh;overflow:auto;border-top:1px solid #16223c;background:#0a101f;flex:0 0 auto}
.ln{display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;border-bottom:1px solid #101a2e}
.ln:hover{background:#121e36}
.ln b{flex:0 0 auto;min-width:36px;height:26px;border-radius:8px;background:#13233f;color:#7dd3fc;
  display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700}
.ln span{flex:1;color:#c7d5ee;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ln.more{justify-content:center;color:#7dd3fc;font-size:12.5px}
#hint{padding:9px 14px 12px;color:#5d7295;font-size:11.5px;line-height:1.9;flex:0 0 auto;
  border-top:1px solid #101a2e}
</style>
</head>
<body>
<div id="bar">
  <button class="nb" id="bback" title="عقب">‹</button>
  <button class="nb" id="bfwd" title="جلو">›</button>
  <button class="nb" id="breload" title="بازخوانی با عکس تازه">⟳</button>
  <label id="fullWrap"><input type="checkbox" id="fullcb">کل صفحه</label>
</div>
<div id="stat">آدرس سایت را بزن یا از کاشی‌های زیر شروع کن؛ بعد شماره‌ی لینک را در کادر پایین وارد کن</div>
<div id="stage">
  <div id="imgwrap">
    <img id="img" alt="عکس صفحه" decoding="async">
    <div id="spin"><div class="ring"></div><div id="spintext">در حال گرفتن عکس صفحه…</div></div>
  </div>
  <div id="fb"></div>
  <div id="tiles"></div>
</div>
<div id="pick">
  <input id="addr" placeholder="شماره‌ی لینک یا آدرس سایت…" autocomplete="off" spellcheck="false">
  <button id="go">برو</button>
</div>
<div id="lnks"></div>
<div id="hint">حالت «ریموت تصویری»: صفحه به‌صورت عکس می‌آید و لینک‌هایش شماره می‌گیرند؛ شماره را در کادر بزن تا همان لینک باز شود. صادقانه: عکس‌ها با سرویس‌های عکس‌گیر رایگان گرفته می‌شوند (اولین عکسِ هر صفحه ممکن است تا ~۱۵ ثانیه طول بکشد، دفعه‌های بعد از کش فوری است) و صفحات نیازمند ورود ممکن است درست رندر نشوند — برای آن‌ها حالت عادی پروکسی هست.</div>
<script>
(function(){
'use strict';
var hist=[],hi=-1,cur=null,links=[],SHOW=80,tok=0,full=false;
function $(id){return document.getElementById(id);}
function fa(s){return String(s).replace(/[0-9]/g,function(d){return '۰۱۲۳۴۵۶۷۸۹'[+d];});}
function navTo(u){return '/api/nav?url='+encodeURIComponent(u);}
function shotFor(u){return '/shot?url='+encodeURIComponent(u)+(full?'&full=1':'');}
function sec(ms){return fa((ms/1000).toFixed(1))+' ثانیه';}
function updNav(){
  $('bback').disabled=(hi<=0);
  $('bfwd').disabled=(hi>=hist.length-1);
}
function go(u,push,reload){
  u=String(u||'').trim();
  if(!u)return;
  if(push!==false){hist=hist.slice(0,hi+1);hist.push(u);hi=hist.length-1;}
  updNav();
  cur=u;
  var my=++tok;
  $('fb').style.display='none';
  $('img').style.display='none';
  $('img').classList.remove('big');
  $('spin').style.display='flex';
  $('spintext').textContent='در حال دریافت صفحه…';
  $('stat').textContent='در حال دریافت '+u;
  fetch(navTo(u)+(reload?'&_='+Date.now():''),{cache:'no-store'})
    .then(function(r){return r.json();})
    .then(function(j){
      if(my!==tok)return;
      if(!j.ok){$('spin').style.display='none';$('stat').textContent='خطا: '+(j.error||'دریافت نشد');return;}
      render(j,reload,my);
    })
    .catch(function(){
      if(my!==tok)return;
      $('spin').style.display='none';
      $('stat').textContent='ارتباط با سرور برقرار نشد';
    });
}
function render(j,reload,my){
  links=j.links||[];
  cur=j.finalUrl||cur;
  $('addr').value=cur;
  renderLinks();
  $('stat').textContent=(j.title||cur)+' — دریافت صفحه در '+sec(j.ms||0)+' — '+fa(links.length)+' لینک شماره‌گذاری شد';
  $('spintext').textContent='در حال گرفتن عکس صفحه… (اولین عکسِ هر صفحه ممکن است تا ~۱۵ ثانیه طول بکشد)';
  var im=$('img');
  im.onload=function(){
    if(my!==tok)return;
    $('spin').style.display='none';
    im.style.display='block';
  };
  im.onerror=function(){
    if(my!==tok)return;
    $('spin').style.display='none';
    var fb=$('fb');
    fb.style.display='block';
    fb.textContent=j.text?('عکس گرفته نشد — متن صفحه:\\n\\n'+j.text):'عکس گرفته نشد؛ دوباره تلاش کن.';
  };
  im.src=shotFor(cur)+(reload?'&_='+Date.now():'');
}
function renderLinks(){
  var box=$('lnks');
  box.textContent='';
  var n=Math.min(links.length,SHOW);
  for(var i=0;i<n;i++)(function(L){
    var d=document.createElement('div');d.className='ln';
    var b=document.createElement('b');b.textContent=fa(L.n);
    var s=document.createElement('span');s.textContent=L.t||L.u;
    d.appendChild(b);d.appendChild(s);
    d.onclick=function(){go(L.u,true);};
    box.appendChild(d);
  })(links[i]);
  if(links.length>n){
    var m=document.createElement('div');m.className='ln more';
    m.textContent='نمایش '+fa(links.length-n)+' لینک بیشتر…';
    m.onclick=function(){SHOW+=200;renderLinks();};
    box.appendChild(m);
  }
}
function smart(v){
  if(/^[a-z][a-z0-9+.\\-]*:\\/\\//i.test(v))return v;
  if(/^[\\w.\\-]+\\.[a-z]{2,}(:\\d+)?([\\/?#].*)?$/i.test(v))return 'https://'+v;
  return 'https://www.bing.com/search?q='+encodeURIComponent(v);
}
function pick(){
  var v=$('addr').value.trim();
  if(!v)return;
  if(/^[0-9]{1,4}$/.test(v)){
    var n=parseInt(v,10);
    if(links[n-1]){go(links[n-1].u,true);return;}
    $('stat').textContent='شماره باید بین ۱ تا '+fa(Math.max(links.length,1))+' باشد';
    return;
  }
  go(smart(v),true);
}
$('go').onclick=pick;
$('addr').addEventListener('keydown',function(e){
  if(e.key==='Enter'||e.keyCode===13){e.preventDefault();pick();}
});
$('bback').onclick=function(){if(hi>0){hi--;go(hist[hi],false);}};
$('bfwd').onclick=function(){if(hi<hist.length-1){hi++;go(hist[hi],false);}};
$('breload').onclick=function(){if(cur)go(cur,false,true);};
$('fullcb').onchange=function(){full=$('fullcb').checked;if(cur)go(cur,false,true);};
$('img').onclick=function(){this.classList.toggle('big');};
var TILES=[
  {t:'BBC فارسی',u:'https://www.bbc.com/persian'},
  {t:'DW فارسی',u:'https://www.dw.com/fa/'},
  {t:'ویکی‌پدیا',u:'https://fa.wikipedia.org/'},
  {t:'گوگل',u:'https://www.google.com/'},
  {t:'یوتیوب',u:'https://www.youtube.com/'},
  {t:'ایران اینتل',u:'https://www.iranintl.com/'}
];
var tb=$('tiles');
for(var i=0;i<TILES.length;i++)(function(t){
  var d=document.createElement('div');d.className='tl';d.textContent=t.t;
  d.onclick=function(){go(t.u,true);};
  tb.appendChild(d);
})(TILES[i]);
updNav();
})();
</script>
</body>
</html>`;
}
