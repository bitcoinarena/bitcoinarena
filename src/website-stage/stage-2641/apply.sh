#!/bin/bash
# kanban #2641: re-apply the Week 2 stage page changes (community bonus box with icons and chips, Send waits for Check, rule links, the Week 2 pot
# bar, the stage bounty rules page and draw.mjs) onto a fresh live page dir. Usage: apply.sh <new live page dir, e.g. sitemirror/page1027> <out dir> <new UI number>
# The out dir is made with hard links (cp -al); every file changed here is written as a new file first and moved in, never written through a link.
set -euo pipefail
SRC=$1; OUT=$2; UI=$3; HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
[ -e "$OUT" ] && { echo "refused: $OUT exists"; exit 2; }
nice -n 19 ionice -c3 cp -al "$SRC" "$OUT"
T=$(mktemp -d "${TMPDIR:-/tmp}/stage2641.XXXX"); cp "$SRC/index.html" "$T/index.html"
# 1. the page diff (written against page960 -> page960-s2641); a hunk that does not apply is the Feedback form's own line, done by feedback-form.py
patch -F3 -o "$T/out.html" "$T/index.html" "$HERE/index.patch" -r "$T/rej" || true
grep -q "const social = SOCIAL_ON()" "$T/out.html" || python3 "$HERE/feedback-form.py" "$T/out.html"
# the Founding Tester checkbox is never appended (Daniel 2026-11-14)
sed -i "s#, shotRow, tick, say, levels#, shotRow, say, levels#" "$T/out.html"
# kanban #2745: a duplicate's secret ticket link in My feedback
python3 "$HERE/dup-link.py" "$T/out.html"
python3 "$HERE/join-icons.py" "$T/out.html"
python3 "$HERE/season-words.py" "$T/out.html"
python3 "$HERE/nostr-wide.py" "$T/out.html" "$REPO/packages/arena-node/src/bounty-social-store.js"
python3 "$HERE/groups.py" "$T/out.html"
# 2. the UI stamp
OLD=$(grep -o 'class="build-line">UI [0-9]*' "$T/out.html" | head -1 | grep -o '[0-9]*$')
sed -i "s#>UI $OLD<#>UI $UI<#g; s#· UI $OLD'#· UI $UI'#g" "$T/out.html"
grep -q "ARENA_SOCIAL_PANEL" "$T/out.html" && ! grep -q "UI $OLD\b" "$T/out.html" || { echo "check the page: panel or UI stamp missing"; exit 3; }
cp "$T/out.html" "$OUT/index.html.new" && mv -f "$OUT/index.html.new" "$OUT/index.html"
# 3. the stage rules page (redesigned 2026-11-14, bounty-redesign.py made it from the old page) and the published draw script
mkdir -p "$OUT/bounty.new" && cp "$HERE/bounty-index.html" "$OUT/bounty.new/index.html" && cp "$REPO/packages/arena-node/tools/bounty-draw.mjs" "$OUT/bounty.new/draw.mjs"
[ -e "$OUT/bounty" ] && mv "$OUT/bounty" "$OUT/bounty.pre-2641-$(date -u +%Y%m%dT%H%MZ)"; mv "$OUT/bounty.new" "$OUT/bounty"
echo "done: $OUT (UI $UI); deploy a preview branch first, then the stage"
