#!/bin/bash
# JOIN A FEDERATION THROUGH fedimint-cli (kanban #348): ARENA_STAKE_LOCK_JOIN_BIN for a seat whose lock tool predates
# `--mode join` - here the stock CLI's join reaches the guardians at their public addresses. Called as the tool is:
#   federation-join-cli.sh --mode join --data-dir <dir> --invite <invite>
# and answers as the tool does: one JSON line {"mode":"join","federation_id":...} (read back with the lock tool's own
# `--mode guardians`, so the directory is proven to open). FEDIMINT_CLI and ARENA_STAKE_LOCK_BIN name the binaries.
set -euo pipefail
while [ $# -gt 0 ]; do case "$1" in --mode) shift 2 ;; --data-dir) DIR=$2; shift 2 ;; --invite) INV=$2; shift 2 ;; *) echo "unexpected $1" >&2; exit 2 ;; esac; done
mkdir -p "$DIR"
"${FEDIMINT_CLI:-fedimint-cli}" --data-dir "$DIR" join-federation "$INV" > /dev/null
"$ARENA_STAKE_LOCK_BIN" --mode guardians --data-dir "$DIR" | python3 -c 'import json,sys; j=json.loads([l for l in sys.stdin if l.startswith("{")][-1]); print(json.dumps({"mode": "join", "federation_id": j["federation_id"]}))'
