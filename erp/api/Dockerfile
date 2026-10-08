# API do GTX MOTO PARTS ERP (Cloud Run ou qualquer host com Docker)
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# aplica as migrações pendentes (com trava) e sobe a API
CMD ["sh", "-c", "npx tsx src/scripts/migrate.ts && exec npx tsx src/server.ts"]
