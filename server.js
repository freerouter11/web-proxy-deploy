#!/usr/bin/env node
/**
 * وب‌پروکسی شخصی — نسخه Node.js (۲)
 *
 * مرورگر پروکسی حرفه‌ای با همان قابلیت‌های نسخه‌ی Cloudflare:
 * تب‌ها، تاریخچه، نشانک‌ها، سوییچ سرور، پشتیبانی یوتیوب (HLS)
 * و کش درون‌حافظه‌ای برای سرعت.
 *
 * ویژگی‌ها:
 *   - رابط «مرورگر» کامل + بازنویسی لینک‌ها/تصاویر/فرم‌ها
 *   - پچ سمت کلاینت: fetch/XHR/لینک‌های داینامیک هم از پروکسی رد می‌شوند
 *   - نگه‌داشتن کوکی‌های سایت مقصد در حافظه (ورود به سایت‌ها)
 *   - کش درون‌حافظه‌ای فایل‌های ایستا
 *   - بدون هیچ وابستگی خارجی — فقط Node.js نسخه ۱۸ به بالا
 *
 * اجرا:  node server.js
 */

'use strict';

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

import {
  AUTH_COOKIE, ORIGIN_COOKIE, MAX_BODY, MAX_REWRITE, UA, STRIP_HEADERS,
  esc, parseCookies, normalizeTarget, isBlockedHost,
  page, loginPage, errorPage, notFoundPage,
  rewriteHtml, rewriteCss,
  ytPlayerInfo, ytSearch, ytPlaylist, ytRouteFor, hlsRewrite, isGooglevideo,
  ytHomePage, ytSearchPage, ytPlaylistPage, ytPlayerPage,
  shellPage, newtabPage,
} from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------------------------- تنظیمات ---------------------------- */

// خواندن فایل .env در کنار پروژه (اگر وجود داشته باشد)
(function loadEnvFile() {
  try {
    const file = path.join(__dirname, '.env');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue;
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch (_) { /* نادیده گرفته می‌شود */ }
})();

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = String(process.env.PROXY_PASSWORD || '').trim();
const ALLOW_PRIVATE = String(process.env.ALLOW_PRIVATE || '').toLowerCase() === 'true';
const TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS || 30000);
const SECRET = crypto.randomBytes(32);
const HLS_JS = (() => {
  try { return fs.readFileSync(path.join(__dirname, 'hls.min.js'), 'utf8'); }
  catch (_) { return '/* hls.min.js not found */'; }
})();

/* --------------------------- کش درون‌حافظه‌ای --------------------------- */

const memCache = new Map(); // url -> {buf, headers, at}
const CACHE_TYPES = /^(image\/|video\/|audio\/|font\/|text\/css|application\/javascript|text\/javascript|application\/octet-stream|application\/pdf)/i;
const CACHE_MAX_BYTES = 96 * 1024 * 1024;
const CACHE_ITEM_MAX = 24 * 1024 * 1024;
let cacheBytes = 0;

function cacheGet(k) {
  const e = memCache.get(k);
  if (!e) return null;
  if (Date.now() - e.at > e.ttl * 1000) { memCache.delete(k); cacheBytes -= e.buf.length; return null; }
  return e;
}

function cachePut(k, buf, ctype, ttl) {
  if (buf.length > CACHE_ITEM_MAX) return;
  if (cacheBytes + buf.length > CACHE_MAX_BYTES) {
    for (const [key, e] of memCache) {
      memCache.delete(key); cacheBytes -= e.buf.length;
      if (cacheBytes + buf.length <= CACHE_MAX_BYTES) break;
    }
  }
  memCache.set(k, { buf, ctype, at: Date.now(), ttl });
  cacheBytes += buf.length;
}

function cacheTtlOf(headers) {
  const cc = headers['cache-control'] || '';
  const m = /max-age\s*=\s*(\d+)/i.exec(cc);
  if (m) return Math.min(Number(m[1]) || 1800, 21600);
  return 1800;
}

/* --------------------------- ابزارها --------------------------- */

function sendHtml(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex',
  });
  res.end(body);
}

function readBody(req, limit) {
  limit = limit || MAX_BODY;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('حجم بدنه درخواست بیش از حد مجاز بود')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ---------------------- جار کوکی (حافظه‌ای) ---------------------- */

const cookieJar = new Map(); // origin -> Map(name -> value)

function jarAdd(origin, setCookies) {
  if (!setCookies || !setCookies.length) return;
  let bucket = cookieJar.get(origin);
  if (!bucket) { bucket = new Map(); cookieJar.set(origin, bucket); }
  for (const sc of setCookies) {
    const pair = String(sc).split(';')[0];
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    const exp = /expires\s*=\s*([^;]+)/i.exec(sc);
    if (exp && new Date(exp[1]).getTime() <= Date.now()) bucket.delete(name);
    else if (!/^\s*deleted\s*$/i.test(value)) bucket.set(name, value);
    if (bucket.size > 80) bucket.delete(bucket.keys().next().value);
  }
}

function jarCookie(origin) {
  const bucket = cookieJar.get(origin);
  if (!bucket || !bucket.size) return null;
  return [...bucket].map(([k, v]) => k + '=' + v).join('; ');
}

/* ------------------------- واکشی از مقصد ------------------------- */

const FWD_HEADERS = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'sec-ch-ua-platform-version', 'sec-ch-ua-full-version-list', 'sec-ch-ua-model', 'sec-ch-ua-arch',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user', 'dnt', 'upgrade-insecure-requests'];

async function fetchTarget(targetUrl, method, reqHeaders, bodyBuf) {
  let url = targetUrl;
  let m = method;
  let buf = bodyBuf;
  let resp = null;

  for (let hop = 0; hop < 6; hop++) {
    const uu = new URL(url);
    const headers = {
      'user-agent': reqHeaders['user-agent'] || UA,
      'accept': reqHeaders['accept'] || '*/*',
      'accept-language': reqHeaders['accept-language'] || 'fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7',
      'accept-encoding': 'gzip, deflate, br',
      'referer': uu.origin + '/',
    };
    for (const h of FWD_HEADERS) {
      if (reqHeaders[h]) headers[h] = reqHeaders[h];
    }
    if (reqHeaders.range) headers.range = reqHeaders.range;
    if (reqHeaders['if-none-match']) headers['if-none-match'] = reqHeaders['if-none-match'];
    if (reqHeaders['if-modified-since']) headers['if-modified-since'] = reqHeaders['if-modified-since'];
    const jc = jarCookie(uu.origin);
    if (jc) headers.cookie = jc;
    if (buf && m !== 'GET' && m !== 'HEAD') {
      headers['content-type'] = reqHeaders['content-type'] || 'application/octet-stream';
    }

    resp = await fetch(url, {
      method: m,
      headers,
      body: (m === 'GET' || m === 'HEAD') ? undefined : buf,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    jarAdd(uu.origin, resp.headers.getSetCookie ? resp.headers.getSetCookie() : (resp.headers.get('set-cookie') ? [resp.headers.get('set-cookie')] : []));

    const loc = resp.headers.get('location');
    if (resp.status >= 300 && resp.status < 400 && loc) {
      url = new URL(loc, url).href;
      if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && m === 'POST')) {
        m = 'GET';
        buf = undefined;
      }
      continue;
    }
    return { resp, url };
  }
  return { resp, url };
}

/* ------------------------- پروکسی HLS یوتیوب ------------------------- */

async function hlsRequest(req, res, u) {
  const key = 'hls:' + u;
  const cached = req.method === 'GET' && !req.headers.range ? cacheGet(key) : null;
  if (cached) {
    res.writeHead(200, { 'content-type': cached.ctype, 'cache-control': 'public, max-age=' + Math.max(60, cached.ttl - 60), 'x-px-cache': 'HIT', 'x-robots-tag': 'noindex', 'accept-ranges': 'bytes' });
    return res.end(cached.buf);
  }

  const headers = {
    'user-agent': 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)',
    'referer': 'https://www.youtube.com/',
  };
  if (req.headers.range) headers.range = req.headers.range;

  let resp;
  try {
    resp = await fetch(u, { headers, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    return res.end('upstream error');
  }
  if (resp.status !== 200) {
    res.writeHead(resp.status, { 'content-type': resp.headers.get('content-type') || 'text/plain' });
    Readable.fromWeb(resp.body).pipe(res);
    return;
  }

  const ctype = resp.headers.get('content-type') || '';
  if (/mpegurl|m3u8/i.test(ctype) || /\/(hls_variant|hls_playlist)\//.test(u)) {
    const text = await resp.text();
    const out = hlsRewrite(text, resp.url || u);
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
    return res.end(out);
  }

  // سگمنت: بافر + کش + ارسال
  const chunks = [];
  let size = 0;
  let tooBig = false;
  for await (const c of resp.body) {
    size += c.length;
    if (size > CACHE_ITEM_MAX) { tooBig = true; break; }
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  const buf = Buffer.concat(chunks);
  const ttl = cacheTtlOf({});
  if (!tooBig) cachePut(key, buf, ctype, 21600);

  const h = {
    'content-type': ctype || 'application/octet-stream',
    'cache-control': 'public, max-age=' + (tooBig ? 1800 : 21600),
    'x-px-cache': 'MISS',
    'x-robots-tag': 'noindex',
    'accept-ranges': 'bytes',
  };
  const cr = resp.headers.get('content-range');
  if (cr) h['content-range'] = cr;
  res.writeHead(resp.status, h);
  res.end(buf);
  if (tooBig) {
    try { Readable.fromWeb(resp.body).pipe(res); } catch (_) { /* بسته شد */ }
  }
}

/* --------------------------- پروکسی اصلی --------------------------- */

async function proxyRequest(targetUrl, req, res, bodyBuf) {
  const method = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? req.method : 'GET';

  // کش ایستاها
  const cacheable = method === 'GET' && !req.headers.range;
  if (cacheable) {
    const hit = cacheGet('static:' + targetUrl);
    if (hit) {
      res.writeHead(200, { 'content-type': hit.ctype, 'cache-control': 'public, max-age=' + Math.max(60, hit.ttl - 60), 'x-px-cache': 'HIT', 'x-robots-tag': 'noindex', 'accept-ranges': 'bytes' });
      return res.end(hit.buf);
    }
  }

  let out;
  try {
    out = await fetchTarget(targetUrl, method, req.headers, bodyBuf);
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return sendHtml(res, 502, errorPage(502,
      timedOut ? 'مهلت اتصال به سایت مقصد تمام شد.' : 'اتصال به سایت مقصد برقرار نشد.',
      targetUrl, e && e.message));
  }

  const { resp, url: finalUrl } = out;
  const ctype = resp.headers.get('content-type') || '';
  const isHtml = /text\/html|application\/xhtml\+xml/i.test(ctype);
  const isCss = /text\/css/i.test(ctype);

  const headers = {};
  for (const [k, v] of resp.headers) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  headers['x-robots-tag'] = 'noindex';

  if (isHtml) {
    const dest = req.headers['sec-fetch-dest'];
    if (!dest || dest === 'document') {
      try {
        headers['set-cookie'] = ORIGIN_COOKIE + '=' + encodeURIComponent(new URL(finalUrl).origin) +
          '; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400';
      } catch (_) { /* نادیده گرفته می‌شود */ }
    }
  }

  if (resp.status === 204 || resp.status === 304 || method === 'HEAD') {
    res.writeHead(resp.status, headers);
    return res.end();
  }

  if (isHtml || isCss) {
    headers['content-type'] = isHtml ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8';
    if (isHtml) headers['cache-control'] = 'no-store'; // صفحه داینامیک؛ کش نشود
    const chunks = [];
    let size = 0;
    let tooBig = false;
    for await (const chunk of resp.body) {
      size += chunk.length;
      if (size > MAX_REWRITE) { tooBig = true; break; }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (!tooBig) {
      const buf = Buffer.concat(chunks);
      const cs = /charset\s*=\s*["']?([\w-]+)/i.exec(ctype);
      let dec;
      try { dec = new TextDecoder(cs ? cs[1] : 'utf-8'); } catch (_) { dec = new TextDecoder('utf-8'); }
      let text = dec.decode(buf);
      text = isHtml ? rewriteHtml(text, finalUrl) : rewriteCss(text, finalUrl);
      res.writeHead(resp.status, headers);
      return res.end(text);
    }
    res.writeHead(resp.status, headers);
    for (const c of chunks) res.write(c);
    Readable.fromWeb(resp.body).pipe(res);
    return;
  }

  // ایستا (عکس/فونت/اسکریپت/ویدیو): بافر + کش
  if (cacheable && resp.status === 200 && CACHE_TYPES.test(ctype) && !resp.headers.get('set-cookie')) {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    for await (const c of resp.body) {
      size += c.length;
      if (size > CACHE_ITEM_MAX) { tooBig = true; break; }
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    }
    if (!tooBig) {
      const buf = Buffer.concat(chunks);
      const ttl = cacheTtlOf(resp.headers);
      cachePut('static:' + targetUrl, buf, ctype, ttl);
      res.writeHead(200, {
        'content-type': ctype,
        'cache-control': 'public, max-age=' + ttl,
        'x-px-cache': 'MISS',
        'x-robots-tag': 'noindex',
        'accept-ranges': 'bytes',
      });
      return res.end(buf);
    }
    res.writeHead(resp.status, headers);
    for (const c of chunks) res.write(c);
    Readable.fromWeb(resp.body).pipe(res);
    return;
  }

  // محتوای باینری: مستقیم جریانی
  res.writeHead(resp.status, headers);
  if (!resp.body) return res.end();
  Readable.fromWeb(resp.body).pipe(res);
}

/* --------------------------- احراز هویت --------------------------- */

function authValue() {
  return crypto.createHmac('sha256', SECRET).update('web-proxy-auth-v1').digest('hex');
}

function authOk(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[AUTH_COOKIE] === authValue();
}

function handleLogin(req, res) {
  let data = '';
  req.on('data', (c) => {
    data += c;
    if (data.length > 10000) { res.writeHead(413); res.end(); req.destroy(); }
  });
  req.on('end', () => {
    let pass = '';
    try { pass = String(new URLSearchParams(data).get('password') || ''); } catch (_) { /* خالی */ }
    if (pass === PASSWORD) {
      res.writeHead(302, {
        'location': '/',
        'set-cookie': AUTH_COOKIE + '=' + authValue() + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000',
      });
      res.end();
    } else {
      sendHtml(res, 401, loginPage(true));
    }
  });
  req.on('error', () => { try { res.end(); } catch (_) { /* بسته شد */ } });
}

/* --------------------------- مسیریابی --------------------------- */

function favicon(res) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#0ea5e9'/><text x='32' y='44' font-size='32' text-anchor='middle' fill='white' font-family='Tahoma'>و</text></svg>`;
  res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' });
  res.end(svg);
}

async function handle(req, res) {
  if (req.method === 'CONNECT') { res.writeHead(405); return res.end(); }

  const host = req.headers.host || 'localhost';
  const u = new URL(req.url, 'http://' + host);
  const p = decodeURI(u.pathname);

  // قفل رمز
  if (PASSWORD) {
    if (!authOk(req)) {
      if (u.pathname === '/login' && req.method === 'POST') return handleLogin(req, res);
      if (u.pathname === '/login') return sendHtml(res, 200, loginPage(false));
      return sendHtml(res, 401, loginPage(false));
    }
  }

  /* ---------- مسیرهای داخلی ---------- */
  if (p === '/' || p === '/index.html') return sendHtml(res, 200, shellPage(!!PASSWORD));
  if (p === '/newtab') return sendHtml(res, 200, newtabPage());
  if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' }); return res.end('ok'); }
  if (u.pathname === '/login') { res.writeHead(302, { location: '/' }); return res.end(); }
  if (p === '/logout') {
    res.writeHead(302, { location: '/', 'set-cookie': AUTH_COOKIE + '=; Path=/; HttpOnly; Max-Age=0' });
    return res.end();
  }
  if (p === '/favicon.ico') return favicon(res);
  if (p === '/assets/hls.min.js') {
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    return res.end(HLS_JS);
  }

  /* ---------- مسیرهای یوتیوب ---------- */
  if (p === '/yt/' || p === '/yt') return sendHtml(res, 200, ytHomePage());
  if (p === '/yt/watch') {
    const v = (u.searchParams.get('v') || '').trim();
    if (!/^[\w-]{6,15}$/.test(v)) return sendHtml(res, 400, errorPage(400, 'شناسه‌ی ویدیو معتبر نیست.', v));
    try {
      const info = await ytPlayerInfo(v);
      return sendHtml(res, 200, ytPlayerPage(info));
    } catch (e) {
      return sendHtml(res, 502, errorPage(502, 'دریافت اطلاعات ویدیو از یوتیوب ممکن نشد.', 'https://www.youtube.com/watch?v=' + v, e && e.message));
    }
  }
  if (p === '/yt/results') {
    const q = (u.searchParams.get('q') || '').trim();
    if (!q) { res.writeHead(302, { location: '/yt/' }); return res.end(); }
    try {
      const videos = await ytSearch(q);
      return sendHtml(res, 200, ytSearchPage(videos, q));
    } catch (e) {
      return sendHtml(res, 502, errorPage(502, 'جستجو در یوتیوب ممکن نشد.', q, e && e.message));
    }
  }
  if (p === '/yt/playlist') {
    const listId = (u.searchParams.get('list') || '').trim();
    if (!/^[\w-]{10,64}$/.test(listId)) return sendHtml(res, 400, errorPage(400, 'شناسه‌ی پلی‌لیست معتبر نیست.', listId));
    try {
      const videos = await ytPlaylist(listId);
      return sendHtml(res, 200, ytPlaylistPage(videos, listId));
    } catch (e) {
      return sendHtml(res, 502, errorPage(502, 'دریافت پلی‌لیست ممکن نشد.', listId, e && e.message));
    }
  }
  if (p === '/yt/embed') {
    const v = (u.searchParams.get('v') || '').trim();
    if (!/^[\w-]{6,15}$/.test(v)) return sendHtml(res, 400, errorPage(400, 'شناسه‌ی ویدیو معتبر نیست.', v));
    return proxyRequest('https://www.youtube.com/embed/' + v + '?rel=0&hl=fa&color=white', req, res, undefined);
  }
  if (p === '/yt/api/hls') {
    const target = u.searchParams.get('u') || '';
    if (!target) { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('missing u'); }
    if (!isGooglevideo(target)) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('forbidden host'); }
    return hlsRequest(req, res, target);
  }

  /* ---------- پروکسی عمومی ---------- */
  let target = null;

  if (u.pathname === '/proxy') {
    target = u.searchParams.get('url');
    const extra = [...u.searchParams.entries()].filter(([k]) => k !== 'url');
    if (target && extra.length) {
      const t = new URL(normalizeTarget(target));
      for (const [k, v] of extra) t.searchParams.append(k, v);
      target = t.href;
    }
  } else {
    const direct = /^\/(https?:\/\/.+)$/.exec(u.pathname);
    if (direct) {
      let raw = direct[1];
      try { raw = decodeURIComponent(raw); } catch (_) { /* همان‌طور که هست */ }
      target = raw + u.search;
    } else {
      const cookies = parseCookies(req.headers.cookie);
      const origin = cookies[ORIGIN_COOKIE];
      if (origin) {
        try { target = new URL(p + u.search, origin).href; } catch (_) { target = null; }
      }
    }
  }

  if (!target) return sendHtml(res, 404, notFoundPage());

  target = normalizeTarget(target);

  let turl;
  try { turl = new URL(target); } catch (_) {
    return sendHtml(res, 400, errorPage(400, 'آدرس واردشده معتبر نیست.', target));
  }
  if (!/^https?:$/.test(turl.protocol)) {
    return sendHtml(res, 400, errorPage(400, 'فقط آدرس‌های http و https پشتیبانی می‌شوند.', target));
  }

  // یوتیوب → صفحه‌ی اختصاصی (فقط برای درخواست‌های صفحه؛ فایل‌های جانبی مستقیم پروکسی می‌شوند)
  const dest = req.headers['sec-fetch-dest'];
  const isDocReq = !dest || dest === 'document' || dest === 'iframe';
  const ytRoute = isDocReq ? ytRouteFor(turl) : null;
  if (ytRoute) { res.writeHead(302, { location: ytRoute }); return res.end(); }

  if (!ALLOW_PRIVATE && isBlockedHost(turl.hostname)) {
    return sendHtml(res, 403, errorPage(403, 'دسترسی به آدرس‌های داخلی/لوکال از طریق پروکسی مجاز نیست.', target));
  }

  const bodyBuf = (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')
    ? await readBody(req) : undefined;

  return proxyRequest(turl.href, req, res, bodyBuf);
}

/* --------------------------- اجرای سرور --------------------------- */

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    try {
      sendHtml(res, 500, errorPage(500, 'خطای داخلی سرور.', '', err && err.message));
    } catch (_) { /* اتصال بسته شده */ }
  });
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('پورت ' + PORT + ' در حال استفاده است. با متغیر محیطی PORT پورت دیگری انتخاب کنید.');
    process.exit(1);
  }
  console.error('خطای سرور:', err);
});

server.listen(PORT, () => {
  console.log('وب‌پروکسی شخصی (مرورگر پروکسی) اجرا شد.');
  console.log('  آدرس محلی: http://localhost:' + PORT);
  if (PASSWORD) console.log('  قفل رمز: فعال');
  else console.log('  هشدار: رمزی تنظیم نشده؛ برای سرور عمومی PROXY_PASSWORD را تنظیم کنید.');
});
