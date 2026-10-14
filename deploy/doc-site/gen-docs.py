import json, html, os
HERE = os.path.dirname(os.path.abspath(__file__))
E = json.load(open(os.path.join(HERE, 'endpoints.json')))
esc = lambda s: html.escape(str(s))
def table(aud):
    rows = [e for e in E if e['audience'] == aud]
    rows.sort(key=lambda e: (e['path'], e['method']))
    out = ['<div class="tbl api"><table><thead><tr><th>Request</th><th>What it does</th><th>Parameters</th><th>Returns</th><th>Access</th></tr></thead><tbody>']
    for e in rows:
        out.append(f'<tr><td class="ep"><span class="m m-{esc(e["method"]).lower()}">{esc(e["method"])}</span> <code>{esc(e["path"])}</code></td>'
                   f'<td data-l="What it does">{esc(e["purpose"])}</td><td data-l="Parameters">{esc(e["params"])}</td><td data-l="Returns">{esc(e["returns"])}</td><td data-l="Access">{esc(e["auth"])}</td></tr>')
    out.append('</tbody></table></div>')
    return '\n'.join(out), len(rows)
dev, ndev = table('game/market developer')
pla, npla = table('player/page')
ops, nops = table('operator/monitoring')
n2n, nn2n = table('node-to-node')

page = open(os.path.join(HERE, 'docs-template.html')).read()
page = page.replace('{{DEV}}', dev).replace('{{PLAYER}}', pla).replace('{{OPS}}', ops).replace('{{N2N}}', n2n)
page = page.replace('{{NDEV}}', str(ndev)).replace('{{NPLAYER}}', str(npla)).replace('{{NOPS}}', str(nops)).replace('{{NN2N}}', str(nn2n)).replace('{{NALL}}', str(len(E)))

# SECTIONS AS ACCORDIONS (kanban #361): every h2 section of the main column becomes a <details class="sec">, open in the file
# (a reader without JavaScript sees everything) and folded by the page's script, which opens the one a link points at
import re
m0 = page.index('<main id="top">'); m1 = page.index('</main>')
main = page[m0:m1]
tail = ''
k = main.find('\n  <div class="folds bottom">')
if k > 0: main, tail = main[:k], main[k:]
parts = re.split(r'(?=\n  <h2 id=")', main)
out = [parts[0] + '\n  <div class="folds"><button type="button" id="fold-open">Open all</button><button type="button" id="fold-close">Close all</button></div>']
for p in parts[1:]:
    h = re.match(r'\n  (<h2 id="[^"]+">.*?</h2>)', p, re.S)
    out.append('\n  <details class="sec" open><summary>' + h.group(1) + '</summary><div class="sec-body">' + p[h.end():] + '\n  </div></details>')
page = page[:m0] + ''.join(out) + tail + page[m1:]
open(os.path.join(HERE, 'www', 'index.html'), 'w').write(page)
# the homepage serves the same page at /docs (kanban #359), so both stay one
open(os.path.join(HERE, '..', 'home-site', 'www', 'docs', 'index.html'), 'w').write(page)
print('written', len(page), ndev, npla, nops, nn2n)
