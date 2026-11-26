# kanban #3795 (the owner 2026-11-26: "Schreibe das in die Bounty ab heute 00:00 die Obergrenze"): at most 5 rewarded reports per reporter
# per UTC day from 26 Nov 2026 00:00 UTC, mass-produced reports at the bot rate. Usage: cap5.py bounty|game|owner|owner-min <file>
import sys
RULE = ("From 26 Nov 2026 00:00 UTC: at most 5 reports per reporter per UTC day are rewarded (the most valuable first). Further reports that day "
        "are still reviewed - real bugs get fixed - but count as variants without a reward. Mass-produced or automated reports are paid at the bot "
        "rate (15 %, no bonus); the full rate is for genuinely good reports (a real, new, reproducible bug with clear impact).")
kind, p = sys.argv[1], sys.argv[2]; s = open(p).read()
def R(a, b):
    global s
    assert s.count(a) == 1, (s.count(a), a[:70]); s = s.replace(a, b)
if 'at most 5 reports per reporter per UTC day' in s: print('cap5 already'); sys.exit(0)
if kind == 'bounty':
    a = '      <li id="node-bounty">'
    R(a, '      <li id="daily-cap"><b>At most 5 rewarded reports a day.</b> ' + RULE + '</li>\n' + a)
elif kind == 'game':
    a = "The feedback form and the bounty services earn no bounty - only the game and the network do. ' }), ruleLink('humans', 'Rules'))"
    R(a, a.replace("network do. '", "network do. " + RULE.replace("'", "\\'") + " '"))
elif kind == 'owner':
    a = "    el('li', { text: 'From 16 Nov 2026 07:06 UTC the 10,000 sat node bounty"
    R(a, "    el('li', { text: '" + RULE + "' }),\n" + a)
elif kind == 'owner-min':   # the built owner page (owner/index.html of a page dir), minified
    a = 'el("li",{text:"From 16 Nov 2026 07:06 UTC the 10,000 sat node bounty'
    R(a, 'el("li",{text:"' + RULE + '"}),' + a)
open(p, 'w').write(s); print('cap5 ok', kind)
