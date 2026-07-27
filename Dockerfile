# =============================================================================
# POS API - Dockerfile multi-stage (despliegue).
#
# Imagen final: node:20-alpine, usuario no-root, build optimizado para prod.
# Entrypoint: `docker-entrypoint.sh` que corre migraciones y luego arranca la
# API. Para saltarse las migraciones automáticas, exportar `RUN_MIGRATIONS=false`
# en el entorno del contenedor.
# =============================================================================

# ---------- Stage 1: dependencias completas (dev + prod) ----------
FROM node:20-alpine AS deps

RUN apk add --no-cache libc6-compat
# pnpm pineado: 11.x requiere Node 22 (usa `node:sqlite` built-in). 9.15.4 es
# la última 9.x estable y coincide con lockfileVersion 9.0 del repo.
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false


# ---------- Stage 2: build (compila TS → JS en dist/) ----------
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Compila TS, luego elimina devDependencies del node_modules para reducir
# tamaño final. Las migraciones corren contra los .js compilados, así que
# typeorm (prod-dep) basta — no se necesita ts-node en runtime.
RUN pnpm build && pnpm prune --prod


# ---------- Stage 3: runner (imagen final) ----------
FROM node:20-alpine AS runner

ENV NODE_ENV=production \
    PORT=3010

# tini = init mínimo para PID 1 (forwarding de señales, reaping de zombies).
# wget = healthcheck. dumb-init no es necesario porque tini cumple.
# postgresql18-client = `pg_dump` para el módulo /backups/*. La MAYOR debe ser
# >= la del servidor (PostgreSQL 18): un cliente más viejo se niega a volcar.
# Si algún día el servidor sube de major, hay que subir este paquete también.
RUN apk add --no-cache wget tini postgresql18-client \
    && addgroup -S nodejs -g 1001 \
    && adduser -S nestjs -u 1001 -G nodejs

WORKDIR /app

COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/package.json ./package.json
COPY --chown=nestjs:nodejs docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER nestjs

EXPOSE 3010

# Healthcheck del contenedor — usa el endpoint de liveness del HealthController.
# `API_PREFIX` está vacío por defecto, por eso el path es `/health/live` plano.
# `PORT` se resuelve en runtime (default 3010 vía ENV de arriba).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD sh -c 'wget --quiet --tries=1 --spider "http://localhost:${PORT}/health/live" || exit 1'

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
