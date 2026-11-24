#!/usr/bin/env node
/**
 * تست دودی وب‌پروکسی (server.js) — بعد از هر تغییر اجرا شود:
 *   node scripts/smoke.mjs
 *
 * چیزهایی که بعد از بازبینی انتقادی باید همیشه کار کنند:
 * امنیت SSRF (فرم‌های عددی، ریدایرکت، DNS)، جدایی نشست‌ها، قفل Origin
 * روی API تغییر IP، استریم صفحات بزرگ، ورودی‌های خراب.
 */
'use strict';
import { spawn } from 'node:child_process';
import http from 'node:http';

const PORT = 3993;           // پروکسی تحت تست (حالت امن — SSRF بلاک)
const PORT2 = 3995;          // پروکسی با ALLOW_PRIVATE=true برای تست‌های کارکردی لوکال
const ORIGIN_PORT = 3994;    // «سایت مقصد» ساختگی برای تست‌های آفلاین
const BASE = `http://127.0.0.1:${PORT}`;
const BASE2 = `http://127.0.0.1:${PORT2}`;

let PASS = 0, FAIL = 0;
const ok = (name, cond, extra) => {
  if (cond) { PASS++; console.log('  PASS', name); }
  else { FAIL++; console.log('  FAIL', name, extra === undefined ? '' : ('— ' + JSON.stringify(extra).slice(0, 200))); }
};

/* ---------- سرور مقصد ساختگی ---------- */
const origin = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/set') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'secret=XYZ; Path=/' });
    return res.end('<html><body>cookie set</body></html>');
  }
  if (u.pathname === '/echo') {
    return res.end('COOKIE=[' + (req.headers.cookie || '') + ']');
  }
  if (u.pathname === '/redir-inside') {
    res.writeHead(302, { location: `http://127.0.0.1:${ORIGIN_PORT}/echo` });
    return res.end();
  }
  if (u.pathname === '/big') {
    const chunk = 'A'.repeat(65536);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    for (let i = 0; i < 260; i++) res.write(chunk); // ~۱۷MB > سقف بازنویسی
    res.end('<p id="end">TAIL-MARKER-OK</p>');
    return;
  }
  if (u.pathname === '/charset') {
    res.writeHead(200, { 'content-type': 'text/html' }); // بدون charset
    return res.end('<html><head><meta charset="utf-8"></head><body>سلام دنیا</body></html>');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<html><head><title>Target</title></head><body><a href="/page2">link</a></body></html>');
});
await new Promise((r) => origin.listen(ORIGIN_PORT, '127.0.0.1', r));

/* ---------- اجرای سرورهای تحت تست ---------- */
const child = spawn('node', ['server.js'], {
  cwd: '/home/z/my-project/web-proxy',
  env: { ...process.env, PORT: String(PORT), RATE_LIMIT_PER_MIN: '600', PROXY_TIMEOUT_MS: '8000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
const child2 = spawn('node', ['server.js'], {
  cwd: '/home/z/my-project/web-proxy',
  env: { ...process.env, PORT: String(PORT2), ALLOW_PRIVATE: 'true', RATE_LIMIT_PER_MIN: '600', PROXY_TIMEOUT_MS: '8000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child2.stderr.on('data', (d) => process.stderr.write('[srv2] ' + d));
await new Promise((r) => setTimeout(r, 1800));

async function req(path, opts, base) {
  const r = await fetch((base || BASE) + path, { redirect: 'manual', ...opts });
  return { status: r.status, headers: r.headers, text: () => r.text(), setCookies: r.headers.getSetCookie ? r.headers.getSetCookie() : [] };
}

try {
  console.log('— صفحات داخلی');
  const home = await req('/');
  ok('shell 200', home.status === 200);
  ok('shell: کوکی نشست px_sid ست می‌شود', home.setCookies.some((c) => c.startsWith('px_sid=')));
  const sid = (home.setCookies.find((c) => c.startsWith('px_sid=')) || '').split('=')[1].split(';')[0];
  ok('px_sid مقدار معتبر دارد', /^[a-f0-9]{32}$/.test(sid), sid);
  const health = await req('/health');
  ok('/health 200', health.status === 200);

  console.log('— پروکسی بازنویسی (سرور دوم با ALLOW_PRIVATE — مقصد لوکال مجاز)');
  const home2 = await req('/', {}, BASE2);
  const sid2 = (home2.setCookies.find((c) => c.startsWith('px_sid=')) || '').split('=')[1].split(';')[0];
  const page1 = await req(`/proxy?url=${encodeURIComponent(`http://127.0.0.1:${ORIGIN_PORT}/`)}`, { headers: { cookie: 'px_sid=' + sid2 } }, BASE2);
  ok('صفحه مقصد 200', page1.status === 200);
  const t1 = await page1.text();
  ok('لینک‌ها بازنویسی می‌شوند', t1.includes('/proxy?url='), t1.slice(0, 120));

  const cs = await req(`/proxy?url=${encodeURIComponent(`http://127.0.0.1:${ORIGIN_PORT}/charset`)}`, { headers: { cookie: 'px_sid=' + sid2 } }, BASE2);
  const csText = await cs.text();
  ok('charset از <meta> تشخیص داده می‌شود (فارسی سالم)', csText.includes('سلام دنیا'), csText.slice(0, 100));

  console.log('— امنیت SSRF');
  const ssrfCases = [
    `http://127.0.0.1:${ORIGIN_PORT}/echo`,
    'http://localhost/echo',
    'http://2130706433/echo',
    'http://0x7f.1/echo',
    'http://0177.0.0.1/echo',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://[::ffff:127.0.0.1]/',
    'http://metadata.google.internal/',
  ];
  for (const t of ssrfCases) {
    const r = await req('/proxy?url=' + encodeURIComponent(t));
    ok('بلاک: ' + t, r.status === 403, r.status);
  }
  const viaRedir = await req(`/proxy?url=${encodeURIComponent(`http://127.0.0.1:${ORIGIN_PORT}/redir-inside`)}`);
  ok('بلاک: ریدایرکت به آدرس داخلی (SSRF دومرحله‌ای)', viaRedir.status === 403, viaRedir.status);

  console.log('— جدایی نشست‌ها (رفع اشتراک کوکی بین کاربران)');
  const homeB = await req('/', {}, BASE2);
  const sidB = (homeB.setCookies.find((c) => c.startsWith('px_sid=')) || '').split('=')[1].split(';')[0];
  ok('کاربر دوم sid متفاوت می‌گیرد', sidB && sidB !== sid2);
  await req(`/proxy?url=${encodeURIComponent(`http://127.0.0.1:${ORIGIN_PORT}/set`)}`, { headers: { cookie: 'px_sid=' + sid2 } }, BASE2);
  const echoA = await (await req(`/proxy?url=${encodeURIComponent(`http://127.0.0.1:${ORIGIN_PORT}/echo`)}`, { headers: { cookie: 'px_sid=' + sid2 } }, BASE2)).text();
  const echoB = await (await req(`/proxy?url=${encodeURIComponent(`http://127.0.0.1:${ORIGIN_PORT}/echo`)}`, { headers: { cookie: 'px_sid=' + sidB } }, BASE2)).text();
  ok('کاربر الف کوکی خودش را می‌بیند', echoA.includes('secret=XYZ'), echoA);
  ok('کاربر ب کوکی الف را نمی‌بیند', !echoB.includes('secret=XYZ'), echoB);

  console.log('— استریم صفحات بزرگ (رفع باگ قطع صفحه)');
  const big = await req(`/proxy?url=${encodeURIComponent(`http://127.0.0.1:${ORIGIN_PORT}/big`)}`, { headers: { cookie: 'px_sid=' + sid2 } }, BASE2);
  const bigText = await big.text();
  ok('صفحه ۱۷MB کامل می‌رسد (TAIL هست)', bigText.includes('TAIL-MARKER-OK'), 'len=' + bigText.length);

  console.log('— قفل Origin روی API تغییر IP');
  const evil = await req('/_ip/rotate', { method: 'POST', headers: { origin: 'https://evil.example' } });
  ok('POST /_ip/rotate از مبدأ غریب → 403', evil.status === 403, evil.status);
  const evilMode = await req('/_ip/mode', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'pool' }) });
  ok('POST /_ip/mode از مبدأ غریب → 403', evilMode.status === 403, evilMode.status);
  const goodMode = await req('/_ip/mode', { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) });
  ok('POST /_ip/mode از مبدأ خودمان → 200', goodMode.status === 200, goodMode.status);
  const st = JSON.parse(await (await req('/_ip')).text());
  ok('GET /_ip: supported=true (undici نصب است)', st.supported === true);
  const manual = await req('/_ip/mode', { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'manual', proxyUrl: 'http://user:secret123@1.2.3.4:8080' }) });
  const manualBody = JSON.parse(await manual.text());
  ok('پروکسی شخصی با احراز هویت پذیرفته می‌شود', manualBody.ok === true, manualBody);
  ok('رمز پروکسی در پاسخ ماسک می‌شود', manualBody.manualUrl === 'http://user:***@1.2.3.4:8080', manualBody.manualUrl);
  await req('/_ip/mode', { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) });

  console.log('— ورودی‌های خراب');
  const badUri = await req('/%E2%98%B0%zz'); // decodeURI خراب — قبلاً ۵۰۰
  ok('مسیر خراب decodeURI باعث 500 نمی‌شود', badUri.status !== 500, badUri.status);
  const badUrl = await req('/proxy?url=' + encodeURIComponent('ftp://x/'));
  ok('شماه ftp رد می‌شود', badUrl.status === 400, badUrl.status);
} catch (e) {
  FAIL++;
  console.log('  FAIL تست‌ها خطا خورد:', e.message);
} finally {
  child.kill('SIGTERM');
  child2.kill('SIGTERM');
  origin.close();
}

console.log(`\nنتیجه: ${PASS} PASS / ${FAIL} FAIL`);
process.exit(FAIL ? 1 : 0);
