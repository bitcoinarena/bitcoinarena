# kanban #2641 (the owner 2026-11-14: "Tu bei jedem Ticket eine 1-zeilige Zusammenfassung posten"): each ticket as "#id: <one line>" under its area;
# the "How it works" step says "Use the Feedback function". Usage: open-issues-lines.py <bounty/index.html>
import sys
p = sys.argv[1]; s = open(p).read()
a = "t1.textContent = a.area; t2.textContent = (a.tickets || []).join(' '); tr.append(t1, t2); tb.append(tr); });"
assert s.count(a) == 1
s = s.replace(a, "t1.textContent = a.area; var its = Array.isArray(a.items) && a.items.length ? a.items : (a.tickets || []).map(function (t) { return { id: t, text: '' }; });\n"
  "          its.forEach(function (i) { var d = document.createElement('div'); d.className = 'oi-line'; var b = document.createElement('b'); b.textContent = i.id; d.append(b, document.createTextNode(i.text ? ': ' + i.text : '')); t2.append(d); });\n"
  "          tr.append(t1, t2); tb.append(tr); });")
s = s.replace('  .gbadge {', '  .oi-line { padding: 2px 0; } .oi-line b { color: var(--btc); font-weight: 600; } #s2-open td:first-child { white-space: nowrap; vertical-align: top; color: var(--text); }\n  .gbadge {', 1)
if '<b>Report it</b></li>' in s:
    s = s.replace('<b>Report it</b></li>', '<b>Use the Feedback function</b><span>at the bottom of the game page</span></li>')
    s = s.replace('  .steps3 li { align-items: center; text-align: center; }', '  .steps3 li { align-items: center; text-align: center; } .steps3 li span:not(.si) { font-size: 13px; }', 1)
open(p, 'w').write(s); print('lines render ok')
