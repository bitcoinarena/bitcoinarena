#!/bin/bash
# kanban #2905: the pre-roll gate - one canary round now (no roll check, no alert), exit 0 when it was played and signed in time, 1 when not.
# Call it from a roll script after each seat (or seat batch), from the test host:
#   ssh -o BatchMode=yes user@test-laptop '~/arena-canary/canary-gate.sh' || { echo "STOP canary gate failed"; exit 1; }
# A pass that finds the canary busy waits for it (the lock); a fresh key's first round (VOID by design, #2901) is played once more.
DIR=${CANARY_DIR:-$HOME/arena-canary}; export CANARY_DIR=$DIR CANARY_TAG=${CANARY_TAG:-gate}
export PATH=$HOME/.nvm/versions/node/v24.22.3/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd "$DIR" || exit 2
for try in 1 2; do
  perl "$DIR/canary-timeout.pl" 480 "$DIR/canary.lock" --wait caffeinate -i node "$DIR/canary-rps.mjs" ${CANARY_URL:-} > "$DIR/gate-last.out" 2>&1; rc=$?
  line=$(grep '^#2905 {' "$DIR/gate-last.out" | tail -1); echo "$line" | cut -c1-600
  echo "$line" | grep -q '"countable":false' && continue
  [ $rc -eq 0 ] && { echo "#2905 gate PASS"; exit 0; }
  echo "#2905 gate FAIL (exit $rc)"; exit 1
done
echo "#2905 gate FAIL (fresh key twice)"; exit 1
