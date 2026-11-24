/**
 * configs.mjs — «کانفیگ‌های آماده (گیت‌هاب)» — ماژول مشترک ورکر کلودفلر و سرور نود
 *
 * ایده: مخازن عمومی گیت‌هاب هر ۱۵ دقیقه کانفیگ‌های رایگان V2Ray/VLESS/VMess/
 * Trojan/… جمع می‌کنند. از داخل ایران معمولاً raw.githubusercontent.com
 * قابل دسترسی نیست؛ این ماژول فهرست را «از طریق همین لایه‌ی پروکسی» می‌گیرد،
 * تجزیه می‌کند و هم در صفحه‌ی فارسی نشان می‌دهد و هم به‌شکل «لینک اشتراک»
 * (subscription) درمی‌آورد که مستقیم در v2rayNG/Hiddify قابل افزودن است.
 *
 * مسیرها:
 *   GET /configs                     صفحه‌ی رابط (فارسی، RTL)
 *   GET /api/configs                 فهرست منبع‌ها + وضعیت کش
 *   GET /api/configs?src=<id>        JSON: تعداد، نمودار پروتکل‌ها، ۵۰۰ کانفیگ اول
 *   GET /api/configs?src=<id>&raw=1  متن خام اشتراک — قابل افزودن مستقیم در v2rayNG
 *                                     (اختیاری: &n=20&random=1 — زیرمجموعه‌ی سبک)
 *   GET /api/configs?url=<sub-url>   منبع دلخواه (فقط http/https عمومی؛ سقف ۴MB)
 *
 * نکته‌ی صادقانه: این‌ها کانفیگ‌های عمومی رایگان‌اند — کیفیت و پایداری‌شان
 * لحظه‌به‌لحظه فرق دارد و هیچ تضمینی نیستند. این اپ خودش تونل VPN نمی‌سازد؛
 * کانفیگ‌ها را برای کلاینت‌های مخصوص (v2rayNG و…) آماده می‌کند.
 */

import { UA, isBlockedHost } from './lib.mjs';

/* --------------------------- منبع‌های منتخب --------------------------- */

const SOURCES = [
  {
    id: 'fast',
    name: 'تست‌شده و سریع',
    repo: '0xRadikal/Free-v2ray-Configs',
    desc: 'کانفیگ‌هایی که همین حالا تست سرعت شده‌اند — هر ۱۵ دقیقه به‌روز.',
    url: 'https://raw.githubusercontent.com/0xRadikal/Free-v2ray-Configs/main/fast/configs.txt',
  },
  {
    id: 'all',
    name: 'همه (حجم بالا)',
    repo: '0xRadikal/Free-v2ray-Configs',
    desc: 'همه‌ی کانفیگ‌های جمع‌آوری‌شده — هزاران عدد، کیفیت متغیر.',
    url: 'https://raw.githubusercontent.com/0xRadikal/Free-v2ray-Configs/main/all/configs.txt',
  },
  {
    id: 'matin',
    name: 'ماتین — همه',
    repo: 'MatinGhanbari/v2ray-configs',
    desc: 'اشتراک تجمیعی ماتین — ترکیبی از چند منبع.',
    url: 'https://raw.githubusercontent.com/MatinGhanbari/v2ray-configs/main/subscriptions/v2ray/all_sub.txt',
  },
  {
    id: 'super',
    name: 'ماتین — سوپر',
    repo: 'MatinGhanbari/v2ray-configs',
    desc: 'حجم کم؛ زیرمجموعه‌ی منتخب — برای اینترنت ضعیف.',
    url: 'https://raw.githubusercontent.com/MatinGhanbari/v2ray-configs/main/subscriptions/v2ray/super-sub.txt',
  },
  {
    id: 'aggregator',
    name: 'تجمیع‌کننده',
    repo: 'mahdibland/V2RayAggregator',
    desc: 'تجمیع‌کننده‌ی قدیمی و شناخته‌شده‌ی V2Ray.',
    url: 'https://raw.githubusercontent.com/mahdibland/V2RayAggregator/master/sub/sub_merge.txt',
  },
  {
    id: 'soli',
    name: 'سولی — همه',
    repo: 'SoliSpirit/v2ray-configs',
    desc: 'مجموعه‌ی بزرگ سولی‌اسپیریت.',
    url: 'https://raw.githubusercontent.com/SoliSpirit/v2ray-configs/main/all_configs.txt',
  },
];

function sourceById(id) {
  for (const s of SOURCES) if (s.id === id) return s;
  return null;
}

/* ---------------------------- ابزارهای کوچک ---------------------------- */

/* توابع کمکی با نام‌های cfg اختصاصی — تا در باندلِ تک‌فایلی با remote.mjs تداخل نکنند */
function cfgSignal(ms) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => { try { ac.abort(); } catch (_) {} }, ms);
    if (typeof t === 'object' && t && typeof t.unref === 'function') t.unref();
    return ac.signal;
  } catch (_) { return undefined; }
}

function cfgJson(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

function cfgText(msg, status, ctype) {
  return new Response(msg, {
    status: status || 400,
    headers: {
      'content-type': (ctype || 'text/plain') + '; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

/* رمزگشایی base64 — هم در ورکر هم در نود */
function b64Decode(s) {
  const bin = typeof atob === 'function'
    ? atob(s)
    : Buffer.from(s, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch (_) { return ''; }
}

function b64IsPlausible(s) {
  return /^[A-Za-z0-9+/=\s]+$/.test(s) && s.replace(/[\s=]/g, '').length >= 32;
}

function safeSubUrl(raw) {
  const t = String(raw || '').trim();
  if (!t || t.length > 2000) return null;
  let u;
  try { u = new URL(t); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (isBlockedHost(u.hostname)) return null;
  return u.href;
}

/* --------------------------- تجزیه‌ی اشتراک --------------------------- */

const SCHEMES = /^(vmess|vless|trojan|ss|ssr|hysteria2?|hy2|tuic|socks5?|wireguard|juicity|anytls):\/\//i;
const MAX_ITEMS_PARSE = 6000;   // سقف تجزیه (باقی فقط شمرده می‌شود)
const MAX_ITEMS_LIST = 500;     // سقف فهرست JSON
const MAX_ITEMS_RAW = 1200;     // سقف خروجی اشتراک خام

function hostPortFromAuthority(auth) {
  // user@host:port → host:port (IPv6 داخل [])
  const m = /(?:^|@)(\[[^\]]+\]|[^:@/]+):(\d{1,5})$/.exec(auth || '');
  if (!m) return '';
  return m[1].replace(/^\[|\]$/g, '') + ':' + m[2];
}

function remarkFromFragment(frag) {
  try { return decodeURIComponent(String(frag || '')).trim(); } catch (_) { return String(frag || '').trim(); }
}

function parseOne(line) {
  const sm = SCHEMES.exec(line);
  if (!sm) return null;
  const proto = sm[1].toLowerCase();
  const rest = line.slice(sm[0].length);
  const hashIdx = rest.indexOf('#');
  const frag = hashIdx >= 0 ? rest.slice(hashIdx + 1) : '';
  let body = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;

  let host = '';
  let title = remarkFromFragment(frag);

  if (proto === 'vmess') {
    // vmess://<base64 JSON>
    try {
      const j = JSON.parse(b64Decode(body.replace(/\s+/g, '')));
      host = String(j.add || '') + (j.port !== undefined ? ':' + j.port : '');
      if (!title && j.ps) title = String(j.ps);
    } catch (_) { /* خراب — بدون جزئیات */ }
    if (!host) host = '(کانفیگ vmess ناقص)';
    if (!title) title = 'vmess';
  } else if (proto === 'ss') {
    // ss://base64(method:pass)@host:port#name  یا  ss://base64(method:pass@host:port)#name
    const at = body.lastIndexOf('@');
    if (at >= 0) {
      host = hostPortFromAuthority(body.slice(at + 1));
    } else {
      try {
        const dec = b64Decode(body.replace(/\s+/g, ''));
        const hp = /@(\[[^\]]+\]|[^:@/]+):(\d{1,5})/.exec(dec);
        if (hp) host = hp[1] + ':' + hp[2];
      } catch (_) { /* نادیده */ }
    }
    if (!host) host = '(کانفیگ ss ناقص)';
    if (!title) title = 'ss';
  } else {
    // vless/trojan/hysteria2/… : user@host:port?params
    const q = body.indexOf('?');
    if (q >= 0) body = body.slice(0, q);
    const at = body.lastIndexOf('@');
    if (at >= 0) host = hostPortFromAuthority(body.slice(at + 1));
    if (!host) host = '(نامشخص)';
    if (!title) title = proto;
  }

  return { p: proto, h: host.slice(0, 60), t: title.slice(0, 70) || proto, u: line };
}

/* آیا متن شبیه اشتراک است؟ (یکی از ۳۰ خطِ غیرخالی اول، با طرح شناخته‌شده شروع شود) */
function looksLikeSubs(text) {
  let n = 0;
  for (const l of String(text).split(/\r?\n/)) {
    const s = l.trim();
    if (!s || s.startsWith('#') || s.startsWith('//')) continue;
    if (SCHEMES.test(s)) return true;
    if (++n >= 30) break;
  }
  return false;
}

export function parseSubs(text) {
  if (!text) return { total: 0, protocols: {}, list: [] };
  // اگر خودِ متن اشتراک نبود، تا دو لایه base64 رمزگشایی می‌کنیم
  // (بعضی منبع‌ها کل فایل یا خطوطشان را کد می‌کنند)
  if (!looksLikeSubs(text)) {
    let cur = String(text);
    for (let depth = 0; depth < 2 && !looksLikeSubs(cur); depth++) {
      const compact = cur.replace(/^#[^\n]*\n?/gm, '').replace(/\s+/g, '');
      if (!b64IsPlausible(compact)) break;
      try {
        const dec = b64Decode(compact);
        if (!dec || dec.length < 32) break;
        cur = dec;
      } catch (_) { break; }
    }
    if (looksLikeSubs(cur)) text = cur;
  }

  const seen = new Set();
  const list = [];
  const protocols = {};
  let total = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    if (line.length > 4000) continue;
    if (!SCHEMES.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    total++;
    if (list.length < MAX_ITEMS_PARSE) {
      const one = parseOne(line);
      if (one) {
        list.push(one);
        protocols[one.p] = (protocols[one.p] || 0) + 1;
      }
    }
  }
  return { total, protocols, list };
}

/* --------------------------- کش درون‌حافظه‌ای --------------------------- */

const SUB_TTL = 10 * 60 * 1000;      // ۱۰ دقیقه — منبع‌ها هر ۱۵ دقیقه عوض می‌شوند
const SUB_MAX_ITEMS = 8;
const RAW_MAX_BYTES = 4 * 1024 * 1024;
const subCache = new Map(); // key -> {raw, parsed, at}
let subBytes = 0;

function cacheGet(key) {
  const v = subCache.get(key);
  if (!v) return null;
  if (Date.now() - v.at > SUB_TTL) { subCache.delete(key); subBytes -= v.raw ? v.raw.length : 0; return null; }
  return v;
}

function cacheSet(key, raw, parsed) {
  const old = subCache.get(key);
  if (old) subBytes -= old.raw ? old.raw.length : 0;
  while (subCache.size >= SUB_MAX_ITEMS && subCache.size) {
    const first = subCache.keys().next().value;
    const v = subCache.get(first);
    subBytes -= v && v.raw ? v.raw.length : 0;
    subCache.delete(first);
  }
  const rawKeep = raw && raw.length <= RAW_MAX_BYTES ? raw : null;
  subCache.set(key, { raw: rawKeep, parsed, at: Date.now() });
  subBytes += rawKeep ? rawKeep.length : 0;
}

/* --------------------- محدودیت نرخ مخصوص همین API --------------------- */
/* واکشی از گیت‌هاب سنگین است؛ جدا از محدودیت کلی سرور، اینجا هر IP
   حداکثر ۱۲ «واکشی تازه» در دقیقه دارد (پاسخ از کش محاسبه نمی‌شود). */
const cfgBuckets = new Map();
function cfgRateLimited(ip) {
  const now = Date.now();
  let b = cfgBuckets.get(ip);
  if (!b || now - b.t >= 60000) {
    b = { t: now, n: 0 };
    cfgBuckets.set(ip, b);
    if (cfgBuckets.size > 4000) {
      let i = 0;
      for (const k of cfgBuckets.keys()) { cfgBuckets.delete(k); if (++i >= 2000) break; }
    }
  }
  b.n++;
  return b.n > 12;
}

/* ------------------------- واکشی از گیت‌هاب ------------------------- */

const FETCH_TIMEOUT = 25000;

async function fetchSub(key, url) {
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        'user-agent': UA,
        'accept': 'text/plain,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: cfgSignal(FETCH_TIMEOUT),
    });
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    throw new Error(aborted ? 'پاسخ گیت‌هاب بیش از ۲۵ ثانیه طول کشید.' : 'اتصال به گیت‌هاب برقرار نشد.');
  }
  if (!resp.ok) throw new Error('گیت‌هاب کد ' + resp.status + ' برگرداند.');
  let buf;
  try { buf = await resp.arrayBuffer(); } catch (_) { throw new Error('بدنه‌ی پاسخ خوانده نشد.'); }
  if (buf.byteLength === 0) throw new Error('پاسخ خالی بود.');
  if (buf.byteLength > RAW_MAX_BYTES + 1024 * 1024) throw new Error('حجم منبع بیش از حد مجاز بود.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: false }).decode(buf); } catch (_) { throw new Error('رمزگشایی متن ممکن نشد.'); }
  if (text.length > RAW_MAX_BYTES) text = text.slice(0, RAW_MAX_BYTES); // سقف ذخیره‌ی کش
  const parsed = parseSubs(text);
  if (!parsed.total) throw new Error('هیچ کانفیگ معتبری در این منبع پیدا نشد (ممکن است مسیر عوض شده باشد).');
  cacheSet(key, text, parsed);
  return { parsed, ms: Date.now() - t0 };
}

async function getSub(key, url) {
  const hit = cacheGet(key);
  if (hit) return { parsed: hit.parsed, ms: 0, cached: true, at: hit.at };
  const out = await fetchSub(key, url);
  return { ...out, cached: false };
}

/* ---------------------------- پاسخ خام ---------------------------- */

function sampleList(list, n, random) {
  if (!random || list.length <= n) return list.slice(0, n);
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = copy[i]; copy[i] = copy[j]; copy[j] = t;
  }
  return copy.slice(0, n);
}

function rawSubscription(origin, srcId, list, n, random, total, customUrl) {
  const picked = sampleList(list, n || MAX_ITEMS_RAW, !!random);
  const head = '# اشتراک کانفیگ‌های رایگان — منبع: ' + srcId + ' (جمع‌آوری از مخازن عمومی گیت‌هاب)\n'
    + '# تعداد کل در منبع: ' + total + (picked.length < total ? ' — اینجا ' + picked.length + ' مورد' : '') + '\n'
    + '# برای افزودن در v2rayNG: اشتراک ← سه‌نقطه ← افزودن — همین نشانی را جای‌گذاری کن\n';
  return cfgText(head + picked.map((x) => x.u).join('\n') + '\n', 200, 'text/plain');
}

/* ------------------------------- مسیریابی ------------------------------- */

export function configsPage() {
  return new Response(CONFIGS_HTML, {
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
 * @param {URL} url شیء URL کامل درخواست
 * @param {string} cip IP کاربر (برای محدودیت نرخ؛ خالی = بدون محدودیت)
 */
export async function handleConfigs(url, cip) {
  let path;
  try { path = decodeURI(url.pathname); } catch (_) { path = url.pathname; }
  if (path !== '/configs' && path !== '/api/configs') return null;

  if (path === '/configs') return configsPage();

  const q = url.searchParams;
  const srcId = (q.get('src') || '').trim();
  const customUrl = (q.get('url') || '').trim();

  /* فهرست منبع‌ها */
  if (!srcId && !customUrl) {
    return cfgJson({
      ok: true,
      sources: SOURCES.map((s) => ({
        id: s.id, name: s.name, repo: s.repo, desc: s.desc,
        cached: !!cacheGet('id:' + s.id),
      })),
      note: 'برای دریافت: /api/configs?src=<id> — برای اشتراک خام: &raw=1',
    });
  }

  let key;
  let label;
  let target;
  if (customUrl) {
    const safe = safeSubUrl(customUrl);
    if (!safe) return cfgJson({ ok: false, error: 'نشانی منبع معتبر نیست — فقط http/https از سایت‌های عمومی.' });
    key = 'url:' + safe;
    label = 'custom';
    target = safe;
  } else {
    const src = sourceById(srcId);
    if (!src) return cfgJson({ ok: false, error: 'چنین منبعی نیست. src باید یکی از این‌ها باشد: ' + SOURCES.map((s) => s.id).join('، ') });
    key = 'id:' + src.id;
    label = src.name;
    target = src.url;
  }

  /* محدودیت نرخ فقط برای واکشی تازه */
  if (cip && cfgRateLimited('cfg|' + cip) && !cacheGet(key)) {
    return cfgJson({ ok: false, error: 'درخواست‌های زیاد — یک دقیقه صبر کن.' }, 429);
  }

  let sub;
  try {
    sub = await getSub(key, target);
  } catch (e) {
    return cfgJson({ ok: false, error: String(e && e.message || e), src: label }, 502);
  }

  /* خروجی اشتراک خام — قابل افزودن مستقیم در v2rayNG/Hiddify */
  if (q.get('raw') === '1') {
    const n = Math.min(Math.max(parseInt(q.get('n') || '0', 10) || 0, 0), MAX_ITEMS_RAW);
    const random = q.get('random') === '1';
    return rawSubscription(url.origin, label, sub.parsed.list, n, random, sub.parsed.total, customUrl);
  }

  return cfgJson({
    ok: true,
    src: label,
    srcId: srcId || null,
    total: sub.parsed.total,
    protocols: sub.parsed.protocols,
    shown: Math.min(sub.parsed.list.length, MAX_ITEMS_LIST),
    list: sub.parsed.list.slice(0, MAX_ITEMS_LIST),
    ms: sub.ms,
    cached: !!sub.cached,
    cachedAt: sub.at || null,
  });
}

/* --------------------------- صفحه‌ی رابط (فارسی، RTL) --------------------------- */

const CONFIGS_HTML = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>کانفیگ‌های آماده (گیت‌هاب)</title>
<link rel="icon" href="/favicon.ico">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%}
body{display:flex;flex-direction:column;background:#0b1220;color:#e7edf8;
  font-family:"Segoe UI",Tahoma,"Vazirmatn",sans-serif;font-size:14px;overflow:hidden}
#top{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#0b1220;border-bottom:1px solid #1b2740}
.lgo{font-size:16px;font-weight:800;flex:1}
.lgo span{color:#10b981}
#sh{padding:8px 15px;border-radius:10px;border:0;background:linear-gradient(135deg,#059669,#34d399);
  color:#03231a;font-weight:700;cursor:pointer;font-family:inherit;font-size:13px;flex:0 0 auto}
#sh:hover{filter:brightness(1.1)}
#stage{flex:1;overflow:auto;padding:14px;scrollbar-width:thin}
#stage::-webkit-scrollbar{width:8px}
#stage::-webkit-scrollbar-thumb{background:#22304d;border-radius:4px}
.wrap{max-width:760px;margin:0 auto}
.sub{color:#7f92b3;font-size:12.5px;line-height:2;margin-bottom:12px}
/* --- منبع‌ها --- */
.srcs{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:14px}
.src{padding:11px 12px;border-radius:11px;background:#101a30;border:1px solid #1b2740;color:#c7d5ee;
  cursor:pointer;text-align:right;font-family:inherit;font-size:12.5px;min-width:0}
.src:hover{border-color:#34d399}
.src.on{border-color:#10b981;background:#0e1f1c}
.src b{display:block;font-size:13px;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.src small{color:#7f92b3;font-size:11px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.src .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#334155;margin-inline-start:5px}
.src .dot.on{background:#10b981}
/* --- خلاصه --- */
#summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;min-height:30px}
.bdg{padding:5px 12px;border-radius:20px;background:#101a30;border:1px solid #1b2740;color:#c7d5ee;font-size:12px}
.bdg.total{background:#0e1f1c;border-color:#10b981;color:#6ee7b7;font-weight:700}
.bdg.vmess{border-color:#7c3aed}.bdg.vless{border-color:#0ea5e9}
.bdg.trojan{border-color:#f43f5e}.bdg.ss{border-color:#64748b}
.bdg.hysteria2,.bdg.hysteria{border-color:#f59e0b}.bdg.tuic{border-color:#22d3ee}
#status{color:#8fa2c4;font-size:12.5px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* --- اکشن‌ها --- */
.acts{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.pbtn{padding:9px 16px;border-radius:10px;border:1px solid #2a3a5c;background:#131f39;color:#c7d5ee;
  cursor:pointer;font-family:inherit;font-size:12.5px}
.pbtn:hover{border-color:#34d399;color:#6ee7b7}
.pbtn.pri{background:linear-gradient(135deg,#059669,#34d399);color:#03231a;border:0;font-weight:700}
.pbtn[disabled]{opacity:.4;cursor:default}
/* --- فهرست --- */
#list{display:flex;flex-direction:column;gap:6px}
.cfg{display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:10px;background:#101a30;
  border:1px solid #1b2740;color:#c7d5ee;font-family:inherit;text-align:right;font-size:12.5px;min-width:0}
.cfg:hover{border-color:#2a4a44}
.cfg .pr{flex:0 0 auto;min-width:52px;text-align:center;padding:3px 8px;border-radius:7px;font-size:10.5px;
  font-weight:700;color:#fff;direction:ltr}
.cfg .tt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cfg .hh{flex:0 0 auto;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:#5d7295;font-size:10.5px;direction:ltr}
.cfg .cp{flex:0 0 auto;padding:5px 11px;border-radius:8px;border:1px solid #2a3a5c;background:#0d1730;
  color:#7dd3fc;cursor:pointer;font-family:inherit;font-size:11.5px}
.cfg .cp:hover{border-color:#38bdf8}
/* --- راهنما --- */
.guide{margin-top:16px;border:1px solid #1b2740;border-radius:12px;background:rgba(13,23,48,.6)}
.guide summary{padding:11px 14px;cursor:pointer;color:#c7d5ee;font-size:13px;user-select:none}
.guide summary:hover{color:#fff}
.guide .in{padding:2px 16px 16px}
.guide b{color:#6ee7b7}
.guide li{margin:6px 22px 0;color:#8fa2c4;font-size:12.5px;line-height:2.1}
.guide .warn{color:#fbbf24}
#busy{display:none;text-align:center;color:#7f92b3;padding:26px 0;font-size:13px}
#busy .spin{display:inline-block;width:38px;height:38px;border-radius:50%;border:4px solid #1e2c4a;
  border-top-color:#34d399;animation:sp 1s linear infinite;margin-bottom:10px}
@keyframes sp{to{transform:rotate(360deg)}}
@media(max-width:620px){
  .cfg .hh{display:none}
  .srcs{grid-template-columns:1fr 1fr}
}
</style>
</head>
<body>
<header id="top">
  <div class="lgo">کانفیگ‌های <span>آماده</span></div>
  <button id="sh">نوسازی</button>
</header>
<main id="stage">
  <div class="wrap">
    <p class="sub">کانفیگ‌های رایگان V2Ray (VLESS/VMess/Trojan/…) از مخازن عمومی گیت‌هاب — به‌روزرسانی هر ۱۵ دقیقه.<br>از داخل ایران گیت‌هاب‌را نمی‌شود باز کرد؛ این صفحه آن را از طریق همین لایه‌ی پروکسی می‌گیرد.</p>
    <div class="srcs" id="srcs"></div>
    <div id="summary"><span id="status">یک منبع را انتخاب کن…</span></div>
    <div class="acts">
      <button class="pbtn pri" id="bSub" disabled>کپی نشانی اشتراک (برای v2rayNG)</button>
      <button class="pbtn" id="bRand" disabled>کپی ۱۰ کانفیگ تصادفی</button>
      <button class="pbtn" id="bAll" disabled>کپی همه‌ی نشان‌داده‌شده</button>
    </div>
    <div id="busy"><div class="spin"></div><br>در حال دریافت از گیت‌هاب… (از طریق لایه‌ی پروکسی؛ چند ثانیه طول می‌کشد)</div>
    <div id="list"></div>
    <details class="guide">
      <summary>راهنمای استفاده در v2rayNG / Hiddify (باز کن)</summary>
      <div class="in">
        <ul>
          <li><b>راه ۱ — اشتراک (بهترین):</b> دکمه‌ی «کپی نشانی اشتراک» را بزن. در v2rayNG تب <b>اشتراک</b> (Subscription) ← آیکون + ← نشانی را جای‌گذاری کن و «به‌روزرسانی» بزن. تعداد زیادی کانفیگ یک‌جا می‌آید و هر بار نوسازی، تازه‌ها را می‌گیرد.</li>
          <li><b>راه ۲ — کپی تکی:</b> کنار هر کانفیگ دکمه‌ی «کپی» است؛ در v2rayNG از منوی سه‌نقطه ← «از کلیپ‌بورد وارد کن».</li>
          <li><b>Hiddify:</b> صفحه‌ی اصلی ← افزودن پروفایل ← «افزودن از کلیپ‌بورد» یا جای‌گذاری همان نشانی اشتراک.</li>
          <li>برای اینترنت ضعیف، منبع «سوپر» یا «تست‌شده و سریع» را انتخاب کن و از «کپی ۱۰ کانفیگ تصادفی» بگیر تا حجم کم بماند.</li>
          <li class="warn">صادقانه: این کانفیگ‌ها عمومی و رایگان‌اند؛ هر لحظه ممکن است پر شوند، کند باشند یا خاموش شوند. کیفیت‌شان را خودت تست کن و بهترین را برای خودت نگه دار.</li>
          <li class="warn">خودِ این اپ نمی‌تواند با این کانفیگ‌ها تونل بزند؛ آن‌ها مال کلاینت‌های VPN مثل v2rayNG/Hiddify/NekoBox هستند.</li>
        </ul>
      </div>
    </details>
    <p class="sub" style="margin-top:12px;color:#5d7295">منبع دلخواهت را هم می‌توانی بده: /api/configs?url=…&amp;raw=1 — هر نشانی اشتراک عمومی از گیت‌هاب.</p>
  </div>
</main>
<script>
(function(){
'use strict';
function $(id){return document.getElementById(id);}
var srcsEl=$('srcs'),listEl=$('list'),statusEl=$('status'),busyEl=$('busy'),summaryEl=$('summary');
var cur=null,busy=false;
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
var COLORS={vmess:'#7c3aed',vless:'#0ea5e9',trojan:'#f43f5e',ss:'#64748b',ssr:'#64748b',
  hysteria:'#f59e0b',hysteria2:'#f59e0b',tuic:'#22d3ee',socks:'#94a3b8',wireguard:'#84cc16',
  juicity:'#a78bfa',anytls:'#fb923c'};
var SRC=[];
function renderSrcs(){
  var h='';
  for(var i=0;i<SRC.length;i++){
    var s=SRC[i];
    h+='<button class="src'+(cur&&cur.id===s.id?' on':'')+'" data-id="'+esc(s.id)+'">'
      +'<b>'+esc(s.name)+'</b><small>'+esc(s.repo)+'</small>'
      +'<small><span class="dot'+(s.cached?' on':'')+'"></span>'+(s.cached?'در کش':'')+'</small></button>';
  }
  srcsEl.innerHTML=h;
}
function setStatus(t){statusEl.textContent=t;}
function renderSummary(d){
  var h='<span class="bdg total">'+d.total+' کانفیگ</span>';
  var keys=Object.keys(d.protocols);
  for(var i=0;i<keys.length;i++){
    var k=keys[i];
    h+='<span class="bdg '+k+'">'+k.toUpperCase()+' × '+d.protocols[k]+'</span>';
  }
  h+='<span id="status">'+esc(d.cached?'از کش (تازه '+new Date(d.cachedAt||Date.now()).toLocaleTimeString('fa-IR')+')':('آمد در '+d.ms+' میلی‌ثانیه'))+'</span>';
  summaryEl.innerHTML=h;
  $('bSub').disabled=false;$('bRand').disabled=false;$('bAll').disabled=false;
}
function renderList(d){
  var h='';
  for(var i=0;i<d.list.length;i++){
    var c=d.list[i];
    h+='<div class="cfg"><span class="pr" style="background:'+(COLORS[c.p]||'#334155')+'">'+esc(c.p.toUpperCase())+'</span>'
      +'<span class="tt" title="'+esc(c.u)+'">'+esc(c.t)+'</span>'
      +'<span class="hh">'+esc(c.h)+'</span>'
      +'<button class="cp" data-i="'+i+'">کپی</button></div>';
  }
  listEl.innerHTML=h;
  listEl._data=d.list;
}
function load(id){
  if(busy)return;
  busy=true;cur={id:id};
  renderSrcs();
  listEl.innerHTML='';summaryEl.innerHTML='<span id="status">در حال دریافت…</span>';
  $('bSub').disabled=true;$('bRand').disabled=true;$('bAll').disabled=true;
  busyEl.style.display='block';
  fetch('/api/configs?src='+encodeURIComponent(id),{cache:'no-store'})
    .then(function(r){return r.json();})
    .then(function(d){
      busyEl.style.display='none';busy=false;
      if(!d.ok){summaryEl.innerHTML='<span id="status" style="color:#fb7185">خطا: '+esc(d.error||'؟')+' — منبع دیگری را امتحان کن</span>';renderSrcs();return;}
      renderSummary(d);renderList(d);renderSrcs();
    })
    .catch(function(){
      busyEl.style.display='none';busy=false;
      summaryEl.innerHTML='<span id="status" style="color:#fb7185">ارتباط برقرار نشد — دوباره تلاش کن</span>';
    });
}
srcsEl.addEventListener('click',function(e){
  var b=e.target.closest('.src');if(!b)return;
  load(b.getAttribute('data-id'));
});
listEl.addEventListener('click',function(e){
  var b=e.target.closest('.cp');if(!b)return;
  var data=listEl._data||[];
  var c=data[Number(b.getAttribute('data-i'))];
  if(!c)return;
  copy(c.u,'کانفیگ کپی شد');
});
function copy(txt,msg){
  function note(m){setStatus(m);setTimeout(function(){setStatus('');},2600);}
  function legacy(){
    var ta=document.createElement('textarea');
    ta.value=txt;ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.select();
    try{document.execCommand('copy');note(msg);}catch(e){note('کپی نشد — دستی کپی کن');}
    ta.remove();
  }
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(function(){note(msg);},function(){legacy();});
  }else legacy();
}
$('bSub').onclick=function(){
  if(!cur)return;
  var u=location.origin+'/api/configs?src='+encodeURIComponent(cur.id)+'&raw=1';
  copy(u,'نشانی اشتراک کپی شد — در v2rayNG جای‌گذاری کن');
};
$('bRand').onclick=function(){
  var data=listEl._data||[];
  if(!data.length)return;
  var copy2=data.slice();
  for(var i=copy2.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1));var t=copy2[i];copy2[i]=copy2[j];copy2[j]=t;}
  copy(copy2.slice(0,10).map(function(x){return x.u;}).join('\\n'),'۱۰ کانفیگ تصادفی کپی شد');
};
$('bAll').onclick=function(){
  var data=listEl._data||[];
  if(!data.length)return;
  copy(data.map(function(x){return x.u;}).join('\\n'),data.length+' کانفیگ کپی شد');
};
$('sh').onclick=function(){if(cur)load(cur.id);};
/* شروع: فهرست منبع‌ها */
fetch('/api/configs',{cache:'no-store'})
  .then(function(r){return r.json();})
  .then(function(d){
    if(d&&d.ok){SRC=d.sources||[];renderSrcs();
      if(SRC.length)load(SRC[0].id);}
  })
  .catch(function(){setStatus('فهرست منبع‌ها نیامد — دوباره باز کن');});
})();
</script>
</body>
</html>`;
