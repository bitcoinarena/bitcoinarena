# kanban #2789 (the owner 2026-11-15, stage only): the pot warning banner on top of the stage Feedback form and the stage /bounty/ page - from 90 % used
# yellow, from 98 % with the reports still waiting for review, used up red ("... nothing is paid until Season <current+1> starts."). The text comes
# from pot-banner.js (one function for both pages, tested by packages/arena-node/test/stage-pot-banner-2789.test.js); it replaces no-carry.py's
# used-up notice in the form. Usage: pot-banner.py <index.html> [<bounty/index.html>] (run after no-carry.py)
import os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
FN = open(os.path.join(HERE, 'pot-banner.js')).read()
def R(s, a, b):
    assert s.count(a) == 1, a[:70]; return s.replace(a, b)
p = sys.argv[1]; s = open(p).read()
s = R(s, '</head>', '<script>\n' + FN + '</script>\n</head>')
i = s.index("if (p && p.usedUp === true) {"); j = s.index("ruleLink('budget', 'Rules'))); }", i) + len("ruleLink('budget', 'Rules'))); }")
s = s[:i] + ("{ const ban = typeof arenaPotBanner === 'function' ? arenaPotBanner(p) : null; "
             "if (ban) budgetSlot.prepend(el('div', { cls: 'fb-potban ' + ban.level, role: 'status' }, ...ban.lines.map((t) => el('div', { text: t })), ruleLink('budget', 'Rules'))); }") + s[j:]
s = R(s, "    #arena-feedback .fb-budget-slot .fb-budget { margin: 0 0 10px; }",
      "    #arena-feedback .fb-budget-slot .fb-budget { margin: 0 0 10px; }\n"
      "    #arena-feedback .fb-potban { font-size: 12.5px; line-height: 1.45; margin: 0 0 10px; padding: 8px 10px; border-radius: 8px; font-weight: 600; }\n"
      "    #arena-feedback .fb-potban.warn { color: #f5d77a; border: 1px solid rgba(210,153,34,.7); background: rgba(210,153,34,.14); }\n"
      "    #arena-feedback .fb-potban.full { color: #ffb4ae; border: 1px solid rgba(248,81,73,.7); background: rgba(248,81,73,.14); }\n"
      "    #arena-feedback .fb-potban .fb-rule { font-weight: 400; }")
open(p, 'w').write(s)
if len(sys.argv) > 2:
    b = sys.argv[2]; t = open(b).read()
    t = R(t, '</head>', '<script>\n' + FN + '</script>\n</head>')
    t = R(t, '<main>\n', '<main>\n  <div id="pot-banner" role="status" hidden></div>\n')
    t = R(t, "        document.getElementById('pot-bar').style.width = Math.min(100, Math.round(100 * s.usedSats / s.potSats)) + '%';",
          "        document.getElementById('pot-bar').style.width = Math.min(100, Math.round(100 * s.usedSats / s.potSats)) + '%';\n"
          "        /* kanban #2789: the pot warning on top */\n"
          "        var ban = typeof arenaPotBanner === 'function' ? arenaPotBanner(s) : null, box = document.getElementById('pot-banner');\n"
          "        if (ban && box) { box.className = 'pot-banner ' + ban.level; box.replaceChildren(); ban.lines.forEach(function (l) { var d = document.createElement('div'); d.textContent = l; box.appendChild(d); }); box.hidden = false; }")
    t = R(t, '</style>', "  .pot-banner { margin: 0 0 18px; padding: 12px 14px; border-radius: 10px; font-weight: 600; line-height: 1.45; }\n"
          "  .pot-banner.warn { color: #f5d77a; border: 1px solid rgba(210,153,34,.7); background: rgba(210,153,34,.14); }\n"
          "  .pot-banner.full { color: #ffb4ae; border: 1px solid rgba(248,81,73,.7); background: rgba(248,81,73,.14); }\n</style>")
    open(b, 'w').write(t)
print('pot-banner ok')
