#!/usr/bin/env bash
# INSTALLS THE DAILY'S SEATS AS PERSISTENT USER SERVICES (the owner 2026-09-15: keep the Daily through
# restarts). Nothing here starts a service; `systemctl --user enable --now` does, once the temporary
# units they replace are stopped.
#
#   bash deploy/daily/install.sh <commit>
#
# THE CODE IS A CHECKOUT ON PERSISTENT DISK, detached at a pushed commit: /tmp is emptied at every
# boot (tmpfiles "D /tmp"), and the seats used to run the working tree - where a half-done edit
# reached players. The checkout moves only when a commit is checked out there on purpose.
set -euo pipefail
COMMIT="${1:?name the pushed commit the Daily seats run}"
D="${BLWP_2OF2_DIR:-/mnt/bitcoin/blwp-2of2}"
REPO="${BLWP_REPO:-/home/arena/btc-logistics-war}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "$HERE/../.." && pwd)"
UNITS="$HOME/.config/systemd/user"

git -C "$REPO" fetch -q origin phase0-deterministic-core
if [ -d "$D/code/.git" ] || [ -f "$D/code/.git" ]; then
  git -C "$D/code" checkout -q --detach "$COMMIT"
else
  git -C "$REPO" worktree add --detach "$D/code" "$COMMIT"
fi
# git tracks no node_modules: the four packages' own, copied from the tree that ran the suites.
for p in blwp-client blwp-node core protocol; do
  rm -rf "$D/code/packages/$p/node_modules"
  cp -a "$SRC/packages/$p/node_modules" "$D/code/packages/$p/node_modules"
done
mkdir -p "$UNITS"
for u in "$HERE"/*.service; do
  sed -e "s#@PATH@#$PATH#g" -e "s#@D@#$D#g" "$u" > "$UNITS/$(basename "$u")"
done
systemctl --user daemon-reload
echo "the Daily's code at $D/code is $(git -C "$D/code" rev-parse --short HEAD); units installed in $UNITS"
