// لایه‌ی Deno Deploy — همان ورکر کلادفلر روی runtime دوم
// ---------------------------------------------------------------
// راه‌اندازی (رایگان، بدون کارت):
//   1) به deno.com/deploy برو و با گیت‌هاب وارد شو
//   2) New Project → GitHub → ریپوی web-proxy-deploy را انتخاب کن
//   3) نقطه‌ی ورود (Entrypoint): deno/main.js
//   4) بعد از ساخت، نشانی (چیزی مثل xxx.deno.dev) را در اپ اندروید
//      از «مدیریت لایه‌ها ← افزودن لایه» اضافه کن
//
// نکته: worker.js کاملاً از APIهای استاندارد وب استفاده می‌کند؛
// تنها تفاوت، این پوشش ۳ خطی برای Deno.serve است.
// رمز اختیاری: در تنظیمات Deno Deploy متغیر محیطی PROXY_PASSWORD بگذار.

import handler from '../worker.js';

Deno.serve((req) => handler.fetch(req, Deno.env.toObject(), undefined));
