#!/bin/bash
# A NODE'S CERTIFICATE, AS A SETUP STEP (spec §25.3, kanban #335: "A browser on an HTTPS page may not open ws:// - mixed
# content is blocked - so every node serving players needs a valid certificate ... Node software SHOULD make certificate
# provisioning a first-class setup step"). Gets a certificate for the node's public host name and prints the two lines the
# node's environment takes (main.js: ARENA_TLS_CERT, ARENA_TLS_KEY - it answers https and wss on its own port, and reads
# the files again every hour, so a renewal needs no restart).
#
#   bash tools/tls-setup.sh <host name> <dir> [tailscale|certbot <email>]
#
#   tailscale (default): `tailscale cert` for a *.ts.net name of this machine (Tailscale's own Let's Encrypt). Renew by
#                        running this again (a cron line is printed).
#   certbot <email>:     Let's Encrypt HTTP-01 on port 80 of this machine for any public name pointing at it.
# The advertised endpoint (§5A.2) is then wss://<host name>:<the node's port>/... - committed in the bond's advert, so it is
# chosen once (§25.3: "running a node is a commitment to a stable address").
set -euo pipefail
HOST=${1:?host name}; DIR=${2:?directory for the certificate}; HOW=${3:-tailscale}
mkdir -p "$DIR"; chmod 700 "$DIR"
case "$HOW" in
  tailscale)
    tailscale cert --cert-file "$DIR/cert.pem" --key-file "$DIR/key.pem" "$HOST" >&2
    RENEW="tailscale cert --cert-file $DIR/cert.pem --key-file $DIR/key.pem $HOST" ;;
  certbot)
    EMAIL="${4:?an email for the certificate authority}"
    certbot certonly --standalone --non-interactive --agree-tos -m "$EMAIL" -d "$HOST" \
      --config-dir "$DIR/le" --work-dir "$DIR/le-work" --logs-dir "$DIR/le-logs" >&2
    ln -sf "$DIR/le/live/$HOST/fullchain.pem" "$DIR/cert.pem"; ln -sf "$DIR/le/live/$HOST/privkey.pem" "$DIR/key.pem"
    RENEW="certbot renew --config-dir $DIR/le --work-dir $DIR/le-work --logs-dir $DIR/le-logs" ;;
  *) echo "tailscale or certbot, not $HOW" >&2; exit 2 ;;
esac
chmod 600 "$DIR/key.pem" 2>/dev/null || true
# the certificate read back: its name and its end
openssl x509 -in "$DIR/cert.pem" -noout -subject -enddate >&2
echo "ARENA_TLS_CERT=$DIR/cert.pem"
echo "ARENA_TLS_KEY=$DIR/key.pem"
echo "# renew (cron, daily): $RENEW" >&2
