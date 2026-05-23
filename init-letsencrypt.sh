#!/bin/bash
# =============================================================================
# Bootstrap inicial de certificados Let's Encrypt para POS API.
#
# Resuelve el chicken-and-egg: nginx necesita certs para arrancar, pero
# certbot necesita nginx (puerto 80) para validar el dominio. Solución
# (patrón wmnnd):
#   1. Crea un cert "dummy" auto-firmado en el path donde nginx lo espera.
#   2. Levanta nginx con el dummy → puerto 80 sirve los challenges ACME.
#   3. Borra el dummy y pide el cert real con certbot (webroot).
#   4. Reload nginx para que tome el cert real.
#
# Se invoca automáticamente por `deploy.sh` la primera vez (si no hay certs).
# Para reemitir manualmente: borra `./certbot/conf` y vuelve a correr este
# script (¡cuidado con los rate limits de Let's Encrypt!).
# =============================================================================
set -euo pipefail

# Carga variables del .env si existe (DOMAIN, LETSENCRYPT_EMAIL, STAGING).
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

DOMAIN=${DOMAIN:?Falta DOMAIN en .env (ej: api.altivopos.com)}
LETSENCRYPT_EMAIL=${LETSENCRYPT_EMAIL:?Falta LETSENCRYPT_EMAIL en .env}
# STAGING=1 usa el servidor de pruebas de LE (cert no confiable pero sin
# rate limits agresivos). Útil para validar el setup la primera vez.
STAGING=${LETSENCRYPT_STAGING:-0}

COMPOSE="docker compose -f docker-compose.prod.yml"
DATA_PATH="./certbot"
RSA_KEY_SIZE=4096

if [ -d "$DATA_PATH/conf/live/$DOMAIN" ]; then
  read -rp "Ya existen certificados para $DOMAIN. ¿Reemplazar? (y/N): " decision
  if [ "$decision" != "Y" ] && [ "$decision" != "y" ]; then
    echo "Cancelado por el usuario."
    exit 0
  fi
fi

echo "### Descargando parámetros TLS recomendados..."
mkdir -p "$DATA_PATH/conf"
if [ ! -e "$DATA_PATH/conf/options-ssl-nginx.conf" ] || [ ! -e "$DATA_PATH/conf/ssl-dhparams.pem" ]; then
  curl -fsSL https://raw.githubusercontent.com/certbot/certbot/master/certbot-nginx/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf > "$DATA_PATH/conf/options-ssl-nginx.conf"
  curl -fsSL https://raw.githubusercontent.com/certbot/certbot/master/certbot/certbot/ssl-dhparams.pem > "$DATA_PATH/conf/ssl-dhparams.pem"
fi

echo "### Creando certificado dummy para $DOMAIN..."
LIVE_PATH="/etc/letsencrypt/live/$DOMAIN"
mkdir -p "$DATA_PATH/conf/live/$DOMAIN"
$COMPOSE run --rm --entrypoint "\
  openssl req -x509 -nodes -newkey rsa:$RSA_KEY_SIZE -days 1 \
    -keyout '$LIVE_PATH/privkey.pem' \
    -out '$LIVE_PATH/fullchain.pem' \
    -subj '/CN=localhost'" certbot
# chain.pem es referenciado por nginx (ssl_trusted_certificate). Para el
# dummy lo apuntamos al fullchain — se reemplazará en el paso de issuance.
$COMPOSE run --rm --entrypoint "cp $LIVE_PATH/fullchain.pem $LIVE_PATH/chain.pem" certbot

echo "### Levantando nginx con cert dummy..."
$COMPOSE up --force-recreate -d nginx

echo "### Borrando cert dummy..."
$COMPOSE run --rm --entrypoint "\
  rm -Rf /etc/letsencrypt/live/$DOMAIN && \
  rm -Rf /etc/letsencrypt/archive/$DOMAIN && \
  rm -Rf /etc/letsencrypt/renewal/$DOMAIN.conf" certbot

echo "### Solicitando certificado real para $DOMAIN ..."
STAGING_ARG=""
if [ "$STAGING" != "0" ]; then
  STAGING_ARG="--staging"
  echo "    (modo STAGING — el cert NO será confiable)"
fi

$COMPOSE run --rm --entrypoint "\
  certbot certonly --webroot -w /var/www/certbot \
    $STAGING_ARG \
    --email $LETSENCRYPT_EMAIL \
    --agree-tos \
    --no-eff-email \
    --rsa-key-size $RSA_KEY_SIZE \
    --force-renewal \
    -d $DOMAIN" certbot

echo "### Recargando nginx con el cert real..."
$COMPOSE exec nginx nginx -s reload

echo
echo "Listo: certificado activo para https://$DOMAIN"
