/**
 * وب‌پروکسی شخصی — نسخه Cloudflare Workers (۳٫۱ — پس از بازبینی انتقادی)
 *
 * اصلاحات این نسخه:
 *   - محافظت SSRF روی مقصد و «هر پرشِ ریدایرکت» (قبلاً کلاً وجود نداشت!)
 *   - جار کوکی برای هر نشست (px_sid) — قبلاً کوکی‌ها کلاً نگه داشته نمی‌شدند
 *     و ورود به سایت‌ها روی لایه‌ی Cloudflare عملاً کار نمی‌کرد (best-effort:
 *     هر isolate حافظه‌ی خودش را دارد و ممکن است بین درخواست‌ها خالی شود)
 *   - قفل API تغییر IP روی Origin (قبلاً CORS باز (*) بود)
 *   - محدودیت نرخ درخواست + قفل تلاش‌های ورود (حافظه‌ی هر isolate)
 *   - سقف بازنویسی ۴MB برای حفظ سهم CPU ورکر (سقف ۱۵MB ریسک تجاوز از
 *     محدودیت CPU پلن رایگان بود)
 *
 * ماژول‌های همراه: lib.mjs (منطق مشترک) و assets.js (کتابخانه‌ی hls.js)
 *
 * تنظیم رمز ورود: متغیر محیطی PROXY_PASSWORD در تنظیمات Worker.
 */

import {
  AUTH_COOKIE, ORIGIN_COOKIE, SID_COOKIE, MAX_BODY, MAX_REWRITE, UA, STRIP_HEADERS,
  esc, parseCookies, normalizeTarget, isBlockedHost, createCookieJar,
  page, loginPage, errorPage, notFoundPage,
  rewriteHtml, rewriteCss,
  ytPlayerInfo, ytSearch, ytPlaylist, ytRouteFor, hlsRewrite, isGooglevideo,
  ytHomePage, ytSearchPage, ytPlaylistPage, ytPlayerPage,
  shellPage, newtabPage,
} from './lib.mjs';
import { HLS_JS } from './assets.js';

/* --------------------------- کش Cloudflare --------------------------- */

const CACHE = (typeof caches !== 'undefined') ? caches.default : null; // در محیط تست Node در دسترس نیست
const CACHE_TYPES = /^(image\/|video\/|audio\/|font\/|text\/css|application\/javascript|text\/javascript|application\/octet-stream|application\/pdf)/i;
// سقف بازنویسی روی ورکر: پلن رایگان سهم CPU کمی دارد؛ ۱۵MB ریسک بود.
const WORKER_REWRITE_MAX = 4 * 1024 * 1024;

function cacheTtlOf(resp) {
  const cc = resp.headers.get('cache-control') || '';
  const m = /max-age\s*=\s*(\d+)/i.exec(cc);
  if (m) return Math.min(Number(m[1]) || 1800, 21600);
  return 1800;
}

function html(status, body) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

/* ------------------- نشست هر مرورگر + جار کوکی (best-effort) ------------------- */

const jar = createCookieJar(2000);

function sidOf(request) {
  const s = parseCookies(request.headers.get('cookie') || '')[SID_COOKIE];
  return /^[a-f0-9]{32}$/.test(s || '') ? s : '';
}

function newSid() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* ------------------- محدودیت نرخ (حافظه‌ی isolate) ------------------- */

const RATE_LIMIT = 300;      // در دقیقه برای هر IP — با env قابل تغییر نیست (ورکر بدون KV)
const IP_RATE_LIMIT = 30;
const buckets = new Map();   // "zone|ip" -> {t, n}
function rateLimited(ip, zone, limit) {
  const k = zone + '|' + ip;
  const now = Date.now();
  let b = buckets.get(k);
  if (!b || now - b.t >= 60000) {
    b = { t: now, n: 0 };
    buckets.set(k, b);
    if (buckets.size > 8000) {
      let i = 0;
      for (const kk of buckets.keys()) { buckets.delete(kk); if (++i >= 4000) break; }
    }
  }
  b.n++;
  return b.n > limit;
}

/* تلاش‌های ورود ناموفق — ۸ در ۱۰ دقیقه */
const loginFails = new Map();
function loginLimited(ip) {
  const e = loginFails.get(ip);
  if (!e) return false;
  if (Date.now() - e.at > 10 * 60 * 1000) { loginFails.delete(ip); return false; }
  return e.n >= 8;
}

/* مقایسه‌ی زمان-ثابت رمز */
async function safeEq(a, b) {
  const enc = new TextEncoder();
  const d = async (s) => {
    const g = await crypto.subtle.digest('SHA-256', enc.encode(String(s)));
    return [...new Uint8Array(g)].map((x) => x.toString(16).padStart(2, '0')).join('');
  };
  return (await d(a)) === (await d(b));
}

async function authValue(env) {
  const data = new TextEncoder().encode('web-proxy-auth-v1:' + String((env && env.PROXY_PASSWORD) || ''));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function handleLogin(request, env, password, ip) {
  if (loginLimited(ip)) {
    return html(429, loginPage('تلاش‌های ناموفق زیاد بود؛ ۱۰ دقیقه صبر کن.'));
  }
  let pass = '';
  try { const fd = await request.formData(); pass = String(fd.get('password') || ''); } catch (_) { /* خالی */ }
  if (await safeEq(pass, password)) {
    loginFails.delete(ip);
    return new Response(null, {
      status: 302,
      headers: {
        'location': '/',
        'set-cookie': AUTH_COOKIE + '=' + (await authValue(env)) + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000',
      },
    });
  }
  const e = loginFails.get(ip) || { n: 0, at: Date.now() };
  e.n++; e.at = Date.now();
  loginFails.set(ip, e);
  if (loginFails.size > 3000) { let i = 0; for (const k of loginFails.keys()) { loginFails.delete(k); if (++i >= 1500) break; } }
  return html(401, loginPage(true));
}

/* ------------------------------ مسیریابی ------------------------------ */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      // decodeURI روی مسیرهای خراب Exception می‌انداخت — ۵۰۰ می‌داد
      let path;
      try { path = decodeURI(url.pathname); } catch (_) { path = url.pathname; }
      const PASSWORD = String((env && env.PROXY_PASSWORD) || '').trim();
      const cip = request.headers.get('cf-connecting-ip') || 'local';
      const sid = sidOf(request);
      const selfHost = url.host;

      // محدودیت نرخ کلی (پروکسی + API) — ضد سوءاستفاده
      if (rateLimited(cip, 'px', RATE_LIMIT)) {
        return html(429, errorPage(429, 'درخواست‌های زیادی می‌فرستی؛ یک دقیقه صبر کن.', ''));
      }

      // قفل رمز
      if (PASSWORD) {
        const cookies = parseCookies(request.headers.get('cookie') || '');
        if (cookies[AUTH_COOKIE] !== (await authValue(env))) {
          if (url.pathname === '/login') {
            if (request.method === 'POST') return handleLogin(request, env, PASSWORD, cip);
            return html(200, loginPage(false));
          }
          return html(401, loginPage(false));
        }
      }

      /* ---------- مسیرهای داخلی ---------- */
      if (path === '/' || path === '/index.html') {
        // نشست مرورگر از اولین صفحه سِت می‌شود
        const sc = [SID_COOKIE + '=' + (sid || newSid()) + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000'];
        return new Response(shellPage(!!PASSWORD), {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-robots-tag': 'noindex',
            'set-cookie': sc,
          },
        });
      }
      if (path === '/newtab') return html(200, newtabPage());
      if (path === '/health') return new Response('ok', { status: 200, headers: { 'access-control-allow-origin': '*' } });
      /* لایه‌ی Cloudflare نمی‌تواند از پروکسی خروجی استفاده کند؛ پنل «تغییر IP»
         این را می‌بیند و کاربر را به لایه‌ی Node (Railway/Render) راهنمایی می‌کند.
         قفل Origin: CORS باز حذف شد — سایت‌های دیگر به این API دسترسی ندارند. */
      if (path === '/_ip' || path === '/_ip/rotate' || path === '/_ip/mode' || path === '/_ip/test') {
        const ipJson = {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        };
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: ipJson });
        if (request.method === 'POST') {
          // فقط مبدأ خود سرور (پنل پوسته از طریق /proxy خودش می‌رود)
          const orig = request.headers.get('origin');
          if (orig) {
            try { if (new URL(orig).host !== selfHost) return new Response('forbidden origin', { status: 403, headers: ipJson }); } catch (_) { return new Response('forbidden origin', { status: 403, headers: ipJson }); }
          }
        }
        if (path === '/_ip/test') {
          // تست زنده: IP خروجی خود ورکر را نشان می‌دهد (چرخش روی این لایه ممکن نیست)
          let ip = '', country = '', ok = false;
          try {
            const r = await fetch('https://ipwho.is/', { headers: { 'user-agent': UA } });
            if (r.ok) { const j = await r.json(); ip = String(j.ip || ''); country = String(j.country || ''); ok = !!ip; }
          } catch (_) { /* پایین */ }
          if (!ip) {
            try {
              const r2 = await fetch('https://api.ipify.org/?format=json');
              if (r2.ok) { ip = String((await r2.json()).ip || ''); ok = !!ip; }
            } catch (_) { /* پایین */ }
          }
          return new Response(JSON.stringify({ supported: false, mode: 'direct', ok, ip, country }), { status: 200, headers: ipJson });
        }
        return new Response(JSON.stringify({ supported: false, mode: 'direct' }), { status: 200, headers: ipJson });
      }
      if (url.pathname === '/login') return Response.redirect(url.origin + '/', 302);
      if (path === '/logout') {
        return new Response(null, {
          status: 302,
          headers: { 'location': '/', 'set-cookie': AUTH_COOKIE + '=; Path=/; Max-Age=0' },
        });
      }
      if (path === '/favicon.ico') {
        const svg = faviconSvg();
        return new Response(svg, {
          status: 200,
          headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' },
        });
      }
      if (path === '/assets/hls.min.js') {
        return new Response(HLS_JS, {
          status: 200,
          headers: {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'public, max-age=31536000, immutable',
          },
        });
      }

      /* ---------- مسیرهای یوتیوب ---------- */
      if (path === '/yt/' || path === '/yt') return html(200, ytHomePage());
      if (path === '/yt/watch') {
        const v = (url.searchParams.get('v') || '').trim();
        if (!/^[\w-]{6,15}$/.test(v)) return html(400, errorPage(400, 'شناسه‌ی ویدیو معتبر نیست.', v));
        try {
          const ytCookie = jar.cookie(sid, 'https://www.youtube.com') || '';
          const info = await ytPlayerInfo(v, { cookie: ytCookie });
          return html(200, ytPlayerPage(info));
        } catch (e) {
          return html(502, errorPage(502, 'دریافت اطلاعات ویدیو از یوتیوب ممکن نشد.', 'https://www.youtube.com/watch?v=' + v, e && e.message));
        }
      }
      if (path === '/yt/results') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return Response.redirect(url.origin + '/yt/', 302);
        try {
          const videos = await ytSearch(q);
          return html(200, ytSearchPage(videos, q));
        } catch (e) {
          return html(502, errorPage(502, 'جستجو در یوتیوب ممکن نشد.', q, e && e.message));
        }
      }
      if (path === '/yt/playlist') {
        const listId = (url.searchParams.get('list') || '').trim();
        if (!/^[\w-]{10,64}$/.test(listId)) return html(400, errorPage(400, 'شناسه‌ی پلی‌لیست معتبر نیست.', listId));
        try {
          const videos = await ytPlaylist(listId);
          return html(200, ytPlaylistPage(videos, listId));
        } catch (e) {
          return html(502, errorPage(502, 'دریافت پلی‌لیست ممکن نشد.', listId, e && e.message));
        }
      }
      if (path === '/yt/embed') {
        const v = (url.searchParams.get('v') || '').trim();
        if (!/^[\w-]{6,15}$/.test(v)) return html(400, errorPage(400, 'شناسه‌ی ویدیو معتبر نیست.', v));
        return await proxyFetch(request, 'https://www.youtube.com/embed/' + v + '?rel=0&hl=fa&color=white', ctx, sid);
      }
      if (path === '/yt/api/hls') {
        const u = url.searchParams.get('u') || '';
        if (!u) return new Response('missing u', { status: 400 });
        if (!isGooglevideo(u)) return new Response('forbidden host', { status: 403 });
        return hlsFetch(request, u, ctx);
      }

      /* ---------- پروکسی عمومی ---------- */
      let target = null;

      if (url.pathname === '/proxy') {
        target = url.searchParams.get('url');
        const extra = [...url.searchParams.entries()].filter(([k]) => k !== 'url');
        if (target && extra.length) {
          const t = new URL(normalizeTarget(target));
          for (const [k, v] of extra) t.searchParams.append(k, v);
          target = t.href;
        }
      } else {
        const direct = /^\/(https?:\/\/.+)$/.exec(url.pathname);
        if (direct) {
          let raw = direct[1];
          try { raw = decodeURIComponent(raw); } catch (_) { /* همان‌طور که هست */ }
          target = raw + url.search;
        } else {
          const cookies = parseCookies(request.headers.get('cookie') || '');
          const origin = cookies[ORIGIN_COOKIE];
          if (origin) {
            try { target = new URL(path + url.search, origin).href; } catch (_) { target = null; }
          }
        }
      }

      if (!target) return html(404, notFoundPage());

      target = normalizeTarget(target);

      let turl;
      try { turl = new URL(target); } catch (_) {
        return html(400, errorPage(400, 'آدرس واردشده معتبر نیست.', target));
      }
      if (!/^https?:$/.test(turl.protocol)) {
        return html(400, errorPage(400, 'فقط آدرس‌های http و https پشتیبانی می‌شوند.', target));
      }

      /* محافظت SSRF — نسخه‌ی قبلی ورکر این بررسی را کلاً نداشت! */
      if (isBlockedHost(turl.hostname)) {
        return html(403, errorPage(403, 'دسترسی به آدرس‌های داخلی/لوکال از طریق پروکسی مجاز نیست.', target));
      }

      // آدرس‌های یوتیوب فقط برای «صفحه‌ها» به مسیر اختصاصی هدایت می‌شوند؛
      // فایل‌های جانبی (js/css/img) باید از مسیر عادی پروکسی رد شوند.
      const dest = request.headers.get('sec-fetch-dest');
      const isDocReq = !dest || dest === 'document' || dest === 'iframe';
      const ytRoute = isDocReq ? ytRouteFor(turl) : null;
      if (ytRoute) return new Response(null, { status: 302, headers: { location: ytRoute } });

      return await proxyFetch(request, turl.href, ctx, sid);
    } catch (e) {
      return html(500, errorPage(500, 'خطای داخلی سرور.', '', e && e.message));
    }
  },
};

function faviconSvg() {
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#0ea5e9'/><text x='32' y='44' font-size='32' text-anchor='middle' fill='white' font-family='Tahoma'>و</text></svg>`;
}

/* ------------------------- پروکسی HLS یوتیوب ------------------------- */

async function hlsFetch(request, u, ctx) {
  const headers = {
    'user-agent': 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)',
    'referer': 'https://www.youtube.com/',
  };
  const range = request.headers.get('range');
  if (range) headers.range = range;

  // کش برای سگمنت‌ها (بازیابی سریع و کاهش بار)
  const cacheable = request.method === 'GET' && !range;
  const key = new Request('https://pxcache.internal/hls/' + u);
  if (cacheable && CACHE) {
    try {
      const hit = await CACHE.match(key);
      if (hit) {
        const h = new Headers(hit.headers);
        h.set('x-px-cache', 'HIT');
        return new Response(hit.body, { status: hit.status, headers: h });
      }
    } catch (_) { /* کش در دسترس نیست */ }
  }

  let resp;
  try {
    resp = await fetch(u, { headers, redirect: 'follow' });
  } catch (e) {
    return new Response('upstream error', { status: 502 });
  }
  if (resp.status !== 200) {
    return new Response(resp.body, { status: resp.status, headers: { 'content-type': resp.headers.get('content-type') || 'text/plain' } });
  }

  const ctype = resp.headers.get('content-type') || '';
  if (/mpegurl|m3u8/i.test(ctype) || /\/(hls_variant|hls_playlist)\//.test(u)) {
    // پلی‌لیست: بازنویسی آدرس‌ها به مسیر پروکسی
    const text = await resp.text();
    const out = hlsRewrite(text, resp.url || u);
    return new Response(out, {
      status: 200,
      headers: {
        'content-type': 'application/vnd.apple.mpegurl',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
      },
    });
  }

  // سگمنت ویدیو: جریانی + کش
  const out = new Headers();
  for (const [k, v] of resp.headers) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) out.set(k, v);
  }
  out.set('x-robots-tag', 'noindex');
  out.set('accept-ranges', 'bytes');

  if (cacheable && CACHE) {
    const len = Number(resp.headers.get('content-length') || '0');
    if (len > 0 && len <= 24 * 1024 * 1024) {
      const ttl = Math.min(cacheTtlOf(resp), 21600);
      const buf = await resp.arrayBuffer();
      ctx.waitUntil(CACHE.put(key, new Response(buf.slice(0), {
        status: 200,
        headers: { 'content-type': ctype, 'cache-control': 'public, max-age=' + ttl },
      })).catch(() => {}));
      const h = new Headers();
      h.set('content-type', ctype);
      h.set('cache-control', 'public, max-age=' + ttl);
      h.set('x-px-cache', 'MISS');
      h.set('accept-ranges', 'bytes');
      return new Response(buf, { status: 200, headers: h });
    }
  }
  return new Response(resp.body, { status: resp.status, headers: out });
}

/* --------------------------- پروکسی اصلی --------------------------- */

// هدرهای مرورگر که برای واقعی‌نمایی درخواست به مقصد فوروارد می‌شوند
// (ایراد قبلی: sec-ch-ua-mobile دو بار در فهرست بود)
const FWD_HEADERS = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'sec-ch-ua-platform-version', 'sec-ch-ua-full-version-list', 'sec-ch-ua-model', 'sec-ch-ua-arch',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user', 'dnt', 'upgrade-insecure-requests'];

async function proxyFetch(request, targetUrl, ctx, sid) {
  let method = request.method;
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    const cl = Number(request.headers.get('content-length') || '0');
    if (cl > MAX_BODY) return html(413, errorPage(413, 'حجم درخواست بیش از حد مجاز است.', targetUrl));
    body = await request.arrayBuffer();
  }
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) method = 'GET';

  /* کش کوتاه صفحه (۳۰ ثانیه): باز کردن دوباره‌ی همین صفحه بدون رفت‌وبرگشت به مبدأ و بدون بازنویسی مجدد.
     فقط صفحات عمومی کش می‌شوند (بدون کوکی شخصی و بدون set-cookie مبدأ). */
  if (method === 'GET' && CACHE) {
    try {
      const hit = await CACHE.match(new Request('https://pxcache.internal/page/' + targetUrl));
      if (hit) {
        const h = new Headers();
        h.set('content-type', 'text/html; charset=utf-8');
        h.set('cache-control', 'private, max-age=20, stale-while-revalidate=300');
        h.set('x-robots-tag', 'noindex');
        h.set('x-px-cache', 'HIT');
        h.append('set-cookie', SID_COOKIE + '=' + (sid || newSid()) + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000');
        const dest = request.headers.get('sec-fetch-dest');
        const fin = hit.headers.get('x-px-final');
        if ((!dest || dest === 'document') && fin) {
          try { h.append('set-cookie', ORIGIN_COOKIE + '=' + encodeURIComponent(new URL(fin).origin) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400'); } catch (_) { }
        }
        return new Response(await hit.text(), { status: 200, headers: h });
      }
    } catch (_) { /* کش خراب است؛ نادیده گرفته می‌شود */ }
  }

  /* ریدایرکت‌ها دستی دنبال می‌شوند تا «هر پرش» از نظر SSRR بررسی شود —
     قبلاً redirect:'follow' بود و مقصدِ ریدایرکت بدون بررسی می‌ماند. */
  let url = targetUrl;
  let resp = null;
  let personalized = false; // اگر کوکی سایت مقصد فرستاده شد، صفحه شخصی است و کش نمی‌شود
  for (let hop = 0; hop < 6; hop++) {
    const uu = new URL(url);
    if (isBlockedHost(uu.hostname)) {
      return html(403, errorPage(403, 'دسترسی به آدرس‌های داخلی/لوکال از طریق پروکسی مجاز نیست.', url));
    }
    const headers = {
      'user-agent': request.headers.get('user-agent') || UA,
      'accept': request.headers.get('accept') || '*/*',
      'accept-language': request.headers.get('accept-language') || 'fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7',
      'referer': uu.origin + '/',
    };
    for (const h of FWD_HEADERS) {
      const v = request.headers.get(h);
      if (v) headers[h] = v;
    }
    const range = request.headers.get('range');
    if (range) headers.range = range;
    if (request.headers.get('if-none-match')) headers['if-none-match'] = request.headers.get('if-none-match');
    // کوکی سایت مقصد از جار «همین نشست» (پشتیبانی ورود — best-effort روی ورکر)
    const jc = jar.cookie(sid, uu.origin);
    if (jc) { headers.cookie = jc; personalized = true; }
    if (body && method !== 'GET' && method !== 'HEAD') {
      const ct = request.headers.get('content-type');
      if (ct) headers['content-type'] = ct;
    }

    // کش فایل‌های ایستا (عکس/فونت/اسکریپت/ویدیو) — سرعت بارگیری مجدد چند برابر
    const isGet = method === 'GET' && !range && hop === 0;
    if (isGet && CACHE) {
      try {
        const key = new Request('https://pxcache.internal/static/' + url);
        const hit = await CACHE.match(key);
        if (hit) {
          const h = new Headers(hit.headers);
          h.set('x-px-cache', 'HIT');
          return new Response(hit.body, { status: hit.status, headers: h });
        }
      } catch (_) { /* کش در دسترس نیست */ }
    }

    try {
      resp = await fetch(url, { method, headers, body, redirect: 'manual' });
    } catch (e) {
      return html(502, errorPage(502, 'اتصال به سایت مقصد برقرار نشد.', url, e && e.message));
    }

    // کوکی‌های مقصد در جار همین نشست
    const rawSc = [];
    try {
      if (resp.headers.getSetCookie) for (const c of resp.headers.getSetCookie()) rawSc.push(c);
      else if (resp.headers.get('set-cookie')) rawSc.push(resp.headers.get('set-cookie'));
    } catch (_) { /* بدون کوکی */ }
    jar.add(sid, uu.origin, rawSc);

    const loc = resp.headers.get('location');
    if (resp.status >= 300 && resp.status < 400 && loc) {
      try { if (resp.body) await resp.body.cancel(); } catch (_) { /* بسته */ }
      url = new URL(loc, url).href;
      if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    break;
  }

  const ctype = resp.headers.get('content-type') || '';
  const isHtml = /text\/html|application\/xhtml\+xml/i.test(ctype);
  const isCss = /text\/css/i.test(ctype);
  const finalUrl = resp.url || url;

  const out = new Headers();
  for (const [k, v] of resp.headers) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) out.set(k, v);
  }
  out.set('x-robots-tag', 'noindex');

  // کوکی نشست مرورگر + مبدأ فعال — همیشه همراه پاسخ‌های سند
  const setCookies = [SID_COOKIE + '=' + (sid || newSid()) + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000'];
  if (isHtml) {
    const dest = request.headers.get('sec-fetch-dest');
    if (!dest || dest === 'document') {
      try {
        setCookies.push(ORIGIN_COOKIE + '=' + encodeURIComponent(new URL(finalUrl).origin) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400');
      } catch (_) { /* نادیده گرفته می‌شود */ }
    }
  }
  out.append('set-cookie', setCookies[0]);
  if (setCookies[1]) out.append('set-cookie', setCookies[1]);

  if (resp.status === 204 || resp.status === 304 || method === 'HEAD') {
    try { if (resp.body) await resp.body.cancel(); } catch (_) { /* بسته */ }
    return new Response(null, { status: resp.status, headers: out });
  }

  if (isHtml || isCss) {
    out.set('content-type', isHtml ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8');
    if (isHtml) out.set('cache-control', 'private, max-age=20, stale-while-revalidate=300'); // برگشت/جلو/بازخوانی فوری؛ تازگی ۲۰ ثانیه
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > WORKER_REWRITE_MAX || buf.byteLength > MAX_REWRITE) {
      return new Response(buf, { status: resp.status, headers: out }); // بدون بازنویسی (سقف CPU ورکر)
    }
    const cs = /charset\s*=\s*["']?([\w-]+)/i.exec(ctype);
    let dec;
    try { dec = new TextDecoder(cs ? cs[1] : 'utf-8'); } catch (_) { dec = new TextDecoder('utf-8'); }
    let text = dec.decode(buf);
    text = isHtml ? rewriteHtml(text, finalUrl) : rewriteCss(text, finalUrl);
    // کش کوتاه صفحه (۳۰ث) — فقط صفحات عمومی؛ کلید روی نشانی درخواستی و نهایی (ریدایرکت‌ها)
    if (isHtml && method === 'GET' && CACHE && resp.status === 200 && !personalized
      && !resp.headers.get('set-cookie') && text.length <= 768 * 1024 && !/https?:\/\/[^/@]+@/.test(targetUrl)) {
      const mk = () => new Response(text, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'x-px-final': finalUrl },
      });
      out.set('x-px-cache', 'MISS');
      ctx.waitUntil(CACHE.put(new Request('https://pxcache.internal/page/' + targetUrl), mk()).catch(() => {}));
      if (finalUrl !== targetUrl) {
        ctx.waitUntil(CACHE.put(new Request('https://pxcache.internal/page/' + finalUrl), mk()).catch(() => {}));
      }
    }
    return new Response(text, { status: resp.status, headers: out });
  }

  // محتوای باینری/ایستا: جریانی + کش ایستاها برای سرعت
  const isGet2 = method === 'GET' && !request.headers.get('range');
  if (isGet2 && CACHE && resp.status === 200 && CACHE_TYPES.test(ctype) && !resp.headers.get('set-cookie')) {
    const len = Number(resp.headers.get('content-length') || '0');
    if (len > 0 && len <= 24 * 1024 * 1024) {
      const ttl = cacheTtlOf(resp);
      const buf = await resp.arrayBuffer();
      ctx.waitUntil(CACHE.put(new Request('https://pxcache.internal/static/' + url), new Response(buf.slice(0), {
        status: 200,
        headers: { 'content-type': ctype, 'cache-control': 'public, max-age=' + ttl },
      })).catch(() => {}));
      const h = new Headers();
      h.set('content-type', ctype);
      h.set('cache-control', 'public, max-age=' + ttl);
      h.set('x-px-cache', 'MISS');
      h.set('x-robots-tag', 'noindex');
      return new Response(buf, { status: 200, headers: h });
    }
  }

  return new Response(resp.body, { status: resp.status, headers: out });
}
