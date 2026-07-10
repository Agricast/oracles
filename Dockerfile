FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Install Chromium for the direct-MOC scraper (src/moc-scraper.ts). Bloats
# this slim image (~400MB+) but the reporter must be able to scrape MOC
# itself instead of depending on the backend's /public/price feed.
RUN npx playwright install --with-deps chromium

COPY --from=build /app/dist ./dist

# Run as a dedicated non-root user. The scraper renders untrusted remote
# content (data.moc.go.th) with Chromium's sandbox now enabled (the
# --no-sandbox launch arg was removed from moc-scraper.ts) - a renderer
# exploit must not also get root on the container, since REPORTER_PRIVATE_KEY
# lives in this same process's env.
RUN groupadd --system reporter && useradd --system --gid reporter --create-home reporter \
  && chown -R reporter:reporter /app
USER reporter

# REPORTER_PRIVATE_KEY and the rest of .env.example must be supplied at
# runtime (docker run --env-file .env ...) - never baked into the image.
# --import loads otel-init.js before reporter.js so the OTel SDK (opt-in,
# see src/otel-init.ts) is registered before any span/log could be emitted.
CMD ["node", "--import", "./dist/otel-init.js", "dist/reporter.js"]
