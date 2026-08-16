FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

LABEL org.opencontainers.image.title="WebPageAnalyz API" \
      org.opencontainers.image.description="WebPageAnalyz API process without hostile execution tools" \
      org.opencontainers.image.source="https://github.com/onuracar-dev/WebPageAnalyz"

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    EXECUTION_ROLE=api \
    BROWSER_EXECUTION_DISABLED=true \
    PDF_EXECUTION_DISABLED=true \
    SOURCE_EXECUTION_DISABLED=true \
    OSV_EXECUTION_DISABLED=true \
    ARTIFACT_DIR=/app/logs

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --chown=node:node . .
RUN mkdir -p /app/logs/source-inputs /app/worker-results && chown -R node:node /app/logs /app/worker-results

USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:5000/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
