#!/bin/bash
# =============================================================================
# POS API - deploy de un solo comando.
#
# Idempotente: la primera vez bootstrapea TLS con Let's Encrypt y arranca
# todo el stack; en runs siguientes solo pullea la imagen nueva y la sube
# con `docker compose up -d` (zero downtime para postgres/nginx; api se
# recrea con depends_on healthy).
#
# Uso típico en la VM:
#   cd /opt/pos_api
#   ./deploy.sh
#
# Variables de entorno opcionales:
#   GHCR_USERNAME, GHCR_TOKEN   Para hacer `docker login ghcr.io` (necesario
#                               si la imagen es privada — por defecto en GHCR).
#   SKIP_LOGIN=1                Salta el login (la VM ya tiene credenciales).
#   FORCE_BOOTSTRAP=1           Vuelve a correr init-letsencrypt.sh aunque
#                               existan certs.
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env"
COMPOSE="docker compose -f $COMPOSE_FILE"

# --- 1. Validaciones ------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker no está instalado en esta VM." >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: falta $ENV_FILE en $(pwd)." >&2
  echo "       Copia .env.production.example a .env y ajústalo." >&2
  exit 1
fi

# Carga variables del .env (sólo para validación + uso en este script).
set -a
# shellcheck disable=SC1091
. ./"$ENV_FILE"
set +a

: "${DOMAIN:?Falta DOMAIN en .env}"
: "${LETSENCRYPT_EMAIL:?Falta LETSENCRYPT_EMAIL en .env}"
: "${IMAGE_NAME:?Falta IMAGE_NAME en .env (ej: ghcr.io/owner/pos_api:latest)}"
: "${JWT_SECRET:?Falta JWT_SECRET en .env}"
: "${DB_PASSWORD:?Falta DB_PASSWORD en .env}"

# --- 2. Login al registry --------------------------------------------------

if [ "${SKIP_LOGIN:-0}" != "1" ] && [ -n "${GHCR_USERNAME:-}" ] && [ -n "${GHCR_TOKEN:-}" ]; then
  echo "[deploy] docker login ghcr.io como $GHCR_USERNAME ..."
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin
fi

# --- 3. Pull de la imagen --------------------------------------------------

echo "[deploy] Pulleando $IMAGE_NAME ..."
docker pull "$IMAGE_NAME"

# --- 4. Bootstrap TLS si es primera vez ------------------------------------

CERTS_PATH="./certbot/conf/live/$DOMAIN"
if [ "${FORCE_BOOTSTRAP:-0}" = "1" ] || [ ! -d "$CERTS_PATH" ]; then
  echo "[deploy] No hay certificados Let's Encrypt para $DOMAIN — bootstrap inicial."
  bash ./init-letsencrypt.sh
fi

# --- 5. Arranque del stack -------------------------------------------------

echo "[deploy] Levantando stack..."
$COMPOSE up -d --remove-orphans

# --- 6. Reporte ------------------------------------------------------------

echo
echo "[deploy] Estado de los servicios:"
$COMPOSE ps

echo
echo "[deploy] Verificando health del API (esperando hasta 30s)..."
for i in $(seq 1 30); do
  if curl -fsS "http://localhost:${PORT:-3010}/health/live" >/dev/null 2>&1; then
    echo "[deploy] API responde OK en /health/live."
    break
  fi
  sleep 1
  if [ "$i" -eq 30 ]; then
    echo "[deploy] El API no respondió en 30s. Revisa: docker compose -f $COMPOSE_FILE logs api" >&2
    exit 1
  fi
done

echo
echo "[deploy] Deploy completo:"
echo "         https://$DOMAIN/health"
