import json, html, os
HERE = os.path.dirname(os.path.abspath(__file__))
E = json.load(open(os.path.join(HERE, 'endpoints.json')))
esc = lambda s: html.escape(str(s))
def table(aud):
    rows = [e for e in E if e['audience'] == aud]
    rows.sort(key=lambda e: (e['path'], e['method']))
    out = ['<div class="tbl"><table><thead><tr><th>Request</th><th>What it does</th><th>Parameters</th><th>Returns</th><th>Access</th></tr></thead><tbody>']
    for e in rows:
        out.append(f'<tr><td class="ep"><span class="m m-{esc(e["method"]).lower()}">{esc(e["method"])}</span> <code>{esc(e["path"])}</code></td>'
                   f'<td>{esc(e["purpose"])}</td><td>{esc(e["params"])}</td><td>{esc(e["returns"])}</td><td>{esc(e["auth"])}</td></tr>')
    out.append('</tbody></table></div>')
    return '\n'.join(out), len(rows)
dev, ndev = table('game/market developer')
pla, npla = table('player/page')
ops, nops = table('operator/monitoring')
n2n, nn2n = table('node-to-node')

page = open(os.path.join(HERE, 'docs-template.html')).read()
page = page.replace('{{DEV}}', dev).replace('{{PLAYER}}', pla).replace('{{OPS}}', ops).replace('{{N2N}}', n2n)
page = page.replace('{{NDEV}}', str(ndev)).replace('{{NPLAYER}}', str(npla)).replace('{{NOPS}}', str(nops)).replace('{{NN2N}}', str(nn2n)).replace('{{NALL}}', str(len(E)))
open(os.path.join(HERE, 'www', 'index.html'), 'w').write(page)
print('written', len(page), ndev, npla, nops, nn2n)
