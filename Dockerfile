# وب‌پروکسی شخصی — تصویر داکر برای استقرار روی Railway
# ساخت با: docker build -t web-proxy .
FROM node:20-alpine

# امنیت: اجرا با کاربر غیر ریشه
RUN mkdir -p /app && chown -R node:node /app
WORKDIR /app

# وابستگی (فقط undici — موتور سرعت و تغییر IP)
COPY --chown=node:node package.json package-lock.json railway.json ./
RUN npm ci --omit=dev && chown -R node:node node_modules

# فقط فایل‌های لازم (کد سبک)
COPY --chown=node:node server.js lib.mjs assets.js hls.min.js ./

ENV NODE_ENV=production
USER node
EXPOSE 3000

# Railway متغیر PORT را خودش تنظیم می‌کند
CMD ["node", "server.js"]
