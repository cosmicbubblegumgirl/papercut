FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates poppler-utils unzip pandoc tesseract-ocr \
 && rm -rf /var/lib/apt/lists/*
COPY . .
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8787 PAPERCUT_DB=/data/papercut.db
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT || 8787) +'/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server.js"]
