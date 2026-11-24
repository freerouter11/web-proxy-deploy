/**
 * کتابخانه‌ی مشترک وب‌پروکسی — نسخه ۳٫۱ (پس از بازبینی انتقادی)
 *
 * این فایل بین نسخه‌ی Cloudflare Workers (worker.js) و نسخه‌ی
 * Node.js (server.js) مشترک است و شامل:
 *   - ابزارهای عمومی و صفحات پایه (ورود/خطا)
 *   - محافظت SSRF سخت‌گیرانه (فرم‌های عددی IPv4، IPv6 نگاشته، ریدایرکت‌ها)
 *   - جار کوکی «برای هر نشست» — کوکی‌های کاربران مختلف جدا از هم
 *   - موتور بازنویسی HTML/CSS + پچ سمت کلاینت (fetch/XHR/لینک‌های داینامیک)
 *   - پشتیبانی یوتیوب (Innertube API + پخش HLS)
 *   - رابط «مرورگر» با تب‌ها، تاریخچه، نشانک‌ها و سوییچ سرور
 */

/* ---------------------------- ثابت‌ها ---------------------------- */

const AUTH_COOKIE = 'px_auth';
const ORIGIN_COOKIE = 'px_origin';
const SID_COOKIE = 'px_sid';   // شناسه‌ی نشست هر مرورگر — کوکی‌ها و جار جدا برای هر کاربر
const MAX_BODY = 10 * 1024 * 1024;     // حداکثر حجم بدنه‌ی درخواست (۱۰ مگابایت)
const MAX_REWRITE = 15 * 1024 * 1024;  // حداکثر حجم بازنویسی HTML/CSS
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const STRIP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'content-length', 'content-encoding',
  'strict-transport-security', 'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'report-to', 'nel', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'permissions-policy', 'clear-site-data', 'set-cookie', 'service-worker', 'link',
]);

// دامنه‌های یوتیوب که به صفحه‌ی اختصاصی پروکسی هدایت می‌شوند
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be']);

/* --------------------------- ابزارهای عمومی --------------------------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch (_) { /* همان‌طور که هست */ }
    out[k] = v;
  }
  return out;
}

function fmtViews(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + ' میلیارد';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + ' میلیون';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + ' هزار';
  return String(n);
}

function fmtDur(sec) {
  sec = Number(sec) || 0;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h ? h + ':' + mm + ':' + ss : m + ':' + ss;
}

function normalizeTarget(t) {
  t = String(t || '').trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
  return 'https://' + t.replace(/^\/+/, '');
}

function _ipv4ToInt(h) {
  const p = h.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function _isPrivateIpv4(n) {
  const a = (n >>> 24) & 255, b = (n >>> 16) & 255;
  if (a === 0 || a === 10 || a === 127) return true;          // 0/8، 10/8، loopback
  if (a === 169 && b === 254) return true;                     // link-local (شامل 169.254.169.254 ابر)
  if (a === 172 && b >= 16 && b <= 31) return true;            // 172.16/12
  if (a === 192 && b === 168) return true;                     // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;           // CGNAT 100.64/10
  if (a === 192 && b === 0) return true;                       // 192.0.0/24 و 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true;        // بنچمارک
  if (a >= 224) return true;                                   // multicast و رزروشده
  return false;
}

/**
 * محافظت SSRF — نسخه‌ی سخت‌گیرانه.
 * ایراد نسخه‌ی قبلی: فرم‌های عددی IPv4 (مثل http://2130706433 = 127.0.0.1)،
 * هگز/اکتال، و IPv6 نگاشته (::ffff:127.0.0.1) از دست رد می‌شدند.
 * الان همه با نرمال‌سازی WHATWG URL + بازرسی دقیق بازه‌ها بلاک می‌شوند.
 */
function isBlockedHost(hostname) {
  let h = String(hostname || '').toLowerCase().trim().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') ||
      h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home') || h.endsWith('.arpa')) return true;
  // نرمال‌سازی فرم‌های عددی IPv4 (2130706433، 0x7f.1، 0177.0.0.1 و…) با پارسر WHATWG
  try {
    const u = h.includes(':') ? new URL('http://[' + h + ']/') : new URL('http://' + h + '/');
    const norm = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (norm && norm !== h) h = norm;
  } catch (_) { return true; } // بدشکل → بلاک
  const v4 = _ipv4ToInt(h);
  if (v4 !== null) return _isPrivateIpv4(v4);
  if (h.includes(':')) { // IPv6
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('::ffff:')) {                    // نگاشت IPv4
      const tail = h.slice(7);
      const m = _ipv4ToInt(tail);
      if (m !== null) return _isPrivateIpv4(m);
      return true;                                    // فرم hex نگاشت هم بلاک
    }
    if (/^f[cd]/.test(h)) return true;                // ULA fc00::/7
    if (/^fe[89ab]/.test(h)) return true;             // link-local fe80::/10
    if (/^ff/.test(h)) return true;                   // multicast
    if (/^2001:db8/.test(h)) return true;             // مستندسازی
    if (h.startsWith('64:ff9b:')) return true;        // NAT64 — قابل سوءاستفاده برای دور زدن
    return false;
  }
  if (/^\d+$/.test(h)) return true; // عدد بدون نقطه که تا اینجا نرمال نشده → مشکوک
  return false;
}

/* ------------------- جار کوکی «برای هر نشست» -------------------
 * ایراد جدی نسخه‌های قبلی: کوکی‌های همه‌ی کاربران در یک ظرفِ مشترکِ
 * «بر اساس مبدأ» نگه داشته می‌شد؛ یعنی اگر کاربر الف وارد سایتی شود،
 * کاربر ب با نشستِ الف آن سایت را می‌دید — روی استقرار عمومی فاجعه است.
 * الان هر مرورگر یک px_sid می‌گیرد و ظرف کوکی‌ها جدا است.
 * پشتیبانی از Domain= هم اضافه شد (ورود بین زیردامنه‌ها).
 */
function createCookieJar(limit) {
  const MAX = limit || 4000;
  const jar = new Map(); // "sid\u0000scope" -> Map(name -> value)
  const kOf = (sid, scope) => sid + '\u0000' + scope;
  function bucket(sid, scope) {
    const k = kOf(sid, scope);
    let b = jar.get(k);
    if (!b) {
      b = new Map();
      if (jar.size >= MAX) {
        const drop = Math.ceil(MAX / 8);
        let i = 0;
        for (const k2 of jar.keys()) { jar.delete(k2); if (++i >= drop) break; }
      }
      jar.set(k, b);
    }
    return b;
  }
  function add(sid, origin, setCookies) {
    if (!sid || !setCookies || !setCookies.length) return;
    let host = '';
    try { host = new URL(origin).hostname.toLowerCase(); } catch (_) { return; }
    for (const sc of setCookies) {
      const parts = String(sc).split(';');
      const pair = parts[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let domain = '';
      for (const attr of parts.slice(1)) {
        const m = /^\s*domain\s*=\s*(.+)/i.exec(attr);
        if (m) domain = m[1].trim().toLowerCase().replace(/^\.+/, '');
      }
      const exp = /expires\s*=\s*([^;]+)/i.exec(sc);
      const expired = exp ? (new Date(exp[1]).getTime() || 0) <= Date.now() : false;
      const scope = domain ? 'd:' + domain : 'o:' + origin;
      if (expired || /^\s*deleted\s*$/i.test(value)) {
        const b = jar.get(kOf(sid, scope));
        if (b) b.delete(name);
        continue;
      }
      if (domain && !(host === domain || host.endsWith('.' + domain))) continue; // دامنه‌ی جعلی
      const b = bucket(sid, scope);
      b.set(name, value);
      if (b.size > 80) b.delete(b.keys().next().value);
    }
  }
  function cookie(sid, origin) {
    if (!sid) return null;
    let host = '';
    try { host = new URL(origin).hostname.toLowerCase(); } catch (_) { return null; }
    const out = new Map();
    const ob = jar.get(kOf(sid, 'o:' + origin));
    if (ob) for (const [k, v] of ob) out.set(k, v);
    let p = host;
    while (p.includes('.')) {
      const db = jar.get(kOf(sid, 'd:' + p));
      if (db) for (const [k, v] of db) if (!out.has(k)) out.set(k, v);
      p = p.slice(p.indexOf('.') + 1);
    }
    if (!out.size) return null;
    return [...out].map(([k, v]) => k + '=' + v).join('; ');
  }
  return { add, cookie };
}

/* ------------------------- CSS پایه‌ی صفحات ------------------------- */

const BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:grid;place-items:center;padding:24px;color:#e7edf8;
  font-family:"Segoe UI",Tahoma,"Vazirmatn","Iranian Sans",sans-serif;
  background:#0b1220;
  background-image:radial-gradient(900px 500px at 85% -10%,rgba(56,189,248,.16),transparent 60%),
                   radial-gradient(700px 420px at 5% 110%,rgba(34,211,238,.12),transparent 60%)}
.card{width:100%;max-width:640px;background:rgba(17,26,46,.92);border:1px solid #22304d;border-radius:20px;
  padding:36px 32px;box-shadow:0 24px 60px rgba(0,0,0,.55)}
h1{font-size:25px;font-weight:700;margin-bottom:10px}
.sub{color:#93a5c4;font-size:14px;line-height:2;margin-bottom:22px}
.row{display:flex;gap:10px;flex-wrap:wrap}
input[type=text],input[type=password],input[type=search]{flex:1;min-width:220px;padding:14px 16px;border-radius:12px;border:1px solid #2a3a5c;
  background:#0c1526;color:#e7edf8;font-size:15px;outline:none;direction:ltr;text-align:left;font-family:inherit}
input:focus{border-color:#38bdf8;box-shadow:0 0 0 3px rgba(56,189,248,.2)}
button{padding:14px 22px;border-radius:12px;border:0;background:linear-gradient(135deg,#0ea5e9,#22d3ee);
  color:#04121f;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit}
button:hover{filter:brightness(1.09)}
.hint{margin-top:20px;color:#7f92b3;font-size:12.5px;line-height:2.2}
code{background:#0c1526;border:1px solid #22304d;padding:2px 8px;border-radius:6px;direction:ltr;display:inline-block;
  font-size:12px;color:#7dd3fc;word-break:break-all;text-align:left}
.err{color:#f87171;font-size:13px;margin-bottom:14px}
a{color:#7dd3fc;text-decoration:none}
a:hover{text-decoration:underline}
.corner{margin-top:24px}
`;

function page(title, bodyHtml, extraHead) {
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="icon" href="/favicon.ico">
<style>${BASE_CSS}</style>
${extraHead || ''}
</head>
<body>
<main class="card">
${bodyHtml}
</main>
</body>
</html>`;
}

function loginPage(err, msg) {
  const errText = typeof err === 'string' ? err : (msg || (err ? 'رمز درست نبود، دوباره امتحان کن.' : ''));
  return page('ورود به وب‌پروکسی', `
<h1>ورود</h1>
<p class="sub">این پروکسی با رمز محافظت می‌شود. برای ادامه رمز را وارد کن.</p>
${errText ? '<p class="err">' + esc(errText) + '</p>' : ''}
<form method="post" action="/login" class="row">
  <input type="password" name="password" placeholder="رمز عبور" autofocus>
  <button type="submit">ورود</button>
</form>`);
}

function errorPage(status, msg, target, detail) {
  return page('خطا ' + status, `
<h1>سایت باز نشد</h1>
<p class="sub">${esc(msg)}</p>
<p class="hint">کد وضعیت: <b>${esc(status)}</b></p>
${target ? `<p class="hint">آدرس مقصد:<br><code>${esc(target)}</code></p>` : ''}
${detail ? `<p class="hint">جزئیات فنی: <code>${esc(String(detail).slice(0, 300))}</code></p>` : ''}
<p class="hint"><a href="/">بازگشت به مرورگر</a></p>`);
}

function notFoundPage() {
  return page('صفحه پیدا نشد', `
<h1>صفحه پیدا نشد</h1>
<p class="sub">این آدرس در پروکسی وجود ندارد. آدرس سایت موردنظر را در نوار آدرس مرورگر وارد کن.</p>
<p class="hint"><a href="/">صفحه اصلی</a></p>`);
}

function faviconResponse() {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#0ea5e9'/><text x='32' y='44' font-size='32' text-anchor='middle' fill='white' font-family='Tahoma'>و</text></svg>`;
  return { svg };
}

/* ------------------------ بازنویسی آدرس‌ها ------------------------ */

function proxiedPath(u, base) {
  if (u === null || u === undefined) return null;
  u = String(u).trim();
  if (!u) return null;
  if (u.startsWith('#')) return null;
  if (/^(data|blob|javascript|mailto|tel|sms|about|ws|wss|ftp|ftps|file|chrome|chrome-extension|moz-extension|intent|market|itms|itms-apps|geo|magnet|steam|irc|matrix|tg|whatsapp|skype|webcal):/i.test(u)) return null;
  if (/^\/proxy\?url=/i.test(u)) return u; // قبلاً بازنویسی شده
  try {
    const abs = new URL(u, base);
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
    return '/proxy?url=' + encodeURIComponent(abs.href);
  } catch (_) { return null; }
}

/* ---------------- پچ سمت کلاینت (تقویت باز شدن لینک‌ها از پروکسی) ---------------- */

const CLIENT_PATCH = `(function(){
if(window.__PX__)return;window.__PX__=1;
var B=location.origin;
var PM=/^\\/(https?:\\/\\/[^\\/]+)(\\/.*)?$/;
function base(){var m=PM.exec(location.pathname);return m?m[1]:'';}
function rw(u){
 try{
  if(typeof u!=='string')return u;
  u=u.trim();
  if(!u)return u;
  if(u.charCodeAt(0)===35)return u;
  if(u.indexOf(B+'/')===0)return u;
  if(/^(data|blob|javascript|mailto|tel|sms|about|ftp|file|chrome|intent|market|itms|geo|magnet|tg|webcal):/i.test(u))return u;
  if(u.charAt(0)==='/'&&u.charAt(1)==='/'){u='https:'+u;}
  if(u.charAt(0)==='/'){
    if(PM.test(u))return u;
    var b=base();
    if(b)return B+'/'+b+u;
    return u;
  }
  if(/^https?:\\/\\//i.test(u)){
    if(u.indexOf(B)===0)return u;
    return B+'/'+u;
  }
  return u;
 }catch(e){return u;}
}
var of=window.fetch;
if(of){window.fetch=function(input,init){
 try{
  if(typeof input==='string')input=rw(input);
  else if(input&&typeof input.url==='string'){var nu=rw(input.url);if(nu!==input.url)input=new Request(nu,input);}
 }catch(e){}
 return of.call(this,input,init);
};}
var oo=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(){
 try{arguments[1]=rw(String(arguments[1]));}catch(e){}
 return oo.apply(this,arguments);
};
var SA=Element.prototype.setAttribute;
var UA1={src:1,href:1,action:1,poster:1,formaction:1,'data-src':1,'data-href':1,'data-url':1,'data-original':1,'data-lazy-src':1};
var UA2={srcset:1,'data-srcset':1,imagesrcset:1};
Element.prototype.setAttribute=function(n,v){
 try{
  var k=String(n).toLowerCase();
  if(UA1[k])v=rw(String(v));
  else if(UA2[k])v=String(v).split(',').map(function(p){var t=p.trim().split(/\\s+/);if(t[0])t[0]=rw(t[0]);return t.join(' ');}).join(', ');
 }catch(e){}
 return SA.call(this,n,v);
};
function pp(ctor,prop){
 try{
  var d=Object.getOwnPropertyDescriptor(ctor.prototype,prop);
  if(!d||!d.set)return;
  Object.defineProperty(ctor.prototype,prop,{configurable:true,enumerable:d.enumerable,
   get:function(){return d.get.call(this);},
   set:function(v){try{v=rw(String(v));}catch(e){}d.set.call(this,v);}});
 }catch(e){}
}
try{
 pp(HTMLAnchorElement,'href');pp(HTMLImageElement,'src');pp(HTMLScriptElement,'src');
 pp(HTMLLinkElement,'href');pp(HTMLIFrameElement,'src');pp(HTMLMediaElement,'src');
 pp(HTMLMediaElement,'poster');pp(HTMLFormElement,'action');
}catch(e){}
var WO=window.open;
window.open=function(){
 try{
  if(arguments[0]){
   var abs=rw(new URL(String(arguments[0]),location.href).href);
   if(window.top&&window.top!==window){
    try{window.top.postMessage({px:'open',url:abs},'*');return null;}catch(e){}
   }
   arguments[0]=abs;
  }
 }catch(e){}
 return WO.apply(this,arguments);
};
document.addEventListener('click',function(e){
 try{
  var a=e.target&&e.target.closest?e.target.closest('a[target="_blank"]'):null;
  if(a&&a.getAttribute('href')){
   var abs=rw(new URL(a.getAttribute('href'),location.href).href);
   if(window.top&&window.top!==window){
    e.preventDefault();
    try{window.top.postMessage({px:'open',url:abs},'*');}catch(e2){}
   }
  }
 }catch(err){}
},true);
['pushState','replaceState'].forEach(function(fn){
 var orig=history[fn];
 history[fn]=function(){
  try{
   if(arguments[2]!=null){
    var u=String(arguments[2]);
    var b=base();
    if(u.charAt(0)==='/'&&u.charAt(1)!=='/'&&!PM.test(u)&&b)u='/'+b+u;
    else if(/^https?:\\/\\//i.test(u))u=rw(u);
    arguments[2]=u;
   }
  }catch(e){}
  var r=orig.apply(this,arguments);
  try{if(window.top&&window.top!==window)window.top.postMessage({px:'nav',path:location.pathname+location.search},'*');}catch(e){}
  return r;
 };
});
try{
 if(navigator.serviceWorker){
  Object.defineProperty(Navigator.prototype,'serviceWorker',{configurable:true,get:function(){return undefined;}});
 }
}catch(e){}
})();`;

function rewriteHtml(htmlText, base) {
  htmlText = htmlText.replace(/<base\b[^>]*>/gi, '');
  htmlText = htmlText.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
  htmlText = htmlText.replace(/\sintegrity\s*=\s*("[^"]*"|'[^']*')/gi, '');

  htmlText = htmlText.replace(/(\s(?:href|src|action|poster|formaction|data-src|data-href|data-url|data-original|data-lazy-src)\s*=\s*)("([^"]*)"|'([^']*)')/gi,
    (m, pre, _all, dq, sq) => {
      const p = proxiedPath(dq !== undefined ? dq : sq, base);
      return p ? pre + '"' + p + '"' : m;
    });

  htmlText = htmlText.replace(/(\s(?:href|src|action|poster|formaction|data-src)\s*=\s*)([^\s"'<>=`]+)/gi,
    (m, pre, raw) => {
      const p = proxiedPath(raw, base);
      return p ? pre + '"' + p + '"' : m;
    });

  htmlText = htmlText.replace(/(\s(?:srcset|data-srcset|imagesrcset)\s*=\s*)("([^"]*)"|'([^']*)')/gi,
    (m, pre, _all, dq, sq) => {
      const raw = dq !== undefined ? dq : sq;
      const parts = raw.split(',').map((part) => {
        const t = part.trim().split(/\s+/);
        if (!t[0]) return part.trim();
        const p = proxiedPath(t[0], base);
        if (p) t[0] = p;
        return t.join(' ');
      }).filter(Boolean);
      return parts.length ? pre + '"' + parts.join(', ') + '"' : m;
    });

  // بارگذاری تنبل عکس‌ها: عکس‌های بیرون از صحنه فقط هنگام اسکرول دانلود می‌شوند
  // (صفحه‌های خبری: صدها درخواست و چند مگابایت در بار اول کم می‌شود؛ جز ۳ عکس اول که احتمالاً در بالای صفحه‌اند)
  let imgSeen = 0;
  htmlText = htmlText.replace(/<img\b([^>]*)>/gi, (m, attrs) => {
    imgSeen++;
    if (imgSeen <= 3 || /\sloading\s*=/i.test(attrs)) return m;
    return '<img' + attrs + ' loading="lazy" decoding="async">';
  });

  htmlText = htmlText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, _q, raw) => {
    const p = proxiedPath(raw.trim(), base);
    return p ? 'url("' + p + '")' : m;
  });

  htmlText = htmlText.replace(/(<meta[^>]*content\s*=\s*["'])([^"']*url\s*=\s*[^"']*)(["'])/gi, (m, pre, content, post) => {
    const mm = /^(\s*\d+\s*;\s*url\s*=\s*)(.*)$/i.exec(content);
    if (!mm) return m;
    const raw = mm[2].trim().replace(/^["']|["']$/g, '');
    const p = proxiedPath(raw, base);
    return p ? pre + mm[1] + p + post : m;
  });

  // تزریق پچ کلاینت در ابتدای head — تا fetch/XHR/لینک‌های داینامیک هم از پروکسی رد شوند
  const inject = '<script>' + CLIENT_PATCH + '</script>';
  if (/<head[^>]*>/i.test(htmlText)) {
    htmlText = htmlText.replace(/<head[^>]*>/i, (m) => m + inject);
  } else if (/<html[^>]*>/i.test(htmlText)) {
    htmlText = htmlText.replace(/<html[^>]*>/i, (m) => m + inject);
  } else {
    htmlText = inject + htmlText;
  }

  return htmlText;
}

function rewriteCss(css, base) {
  css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, _q, raw) => {
    const p = proxiedPath(raw.trim(), base);
    return p ? 'url("' + p + '")' : m;
  });
  css = css.replace(/@import\s+(['"])([^'"]+)\1/gi, (m, _q, raw) => {
    const p = proxiedPath(raw, base);
    return p ? '@import "' + p + '"' : m;
  });
  return css;
}

/* ============================ پشتیبانی یوتیوب ============================ */

const YT_IOS_KEY = 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc';
const YT_WEB_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const YT_IOS_UA = 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)';

const YT_IOS_CLIENT = {
  clientName: 'IOS', clientVersion: '20.10.4', deviceModel: 'iPhone16,2',
  osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en', gl: 'US',
  userAgent: YT_IOS_UA,
};
const YT_WEB_CLIENT = {
  clientName: 'WEB', clientVersion: '2.20250213.01.00', hl: 'en', gl: 'US',
};

// کش حافظه‌ای (در ورکر بین درخواست‌ها و در Node تا ری‌استارت زنده می‌ماند)
const ytMem = new Map();
function memGet(k, ttlMs) {
  const e = ytMem.get(k);
  if (e && Date.now() - e.at < ttlMs) return e.val;
  return null;
}
function memSet(k, v) {
  if (ytMem.size > 400) {
    let n = 0;
    for (const key of ytMem.keys()) { ytMem.delete(key); if (++n >= 100) break; }
  }
  ytMem.set(k, { at: Date.now(), val: v });
}

async function innertube(endpoint, body, key, ua, extra) {
  const headers = {
    'content-type': 'application/json',
    'user-agent': (extra && extra.ua) || ua,
    'cookie': (extra && extra.cookie) || 'SOCS=CAI',
    'origin': 'https://www.youtube.com',
  };
  // قلاب fetcher: سرور Node می‌تواند undici با dispatcher بدهد تا یوتیوب هم
  // از اتصال زنده و «حالت تغییر IP» عبور کند (نسخه‌ی قبلی از fetch خام می‌رفت).
  const f = (extra && extra.fetch) || fetch;
  const r = await f('https://www.youtube.com/youtubei/v1/' + endpoint + '?key=' + key + '&prettyPrint=false', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('innertube ' + endpoint + ': ' + r.status);
  return r.json();
}

function walkCollect(o, key, acc, depth) {
  if (depth > 45 || !o || typeof o !== 'object') return;
  if (Array.isArray(o)) { for (const v of o) walkCollect(v, key, acc, depth + 1); return; }
  if (key in o) acc.push(o[key]);
  for (const v of Object.values(o)) walkCollect(v, key, acc, depth + 1);
}

function parseVideoRenderer(v) {
  if (!v || !v.videoId) return null;
  const title = ''.concat.apply('', (v.title && v.title.runs || []).map((r) => r.text || ''));
  const channel = ''.concat.apply('', ((v.ownerText || v.shortBylineText || {}).runs || []).map((r) => r.text || ''));
  return {
    videoId: v.videoId,
    title: title || '(بی‌نام)',
    channel: channel,
    length: (v.lengthText || {}).simpleText || '',
    views: ((v.shortViewCountText || {}).simpleText) || '',
    thumb: bestThumb((v.thumbnail || {}).thumbnails),
  };
}

function parseLockup(l) {
  if (!l) return null;
  const md = ((l.metadata || {}).lockupMetadataViewModel) || {};
  const title = ((md.title || {}).content) || '(بی‌نام)';
  let channel = '', views = '';
  try {
    const rows = (((md.metadata || {}).contentMetadataViewModel || {}).metadataRows) || [];
    for (const row of rows) {
      for (const part of (row.metadataParts || [])) {
        const t = part.content || '';
        if (/views|بازدید/i.test(t)) views = t;
        else if (!channel) channel = t;
      }
    }
  } catch (_) { /* بدون متادیتا */ }
  return {
    videoId: l.contentId,
    title,
    channel,
    length: '',
    views,
    thumb: bestThumb((((l.contentImage || {}).thumbnailViewModel || {}).image || {}).sources),
  };
}

function bestThumb(sources) {
  if (!sources || !sources.length) return '';
  let best = sources[0];
  for (const s of sources) if ((s.width || 0) > (best.width || 0)) best = s;
  return best.url || '';
}

function collectVideos(data) {
  const out = [];
  const seen = new Set();
  const vr = []; walkCollect(data, 'videoRenderer', vr, 0);
  for (const v of vr) { const p = parseVideoRenderer(v); if (p && !seen.has(p.videoId)) { seen.add(p.videoId); out.push(p); } }
  const lk = []; walkCollect(data, 'lockupViewModel', lk, 0);
  for (const l of lk) { const p = parseLockup(l); if (p && p.videoId && !seen.has(p.videoId)) { seen.add(p.videoId); out.push(p); } }
  return out;
}

async function ytPlayerInfo(videoId, opts) {
  opts = opts || {};
  const ck = 'player:' + (opts.cookie ? 'auth:' : 'anon:') + videoId;
  const cached = memGet(ck, 10 * 60 * 1000);
  if (cached) return cached;
  let d = null;
  /* مسیر لاگین‌دار: کوکی نشست کاربر (از جار سرور) → رد شدن از چالش ربات */
  if (opts.cookie) {
    try {
      d = await innertube('player', {
        context: { client: YT_IOS_CLIENT },
        videoId, contentCheckOk: true, racyCheckOk: true,
      }, YT_IOS_KEY, YT_IOS_UA, { cookie: opts.cookie, fetch: opts.fetch });
    } catch (_) { d = null; }
  }
  if (!d) {
    d = await innertube('player', {
      context: { client: YT_IOS_CLIENT },
      videoId, contentCheckOk: true, racyCheckOk: true,
    }, YT_IOS_KEY, YT_IOS_UA, { fetch: opts.fetch });
  }
  let status = ((d.playabilityStatus || {}).status) || '';
  let sd = d.streamingData || {};
  /* اگر نشست لاگین‌دار با کلاینت IOS باز نشد، کلاینت WEB با همان کوکی */
  if (status !== 'OK' && opts.cookie) {
    try {
      const d2 = await innertube('player', {
        context: { client: YT_WEB_CLIENT },
        videoId, contentCheckOk: true, racyCheckOk: true,
      }, YT_WEB_KEY, opts.ua || UA, { cookie: opts.cookie, fetch: opts.fetch });
      const st2 = ((d2.playabilityStatus || {}).status) || '';
      const sd2 = (d2.streamingData || {});
      const hasUrl = ((sd2.formats || []).some((f) => f.url)) || sd2.hlsManifestUrl;
      if (st2 === 'OK' && hasUrl) { d = d2; status = st2; sd = sd2; }
    } catch (_) { /* همان نتیجه‌ی قبلی می‌ماند */ }
  }
  const vd = d.videoDetails || {};
  const hls = sd.hlsManifestUrl || '';
  /* فرمت‌های progressive با لینک مستقیم (مسیر WEB لاگین‌دار) */
  const formats = [];
  for (const f of (sd.formats || [])) {
    if (!f.url || !/^video\/(mp4|webm)/i.test(f.mimeType || '')) continue;
    formats.push({
      url: f.url,
      label: f.qualityLabel || (f.height ? f.height + 'p' : ''),
    });
  }
  formats.sort((a, b) => (parseInt(b.label, 10) || 0) - (parseInt(a.label, 10) || 0));
  const info = {
    ok: status === 'OK' && !!(hls || formats.length),
    status,
    videoId,
    title: vd.title || '(بی‌نام)',
    author: vd.author || '',
    lengthSeconds: Number(vd.lengthSeconds) || 0,
    viewCount: vd.viewCount || '0',
    description: (vd.shortDescription || '').slice(0, 4000),
    thumb: bestThumb((vd.thumbnail || {}).thumbnails),
    hls,
    formats,
    reason: ((d.playabilityStatus || {}).reason) || '',
  };
  if (info.ok) memSet(ck, info);
  return info;
}

async function ytSearch(q, opts) {
  opts = opts || {};
  const ck = 'search:' + q;
  const cached = memGet(ck, 5 * 60 * 1000);
  if (cached) return cached;
  const d = await innertube('search', {
    context: { client: YT_WEB_CLIENT }, query: q,
  }, YT_WEB_KEY, UA, { fetch: opts.fetch });
  const videos = collectVideos(d).slice(0, 30);
  if (videos.length) memSet(ck, videos);
  return videos;
}

async function ytPlaylist(listId, opts) {
  opts = opts || {};
  const ck = 'playlist:' + listId;
  const cached = memGet(ck, 10 * 60 * 1000);
  if (cached) return cached;
  const d = await innertube('browse', {
    context: { client: YT_WEB_CLIENT }, browseId: 'VL' + listId,
  }, YT_WEB_KEY, UA, { fetch: opts.fetch });
  const videos = collectVideos(d).slice(0, 100);
  if (videos.length) memSet(ck, videos);
  return videos;
}

// تشخیص آدرس یوتیوب → مسیر داخلی اختصاصی
function ytRouteFor(turl) {
  const host = turl.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return null;
  const p = turl.pathname;
  const q = turl.searchParams;

  if (host === 'youtu.be') {
    const id = p.split('/')[1];
    return (id && /^[\w-]{6,15}$/.test(id)) ? '/yt/watch?v=' + encodeURIComponent(id) : '/yt/';
  }
  if (p === '/watch' && q.get('v')) return '/yt/watch?v=' + encodeURIComponent(q.get('v'));
  const m = /^\/(?:shorts|embed|live|v)\/([\w-]{6,15})/.exec(p);
  if (m) return '/yt/watch?v=' + encodeURIComponent(m[1]);
  if (p === '/results' && q.get('search_query')) return '/yt/results?q=' + encodeURIComponent(q.get('search_query'));
  if (p === '/playlist' && q.get('list')) return '/yt/playlist?list=' + encodeURIComponent(q.get('list'));
  return '/yt/';
}

// بازنویسی پلی‌لیست HLS: همه‌ی خط‌ها به مسیر پروکسی هدایت می‌شوند
function hlsRewrite(text, baseUrl) {
  return text.split('\n').map((line) => {
    const l = line.trim().replace(/\r$/, '');
    if (!l) return line;
    if (l.charAt(0) === '#') {
      return line.replace(/URI="([^"]+)"/g, (m, u) => {
        try { return 'URI="/yt/api/hls?u=' + encodeURIComponent(new URL(u, baseUrl).href) + '"'; } catch (_) { return m; }
      });
    }
    try { return '/yt/api/hls?u=' + encodeURIComponent(new URL(l, baseUrl).href); } catch (_) { return line; }
  }).join('\n');
}

function isGooglevideo(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'googlevideo.com' || h.endsWith('.googlevideo.com');
  } catch (_) { return false; }
}

/* ------------------------- صفحات یوتیوب (فارسی) ------------------------- */

const YT_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0b1220;color:#e7edf8;font-family:"Segoe UI",Tahoma,"Vazirmatn",sans-serif;min-height:100vh}
a{color:inherit;text-decoration:none}
header.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:12px;padding:10px 16px;
  background:rgba(11,18,32,.96);backdrop-filter:blur(8px);border-bottom:1px solid #22304d;flex-wrap:wrap}
.brand{font-size:19px;font-weight:800;color:#f43f5e;white-space:nowrap}
.brand b{color:#e7edf8}
.sbox{flex:1;display:flex;gap:8px;min-width:230px}
.sbox input{flex:1;padding:11px 16px;border-radius:24px;border:1px solid #2a3a5c;background:#0c1526;
  color:#e7edf8;font-size:14.5px;outline:none;font-family:inherit}
.sbox input:focus{border-color:#38bdf8}
.sbox button{padding:11px 20px;border-radius:24px;border:0;background:#f43f5e;color:#fff;font-weight:700;
  cursor:pointer;font-family:inherit;font-size:14px}
.sbox button:hover{filter:brightness(1.1)}
main{max-width:1100px;margin:0 auto;padding:20px 14px 60px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:18px}
.vitem{background:rgba(17,26,46,.65);border:1px solid #1d2a44;border-radius:14px;overflow:hidden;
  transition:transform .15s,border-color .15s}
.vitem:hover{transform:translateY(-3px);border-color:#38507e}
.thumb{position:relative;aspect-ratio:16/9;background:#101a30;display:block}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.dur{position:absolute;bottom:6px;left:6px;background:rgba(0,0,0,.82);color:#fff;font-size:12px;
  padding:2px 7px;border-radius:6px;direction:ltr}
.vinfo{padding:10px 12px 13px}
.vtitle{font-size:13.8px;font-weight:600;line-height:1.7;display:-webkit-box;-webkit-line-clamp:2;
  -webkit-box-orient:vertical;overflow:hidden;min-height:46px}
.vchan{color:#93a5c4;font-size:12px;margin-top:6px}
.empty{color:#93a5c4;text-align:center;padding:60px 20px;line-height:2.2;font-size:15px}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 18px}
.chip{padding:8px 15px;border-radius:18px;background:#111a2e;border:1px solid #22304d;color:#c7d5ee;
  font-size:13px;cursor:pointer;font-family:inherit}
.chip:hover{border-color:#38bdf8;color:#7dd3fc}
h2.sec{font-size:17px;margin:4px 2px 14px}
/* پخش‌کننده */
.pwrap{display:flex;flex-direction:column;gap:14px}
.player{width:100%;max-height:72vh;background:#000;border-radius:14px;overflow:hidden;aspect-ratio:16/9}
.player video{width:100%;height:100%;display:block;background:#000}
.vbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
select{padding:8px 12px;border-radius:9px;border:1px solid #2a3a5c;background:#0c1526;color:#e7edf8;
  font-family:inherit;font-size:13px;outline:none}
.hintp{color:#7f92b3;font-size:12.5px}
.ptitle{font-size:18px;font-weight:700;line-height:1.8}
.pmeta{color:#93a5c4;font-size:13px;display:flex;gap:14px;flex-wrap:wrap}
.desc{background:rgba(17,26,46,.65);border:1px solid #1d2a44;border-radius:12px;padding:12px 16px;
  color:#c3d0e8;font-size:13.5px;line-height:2.1;white-space:pre-wrap;word-break:break-word}
.desc summary{cursor:pointer;color:#7dd3fc;font-weight:600}
.perr{background:rgba(244,63,94,.08);border:1px solid #7f1d2d;border-radius:12px;padding:18px;
  color:#fecdd3;line-height:2.2;text-align:center}
.loading{text-align:center;color:#93a5c4;padding:70px 20px;font-size:15px;line-height:2.4}
@media(max-width:600px){.grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
  .vtitle{font-size:12.5px;min-height:40px}header.top{padding:8px 10px}}
`;

function ytDoc(title, bodyHtml, targetUrl) {
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${targetUrl ? '<meta name="px-target" content="' + esc(targetUrl) + '">' : ''}
<title>${esc(title)}</title>
<link rel="icon" href="/favicon.ico">
<style>${YT_CSS}</style>
</head>
<body>
<header class="top">
  <a class="brand" href="/yt/">▶ <b>یوتیوب</b></a>
  <form class="sbox" action="/yt/results" method="get">
    <input type="search" name="q" placeholder="جستجو در یوتیوب..." value="" autocomplete="off">
    <button type="submit">جستجو</button>
  </form>
</header>
<main>
${bodyHtml}
</main>
</body>
</html>`;
}

function vItemHtml(v) {
  const thumb = v.thumb ? '<img src="/proxy?url=' + encodeURIComponent(v.thumb) + '" loading="lazy" alt="">' : '';
  const dur = v.length ? '<span class="dur">' + esc(v.length) + '</span>' : '';
  return `<a class="vitem" href="/yt/watch?v=${esc(v.videoId)}">
<span class="thumb">${thumb}${dur}</span>
<span class="vinfo">
<span class="vtitle">${esc(v.title)}</span>
<span class="vchan">${esc(v.channel)}${v.views ? ' · ' + esc(v.views) : ''}</span>
</span></a>`;
}

function ytHomePage() {
  const chips = ['موزیک فارسی', 'اخبار امروز', 'فیلم کامل', 'طنز', 'آموزش برنامه‌نویسی', ' فوتبال', 'مستند', 'آشپزی ایرانی', 'راک ایرانی', 'کارتون بچه‌گانه'];
  const chipsHtml = chips.map((c) => '<a class="chip" href="/yt/results?q=' + encodeURIComponent(c.trim()) + '">' + esc(c.trim()) + '</a>').join('');
  return ytDoc('یوتیوب — وب‌پروکسی', `
<h2 class="sec">جستجو یا یکی از موضوع‌های محبوب را انتخاب کن</h2>
<div class="chips">${chipsHtml}</div>
<p class="hintp" style="margin:26px 2px;line-height:2.4">
پخش ویدیوها از طریق پروکسی و با کیفیت قابل انتخاب انجام می‌شود.<br>
آدرس هر ویدیو هم مستقیم کار می‌کند: <code style="direction:ltr;display:inline-block;background:#0c1526;padding:2px 8px;border-radius:6px;font-size:12px">آدرس-پروکسی/https://www.youtube.com/watch?v=...</code>
</p>`, 'https://www.youtube.com/');
}

function ytSearchPage(videos, q) {
  const list = videos.length
    ? '<div class="grid">' + videos.map(vItemHtml).join('') + '</div>'
    : '<div class="empty">نتیجه‌ای پیدا نشد. عبارت دیگری امتحان کن.</div>';
  return ytDoc('جستجو: ' + q + ' — یوتیوب', `
<h2 class="sec">نتایج جستجو برای «${esc(q)}»</h2>
${list}`, 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q));
}

function ytPlaylistPage(videos, listId) {
  const list = videos.length
    ? '<div class="grid">' + videos.map(vItemHtml).join('') + '</div>'
    : '<div class="empty">این پلی‌لیست خالی است یا پیدا نشد.</div>';
  return ytDoc('پلی‌لیست — یوتیوب', `
<h2 class="sec">پلی‌لیست (${videos.length} ویدیو)</h2>
${list}`, 'https://www.youtube.com/playlist?list=' + encodeURIComponent(listId));
}

function ytPlayerPage(info) {
  const target = 'https://www.youtube.com/watch?v=' + encodeURIComponent(info.videoId);
  if (!info.ok) {
    const reason = info.reason || 'پخش این ویدیو در دسترس نیست.';
    const gated = /sign in|bot|confirm|ربات|ورود/i.test(reason) || info.status === 'LOGIN_REQUIRED';
    return ytDoc('خطای پخش — یوتیوب', `
<div class="perr">
<b>پخش مستقیم این ویدیو ممکن نشد.</b><br>
${esc(reason)}
${gated ? '<div style="font-size:13px;opacity:.9;text-align:right;margin-top:10px;line-height:2">گوگل درخواست‌های سرورهای ابری را به‌عنوان ربات تشخیص می‌دهد (سیاست جدید یوتیوب). دو راه داری:<br>۱) <b>پخش‌کننده‌ی جایگزین</b> زیر را امتحان کن — برای بسیاری از ویدیوها کار می‌کند.<br>۲) در آدرس‌بار پروکسی <b>youtube.com</b> را باز کن و <b>وارد اکانت گوگل</b> شو؛ نشست لاگین سمت سرور نگه داشته می‌شود و بعد از آن پخش مستقیم معمولاً آزاد می‌شود.</div>' : ''}
</div>
${gated ? `<div class="pwrap" style="margin-top:14px"><div class="player"><iframe src="/yt/embed?v=${esc(info.videoId)}" style="width:100%;height:100%;border:0" allowfullscreen loading="lazy"></iframe></div><p class="hintp" style="margin-top:8px">پخش‌کننده‌ی جایگزین (embed)</p></div>` : ''}
<div style="margin-top:16px">
<a href="/yt/watch?v=${esc(info.videoId)}" style="display:inline-block;padding:12px 26px;border-radius:12px;background:linear-gradient(135deg,#f43f5e,#fb7185);color:#fff;font-weight:700;text-decoration:none">تلاش مجدد</a> &nbsp;&nbsp;
<a href="/yt/" style="color:#7dd3fc">بازگشت به یوتیوب</a>
</div>`, target);
  }
  const meta = [
    info.author ? esc(info.author) : '',
    Number(info.viewCount) ? fmtViews(info.viewCount) + ' بازدید' : '',
    info.lengthSeconds ? fmtDur(info.lengthSeconds) : '',
  ].filter(Boolean).map((x) => '<span>' + x + '</span>').join('');
  const poster = info.thumb ? ' poster="/proxy?url=' + encodeURIComponent(info.thumb) + '"' : '';
  const useHls = !!info.hls;
  const srcs = (info.formats || []).map((f) => ({
    u: '/proxy?url=' + encodeURIComponent(f.url),
    q: f.label || 'خودکار',
  }));
  return ytDoc(info.title + ' — یوتیوب', `
<div class="pwrap">
<div class="player"><video id="v" controls playsinline preload="metadata"${poster}></video></div>
<div class="vbar">
  <label class="hintp">کیفیت:</label>
  <select id="qsel"><option value="-1">خودکار</option></select>
  <span class="hintp" id="st"></span>
</div>
<h1 class="ptitle">${esc(info.title)}</h1>
<div class="pmeta">${meta}</div>
<details class="desc"><summary>توضیحات</summary>${esc(info.description) || 'بدون توضیحات'}</details>
</div>
${useHls ? '<script src="/assets/hls.min.js"></script>' : ''}
<script>
(function(){
var video=document.getElementById('v');
var st=document.getElementById('st');
var qsel=document.getElementById('qsel');
var KEY='pxyt_${esc(info.videoId)}';
try{var saved=parseFloat(localStorage.getItem(KEY)||'0');}catch(e){var saved=0;}
video.addEventListener('loadedmetadata',function(){
  if(saved>5&&saved<video.duration-8){try{video.currentTime=saved;}catch(e){}}
});
video.addEventListener('timeupdate',function(){
  if(video.currentTime>3){try{localStorage.setItem(KEY,String(video.currentTime));}catch(e){}}
});
var MODE=${JSON.stringify(useHls ? 'hls' : 'fmt')};
if(MODE==='hls'){
  var src=${JSON.stringify('/yt/api/hls?u=' + encodeURIComponent(info.hls))};
  function qs(list){
    for(var i=0;i<list.length;i++){
      var o=document.createElement('option');
      o.value=String(i);
      o.textContent=(list[i].height?list[i].height+'p':'سطح '+(i+1))+(list[i].bitrate?' · '+Math.round(list[i].bitrate/1000)+'kbps':'');
      qsel.appendChild(o);
    }
  }
  if(window.Hls&&Hls.isSupported()){
    var hls=new Hls({maxBufferLength:60,backBufferLength:30,startLevel:-1});
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED,function(){
      qs(hls.levels);
      st.textContent='آماده پخش';
    });
    hls.on(Hls.Events.LEVEL_SWITCHED,function(e,d){
      var lv=hls.levels[d.level];
      if(lv&&lv.height)st.textContent='در حال پخش: '+lv.height+'p';
    });
    hls.on(Hls.Events.ERROR,function(e,d){
      if(d.fatal){
        st.textContent='خطا در بارگیری؛ در حال تلاش مجدد...';
        if(d.type===Hls.ErrorTypes.NETWORK_ERROR){try{hls.startLoad();}catch(x){}}
        else if(d.type===Hls.ErrorTypes.MEDIA_ERROR){try{hls.recoverMediaError();}catch(x){}}
      }
    });
    qsel.onchange=function(){
      hls.currentLevel=parseInt(qsel.value,10);
      hls.loadLevel=parseInt(qsel.value,10);
    };
  }else if(video.canPlayType('application/vnd.apple.mpegurl')){
    video.src=src;
    st.textContent='پخش نیتیو HLS';
  }else{
    st.textContent='مرورگر پخش HLS را پشتیبانی نمی‌کند.';
  }
}else{
  var srcs=${JSON.stringify(srcs)};
  var cur=0;
  for(var i=0;i<srcs.length;i++){
    var o=document.createElement('option');
    o.value=String(i);
    o.textContent=srcs[i].q;
    qsel.appendChild(o);
  }
  function playIdx(i){
    cur=i;
    var t=video.currentTime>3?video.currentTime:0;
    video.src=srcs[i].u;
    video.addEventListener('loadedmetadata',function once(){
      video.removeEventListener('loadedmetadata',once);
      if(t>0&&t<video.duration-5){try{video.currentTime=t;}catch(e){}}
      video.play().catch(function(){});
    });
  }
  if(srcs.length){playIdx(0);st.textContent='آماده پخش';}
  else{st.textContent='فرمتی برای پخش پیدا نشد.';}
  qsel.onchange=function(){playIdx(parseInt(qsel.value,10)||0);};
}
})();
</script>`, target);
}

function ytLoadingPage() {
  return ytDoc('در حال بارگیری — یوتیوب', '<div class="loading">در حال دریافت اطلاعات ویدیو از یوتیوب...<br><span class="hintp">چند لحظه صبر کن</span></div>', 'https://www.youtube.com/');
}

/* ======================= رابط «مرورگر» (شل) ======================= */

function shellPage(hasPassword) {
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>وب‌پروکسی شخصی</title>
<link rel="icon" href="/favicon.ico">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%;overflow:hidden}
body{display:flex;flex-direction:column;background:#0b1220;color:#e7edf8;
  font-family:"Segoe UI",Tahoma,"Vazirmatn",sans-serif;font-size:14px}
/* --- نوار تب‌ها --- */
#tabbar{display:flex;align-items:center;gap:6px;padding:6px 8px 0;background:#080e1c;
  border-bottom:1px solid #1b2740;user-select:none}
#tabs{display:flex;align-items:center;gap:6px;overflow-x:auto;flex:1;scrollbar-width:thin}
#tabs::-webkit-scrollbar{height:3px}
#tabs::-webkit-scrollbar-thumb{background:#22304d;border-radius:3px}
.tab{display:flex;align-items:center;gap:7px;padding:8px 10px;border-radius:10px 10px 0 0;
  background:transparent;color:#8fa2c4;cursor:pointer;white-space:nowrap;max-width:200px;
  min-width:110px;font-size:12.8px;border:1px solid transparent;border-bottom:0}
.tab:hover{background:#101a30;color:#c7d5ee}
.tab.on{background:#0b1220;color:#e7edf8;border-color:#1b2740;position:relative}
.tab.on:after{content:'';position:absolute;top:0;right:10px;left:10px;height:2px;
  background:linear-gradient(90deg,#0ea5e9,#22d3ee);border-radius:2px}
.tab .fav{width:18px;height:18px;border-radius:5px;background:#1d2a44;display:inline-flex;
  align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#7dd3fc;flex:0 0 auto;
  overflow:hidden}
.tab .tt{overflow:hidden;text-overflow:ellipsis;flex:1}
.tab .x{width:18px;height:18px;border-radius:5px;display:inline-flex;align-items:center;
  justify-content:center;font-size:13px;color:#64789c;flex:0 0 auto}
.tab .x:hover{background:#2a1b2b;color:#fb7185}
.tab.inc .fav{background:#2b2440;color:#c4b5fd}
#newtab{width:30px;height:30px;border-radius:8px;border:0;background:#131f39;color:#7dd3fc;
  font-size:17px;cursor:pointer;flex:0 0 auto;font-family:inherit}
#newtab:hover{background:#1a2a4d}
/* --- نوار ابزار --- */
#toolbar{display:flex;align-items:center;gap:5px;padding:7px 10px;background:#0b1220;
  border-bottom:1px solid #1b2740;flex-wrap:nowrap}
.nbtn{width:34px;height:34px;border-radius:9px;border:0;background:transparent;color:#a9bcd9;
  cursor:pointer;font-size:15px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center}
.nbtn:hover{background:#131f39;color:#e7edf8}
.nbtn.dis{opacity:.3;cursor:default}
.nbtn.dis:hover{background:transparent;color:#a9bcd9}
#addr{flex:1;min-width:80px;padding:9px 16px;border-radius:18px;border:1px solid #24334f;
  background:#0d1730;color:#e7edf8;font-size:13.8px;outline:none;direction:ltr;text-align:left;
  font-family:inherit;transition:border-color .15s}
#addr:focus{border-color:#38bdf8;box-shadow:0 0 0 3px rgba(56,189,248,.15)}
#addr::placeholder{direction:rtl;text-align:right;color:#5d7295}
#kb{position:absolute;top:60px;inset-inline-start:0;background:#22304d;border-radius:8px;padding:2px 10px;
  font-size:11.5px;color:#c7d5ee;display:none}
/* --- نوار نشانک‌ها --- */
#bmbar{display:flex;align-items:center;gap:6px;padding:4px 10px;background:#0a101f;
  border-bottom:1px solid #16223c;overflow-x:auto;scrollbar-width:none}
#bmbar::-webkit-scrollbar{display:none}
.bm{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:7px;
  background:transparent;color:#93a5c4;font-size:12px;cursor:pointer;white-space:nowrap;border:0;font-family:inherit}
.bm:hover{background:#132038;color:#c7d5ee}
/* --- محتوا --- */
#content{flex:1;position:relative;background:#04070f}
#content iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff;display:none}
#content iframe.on{display:block}
#emptystub{position:absolute;inset:0;display:none;align-items:center;justify-content:center;color:#3a4d6e}
/* --- پنل‌ها --- */
#overlay{position:fixed;inset:0;background:rgba(3,6,14,.72);backdrop-filter:blur(4px);z-index:50;
  display:none;align-items:flex-start;justify-content:center;padding:6vh 14px}
#overlay.on{display:flex}
.panel{background:#0e1729;border:1px solid #22304d;border-radius:18px;width:100%;max-width:560px;
  max-height:82vh;overflow-y:auto;padding:22px 24px;box-shadow:0 30px 80px rgba(0,0,0,.6)}
.panel h2{font-size:17px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between}
.panel h2 .cls{cursor:pointer;color:#64789c;font-size:20px;padding:2px 8px;border-radius:6px}
.panel h2 .cls:hover{background:#1a2742;color:#e7edf8}
.lrow{display:flex;align-items:center;gap:10px;padding:10px 6px;border-bottom:1px solid #16223c;
  cursor:pointer;border-radius:8px}
.lrow:hover{background:#121e36}
.lrow .lt{flex:1;overflow:hidden}
.lrow .lt b{display:block;font-size:13.2px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lrow .lt span{display:block;color:#7f92b3;font-size:11.5px;direction:ltr;text-align:left;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.lrow .ld{color:#5d7295;font-size:11px;flex:0 0 auto}
.pbtn{padding:9px 18px;border-radius:10px;border:1px solid #2a3a5c;background:#131f39;color:#c7d5ee;
  cursor:pointer;font-family:inherit;font-size:13px}
.pbtn:hover{border-color:#38bdf8;color:#7dd3fc}
.pbtn.pri{background:linear-gradient(135deg,#0ea5e9,#22d3ee);color:#04121f;border:0;font-weight:700}
.pbtn.dngr{border-color:#7f1d2d;color:#fb7185}
.tiny{color:#7f92b3;font-size:12px;line-height:2}
/* --- تنظیمات --- */
.brow{display:flex;align-items:center;gap:8px;padding:9px 4px;border-bottom:1px solid #16223c;flex-wrap:wrap}
.brow input[type=radio]{accent-color:#0ea5e9;width:16px;height:16px;flex:0 0 auto}
.brow .bn{flex:1;min-width:90px}
.brow .bu{flex:2;min-width:150px;color:#7dd3fc;font-size:12px;direction:ltr;text-align:left;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brow .ms{color:#22c55e;font-size:12px;min-width:56px;text-align:left;direction:ltr;flex:0 0 auto}
.frow{display:flex;gap:8px;margin:10px 0;flex-wrap:wrap}
.frow input{flex:1;min-width:120px;padding:10px 14px;border-radius:10px;border:1px solid #2a3a5c;
  background:#0c1526;color:#e7edf8;font-size:13px;outline:none;font-family:inherit}
.frow input:focus{border-color:#38bdf8}
select{padding:9px 12px;border-radius:10px;border:1px solid #2a3a5c;background:#0c1526;color:#e7edf8;
  font-family:inherit;font-size:13px;outline:none}
textarea{width:100%;min-height:110px;padding:12px;border-radius:10px;border:1px solid #2a3a5c;
  background:#0c1526;color:#c7d5ee;font-size:12px;direction:ltr;text-align:left;font-family:monospace;resize:vertical}
/* --- جستجو در صفحه --- */
#findbar{position:fixed;bottom:16px;inset-inline-start:50%;transform:translateX(50%);z-index:60;
  display:none;align-items:center;gap:8px;background:#0e1729;border:1px solid #22304d;
  border-radius:30px;padding:8px 10px 8px 18px;box-shadow:0 16px 50px rgba(0,0,0,.55)}
#findbar.on{display:flex}
#findbar input{width:210px;padding:8px 12px;border-radius:20px;border:1px solid #24334f;background:#0d1730;
  color:#e7edf8;font-size:13.5px;outline:none;font-family:inherit;direction:inherit;text-align:inherit}
#fcount{color:#7f92b3;font-size:12px;min-width:52px;text-align:center}
#findbar .nbtn{width:30px;height:30px}
/* --- منو --- */
#menu{position:fixed;top:46px;inset-inline-end:10px;z-index:70;background:#0e1729;
  border:1px solid #22304d;border-radius:14px;padding:7px;display:none;min-width:215px;
  box-shadow:0 20px 60px rgba(0,0,0,.55)}
#menu.on{display:block}
.mi{display:flex;align-items:center;gap:10px;padding:10px 13px;border-radius:9px;color:#c7d5ee;
  cursor:pointer;font-size:13.5px;white-space:nowrap}
.mi:hover{background:#16233f;color:#fff}
.mi .sc{margin-inline-start:auto;color:#5d7295;font-size:11px;direction:ltr}
.msep{height:1px;background:#1b2740;margin:5px 8px}
mark.pxf{background:#f59e0b;color:#111;border-radius:3px}
mark.pxf.on{background:#f43f5e;color:#fff}
@media(max-width:620px){
  #bmbar{display:none}
  .tab{min-width:88px;max-width:140px}
  #addr{font-size:12.5px;padding:8px 13px}
  .nbtn{width:31px;height:31px}
  #findbar{inset-inline-start:10px;inset-inline-end:10px;transform:none}
  #findbar input{width:auto;flex:1}
}
</style>
</head>
<body>
<div id="tabbar">
  <div id="tabs"></div>
  <button id="newtab" title="تب جدید (Ctrl+T)">+</button>
</div>
<div id="toolbar">
  <button class="nbtn" id="bback" title="عقب (Alt+→)">‹</button>
  <button class="nbtn" id="bfwd" title="جلو (Alt+←)">›</button>
  <button class="nbtn" id="breload" title="بارگیری مجدد (F5)">⟳</button>
  <button class="nbtn" id="bhome" title="خانه">⌂</button>
  <input id="addr" placeholder="جستجو یا آدرس سایت را وارد کنید…" autocomplete="off" spellcheck="false">
  <button class="nbtn" id="bstar" title="نشانک (Ctrl+D)">☆</button>
  <button class="nbtn" id="bmenu" title="منو">⋮</button>
</div>
<div id="bmbar"></div>
<div id="content"><div id="emptystub">یک تب جدید باز کن</div></div>
<div id="overlay"><div class="panel" id="panelbox"></div></div>
<div id="menu"></div>
<div id="findbar">
  <input id="fq" placeholder="جستجو در صفحه…">
  <span id="fcount">۰/۰</span>
  <button class="nbtn" id="fprev" title="قبلی">↑</button>
  <button class="nbtn" id="fnext" title="بعدی">↓</button>
  <button class="nbtn" id="fclose" title="بستن (Esc)">✕</button>
</div>
<script>
(function(){
'use strict';
/* ---------- تنظیمات و داده‌ها ---------- */
var LS={s:'pxsh_settings',b:'pxsh_bookmarks',h:'pxsh_history'};
function lsGet(k,d){try{var v=localStorage.getItem(k);return v?JSON.parse(v):d;}catch(e){return d;}}
function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}}
var settings=lsGet(LS.s,null)||{
  backends:[{name:'سرور فعلی (Cloudflare)',url:location.origin}],
  active:0,engine:'ddg'
};
var bookmarks=lsGet(LS.b,[]);
var history=lsGet(LS.h,[]);
var ENGINES={
  ddg:{t:'داک‌داک‌گو',u:function(q){return 'https://html.duckduckgo.com/html/?q='+encodeURIComponent(q);}},
  bing:{t:'بینگ',u:function(q){return 'https://www.bing.com/search?q='+encodeURIComponent(q);}},
  google:{t:'گوگل',u:function(q){return 'https://www.google.com/search?q='+encodeURIComponent(q);}},
  wiki:{t:'ویکی‌پدیا فارسی',u:function(q){return 'https://fa.wikipedia.org/w/index.php?search='+encodeURIComponent(q);}},
  yt:{t:'یوتیوب',u:function(q){return 'https://www.youtube.com/results?search_query='+encodeURIComponent(q);}}
};
function backend(){var b=settings.backends[settings.active];return b?b.url:location.origin;}
function saveSettings(){lsSet(LS.s,settings);}
/* ---------- عناصر ---------- */
var el=function(id){return document.getElementById(id);};
var tabsEl=el('tabs'),contentEl=el('content'),addrEl=el('addr');
/* ---------- تب‌ها ---------- */
var tabs=[];var tid=1;var active=null;
function newTab(focus,incognito){
  var t={id:tid++,title:'تب جدید',url:'',hist:[],hi:-1,incognito:!!incognito,zoom:1,
         frame:document.createElement('iframe')};
  t.frame.setAttribute('allow','fullscreen; autoplay; encrypted-media; picture-in-picture');
  t.frame.addEventListener('load',function(){onLoad(t);});
  t.frame.src='/newtab';
  contentEl.appendChild(t.frame);
  tabs.push(t);
  if(focus!==false)activate(t.id);
  else renderTabs();
  return t;
}
function tabById(id){for(var i=0;i<tabs.length;i++)if(tabs[i].id===id)return tabs[i];return null;}
function activate(id){
  var t=tabById(id);if(!t)return;
  active=t;
  for(var i=0;i<tabs.length;i++)tabs[i].frame.classList.toggle('on',tabs[i].id===id);
  renderTabs();
  setAddr(t.url);
  updateStar();
  updateNav();
  document.title=(t.url?t.title+' — ':'')+'وب‌پروکسی';
}
function closeTab(id){
  var idx=-1;for(var i=0;i<tabs.length;i++)if(tabs[i].id===id){idx=i;break;}
  if(idx<0)return;
  var t=tabs[idx];
  t.frame.remove();
  tabs.splice(idx,1);
  if(!tabs.length){newTab(true);return;}
  if(active&&active.id===id){activate(tabs[Math.max(0,idx-1)].id);}
  else renderTabs();
}
function renderTabs(){
  var html='';
  for(var i=0;i<tabs.length;i++){
    var t=tabs[i];
    var host=t.url?(t.url.replace(/^https?:\\/\\//,'').split('/')[0]):'';
    var fav=t.url?host.charAt(0).toUpperCase():'+';
    html+='<div class="tab'+((active&&t.id===active.id)?' on':'')+(t.incognito?' inc':'')+'" data-id="'+t.id+'">'
      +'<span class="fav">'+esc2(fav)+'</span><span class="tt">'+esc2(t.title||'تب جدید')+'</span>'
      +'<span class="x" data-x="'+t.id+'">✕</span></div>';
  }
  tabsEl.innerHTML=html;
}
tabsEl.addEventListener('click',function(e){
  var x=e.target.closest('.x');
  if(x){closeTab(Number(x.getAttribute('data-x')));return;}
  var tb=e.target.closest('.tab');
  if(tb)activate(Number(tb.getAttribute('data-id')));
});
el('newtab').addEventListener('click',function(){newTab(true);});
/* ---------- ناوبری ---------- */
function proxyPath(target){return backend()+'/proxy?url='+encodeURIComponent(target);}
/* فراخوانی API پنل IP روی سرورِ فعال — اگر سرور فعال روی مبدأ دیگری است،
   درخواست از مسیر پروکسیِ همین مبدأ می‌رود تا مقصد به هدر Origin حساس نباشد
   و سایت‌های دیگر هم نتوانند حالت خروجی سرور را عوض کنند. */
function ipFetch(path,opts){
  var b=backend();
  try{if(new URL(b).origin===location.origin)return fetch(path,opts||{});}catch(e){}
  return fetch('/proxy?url='+encodeURIComponent(b+path),opts||{});
}
function setAddr(u){addrEl.value=u||'';}
function smartUrl(v){
  v=v.trim();
  if(!v)return '';
  if(/^[a-z][a-z0-9+.\\-]*:\\/\\//i.test(v))return v;
  if(/^localhost(:\\d+)?([\\/?#].*)?$/i.test(v))return 'http://'+v;
  if(/^[\\w.\\-]+\\.[a-z]{2,}(:\\d+)?([\\/?#].*)?$/i.test(v))return 'https://'+v;
  var eng=ENGINES[settings.engine]||ENGINES.ddg;
  return eng.u(v);
}
function navigate(target){
  if(!active)newTab(true);
  active.url=target;
  active.frame.src=proxyPath(target);
  setAddr(target);
  renderTabs();
  updateNav();
}
function onLoad(t){
  if(t.id!==active.id){renderTabs();return;}
  syncFromFrame(t);
}
function targetFromLoc(loc,doc){
  try{
    var p=loc.pathname;
    var href=loc.href||(location.origin+p+(loc.search||''));
    if(p==='/newtab'||p==='/')return '';
    if(p.indexOf('/yt/')===0){
      var mt=doc&&doc.querySelector&&doc.querySelector('meta[name="px-target"]');
      if(mt&&mt.content)return mt.content;
      var pu=new URL(href);
      if(p.indexOf('/yt/watch')===0)return 'https://www.youtube.com/watch?v='+(pu.searchParams.get('v')||'');
      if(p.indexOf('/yt/results')===0)return 'https://www.youtube.com/results?search_query='+(pu.searchParams.get('q')||'');
      if(p.indexOf('/yt/playlist')===0)return 'https://www.youtube.com/playlist?list='+(pu.searchParams.get('list')||'');
      return 'https://www.youtube.com/';
    }
    if(p==='/proxy'){return new URL(href).searchParams.get('url')||'';}
    var m=/^\\/(https?:\\/.+)$/.exec(p);
    if(m){var raw=m[1];try{raw=decodeURIComponent(raw);}catch(e){}
      return raw+(loc.search||'');}
    return '';
  }catch(e){return '';}
}
function syncFromFrame(t){
  var target='',title='تب جدید',doc=null;
  try{
    var w=t.frame.contentWindow;
    doc=t.frame.contentDocument||w.document;
    target=targetFromLoc(w.location,doc);
    if(doc&&doc.title)title=doc.title;
    try{doc.addEventListener('keydown',relayKey,true);}catch(e){}
    try{if(t.zoom!==1&&doc.body)doc.body.style.zoom=t.zoom;}catch(e){}
  }catch(e){}
  t.url=target;t.title=title;
  if(t.hi<0||t.hist[t.hi]!==target){t.hist=t.hist.slice(0,t.hi+1);t.hist.push(target);t.hi=t.hist.length-1;}
  if(!t.incognito&&target){history.unshift({u:target,t:title,at:Date.now()});
    if(history.length>300)history.length=300;lsSet(LS.h,history);}
  if(t.id===active.id){setAddr(target);updateStar();updateNav();
    document.title=(target?title+' — ':'')+'وب‌پروکسی';}
  renderTabs();
}
addrEl.addEventListener('keydown',function(e){
  if(e.key==='Enter'){var v=addrEl.value.trim();if(v)navigate(smartUrl(v));addrEl.blur();}
});
el('bback').addEventListener('click',function(){goHist(-1);});
el('bfwd').addEventListener('click',function(){goHist(1);});
el('breload').addEventListener('click',function(){reloadTab();});
el('bhome').addEventListener('click',function(){if(active){active.url='';active.frame.src='/newtab';setAddr('');renderTabs();}});
function goHist(d){
  if(!active)return;
  var ni=active.hi+d;
  if(ni<0||ni>=active.hist.length)return;
  active.hi=ni;
  var u=active.hist[ni];
  if(u){active.url=u;active.frame.src=proxyPath(u);setAddr(u);}
  else{active.url='';active.frame.src='/newtab';setAddr('');}
  renderTabs();updateNav();
}
function reloadTab(){
  if(!active)return;
  try{active.frame.contentWindow.location.reload();}catch(e){
    if(active.url)active.frame.src=proxyPath(active.url);else active.frame.src='/newtab';}
}
function updateNav(){
  el('bback').classList.toggle('dis',!active||active.hi<=0);
  el('bfwd').classList.toggle('dis',!active||active.hi>=active.hist.length-1);
}
/* ---------- نشانک‌ها ---------- */
function updateStar(){
  var on=active&&active.url&&isBooked(active.url);
  el('bstar').textContent=on?'★':'☆';
  el('bstar').style.color=on?'#f59e0b':'';
}
function isBooked(u){for(var i=0;i<bookmarks.length;i++)if(bookmarks[i].u===u)return true;return false;}
el('bstar').addEventListener('click',function(){
  if(!active||!active.url)return;
  var u=active.url;
  if(isBooked(u)){bookmarks=bookmarks.filter(function(b){return b.u!==u;});}
  else bookmarks.unshift({u:u,t:active.title||u,at:Date.now()});
  lsSet(LS.b,bookmarks);updateStar();renderBm();
});
function renderBm(){
  var h='';
  for(var i=0;i<bookmarks.length;i++){
    var b=bookmarks[i];
    var host=b.u.replace(/^https?:\\/\\//,'').split('/')[0];
    h+='<button class="bm" data-u="'+esc2(b.u)+'" title="'+esc2(b.u)+'">'+esc2(host)+'</button>';
  }
  el('bmbar').innerHTML=h||'<span style="color:#3a4d6e;font-size:11.5px;padding:3px 6px">نشانک‌ها اینجا نمایش داده می‌شوند — با ☆ اضافه کن</span>';
}
el('bmbar').addEventListener('click',function(e){
  var b=e.target.closest('.bm');if(!b)return;
  navigate(b.getAttribute('data-u'));
});
/* ---------- منو و پنل‌ها ---------- */
var menuEl=el('menu');
el('bmenu').addEventListener('click',function(e){e.stopPropagation();menuEl.classList.toggle('on');renderMenu();});
document.addEventListener('click',function(){menuEl.classList.remove('on');});
function renderMenu(){
  menuEl.innerHTML=
   '<div class="mi" data-a="newtab">تب جدید<span class="sc">Ctrl+T</span></div>'
  +'<div class="mi" data-a="inc">تب ناشناس</div>'
  +'<div class="mi" data-a="remote">مرورگر تصویری (ریموت)</div>'
  +'<div class="msep"></div>'
  +'<div class="mi" data-a="history">تاریخچه</div>'
  +'<div class="mi" data-a="bookmarks">نشانک‌ها</div>'
  +'<div class="mi" data-a="find">جستجو در صفحه<span class="sc">Ctrl+F</span></div>'
  +'<div class="mi" data-a="zin">بزرگ‌نمایی<span class="sc">Ctrl +</span></div>'
  +'<div class="mi" data-a="zout">کوچک‌نمایی<span class="sc">Ctrl −</span></div>'
  +'<div class="mi" data-a="zreset">بازنشانی بزرگ‌نمایی<span class="sc">Ctrl 0</span></div>'
  +'<div class="msep"></div>'
  +'<div class="mi" data-a="settings">تنظیمات و سرورها</div>'
  +'<div class="mi" data-a="ip">تغییر IP خروجی</div>'
  +'<div class="mi" data-a="about">درباره</div>';
}
menuEl.addEventListener('click',function(e){
  var mi=e.target.closest('.mi');if(!mi)return;
  menuEl.classList.remove('on');
  var a=mi.getAttribute('data-a');
  if(a==='newtab')newTab(true);
  else if(a==='inc')newTab(true,true);
  else if(a==='remote'){newTab(true).frame.src='/remote';}
  else if(a==='history')showHistory();
  else if(a==='bookmarks')showBookmarks();
  else if(a==='find')openFind();
  else if(a==='zin')setZoom(active?active.zoom+0.1:1);
  else if(a==='zout')setZoom(active?active.zoom-0.1:1);
  else if(a==='zreset')setZoom(1);
  else if(a==='settings')showSettings();
  else if(a==='ip')showIpPanel();
  else if(a==='about')showAbout();
});
var overlay=el('overlay'),panelbox=el('panelbox');
function openPanel(html){
  panelbox.innerHTML='<h2><span>'+html.t+'</span><span class="cls">✕</span></h2>'+html.b;
  overlay.classList.add('on');
  panelbox.querySelector('.cls').onclick=closePanel;
}
function closePanel(){overlay.classList.remove('on');}
overlay.addEventListener('click',function(e){if(e.target===overlay)closePanel();});
function fmtTime(at){
  var d=new Date(at);
  function p(n){return (n<10?'0':'')+n;}
  return p(d.getHours())+':'+p(d.getMinutes())+' — '+d.toLocaleDateString('fa-IR');
}
function showHistory(){
  var h='';
  for(var i=0;i<history.length;i++){
    var it=history[i];
    h+='<div class="lrow" data-u="'+esc2(it.u)+'"><div class="lt"><b>'+esc2(it.t||it.u)
      +'</b><span>'+esc2(it.u)+'</span></div><div class="ld">'+fmtTime(it.at)+'</div></div>';
  }
  if(!history.length)h='<p class="tiny" style="padding:20px 4px">تاریخچه خالی است.</p>';
  openPanel({t:'تاریخچه',b:'<div style="margin-bottom:10px;display:flex;gap:8px">'
    +'<button class="pbtn dngr" id="clrH">پاک کردن همه</button></div>'+h});
  panelbox.querySelector('#clrH').onclick=function(){history=[];lsSet(LS.h,history);showHistory();};
  panelbox.addEventListener('click',function(e){
    var r=e.target.closest('.lrow');if(r){closePanel();navigate(r.getAttribute('data-u'));}
  });
}
function showBookmarks(){
  var h='';
  for(var i=0;i<bookmarks.length;i++){
    var b=bookmarks[i];
    h+='<div class="lrow" data-u="'+esc2(b.u)+'"><div class="lt"><b>'+esc2(b.t||b.u)
      +'</b><span>'+esc2(b.u)+'</span></div><button class="pbtn dngr" data-del="'+esc2(b.u)+'">حذف</button></div>';
  }
  if(!bookmarks.length)h='<p class="tiny" style="padding:20px 4px">هنوز نشانکی نداری. با دکمه‌ی ☆ صفحه‌ی فعلی را نشانک کن.</p>';
  openPanel({t:'نشانک‌ها',b:h});
  panelbox.addEventListener('click',function(e){
    var d=e.target.closest('[data-del]');
    if(d){bookmarks=bookmarks.filter(function(x){return x.u!==d.getAttribute('data-del');});
      lsSet(LS.b,bookmarks);renderBm();showBookmarks();return;}
    var r=e.target.closest('.lrow');if(r){closePanel();navigate(r.getAttribute('data-u'));}
  });
}
function showAbout(){
  openPanel({t:'درباره',b:
   '<p class="tiny">مرورگر پروکسی شخصی — نسخه ۳.۰</p>'
  +'<p class="tiny">تمام صفحات از طریق سرور واسط باز می‌شوند؛ لینک‌ها، تصاویر، فرم‌ها و درخواست‌های داینامیک هم از مسیر پروکسی رد می‌شوند. پشتیبانی پخش یوتیوب با کیفیت انتخابی، موتور سرعت با اتصال‌های زنده و — روی لایه‌های Node — تغییر IP خروجی.</p>'
  +'<p class="tiny">میان‌برها: <b>Ctrl+T</b> تب جدید · <b>Ctrl+W</b> بستن تب · <b>Ctrl+L</b> نوار آدرس · <b>Ctrl+D</b> نشانک · <b>Ctrl+F</b> جستجو در صفحه · <b>Alt+→/←</b> عقب/جلو · <b>Ctrl +/-/0</b> بزرگ‌نمایی</p>'});
}
/* ---------- تنظیمات و سوییچ سرور ---------- */
function showSettings(){
  var rows='';
  for(var i=0;i<settings.backends.length;i++){
    var b=settings.backends[i];
    rows+='<div class="brow">'
      +'<input type="radio" name="bk" data-i="'+i+'"'+(i===settings.active?' checked':'')+'>'
      +'<span class="bn">'+esc2(b.name)+'</span><span class="bu">'+esc2(b.url)+'</span>'
      +'<span class="ms" id="ms'+i+'"></span>'
      +'<button class="pbtn dngr" data-rm="'+i+'">حذف</button></div>';
  }
  var engs='';
  var keys=Object.keys(ENGINES);
  for(var j=0;j<keys.length;j++){
    engs+='<option value="'+keys[j]+'"'+(keys[j]===settings.engine?' selected':'')+'>'+ENGINES[keys[j]].t+'</option>';
  }
  openPanel({t:'تنظیمات و سرورها',b:
   '<p class="tiny">سرور فعال — همه‌ی صفحات از طریق این سرور باز می‌شوند. می‌توانی چند سرور (ورکرهای مختلف، Render، سرور شخصی) اضافه کنی و بین‌شان سوییچ کنی.</p>'
  +rows
  +'<div class="frow"><input id="nbname" placeholder="نام (مثلاً ورکر ۲)"><input id="nburl" placeholder="https://آدرس-سرور" direction="ltr"><button class="pbtn pri" id="addBk">افزودن</button></div>'
  +'<div class="frow"><button class="pbtn" id="testBk">تست سرعت سرورها</button></div>'
  +'<p class="tiny">موتور جستجوی پیش‌فرض نوار آدرس:</p>'
  +'<div class="frow"><select id="engSel">'+engs+'</select></div>'
  +'<p class="tiny">انتقال داده‌ها (نشانک‌ها/تاریخچه) بین سرورها — کپی کن و در سرور دیگر جای‌گذاری کن:</p>'
  +'<div class="frow"><button class="pbtn" id="expD">دریافت داده‌ها</button><button class="pbtn" id="impD">بازیابی از متن</button></div>'
  +'<textarea id="dataBox" placeholder="داده‌های پشتیبان اینجا…" style="display:none"></textarea>'});
  panelbox.querySelectorAll('input[name=bk]').forEach(function(r){
    r.addEventListener('change',function(){
      settings.active=Number(this.getAttribute('data-i'));
      saveSettings();
      showSettings();
      if(active&&active.url){active.frame.src=proxyPath(active.url);}
    });
  });
  var rm=panelbox.querySelectorAll('[data-rm]');
  for(var k=0;k<rm.length;k++)rm[k].onclick=function(){
    var i=Number(this.getAttribute('data-rm'));
    settings.backends.splice(i,1);
    if(settings.active>=settings.backends.length)settings.active=0;
    saveSettings();showSettings();
  };
  panelbox.querySelector('#addBk').onclick=function(){
    var n=panelbox.querySelector('#nbname').value.trim();
    var u=panelbox.querySelector('#nburl').value.trim().replace(/\\/+$/,'');
    if(!n||!/^https?:\\/\\//.test(u)){alert('نام و آدرس (شروع با https://) را کامل وارد کن.');return;}
    settings.backends.push({name:n,url:u});saveSettings();showSettings();
  };
  panelbox.querySelector('#testBk').onclick=function(){
    var btn=this;btn.textContent='در حال تست…';btn.disabled=true;
    var list=settings.backends;
    var done=0;
    /* تست بیدار-آگاه: سرویس‌های رایگان (مثل Render) بعد از ۱۵ دقیقه بی‌کاری
     * می‌خوابند و بیدار شدنشان تا ~۱ دقیقه طول می‌کشد؛ به‌جای «خطا»،
     * «بیدار شدن…» نشان می‌دهیم و چند بار دوباره تلاش می‌کنیم.
     * پاسخ باید متن «ok» باشد — صفحه‌ی لودینگ پلتفرم (HTML با کد ۲۰۰) رد می‌شود. */
    function testOne(b,i,attempt){
      var sp=panelbox.querySelector('#ms'+i);
      var t0=Date.now();
      var ctl=new AbortController();
      var to=setTimeout(function(){ctl.abort();},9000);
      fetch(b.url+'/health',{cache:'no-store',signal:ctl.signal})
       .then(function(r){return r.text().then(function(txt){return {ok:r.ok&&txt==='ok'};});})
       .then(function(r){
         clearTimeout(to);
         if(r.ok){
           var ms=Date.now()-t0;var sp2=panelbox.querySelector('#ms'+i);
           if(sp2)sp2.textContent=ms+' ms';b.ms=ms;return {fin:true};
         }
         throw new Error('bad');
       })
       .catch(function(){
         clearTimeout(to);
         if(attempt<4){ // تا ۴ بار با فاصله — بیدار شدن سرور خوابیده
           var sp3=panelbox.querySelector('#ms'+i);
           if(sp3)sp3.textContent='بیدار شدن… ('+(attempt+1)+'/۴)';
           b.ms=99999;
           setTimeout(function(){testOne(b,i,attempt+1);},9000);
           return {fin:false};
         }
         var sp4=panelbox.querySelector('#ms'+i);if(sp4)sp4.textContent='خواب/خطا';b.ms=99999;
         return {fin:true};
       })
       .then(function(res){
         if(!res||!res.fin)return; /* تلاش مجدد در جریان است؛ شمارش نکن */
         if(++done===list.length){btn.textContent='تست سرعت سرورها';btn.disabled=false;
           var alive=list.filter(function(x){return (x.ms||99999)<99999;});
           if(!alive.length){alert('هیچ سروری پاسخ نداد. اگر لایه رایگان است، ممکن است خوابیده باشد — دوباره تست بزن.');return;}
           var best=0;for(var x=0;x<list.length;x++)if((list[x].ms||99999)<(list[best].ms||99999))best=x;
           if(list.length>1&&confirm('سریع‌ترین سرور: '+list[best].name+' — فعال شود؟')){
             settings.active=best;saveSettings();showSettings();
             if(active&&active.url)active.frame.src=proxyPath(active.url);}}
       });
    }
    list.forEach(function(b,i){
      var sp=panelbox.querySelector('#ms'+i);if(sp)sp.textContent='…';
      testOne(b,i,0);
    });
  };
  panelbox.querySelector('#engSel').onchange=function(){settings.engine=this.value;saveSettings();};
  panelbox.querySelector('#expD').onclick=function(){
    var box=panelbox.querySelector('#dataBox');box.style.display='block';
    box.value=JSON.stringify({bookmarks:bookmarks,history:history.slice(0,150)});
    box.select();
    try{document.execCommand('copy');}catch(e){}
  };
  panelbox.querySelector('#impD').onclick=function(){
    var box=panelbox.querySelector('#dataBox');
    try{
      var d=JSON.parse(box.value);
      if(d.bookmarks)bookmarks=d.bookmarks;
      if(d.history)history=d.history;
      lsSet(LS.b,bookmarks);lsSet(LS.h,history);
      renderBm();alert('داده‌ها بازیابی شد.');
    }catch(e){alert('متن داده معتبر نیست.');}
  };
}
/* ---------- تغییر IP خروجی ---------- */
function showIpPanel(){
  var base=backend();
  openPanel({t:'تغییر IP خروجی',b:
   '<p class="tiny">IP خروجی همان آی‌پی‌ای است که سایت‌های مقصد می‌بینند. روی لایه‌های Node (Railway / Render / سرور شخصی) می‌توان آن را عوض کرد؛ لایه‌ی Cloudflare این قابلیت را ندارد.</p>'
  +'<div class="brow"><span class="bn">سرور فعال</span><span class="bu">'+esc2(base)+'</span>'
  +'<button class="pbtn" id="ipTest">تست IP فعلی</button></div>'
  +'<div class="brow"><span class="bn">نتیجه</span><span class="bu" id="ipLive">—</span><span class="ms" id="ipMs"></span></div>'
  +'<div id="ipBox" style="margin-top:8px"><p class="tiny">در حال بررسی پشتیبانی سرور…</p></div>'});
  panelbox.querySelector('#ipTest').onclick=function(){
    var sp=panelbox.querySelector('#ipLive');
    sp.textContent='در حال تست…';
    panelbox.querySelector('#ipMs').textContent='';
    ipFetch('/_ip/test',{cache:'no-store'})
      .then(function(r){return r.json();})
      .then(function(j){
        if(j.ok){
          sp.textContent=j.ip+(j.country?(' — '+j.country):'');
          panelbox.querySelector('#ipMs').textContent=j.latency?(j.latency+' ms'):'';
        } else {
          sp.textContent=j.error||'تست ممکن نشد';
        }
      })
      .catch(function(){sp.textContent='خطا در تست';});
  };
  ipFetch('/_ip',{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(st){
    if(!st||!st.supported){
      panelbox.querySelector('#ipBox').innerHTML=
        '<p class="tiny" style="color:#fbbf24">⚠ این سرور از تغییر IP پشتیبانی نمی‌کند (لایه‌ی Cloudflare).</p>'
       +'<p class="tiny">از منوی ⋮ ← «تنظیمات و سرورها» یک سرور Railway یا Render را فعال کن و دوباره این پنل را باز کن. تست سرعت سرورها هم سریع‌ترین را پیدا می‌کند.</p>';
      return;
    }
    renderIpCtl(st);
  }).catch(function(){
    panelbox.querySelector('#ipBox').innerHTML='<p class="tiny">سرور پاسخ نداد؛ دوباره امتحان کن.</p>';
  });
  function renderIpCtl(st){
    var mode=st.mode||'direct';
    var h='<p class="tiny" style="margin-top:6px">حالت مسیر خروجی:</p>'
    +'<div class="brow"><input type="radio" name="ipm" value="direct"'+(mode==='direct'?' checked':'')+'><span class="bn">مستقیم (سریع‌ترین)</span><span class="bu">'
      +(st.direct&&st.direct.ip?('IP سرور: '+esc2(st.direct.ip)+(st.direct.country?(' — '+esc2(st.direct.country)):'')):'IP خودِ سرور')+'</span></div>'
    +'<div class="brow"><input type="radio" name="ipm" value="pool"'+(mode==='pool'?' checked':'')+'><span class="bn">چرخش پروکسی رایگان</span><span class="bu">'
      +(st.pool&&st.pool.size?('استخر: '+st.pool.size+' پروکسی سالم'):'در حال آماده‌سازی استخر…')+'</span></div>'
    +'<div class="brow"><input type="radio" name="ipm" value="manual"'+(mode==='manual'?' checked':'')+'><span class="bn">پروکسی شخصی</span><span class="bu">http://host:port</span></div>'
    +'<div id="ipExtra" style="margin-top:8px"></div>';
    panelbox.querySelector('#ipBox').innerHTML=h;
    function extra(){
      var m=panelbox.querySelector('input[name=ipm]:checked').value;
      var ex=panelbox.querySelector('#ipExtra');
      if(m==='direct'){
        ex.innerHTML='<p class="tiny">همه‌ی درخواست‌ها با IP خودِ سرور می‌روند — سریع‌ترین حالت. اگر سایتی این IP را بسته، یکی از دو حالت دیگر را انتخاب کن.</p>';
      } else if(m==='pool'){
        ex.innerHTML='<div class="frow"><button class="pbtn pri" id="ipRot">🔄 گرفتن IP جدید</button></div>'
        +(st.active?'<p class="tiny">پروکسی فعال: <b style="direction:ltr">'+esc2(st.active.ip)+'</b>'+(st.active.country?(' — '+esc2(st.active.country)):'')+' · '+st.active.latency+'ms</p>':'')
        +'<p class="tiny">هر بار «گرفتن IP جدید» یک پروکسی سالمِ دیگر فعال می‌شود. پروکسی‌های رایگان کندتر از مسیر مستقیم‌اند؛ بعد از تمام شدن کار برگرد به حالت مستقیم.</p>';
        panelbox.querySelector('#ipRot').onclick=function(){
          var b=this;b.disabled=true;b.textContent='در حال جستجوی پروکسی سالم… (تا ۱ دقیقه)';
          ipFetch('/_ip/rotate',{method:'POST'}).then(function(r){return r.json();}).then(function(j){
            if(j.ok&&j.active){
              renderIpCtl(j);
              var live=panelbox.querySelector('#ipLive');if(live)live.textContent=j.active.ip;
              panelbox.querySelector('#ipTest').click();
            } else {
              b.disabled=false;b.textContent='🔄 گرفتن IP جدید';
              alert(j.error||'پروکسی سالمی پیدا نشد؛ کمی بعد دوباره امتحان کن.');
            }
          }).catch(function(){b.disabled=false;b.textContent='🔄 گرفتن IP جدید';alert('ارتباط با سرور برقرار نشد.');});
        };
      } else {
        ex.innerHTML='<div class="frow"><input id="ipUrl" placeholder="http://host:port" direction="ltr" value="'+esc2(st.manualUrl||'')+'"><button class="pbtn pri" id="ipSetM">فعال‌سازی</button></div>'
        +'<p class="tiny">آدرس پروکسی شخصی‌ات را بده (مثلاً پروکسی چرخشی خریداری‌شده). همه‌ی ترافیک از آن می‌گذرد.</p>';
        panelbox.querySelector('#ipSetM').onclick=function(){
          var u=panelbox.querySelector('#ipUrl').value.trim();
          ipFetch('/_ip/mode',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'manual',proxyUrl:u})})
            .then(function(r){return r.json();}).then(function(j){
              if(j.ok){renderIpCtl(j);alert('پروکسی شخصی فعال شد.');}
              else{alert(j.error||'پروکسی فعال نشد.');}
            }).catch(function(){alert('ارتباط با سرور برقرار نشد.');});
        };
      }
    }
    panelbox.querySelectorAll('input[name=ipm]').forEach(function(r){
      r.addEventListener('change',function(){
        var m=this.value;
        ipFetch('/_ip/mode',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:m})})
          .then(function(r2){return r2.json();}).then(function(j){if(j.ok)renderIpCtl(j);})
          .catch(function(){alert('تغییر حالت ممکن نشد.');});
      });
      r.addEventListener('change',extra);
    });
    extra();
  }
}
/* ---------- جستجو در صفحه ---------- */
var findbar=el('findbar'),fq=el('fq'),marks=[];
function openFind(){findbar.classList.add('on');fq.focus();fq.select();}
function closeFind(){findbar.classList.remove('on');clearMarks();}
el('fclose').addEventListener('click',closeFind);
fq.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();stepFind(e.shiftKey?-1:1);}});
el('fnext').addEventListener('click',function(){stepFind(1);});
el('fprev').addEventListener('click',function(){stepFind(-1);});
function clearMarks(){
  try{
    var doc=active&&active.frame.contentDocument;
    if(doc){var ms=doc.querySelectorAll('mark.pxf');
      for(var i=0;i<ms.length;i++){var p=ms[i].parentNode;p.replaceChild(doc.createTextNode(ms[i].textContent),ms[i]);p.normalize();}}
  }catch(e){}
  marks=[];el('fcount').textContent='۰/۰';
}
function doFind(q){
  clearMarks();
  if(!q)return;
  try{
    var doc=active.frame.contentDocument;
    if(!doc||!doc.body)return;
    var walker=doc.createTreeWalker(doc.body,NodeFilter.SHOW_TEXT,null,false);
    var texts=[];
    while(walker.nextNode()){var n=walker.currentNode;
      if(n.nodeValue&&n.nodeValue.toLowerCase().indexOf(q.toLowerCase())>=0&&!n.parentNode.closest('script,style'))texts.push(n);}
    var mark=doc.createElement('mark');mark.className='pxf';
    for(var i=0;i<texts.length&&marks.length<200;i++){
      var node=texts[i];var idx=node.nodeValue.toLowerCase().indexOf(q.toLowerCase());
      while(idx>=0&&marks.length<200){
        var rng=doc.createRange();
        rng.setStart(node,idx);rng.setEnd(node,idx+q.length);
        var m=mark.cloneNode(false);
        try{rng.surroundContents(m);marks.push(m);}catch(e){}
        if(node.nodeValue)idx=node.nodeValue.toLowerCase().indexOf(q.toLowerCase(),idx+q.length);else break;
      }
    }
  }catch(e){}
  stepFind(1,true);
}
fq.addEventListener('input',function(){doFind(fq.value);});
var fIdx=-1;
function stepFind(d,reset){
  if(!marks.length){el('fcount').textContent='۰/۰';return;}
  if(reset)fIdx=-1;
  if(fIdx>=0&&marks[fIdx])marks[fIdx].classList.remove('on');
  fIdx=(fIdx+d+marks.length)%marks.length;
  marks[fIdx].classList.add('on');
  try{marks[fIdx].scrollIntoView({block:'center'});}catch(e){}
  el('fcount').textContent=(fIdx+1)+'/'+marks.length;
}
/* ---------- بزرگ‌نمایی ---------- */
function setZoom(z){
  if(!active)return;
  z=Math.min(2,Math.max(0.4,Math.round(z*10)/10));
  active.zoom=z;
  try{var doc=active.frame.contentDocument;if(doc&&doc.body)doc.body.style.zoom=z;}catch(e){}
}
/* ---------- میان‌برها ---------- */
function relayKey(e){handleKey(e,true);}
function handleKey(e,fromFrame){
  var k=e.key;
  if(e.ctrlKey&&(k==='t'||k==='T')){e.preventDefault();newTab(true);return;}
  if(e.ctrlKey&&(k==='w'||k==='W')){e.preventDefault();if(active)closeTab(active.id);return;}
  if(e.ctrlKey&&(k==='l'||k==='L')||k==='F6'){e.preventDefault();addrEl.focus();addrEl.select();return;}
  if(e.ctrlKey&&(k==='d'||k==='D')){e.preventDefault();el('bstar').click();return;}
  if(e.ctrlKey&&(k==='f'||k==='F')){e.preventDefault();openFind();return;}
  if(k==='F5'||(e.ctrlKey&&(k==='r'||k==='R'))){e.preventDefault();reloadTab();return;}
  if(e.altKey&&k==='ArrowRight'){e.preventDefault();goHist(-1);return;}
  if(e.altKey&&k==='ArrowLeft'){e.preventDefault();goHist(1);return;}
  if(e.ctrlKey&&(k==='+'||k==='=')){e.preventDefault();setZoom((active?active.zoom:1)+0.1);return;}
  if(e.ctrlKey&&k==='-'){e.preventDefault();setZoom((active?active.zoom:1)-0.1);return;}
  if(e.ctrlKey&&k==='0'){e.preventDefault();setZoom(1);return;}
  if(k==='Escape'){closeFind();closePanel();menuEl.classList.remove('on');return;}
}
document.addEventListener('keydown',function(e){handleKey(e,false);});
/* ---------- پیام از صفحات (تب جدید / window.open / target=_blank) ---------- */
window.addEventListener('message',function(e){
  var d=e.data;
  if(!d||typeof d!=='object')return;
  if(d.px==='go'&&d.url){navigate(smartUrl(String(d.url)));}
  else if(d.px==='open'&&d.url){
    try{
      var uo=new URL(String(d.url),location.origin);
      var t=targetFromLoc(uo,null);
      newTab(true);
      if(t)navigate(t);else if(active){active.url='';active.frame.src='/newtab';}
    }catch(err){}
  }
  else if(d.px==='nav'&&d.path){
    try{
      var nuo=new URL(location.origin+String(d.path));
      var tt=targetFromLoc(nuo,null);
      if(tt&&active){active.url=tt;setAddr(tt);renderTabs();}
    }catch(err){}
  }
});
function esc2(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
/* ---------- افزودن سرور از طریق لینک (لایه‌ی Railway / تجدید پلن) ---------- */
function offerBackendFromLink(){
  try{
    var q=new URLSearchParams(location.search);
    var v=q.get('add-backend')||'';
    if(!v)return;
    try{history.replaceState(null,'',location.pathname);}catch(e){}
    var parts=v.split('|');
    var n=(parts[0]||'').trim()||'سرور جدید';
    var u=(parts[1]||'').trim().replace(/\\/+$/,'');
    if(!/^https?:\\/\\/[a-z0-9.-]+/i.test(u))return;
    for(var i=0;i<settings.backends.length;i++){
      if(settings.backends[i].url===u){
        settings.active=i;saveSettings();
        if(active&&active.url)active.frame.src=proxyPath(active.url);
        return;
      }
    }
    openPanel({t:'افزودن سرور جدید',b:
      '<p class="tiny">این سرور به فهرست سرورهای پروکسی اضافه و فعال شود؟</p>'
      +'<div class="frow" style="justify-content:flex-start;gap:10px;flex-wrap:wrap"><b>'+esc2(n)+'</b>'
      +'<span class="bu" style="direction:ltr">'+esc2(u)+'</span></div>'
      +'<div class="frow"><button class="pbtn pri" id="okAdd">افزودن و فعال‌سازی</button></div>'});
    panelbox.querySelector('#okAdd').onclick=function(){
      settings.backends.push({name:n,url:u});
      settings.active=settings.backends.length-1;
      saveSettings();closePanel();
      if(active&&active.url)active.frame.src=proxyPath(active.url);
    };
  }catch(e){}
}
/* ---------- شروع ---------- */
renderBm();
newTab(true);
offerBackendFromLink();
})();
</script>
</body>
</html>`;
}

/* ---------------------- صفحه‌ی «تب جدید» ---------------------- */

function newtabPage() {
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>تب جدید</title>
<link rel="icon" href="/favicon.ico">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:grid;place-items:center;padding:34px 18px;color:#e7edf8;
  font-family:"Segoe UI",Tahoma,"Vazirmatn",sans-serif;background:#0b1220;
  background-image:radial-gradient(900px 500px at 85% -10%,rgba(56,189,248,.16),transparent 60%),
                   radial-gradient(700px 420px at 5% 110%,rgba(34,211,238,.12),transparent 60%)}
.wrap{width:100%;max-width:620px;text-align:center}
.logo{font-size:38px;font-weight:800;margin-bottom:6px}
.logo span{color:#0ea5e9}
.sub{color:#7f92b3;font-size:13.5px;margin-bottom:30px}
form{display:flex;gap:9px;flex-wrap:wrap;justify-content:center;margin-bottom:34px}
input[type=search]{flex:1;min-width:220px;max-width:430px;padding:15px 20px;border-radius:26px;
  border:1px solid #2a3a5c;background:rgba(12,21,38,.9);color:#e7edf8;font-size:15px;outline:none;
  direction:rtl;text-align:right;font-family:inherit}
input:focus{border-color:#38bdf8;box-shadow:0 0 0 3px rgba(56,189,248,.18)}
select{padding:15px 6px;border-radius:26px;border:1px solid #2a3a5c;background:rgba(12,21,38,.9);
  color:#c7d5ee;font-family:inherit;font-size:13.5px;outline:none}
button{padding:15px 26px;border-radius:26px;border:0;background:linear-gradient(135deg,#0ea5e9,#22d3ee);
  color:#04121f;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit}
button:hover{filter:brightness(1.1)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(102px,1fr));gap:12px}
.tile{display:flex;flex-direction:column;align-items:center;gap:9px;padding:15px 6px;border-radius:14px;
  background:rgba(17,26,46,.7);border:1px solid #1d2a44;cursor:pointer;color:#c7d5ee;font-size:12px;
  font-family:inherit;transition:transform .15s,border-color .15s}
.tile:hover{transform:translateY(-3px);border-color:#38bdf8;color:#fff}
.tile .ic{width:38px;height:38px;border-radius:11px;display:flex;align-items:center;justify-content:center;
  font-size:17px;font-weight:700;color:#fff}
.hint{margin-top:30px;color:#5d7295;font-size:12px;line-height:2.2}
</style>
</head>
<body>
<div class="wrap">
  <div class="logo">وب<span>پروکسی</span></div>
  <div class="sub">هر سایتی را از طریق پروکسی باز کن — مثل یک مرورگر واقعی</div>
  <form id="sf">
    <input type="search" id="q" placeholder="جستجو یا آدرس سایت…" autocomplete="off" autofocus>
    <select id="eng">
      <option value="ddg">داک‌داک‌گو</option>
      <option value="bing">بینگ</option>
      <option value="google">گوگل</option>
      <option value="wiki">ویکی‌پدیا</option>
      <option value="yt">یوتیوب</option>
    </select>
    <button type="submit">برو</button>
  </form>
  <div class="tiles" id="tiles"></div>
  <div class="hint">پخش یوتیوب پشتیبانی می‌شود · با ⭐/☆ نشانک کن · Ctrl+T تب جدید</div>
</div>
<script>
(function(){
'use strict';
var ENGINES={
  ddg:function(q){return 'https://html.duckduckgo.com/html/?q='+encodeURIComponent(q);},
  bing:function(q){return 'https://www.bing.com/search?q='+encodeURIComponent(q);},
  google:function(q){return 'https://www.google.com/search?q='+encodeURIComponent(q);},
  wiki:function(q){return 'https://fa.wikipedia.org/w/index.php?search='+encodeURIComponent(q);},
  yt:function(q){return 'https://www.youtube.com/results?search_query='+encodeURIComponent(q);}
};
var TILES=[
  {t:'مرورگر تصویری',u:'/remote',c:'#7c3aed',i:'▣'},
  {t:'یوتیوب',u:'https://www.youtube.com/',c:'#f43f5e',i:'▶'},
  {t:'BBC فارسی',u:'https://www.bbc.com/persian',c:'#b91c1c',i:'B'},
  {t:'ویکی‌پدیا',u:'https://fa.wikipedia.org/',c:'#334155',i:'W'},
  {t:'DW فارسی',u:'https://www.dw.com/fa/',c:'#1d4ed8',i:'D'},
  {t:'رادیو فردا',u:'https://www.radiofarda.com/',c:'#c2410c',i:'ر'},
  {t:'ایران اینتل',u:'https://www.iranintl.com/',c:'#0e7490',i:'I'},
  {t:'گاردین',u:'https://www.theguardian.com/',c:'#1e3a8a',i:'G'},
  {t:'گوگل',u:'https://www.google.com/',c:'#374151',i:'g'}
];
var box=document.getElementById('tiles');
for(var i=0;i<TILES.length;i++){
  (function(t){
    var b=document.createElement('button');
    b.className='tile';
    b.innerHTML='<span class="ic" style="background:'+t.c+'">'+t.i+'</span><span>'+t.t+'</span>';
    b.onclick=function(){go(t.u);};
    box.appendChild(b);
  })(TILES[i]);
}
function go(url){
  if(url.charAt(0)==='/'){location.href=url;return;} // مسیر داخلی مثل مرورگر تصویری
  if(window.parent&&window.parent!==window){
    try{window.parent.postMessage({px:'go',url:url},'*');return;}catch(e){}
  }
  location.href='/proxy?url='+encodeURIComponent(url);
}
document.getElementById('sf').addEventListener('submit',function(e){
  e.preventDefault();
  var q=document.getElementById('q').value.trim();
  if(!q)return;
  var eng=document.getElementById('eng').value;
  var url=ENGINES[eng]?ENGINES[eng](q):q;
  go(url);
});
})();
</script>
</body>
</html>`;
}

/* ---------------------------- صادر کردن‌ها ---------------------------- */

export {
  AUTH_COOKIE, ORIGIN_COOKIE, SID_COOKIE, MAX_BODY, MAX_REWRITE, UA, STRIP_HEADERS,
  esc, parseCookies, fmtViews, fmtDur, normalizeTarget, isBlockedHost, createCookieJar,
  page, loginPage, errorPage, notFoundPage, faviconResponse,
  proxiedPath, rewriteHtml, rewriteCss, CLIENT_PATCH,
  innertube, ytPlayerInfo, ytSearch, ytPlaylist, ytRouteFor, hlsRewrite, isGooglevideo,
  ytHomePage, ytSearchPage, ytPlaylistPage, ytPlayerPage, ytLoadingPage,
  shellPage, newtabPage,
};

