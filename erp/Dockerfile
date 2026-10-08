# GTX MOTO PARTS ERP — imagem "tudo em um" (site + API na mesma porta). Para o Cloud Run só da API, use api/Dockerfile.
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci
COPY api/tsconfig.json ./
COPY api/src ./src
COPY api/migrations ./migrations
COPY api/samples ./samples
COPY --from=web /web/dist ./web-dist
ENV NODE_ENV=production PORT=8080 WEB_DIST=/app/web-dist
EXPOSE 8080
CMD ["sh", "-c", "npx tsx src/scripts/migrate.ts && exec npx tsx src/server.ts"]
