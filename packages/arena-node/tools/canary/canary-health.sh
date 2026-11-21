#!/bin/bash
# kanban #2905: the canary's one health line (for the hourly check): ssh user@192.168.1.226 '~/arena-canary/canary-health.sh'
export PATH=$HOME/.nvm/versions/node/v24.22.3/bin:/usr/bin:/bin
exec node "${CANARY_DIR:-$HOME/arena-canary}/canary-health.mjs" "$@"
