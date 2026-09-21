# Scent Sommelier - perfume recommendations powered by TypeSafe Jev.
# Easiest: docker compose up --build  (see docker-compose.yml). Or by hand:
#   docker build -t jev-perfume-advisor .
#   docker run --rm -p 8787:8787 jev-perfume-advisor                     # mock mode, no key
#   docker run --rm -p 8787:8787 --env-file .env jev-perfume-advisor     # with the key in .env
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787

# Dependencies first, so code changes do not reinstall them. tsx is a runtime dependency.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY data/catalog ./data/catalog

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

CMD ["node_modules/.bin/tsx", "src/server/main.ts"]
