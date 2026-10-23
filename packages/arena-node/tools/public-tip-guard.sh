#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# KEEP OUR TESTNET4 NODES ON THE PUBLIC CHAIN (kanban #577, 2026-10-23): our miners B and C win a difficulty-1 block now and then but
# lose the tie to the public one by milliseconds; the node that took ours first stays on it (equal work, first seen), and its seats
# read a census the rest of the network does not have. Every 20 s, for the test host node and the test host node:
#
#   INVALIDATE  when mempool.space holds a block at our tip's height that is not ours, and the public chain is at least SETTLE blocks
#               past that height, ours is invalidated (logged). A block of ours ahead of the public tip is never touched.
#   RECONSIDER  every block this guard invalidated that mempool.space now holds at its height is reconsidered on that node.
#
# Measured 2026-10-23 05:30-06:51Z: height 157,361 reorged publicly (fa1ff884 -> c88eb72b -> fa1ff884). The first guard invalidated
# whatever was not public at that moment and could not take it back, so both nodes stood still at 157,360 for 80 minutes; the seats
# fell behind and federation B's session 4659 could not close until the blocks were reconsidered by hand. SETTLE waits out a short
# public reorg; RECONSIDER undoes any invalidation the public chain disagrees with afterwards.
#
#   GUARD_LOG (default ~/blwp-testnet4/public-tip-guard.log)   GUARD_SETTLE (default 2)   GUARD_EVERY_S (default 20)
LOG=${GUARD_LOG:-$HOME/blwp-testnet4/public-tip-guard.log}
SETTLE=${GUARD_SETTLE:-2}
API=https://mempool.space/testnet4/api
bee() { /mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli -datadir=/mnt/bitcoin/tn4 "$@"; }
mac() { ssh -n -o ConnectTimeout=10 -o BatchMode=yes macbook-playtest "\$HOME/blwp-offload/bin-dl/bitcoin-31.1/bin/bitcoin-cli -datadir=\$HOME/blwp-offload/tn4-mac $*"; }
public_at() { local h; h=$(curl -s -m 10 $API/block-height/$1) || return 1; [[ "$h" =~ ^[0-9a-f]{64}$ ]] && echo "$h"; }
guard() {   # $1 = node name, $2 = cli function
  local n=$1 cli=$2 h ours pub ptip
  h=$($cli getblockcount 2>/dev/null) || return
  ours=$($cli getbestblockhash 2>/dev/null) || return
  ptip=$(curl -s -m 10 $API/blocks/tip/height) || return
  [[ "$ptip" =~ ^[0-9]+$ ]] || return
  # RECONSIDER: our own invalidations on this node that the public chain holds now
  [ -f "$LOG" ] && grep " $n invalidateblock " "$LOG" | awk '{print $4, $6}' | sort -u | while read -r hash height; do
    [ "$height" -le "$ptip" ] 2>/dev/null && [ "$height" -ge $((ptip - 50)) ] || continue   # the last 50 blocks: no reorg is deeper
    [ "$(public_at "$height")" = "$hash" ] || continue
    grep " $n [a-z]*block $hash " "$LOG" | tail -1 | grep -q " invalidateblock " || continue   # its last action here: an invalidation
    $cli reconsiderblock "$hash" >/dev/null 2>&1 && echo "$(date -u +%FT%TZ) $n reconsiderblock $hash at $height (public again)" >> "$LOG"
  done
  # INVALIDATE: only once the public chain is SETTLE blocks past our tip's height
  [ "$ptip" -ge $((h + SETTLE)) ] || return
  pub=$(public_at "$h") || return
  [ "$pub" = "$ours" ] && return
  $cli invalidateblock "$ours" >/dev/null 2>&1 && echo "$(date -u +%FT%TZ) $n invalidateblock $ours at $h (public $pub)" >> "$LOG"
}
while true; do
  guard test-host bee
  guard mac mac
  sleep "${GUARD_EVERY_S:-20}"
done
