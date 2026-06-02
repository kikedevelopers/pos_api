#!/bin/bash
# =============================================================================
# Bootstrap inicial de certificados Let's Encrypt — EDGE compartido.
#
# Emite un certificado por cada dominio que sirve el edge nginx:
#   - $DOMAIN      (API)
#   - $PWA_DOMAIN  (PWA)  [opcional: si está vacío, solo se emite el del API]
#
# Resuelve el chicken-and-egg (nginx necesita certs para arrancar, certbot
# necesita nginx en :80 para validar):
#   1. Crea un cert "dummy" para CADA dominio (nginx referencia ambos paths).
#   2. Levanta nginx con los dummies → :80 sirve los challenges ACME.
#   3. Por cada dominio: borra el dummy y pide el cert real (webroot).
#   4. Reload nginx para tomar los certs reales.
#
# Lo invoca deploy.sh la primera vez. Para reemitir: borra ./certbot/conf y
# vuelve a correrlo (ojo rate limits de LE).
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

DOMAIN=${DOMAIN:?Falta DOMAIN en .env (ej: foxpos.kikedevs.com)}
LETSENCRYPT_EMAIL=${LETSENCRYPT_EMAIL:?Falta LETSENCRYPT_EMAIL en .env}
STAGING=${LETSENCRYPT_STAGING:-0}

# Lista de dominios a certificar: API + PWA (si está definido).
DOMAINS="$DOMAIN"
if [ -n "${PWA_DOMAIN:-}" ]; then
  DOMAINS="$DOMAINS $PWA_DOMAIN"
fi

COMPOSE="docker compose -f docker-compose.prod.yml"
DATA_PATH="./certbot"
RSA_KEY_SIZE=4096

echo "### Dominios a certificar: $DOMAINS"

echo "### Descargando parámetros TLS recomendados..."
mkdir -p "$DATA_PATH/conf"
if [ ! -e "$DATA_PATH/conf/options-ssl-nginx.conf" ] || [ ! -e "$DATA_PATH/conf/ssl-dhparams.pem" ]; then
  curl -fsSL https://raw.githubusercontent.com/certbot/certbot/master/certbot-nginx/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf > "$DATA_PATH/conf/options-ssl-nginx.conf"
  curl -fsSL https://raw.githubusercontent.com/certbot/certbot/master/certbot/certbot/ssl-dhparams.pem > "$DATA_PATH/conf/ssl-dhparams.pem"
fi

# --- 1. Cert dummy para CADA dominio (nginx no arranca sin los paths) ---
for d in $DOMAINS; do
  echo "### Creando certificado dummy para $d..."
  LIVE_PATH="/etc/letsencrypt/live/$d"
  mkdir -p "$DATA_PATH/conf/live/$d"
  $COMPOSE run --rm --entrypoint "\
    openssl req -x509 -nodes -newkey rsa:$RSA_KEY_SIZE -days 1 \
      -keyout '$LIVE_PATH/privkey.pem' \
      -out '$LIVE_PATH/fullchain.pem' \
      -subj '/CN=localhost'" certbot
  $COMPOSE run --rm --entrypoint "cp $LIVE_PATH/fullchain.pem $LIVE_PATH/chain.pem" certbot
done

echo "### Levantando nginx con certs dummy..."
$COMPOSE up --force-recreate -d nginx

# --- 2. Por cada dominio: borrar dummy + pedir cert real ---
STAGING_ARG=""
if [ "$STAGING" != "0" ]; then
  STAGING_ARG="--staging"
  echo "    (modo STAGING — los certs NO serán confiables)"
fi

for d in $DOMAINS; do
  echo "### Borrando cert dummy de $d..."
  $COMPOSE run --rm --entrypoint "\
    rm -Rf /etc/letsencrypt/live/$d && \
    rm -Rf /etc/letsencrypt/archive/$d && \
    rm -Rf /etc/letsencrypt/renewal/$d.conf" certbot

  echo "### Solicitando certificado real para $d ..."
  # --cert-name $d FUERZA el nombre del linaje = el dominio, para que el cert
  # quede SIEMPRE en live/$d/ (sin sufijos -0001 aunque existieran linajes
  # previos). nginx referencia live/$d/ exacto.
  $COMPOSE run --rm --entrypoint "\
    certbot certonly --webroot -w /var/www/certbot \
      $STAGING_ARG \
      --email $LETSENCRYPT_EMAIL \
      --agree-tos \
      --no-eff-email \
      --rsa-key-size $RSA_KEY_SIZE \
      --cert-name $d \
      --force-renewal \
      -d $d" certbot
done

echo "### Recargando nginx con los certs reales..."
$COMPOSE exec nginx nginx -s reload

echo
echo "Listo. Certificados activos para: $DOMAINS"
