# kanban #2904 (the owner 2026-11-16: "Die Boni gelten nur, wenn es ein Mensch ist"): the social/community bonus is said and shown for humans
# (a linked, verified X account) only - the bounty pages, the game page's Feedback panel and the node owner page; sources and built pages alike.
import sys, os
PAIRS = [
 # bounty pages
 ("Up to +60 % on every confirmed report. Type your names",
  "Up to +60 % on every confirmed report by a human (a linked, verified X account); bots get no bonus. Type your names"),
 # owner page rules line
 ("+20 % for any two of Telegram, Discord and Armada (at most +60 %).",
  "+20 % for any two of Telegram, Discord and Armada (at most +60 %), for humans only (a linked, verified X account)."),
 # owner page bonus display (readable, then the stripped build)
 ("    const n = j && Number.isFinite(j.bonusPct) ? j.bonusPct : 0;\n    bonus.textContent = 'Social bonus: +' + n + ' %';\n    const x = j && j.flags && j.flags.x === true;",
  "    const x = j && j.flags && j.flags.x === true;\n    // kanban #2904: the bonus counts for a human (a verified X) only\n    const n = x && j && Number.isFinite(j.bonusPct) ? j.bonusPct : 0;\n    bonus.textContent = 'Social bonus: +' + n + ' %' + (!x && j && j.bonusPct > 0 ? ' (humans only: link and verify your X account)' : '');"),
 ('const n=j&&Number.isFinite(j.bonusPct)?j.bonusPct:0;bonus.textContent="Social bonus: +"+n+" %";const x=j&&j.flags&&j.flags.x===true;',
  'const x=j&&j.flags&&j.flags.x===true;const n=x&&j&&Number.isFinite(j.bonusPct)?j.bonusPct:0;bonus.textContent="Social bonus: +"+n+" %"+(!x&&j&&j.bonusPct>0?" (humans only: link and verify your X account)":"");'),
 # game page panel: the badge and its note
 ("const showBonus = (j) => { const n = j && Number.isFinite(j.bonusPct) ? j.bonusPct : socialBonus(j && j.flags);",
  "const showBonus = (j) => { const human = !!(j && j.flags && j.flags.x === true), n0 = j && Number.isFinite(j.bonusPct) ? j.bonusPct : socialBonus(j && j.flags), n = human ? n0 : 0;   // kanban #2904: a human's bonus only"),
 ("bonus.lastChild.textContent = n > 0 ? 'applies to this report' : ''; };",
  "bonus.lastChild.textContent = n > 0 ? 'applies to this report' : n0 > 0 ? 'humans only: link and verify your X account' : ''; };"),
]
for f in sys.argv[1:]:
    s = open(f, encoding='utf-8').read(); n = 0
    for a, b in PAIRS:
        c = s.count(a); n += c; s = s.replace(a, b)
    if n: open(f + '.new', 'w', encoding='utf-8').write(s); os.replace(f + '.new', f)
    print(f, 'replaced', n)
