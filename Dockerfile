FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/

RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY server ./server
COPY web ./web

RUN npm run build && npm prune --omit=dev && mkdir -p /app/server/node_modules

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV HTTP_PORT=80
ENV HTTPS_PORT=443
ENV UI_PORT=3000

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/web/dist ./web/dist

RUN mkdir -p /app/data

VOLUME ["/app/data"]

EXPOSE 80 443 3000 1900/udp 5353/udp

CMD ["node", "server/dist/index.js"]

