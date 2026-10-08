#!/bin/sh
# RUN A COMMAND WITH THIS HOST'S FUNNEL NAME RESOLVED TO ITS OWN TAILNET ADDRESS. The public Funnel relay drops a TLS
# handshake that starts on this same host (measured 2026-09-27 08:25: "unexpected eof", 0 bytes read, on every path,
# the Daily's /blwp-a too), while the tailnet serve on 100.x answers the same name with the same certificate. So a
# client on this host - the lock client, fedimint-cli, a gateway, a guardian asking its peers - reaches the four
# guardians' public wss addresses through a private /etc/hosts in its own user and mount namespace; nothing else on
# the host is changed.
#
#   tools/tailnet-exec.sh <command> [args...]     (ARENA_TAILNET_NAME, ARENA_TAILNET_ADDR, ARENA_TAILNET_HOSTS)
set -eu
NAME=${ARENA_TAILNET_NAME:-seat.example.com}
ADDR=${ARENA_TAILNET_ADDR:-$(tailscale ip -4)}
HOSTS=${ARENA_TAILNET_HOSTS:-$HOME/.blwp-hosts-tailnet}
{ grep -v " $NAME\$" /etc/hosts; echo "$ADDR $NAME"; } > "$HOSTS.new" && mv "$HOSTS.new" "$HOSTS"
exec unshare -rm sh -c 'mount --bind "$0" /etc/hosts && exec "$@"' "$HOSTS" "$@"
