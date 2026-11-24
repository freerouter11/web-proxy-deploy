# وب‌پروکسی شخصی — تصویر داکر برای استقرار روی Back4App / Koyeb / هر کانتینر
# ساخت با: docker build -t web-proxy .
FROM node:20-alpine

# امنیت: اجرا با کاربر غیر ریشه
RUN mkdir -p /app && chown -R node:node /app
WORKDIR /app

# وابستگی (فقط undici — موتور سرعت و تغییر IP)
COPY --chown=node:node package.json package-lock.json railway.json ./
RUN npm ci --omit=dev && chown -R node:node node_modules

# فقط فایل‌های لازم (کد سبک)
COPY --chown=node:node server.js lib.mjs remote.mjs assets.js hls.min.js ./

ENV NODE_ENV=production
# سقف هیپ مناسب پلن‌های رایگان کم‌رم (Back4App رایگان = ۲۵۶MB) — از OOM جلوگیری می‌کند
# کش درون‌حافظه‌ای هم خودش را با این سقف هماهنگ می‌کند (CACHE_MB یا تشخیص خودکار)
ENV NODE_OPTIONS=--max-old-space-size=192
USER node
EXPOSE 3000

# پلتفرم‌های کانتینری متغیر PORT را خودشان تزریق می‌کنند (Back4App/Koyeb)
CMD ["node", "server.js"]
