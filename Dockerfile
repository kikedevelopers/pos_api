# =============================================================================
# POS API - Dockerfile multi-stage
# Imagen final: node:20-alpine, usuario no-root, build optimizado.
# =============================================================================

# ---------- Stage 1: dependencias ----------
FROM node:20-alpine AS deps

RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod=false


# ---------- Stage 2: build ----------
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN pnpm build && pnpm prune --prod


# ---------- Stage 3: runner ----------
FROM node:20-alpine AS runner

ENV NODE_ENV=production

RUN apk add --no-cache wget tini \
    && addgroup -S nodejs -g 1001 \
    && adduser -S nestjs -u 1001 -G nodejs

WORKDIR /app

COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/package.json ./package.json

USER nestjs

EXPOSE 3000

# Healthcheck del contenedor — usa el endpoint de liveness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/api/v1/health/live || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
