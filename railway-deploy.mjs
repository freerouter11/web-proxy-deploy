#!/usr/bin/env node
/**
 * استقرار وب‌پروکسی روی Railway — «لایه‌ی سوم» پروکسی
 * ---------------------------------------------------
 * ⚠️ مهم: این نسخه فقط از GraphQL API استفاده می‌کند. Railway CLI را
 * اجرا نکن — CLI در محیط خودکار شناسایی می‌شود و ممکن است محدودیت
 * «فعالیت مشکوک» روی ورک‌اسپیس فعال کند (تجربه‌شده!).
 *
 * دو حالت استقرار:
 *   ۱) repo (پیش‌فرض) — از ریپوی عمومی گیت‌هاب (بدون نیاز به هیچ توکن دیگری)
 *   ۲) image — از تصویر داکر (برای پلن Pro با رجیستری خصوصی)
 *
 * استفاده (حالت پیش‌فرض):
 *   RAILWAY_TOKEN=rlwy_wksp_...  node railway-deploy.mjs [نام-پروژه]
 *
 * استفاده (حالت تصویر):
 *   RAILWAY_TOKEN=... IMAGE=ghcr.io/... GHCR_USER=... GHCR_TOKEN=... node railway-deploy.mjs
 *
 * تجدید پلن (پس از پایان ۳۰ روز) — همان چیزی که برای تداوم می‌خواهی:
 *   ۱) با یک ایمیل جدید در railway.com از «مرورگر» ثبت‌نام کن
 *   ۲) لینک تأیید ایمیل را باز کن و یک‌بار وارد داشبورد شو
 *   ۳) از Settings → API Tokens یک «Workspace Token» بساز
 *   ۴) همین اسکریپت را با توکن جدید اجرا کن — همه‌چیز از نو ساخته می‌شود
 *   ۵) لینک «افزودن به سوییچ» چاپ‌شده را در مرورگر باز کن و تأیید بزن
 *
 * نکته‌ی مهم برای عدم بلاک‌شدن: ثبت‌نام حتماً از مرورگر انجام شود و
 * هرگز Railway CLI برای استقرار استفاده نشود.
 */

'use strict';

import { writeFileSync } from 'node:fs';

const API = 'https://backboard.railway.app/graphql/v2';
const TOKEN = String(process.env.RAILWAY_TOKEN || '').trim();
const IMAGE = String(process.env.IMAGE || '').trim(); // اگر خالی باشد → حالت repo
const DEPLOY_REPO = String(process.env.DEPLOY_REPO || 'freerouter11/web-proxy-deploy').trim();
const BRANCH = String(process.env.BRANCH || 'main').trim();
const GHCR_USER = String(process.env.GHCR_USER || '').trim();
const GHCR_TOKEN = String(process.env.GHCR_TOKEN || '').trim();
const ENTRY_URL = String(process.env.ENTRY_URL || 'https://web-proxy.aiaikoio323.workers.dev').trim().replace(/\/+$/, '');
const NAME = process.argv[2] || 'web-proxy';

const c = {
  cyan: (s) => `\u001b[1;36m${s}\u001b[0m`,
  green: (s) => `\u001b[1;32m${s}\u001b[0m`,
  red: (s) => `\u001b[1;31m${s}\u001b[0m`,
  yellow: (s) => `\u001b[1;33m${s}\u001b[0m`,
};
const say = (m) => console.log(c.cyan('» ' + m));
const die = (m) => { console.error(c.red('✗ خطا: ' + m)); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODE = IMAGE ? 'image' : 'repo';
if (!TOKEN) die('توکن Railway را بده:  RAILWAY_TOKEN=rlwy_wksp_... node railway-deploy.mjs');
if (!TOKEN.startsWith('rlwy_')) die('توکن باید با rlwy_ شروع شود (از تنظیمات ورک‌اسپیس در railway.com بساز).');
if (MODE === 'image' && (!GHCR_USER || !GHCR_TOKEN)) die('در حالت تصویر: GHCR_USER و GHCR_TOKEN هم لازم است (توکن گیت‌هاب با دسترسی read:packages).');

async function gql(query, variables) {
  let r;
  try {
    r = await fetch(API, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: variables || {} }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error('اتصال به Railway برقرار نشد: ' + e.message);
  }
  const j = await r.json().catch(() => ({}));
  if (j.errors && j.errors.length) {
    const msg = j.errors.map((e) => e.message).join(' | ');
    const err = new Error(msg);
    err.graphql = j.errors;
    throw err;
  }
  return j.data;
}

/* ---------- ۱) پروژه ---------- */
say('بررسی/ساخت پروژه‌ی «' + NAME + '»…');
const projList = await gql(`{ projects { edges { node { id name } } } }`);
let proj = (projList.projects.edges || []).map((e) => e.node).find((p) => p.name === NAME);
if (!proj) {
  const created = await gql(`mutation($n:String!){ projectCreate(input:{name:$n}) { id name } }`, { n: NAME });
  proj = created.projectCreate;
  console.log('  پروژه‌ی جدید ساخته شد.');
} else {
  console.log('  پروژه موجود است، از همان استفاده می‌شود.');
}

/* ---------- ۲) محیط production ---------- */
const projEnv = await gql(`query($id:String!){ project(id:$id){ primaryEnvironmentId environments { edges { node { id name isEphemeral } } } } }`, { id: proj.id });
const envNode = (projEnv.project.environments.edges || []).map((e) => e.node).find((e) => !e.isEphemeral);
const envId = (envNode && envNode.id) || projEnv.project.primaryEnvironmentId;
if (!envId) die('محیط production پیدا نشد.');
console.log('  محیط: ' + ((envNode && envNode.name) || 'production'));

/* ---------- ۳) سرویس + استقرار ---------- */
let svc = null;

if (MODE === 'repo') {
  say('استقرار از ریپوی عمومی «' + DEPLOY_REPO + '» (' + BRANCH + ')…');
  try {
    await gql(`mutation($p:String!,$r:String!,$b:String!,$e:String!){ githubRepoDeploy(input:{projectId:$p,repo:$r,branch:$b,environmentId:$e}) }`,
      { p: proj.id, r: DEPLOY_REPO, b: BRANCH, e: envId });
  } catch (e) {
    const m = String(e.message || '');
    if (/unusual activity|limited this workspace|restricted/i.test(m)) {
      die('این ورک‌اسپیس محدود شده («فعالیت مشکوک») و با توکنِ همان اکانت باز نمی‌شود.\n' +
        'راه‌حل: با یک ایمیل جدید از «مرورگر» در railway.com ثبت‌نام کن، لینک تأیید ایمیل را باز کن،\n' +
        'یک‌بار وارد داشبورد شو و از Settings → API یک «Workspace Token» بساز و همین اسکریپت را\n' +
        'با توکن جدید اجرا کن. همه‌چیز از نو ساخته می‌شود (پروژه، سرویس، دامنه).\n' +
        'هشدار: هرگز Railway CLI یا ابزار خودکار برای ثبت‌نام/استقرار استفاده نکن — همان عامل بلاک است.');
    }
    die(m);
  }
  /* سرویسِ ساخته‌شده توسط استقرار را پیدا کن */
  for (let i = 0; i < 15 && !svc; i++) {
    const l = await gql(`query($id:String!){ project(id:$id){ services { edges { node { id name } } } } }`, { id: proj.id });
    const nodes = (l.project.services.edges || []).map((e) => e.node);
    svc = nodes.find((s) => s.name === 'web-proxy') || nodes.find((s) => /web-proxy/i.test(s.name)) || nodes[0] || null;
    if (!svc) await sleep(4000);
  }
  if (!svc) die('سرویس ساخته نشد؛ داشبورد Railway را ببین.');
  console.log('  سرویس: ' + svc.name);
} else {
  const svcList = await gql(`query($id:String!){ project(id:$id){ services { edges { node { id name } } } } }`, { id: proj.id });
  svc = (svcList.project.services.edges || []).map((e) => e.node).find((s) => s.name === 'web-proxy');
  if (!svc) {
    const created = await gql(`mutation($p:String!,$n:String!){ serviceCreate(input:{projectId:$p,name:$n}) { id name } }`, { p: proj.id, n: 'web-proxy' });
    svc = created.serviceCreate;
  }
  await gql(`mutation($e:String!,$p:String!,$s:String!,$v:String!){ variableUpsert(input:{environmentId:$e,projectId:$p,serviceId:$s,skipDeploys:true,name:"PORT",value:$v}) }`,
    { e: envId, p: proj.id, s: svc.id, v: '3000' });
  say('تنظیم تصویر «' + IMAGE + '»…');
  await gql(`mutation($e:String!,$s:String!,$img:String!,$u:String!,$pw:String!){
    serviceInstanceUpdate(environmentId:$e, serviceId:$s, input:{
      source:{ image:$img },
      registryCredentials:{ username:$u, password:$pw },
      healthcheckPath:"/health",
      healthcheckTimeout:180
    })
  }`, { e: envId, s: svc.id, img: IMAGE, u: GHCR_USER, pw: GHCR_TOKEN });
}

/* ---------- ۴) انتظار برای استقرار ---------- */
say('در انتظار پایان استقرار (۲ تا ۵ دقیقه)…');
let dep = null;
for (let i = 0; i < 25 && !dep; i++) {
  const dl = await gql(`query($e:String!,$s:String!){ deployments(first:1,input:{environmentId:$e,serviceId:$s}){ edges { node { id status } } } }`, { e: envId, s: svc.id });
  const node = dl.deployments.edges[0] && dl.deployments.edges[0].node;
  if (node && node.status !== 'REMOVED') dep = node;
  if (!dep) await sleep(4000);
}
if (!dep) die('هیچ استقراری آغاز نشد.');

let status = dep.status;
for (let i = 0; i < 100; i++) {
  if (status === 'SUCCESS') break;
  if (status === 'FAILED' || status === 'CRASHED' || status === 'REMOVED') {
    const info = await gql(`query($id:String!){ deployment(id:$id){ meta } }`, { id: dep.id });
    const errs = (info.deployment.meta && info.deployment.meta.configErrors) || [];
    die('استقرار ناموفق بود (' + status + '): ' + (errs.join(' — ') || 'دلیل ثبت نشد؛ لاگ‌ها را در داشبورد ببین.'));
  }
  process.stdout.write('  وضعیت: ' + status + '   \r');
  await sleep(6000);
  const dl = await gql(`query($id:String!){ deployment(id:$id){ status } }`, { id: dep.id });
  status = dl.deployment.status;
}
if (status !== 'SUCCESS') die('استقرار در حالت «' + status + '» ماند؛ داشبورد را ببین.');
console.log('  استقرار: ' + c.green('موفق') + '                 ');

/* ---------- ۵) دامنه‌ی عمومی ---------- */
say('ساخت دامنه‌ی عمومی…');
let port = 3000;
try {
  const vv = await gql(`query($e:String!,$p:String!,$s:String!){ variables(environmentId:$e,projectId:$p,serviceId:$s){ edges { node { name value } } } }`,
    { e: envId, p: proj.id, s: svc.id });
  const pv = (vv.variables.edges || []).map((x) => x.node).find((x) => x.name === 'PORT');
  if (pv && /^\d+$/.test(pv.value)) port = Number(pv.value);
} catch (_) { /* پیش‌فرض ۳۰۰۰ */ }

let domain = '';
try {
  const existing = await gql(`query($p:String!,$e:String!,$s:String!){ domains(projectId:$p,environmentId:$e,serviceId:$s){ edges { node { domain } } } }`,
    { p: proj.id, e: envId, s: svc.id });
  domain = ((existing.domains.edges || []).map((x) => x.node.domain)[0]) || '';
} catch (_) { /* بدون دامنه‌ی موجود */ }

if (!domain) {
  const d = await gql(`mutation($e:String!,$s:String!,$p:Int!){ serviceDomainCreate(input:{environmentId:$e,serviceId:$s,targetPort:$p}) { domain } }`,
    { e: envId, s: svc.id, p: port });
  domain = d.serviceDomainCreate.domain;
}
if (!domain) die('دامنه ساخته نشد.');
console.log('  دامنه: ' + domain);

const URL_ = domain.startsWith('http') ? domain : 'https://' + domain;

/* ---------- ۶) بررسی سلامت ---------- */
say('بررسی سلامت سرور…');
let ok = false;
for (let i = 0; i < 30; i++) {
  try {
    const r = await fetch(URL_ + '/health', { signal: AbortSignal.timeout(6000) });
    if (r.ok) { ok = true; break; }
  } catch (_) { /* تلاش بعدی */ }
  await sleep(4000);
}
console.log('  سلامت: ' + (ok ? c.green('تأیید شد') : c.yellow('هنوز آماده نیست — کمی بعد خودش بالا می‌آید')));

/* ---------- ۷) خروجی ---------- */
try { writeFileSync('railway-url.txt', URL_ + '\n'); } catch (_) { /* فقط اطلاع */ }

const ADD_LINK = ENTRY_URL + '/?add-backend=' + encodeURIComponent('Railway|' + URL_);

console.log('');
console.log(c.green('✅ لایه‌ی سوم (Railway) آماده شد'));
console.log('');
console.log('  آدرس پروکسی:    ' + c.yellow(URL_));
console.log('  آدرس‌دهی مستقیم: ' + URL_ + '/proxy?url=https://example.com');
console.log('');
console.log('  افزودن به سوییچ پروکسی — این لینک را در مرورگر باز کن و «افزودن و فعال‌سازی» را بزن:');
console.log(c.yellow('  ' + ADD_LINK));
console.log('');
console.log('  (آدرس در فایل railway-url.txt هم ذخیره شد)');
