FROM node:22-alpine
WORKDIR /app
COPY . .
RUN mkdir -p /data
ENV NODE_ENV=production PORT=8787 PAPERCUT_DB=/data/papercut.db
EXPOSE 8787
CMD ["node", "server.js"]
