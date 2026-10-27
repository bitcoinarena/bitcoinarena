#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# FEDERATION A'S GUARDIANS ON A RAM DISK, THE OPS VERSION (kanban #587, hardened by kanban #718): the successor of
# ~/blwp-testnet4/ops/guardian-ram.sh. Same layout (RAM in /dev/shm/blwp-guardians/N, data dir ~/blwp-testnet4/node-N.db.guardian with
# symlinks into it, snapshots in <data dir>/ram-snaps), three changes:
#
#   ONE SET A MINUTE   `loop`: all 7 guardians frozen (SIGSTOP), each database staged within RAM (table files hard-linked, the WAL and
#                      MANIFEST copied), all 7 thawed - then the 7 stages written to disk one after another, under ONE name. Measured
#                      2026-10-26: the staggered snapshots (one guardian every ~8.5 s) split a reboot at 13:31Z into 7 moments and
#                      session 7753 stood still ~7 h. The disk write stays one after another (the 2026-10-23 ruling's point).
#   A CLEAN STOP       `final N` (ExecStopPost): after fedimintd exited, its database written once more and named in ram-snaps/clean. A
#                      shutdown that stops the units properly therefore loses nothing and needs no check.
#   RECOVERY AT START  `restore N` (ExecStartPre), when the RAM is empty (a reboot): the FIRST guardian to start restores ALL 7 from their
#                      snapshots, under a lock, and runs tools/guardian-recover.mjs over them: one set or clean - started as they are;
#                      different moments with the same accepted items - each kept on disk, the AlephBFT units (0x05) and accepted items
#                      (0x01) deleted on all (what ops/fedA-repair-7753.sh did by hand); different accepted items or sessions - REFUSED,
#                      the unit does not start, the reason in the log. The verdict is kept in RAM for the other 6 starts of this boot.
#
#   guardian-ram-ops.sh migrate N | restore N | final N | sync-all | loop | check
#
# Needs: node (ARENA_NODE, default node on PATH), the repo (ARENA_REPO), fedimint-dbtool of the same fork as fedimintd (FEDIMINT_DBTOOL;
# without it a mixed restore is started unchecked, as before, and logged so).
set -u
SHM=${GUARDIAN_RAM_SHM:-/dev/shm/blwp-guardians}
HOMEDIR=${GUARDIAN_RAM_HOME:-$HOME/blwp-testnet4}
GUARDIANS=${GUARDIAN_RAM_LIST:-"1 2 3 4 5 6 7"}
REPO=${ARENA_REPO:-$HOME/btc-logistics-war}
NODE=${ARENA_NODE:-node}
DBTOOL=${FEDIMINT_DBTOOL:-}
LOG=${GUARDIAN_RAM_LOG:-$HOMEDIR/guardian-ram-recover.log}
unit() { echo "blwp-tn4-guardian-$((31211 + 10 * $1))"; }
datadir() { readlink -f "$HOMEDIR/node-$1.db.guardian"; }
say() { echo "$(date -u +%FT%TZ) guardian $1: $2" | tee -a "$LOG" >&2; }
pid_of() { local p; p=$(systemctl --user show "$(unit "$1")" -p MainPID --value 2>/dev/null); [ -n "$p" ] && [ "$p" != 0 ] && echo "$p"; }

# THE STAGE: RocksDB never rewrites a table file (*.sst, *.blob), so a hard link is a true copy of it; everything else is copied
stage() {
  local src=$1 dst=$2 f
  mkdir -p "$dst" || return 1
  for f in "$src"/*; do
    [ -e "$f" ] || continue
    case "$f" in *.sst|*.blob) ln "$f" "$dst/" 2>/dev/null || cp -p "$f" "$dst/" || return 1 ;; *) cp -p "$f" "$dst/" || return 1 ;; esac
  done
}

# one staged copy written as snapshot NAME, made current, the last two snap-* kept; CLEAN=1 also names it in ram-snaps/clean
write_snap() {
  local n=$1 name=$2 d r; d=$(datadir "$n"); r="$SHM/$n"
  mkdir -p "$d/ram-snaps"
  local prev=(); [ -e "$d/ram-snaps/current" ] && prev=(--link-dest="$(readlink -f "$d/ram-snaps/current")")
  rsync -a --delete "${prev[@]}" "$r/stage/" "$d/ram-snaps/$name.partial/" && sync -f "$d/ram-snaps" || { say "$n" "snapshot write failed"; rm -rf "$r/stage"; return 1; }
  rm -rf "$d/ram-snaps/$name"; mv "$d/ram-snaps/$name.partial" "$d/ram-snaps/$name"
  ln -sfn "$name" "$d/ram-snaps/current.new" && mv -T "$d/ram-snaps/current.new" "$d/ram-snaps/current"
  [ "${CLEAN:-0}" = 1 ] && echo "$name" > "$d/ram-snaps/clean"
  rm -rf "$r/stage"
  ls -1d "$d"/ram-snaps/snap-* 2>/dev/null | grep -v '\.partial$' | sort | head -n -2 | xargs -r rm -rf
  ls -1d "$d"/ram-snaps/snap-*.partial 2>/dev/null | xargs -r rm -rf
}

# ONE SET: every running guardian in RAM frozen, staged, thawed - then written one after another under one name. One failed stage: none
# written (the others would be a newer moment than it).
sync_all() {
  local n pids=() ns=() ok=1 name t0 held
  for n in $GUARDIANS; do
    local d; d=$(datadir "$n")
    [ -L "$d/database" ] && [ -e "$SHM/$n/database/CURRENT" ] || continue
    local p; p=$(pid_of "$n") || continue
    rm -rf "$SHM/$n/stage"; pids+=("$p"); ns+=("$n")
  done
  [ ${#ns[@]} -gt 0 ] || return 0
  t0=$(date +%s%N)
  kill -STOP "${pids[@]}" 2>/dev/null
  for n in "${ns[@]}"; do stage "$SHM/$n/database" "$SHM/$n/stage" || { ok=0; say "$n" "copy in RAM failed - no set this minute"; break; }; done
  kill -CONT "${pids[@]}" 2>/dev/null
  held=$(( ($(date +%s%N) - t0) / 1000000 ))
  if [ $ok = 0 ]; then for n in "${ns[@]}"; do rm -rf "$SHM/$n/stage"; done; return 1; fi
  name="snap-$(date -u +%Y%m%dT%H%M%S)"
  for n in "${ns[@]}"; do write_snap "$n" "$name"; echo "$held" > "$SHM/$n/last-hold-ms"; done
}

# AFTER fedimintd EXITED (ExecStopPost): nothing to freeze; the RAM database written once more and marked clean
final() {
  local n=$1 d; d=$(datadir "$n")
  [ -L "$d/database" ] && [ -e "$SHM/$n/database/CURRENT" ] || return 0
  pid_of "$n" >/dev/null && { say "$n" "still running: no final snapshot"; return 0; }
  rm -rf "$SHM/$n/stage"; stage "$SHM/$n/database" "$SHM/$n/stage" || return 0
  CLEAN=1 write_snap "$n" "snap-$(date -u +%Y%m%dT%H%M%S)-stop" && say "$n" "clean stop: last snapshot $(readlink "$d/ram-snaps/current")"
  return 0
}

restore_one() {   # the newest snapshot back into an empty RAM (no check here)
  local n=$1 d; d=$(datadir "$n"); local r="$SHM/$n" snap="$d/ram-snaps/current"
  mkdir -p "$r"
  [ -e "$r/database/CURRENT" ] && return 0
  [ -e "$snap/CURRENT" ] || { say "$n" "REFUSED: no database in RAM and no snapshot at $snap - not starting empty"; return 1; }
  rm -rf "$r/database.partial" && cp -a "$(readlink -f "$snap")" "$r/database.partial" && mv "$r/database.partial" "$r/database" || return 1
  mkdir -p "$r/db_checkpoints"
  say "$n" "restored into RAM from $(readlink "$snap")"
}

# THE CHECK OVER ALL 7 (stopped): prints the tool's lines, answers its exit code
check_all() {
  local args=() n
  for n in $GUARDIANS; do args+=(--guardian "$(datadir "$n"):$SHM/$n"); done
  [ -n "$DBTOOL" ] && args+=(--dbtool "$DBTOOL")
  "$NODE" "$REPO/packages/arena-node/tools/guardian-recover.mjs" "$@" "${args[@]}" 2>&1 | tee -a "$LOG"
  return "${PIPESTATUS[0]}"
}

restore() {
  local n=$1 d; d=$(datadir "$n"); local r="$SHM/$n"
  mkdir -p "$SHM"
  # THE MOVE ITSELF (migrate): unchanged from guardian-ram.sh
  if [ -e "$d/.ram-migrate" ] && [ ! -L "$d/database" ]; then
    mkdir -p "$r"
    cp -a "$d/database" "$r/database.partial" && mv "$r/database.partial" "$r/database" || { say "$n" "copy into RAM failed - stays on disk"; rm -f "$d/.ram-migrate"; return 0; }
    cp -a "$d/db_checkpoints" "$r/db_checkpoints" 2>/dev/null || mkdir -p "$r/db_checkpoints"
    mkdir -p "$d/ram-snaps"
    local name; name="snap-$(date -u +%Y%m%dT%H%M%S)-initial"
    mv "$d/database" "$d/ram-snaps/$name" && ln -sfn "$name" "$d/ram-snaps/current"
    mv "$d/db_checkpoints" "$d/ram-snaps/db_checkpoints.on-disk" 2>/dev/null
    ln -s "$r/database" "$d/database"; ln -s "$r/db_checkpoints" "$d/db_checkpoints"
    rm -f "$d/.ram-migrate"
    say "$n" "moved into RAM; first snapshot $name"
    return 0
  fi
  [ -L "$d/database" ] || return 0      # not migrated: runs on disk as before
  # RAM STILL THERE (a guardian restarted, or killed, without a reboot): nothing was lost
  if [ -e "$r/database/CURRENT" ] && [ ! -e "$SHM/recover.verdict" ]; then mkdir -p "$r/db_checkpoints"; rm -f "$d/ram-snaps/clean"; return 0; fi
  # A REBOOT: the first guardian to start restores and checks all of them, the others read its verdict
  exec 9>"$SHM/recover.lock"; flock 9
  if [ ! -e "$SHM/recover.verdict" ]; then
    local m rc
    for m in $GUARDIANS; do restore_one "$m" || { echo refuse > "$SHM/recover.verdict"; say "$m" "REFUSED: not restored"; }; done
    if [ ! -e "$SHM/recover.verdict" ]; then
      say all "restored after an unclean stop: checking the 7 before any starts"
      check_all --repair; rc=$?
      case $rc in 0) echo start > "$SHM/recover.verdict" ;; 4) echo start > "$SHM/recover.verdict"; say all "UNCHECKED (no fedimint-dbtool): started as before" ;; *) echo refuse > "$SHM/recover.verdict" ;; esac
      for m in $GUARDIANS; do rm -f "$(datadir "$m")/ram-snaps/clean"; done
    fi
  fi
  flock -u 9
  mkdir -p "$r/db_checkpoints"
  if [ "$(cat "$SHM/recover.verdict")" = refuse ]; then say "$n" "REFUSED at start - see $LOG; the databases are as restored (ram-snaps/pre-repair-* if a repair began)"; return 1; fi
  return 0
}

migrate() {
  local n=$1 d; d=$(datadir "$n")
  [ -L "$d/database" ] && { say "$n" "already in RAM"; return 0; }
  touch "$d/.ram-migrate"
  systemctl --user restart "$(unit "$n")"
  sleep 3
  [ -L "$d/database" ] && say "$n" "running from RAM: $(systemctl --user is-active "$(unit "$n")")" || { say "$n" "NOT moved"; return 1; }
}

case "${1:-}" in
  migrate) migrate "$2" ;;
  restore) restore "$2" ;;
  final) final "$2" ;;
  sync-all) sync_all ;;
  check) check_all ;;          # read-only: the 7 must be stopped (dbtool opens each database)
  # ONE SET A MINUTE, at second 0 (kanban #718 replaces the staggered seconds of 2026-10-23)
  loop) while true; do
          sync_all || true
          left=$(( (60000000000 - $(date +%s%N) % 60000000000) / 1000000 ))
          sleep "$(printf '%d.%03d' $((left / 1000)) $((left % 1000)))"
        done ;;
  *) echo "usage: guardian-ram-ops.sh migrate|restore|final N | sync-all | loop | check"; exit 2 ;;
esac
