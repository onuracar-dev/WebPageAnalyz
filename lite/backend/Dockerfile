FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

LABEL org.opencontainers.image.title="WebPageAnalyzer Lite" \
      org.opencontainers.image.description="WebPageAnalyzer Lite public backend" \
      org.opencontainers.image.source="https://github.com/onuracar-dev/WebPageAnalyz"

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    PORT=8080

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium chromium-sandbox dumb-init fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --chown=node:node . .
RUN mkdir -p /app/artifacts && chown -R node:node /app/artifacts

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
