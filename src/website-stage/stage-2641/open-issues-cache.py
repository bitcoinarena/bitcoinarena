# kanban #2641 (the owner 2026-11-14: "Die Ticket-Kiste muss cached sein"): the rules page paints the open-issues table at once - from this browser's last
# list (localStorage), else the snapshot built into the page - and refreshes it from the edge-cached list behind; "updated <time>" under the table.
# Usage: open-issues-cache.py <bounty/index.html> [<open-issues.json for the built-in snapshot>]
import sys, json
p = sys.argv[1]; s = open(p).read()
snap = '{"updated":null,"areas":[]}'
if len(sys.argv) > 2:
    try: snap = json.dumps(json.load(open(sys.argv[2])), separators=(',', ':'))
    except Exception: pass
a0 = s.index("      fetch('/api/faucet/feedback/open-issues')"); a1 = s.index("});\n", s.index("Not readable just now.", a0)) + len("});\n")
new = ("      // the list at once: this browser's last copy, else the one built into the page; then the edge's (kanban #2641)\n"
  "      var SNAP = " + snap.replace('</', '<\\/') + ";\n"
  "      var show = function (o) { if (!o || !Array.isArray(o.areas)) return; var tb = document.getElementById('s2-open'); tb.textContent = '';\n"
  "        o.areas.forEach(function (a) { var tr = document.createElement('tr'), t1 = document.createElement('td'), t2 = document.createElement('td');\n"
  "          t1.textContent = a.area; t2.textContent = (a.tickets || []).join(' '); tr.append(t1, t2); tb.append(tr); });\n"
  "        if (!tb.children.length) tb.innerHTML = '<tr><td colspan=\"2\">None open.</td></tr>';\n"
  "        var u = document.getElementById('s2-updated'); if (u && o.updated) u.textContent = 'Updated ' + o.updated.slice(0, 16).replace('T', ' ') + ' UTC'; };\n"
  "      var kept = null; try { kept = JSON.parse(localStorage.getItem('arena.open-issues') || 'null'); } catch (e) { kept = null; }\n"
  "      show(kept && kept.updated && (!SNAP.updated || kept.updated >= SNAP.updated) ? kept : SNAP);\n"
  "      fetch('/api/faucet/feedback/open-issues', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (o) {\n"
  "        show(o); try { localStorage.setItem('arena.open-issues', JSON.stringify(o)); } catch (e) { /* this visit only */ } }).catch(function () {\n"
  "        if (!document.querySelector('#s2-open td:nth-child(2)')) document.getElementById('s2-open').innerHTML = '<tr><td colspan=\"2\">Not readable just now.</td></tr>'; });\n")
s = s[:a0] + new + s[a1:]
s = s.replace('<tbody id="s2-open"><tr><td colspan="2">Reading &hellip;</td></tr></tbody></table>', '<tbody id="s2-open"><tr><td colspan="2">Reading &hellip;</td></tr></tbody></table>\n  <p class="note" id="s2-updated"></p>', 1)
open(p, 'w').write(s); print('open-issues cache ok')
