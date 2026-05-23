#!/bin/sh
# =============================================================================
# POS API - entrypoint del contenedor.
#
# 1. Si RUN_MIGRATIONS=true (default), espera a Postgres y ejecuta
#    `typeorm migration:run` contra el data-source compilado en dist/.
# 2. Después delega al CMD del Dockerfile (`node dist/main.js`).
#
# Se ejecuta como usuario `nestjs` (no-root). Las migraciones corren contra el
# JS compilado, así que NO se requiere ts-node en runtime.
# =============================================================================
set -e

RUN_MIGRATIONS=${RUN_MIGRATIONS:-true}

if [ "$RUN_MIGRATIONS" = "true" ]; then
  echo "[entrypoint] RUN_MIGRATIONS=true — ejecutando migraciones..."

  # Reintento ligero por si Postgres aún no aceptó conexiones (race con el
  # healthcheck del compose). 10 intentos × 2s = 20s de gracia.
  ATTEMPTS=0
  MAX_ATTEMPTS=10
  until node node_modules/typeorm/cli.js -d dist/database/data-source.js migration:run; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
      echo "[entrypoint] Migraciones fallaron tras ${MAX_ATTEMPTS} intentos. Abortando." >&2
      exit 1
    fi
    echo "[entrypoint] Migraciones fallaron (intento ${ATTEMPTS}/${MAX_ATTEMPTS}). Reintento en 2s..."
    sleep 2
  done

  echo "[entrypoint] Migraciones aplicadas."
else
  echo "[entrypoint] RUN_MIGRATIONS=false — saltando migraciones."
fi

echo "[entrypoint] Iniciando API: $*"
exec "$@"
