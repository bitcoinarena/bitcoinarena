#!/bin/bash
# kanban #3265 (#3251): the stage page with the Orange Pill Run. Usage: stage-page.sh <the stage page dir, e.g. sitemirror/page1099> <out dir> <new UI number>
# The out dir is made with hard links (cp -al); index.html is copied first, so the patch never writes through a link into the source dir.
# Adds games/orange-pill-run/index.html (the game, one file) and games/orange-pill-run/rules.html (the public rules), and the page's bridge (opr-page.py).
# Deploys nothing: the commands to put it on the stage are printed at the end.
set -euo pipefail
SRC=$1; OUT=$2; UI=$3; HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
[ -e "$OUT" ] && { echo "refused: $OUT exists"; exit 2; }
nice -n 19 ionice -c3 cp -al "$SRC" "$OUT"
cp --remove-destination "$SRC/index.html" "$OUT/index.html"
python3 "$HERE/opr-page.py" "$OUT/index.html"
OLD=$(grep -o 'class="build-line"[^>]*>UI [0-9]*' "$OUT/index.html" | head -1 | grep -o '[0-9]*$')
sed -i "s#>UI $OLD<#>UI $UI<#g; s#· UI $OLD'#· UI $UI'#g" "$OUT/index.html"
mkdir -p "$OUT/games/orange-pill-run"
node "$REPO/packages/orange-pill-run/client/build.mjs" --out "$OUT/games/orange-pill-run/index.html"
grep -q "ARENA_OPR_START" "$OUT/index.html" && [ -s "$OUT/games/orange-pill-run/rules.html" ] || { echo "check the page: bridge or game missing"; exit 3; }
echo "done: $OUT (UI $UI, was $OLD)"
echo "preview: npx wrangler pages deploy $OUT --project-name bitcoin-arena-site --branch opr-3265 --commit-dirty=true"
echo "stage:   npx wrangler pages deploy $OUT --project-name bitcoin-arena-site --branch stage --commit-dirty=true"
