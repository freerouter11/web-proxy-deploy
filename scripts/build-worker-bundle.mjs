#!/usr/bin/env node
/**
 * ساخت نسخه‌ی تک‌فایلیِ ورکر برای به‌روزرسانی دستی از داشبورد کلادفلر:
 *   node scripts/build-worker-bundle.mjs
 *
 * خروجی: dist/worker-bundle.js — همه‌ی ماژول‌ها (assets.js + lib.mjs + remote.mjs
 * + worker.js) در یک فایل، بدون import. برای هر لایه‌ی کلادفلر: در ادیتور
 * ورکر همه‌ی کد قبلی را پاک کن، محتوای همین یک فایل را پیست کن و Deploy بزن.
 *
 * فقط برای راحتیِ پیست دستی است؛ استقرار خودکار همان چهار ماژول جدا را
 * می‌فرستد (scripts/cf-deploy.mjs).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

function stripImports(src) {
  // حذف همه‌ی importهای ماژول‌های محلی (چندخطی هم می‌شود)
  return src.replace(/^import\s[\s\S]*?from\s*['"]\.\/[^'"]+['"];?[ \t]*$/gm, '')
            .replace(/^import\s*['"]\.\/[^'"]+['"];?[ \t]*$/gm, '');
}

function stripExports(src) {
  // حذف بلوک export انتهایی (مثل lib.mjs) و پیشوند export از تعریف‌ها
  return src.replace(/^export\s*\{[^}]*\};?[ \t]*$/gm, '')
            .replace(/^export\s+(const|let|var|function|async\s+function|class)\b/gm, '$1 ');
}

const banner = (name) => '/* ================= ' + name + ' ================= */\n';

const parts = [
  banner('assets.js — کتابخانه‌ی hls.js (تولید خودکار؛ ویرایش نشود)'),
  stripExports(stripImports(read('assets.js'))),
  banner('lib.mjs — منطق مشترک'),
  stripExports(stripImports(read('lib.mjs'))),
  banner('remote.mjs — مرورگر تصویری (ریموت)'),
  stripExports(stripImports(read('remote.mjs'))),
  banner('worker.js — نقطه‌ی ورود Cloudflare Workers'),
  stripImports(read('worker.js')),
];

const out = parts.join('\n');
mkdirSync(join(root, 'dist'), { recursive: true });
const outPath = join(root, 'dist', 'worker-bundle.js');
writeFileSync(outPath, out);

// اعتبارسنجی سینتکس
execFileSync(process.execPath, ['--check', outPath], { stdio: 'inherit' });

const kb = (out.length / 1024).toFixed(0);
console.log('ساخته شد: dist/worker-bundle.js (' + kb + 'KB) — سینتکس معتبر است');
console.log('برای به‌روزرسانی هر لایه: داشبورد کلادفلر → ورکر → Edit code → همه را پاک کن → این فایل را پیست کن → Deploy');
