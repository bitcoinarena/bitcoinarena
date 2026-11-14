# kanban #2745: My feedback shows a duplicate's secret ticket link ("Details") to the report's own key, under its reason. Usage: dup-link.py <index.html>
import sys
p = sys.argv[1]; s = open(p).read()
a = "          if (rp.reason) row.append(el('div', { cls: 'fb-why', text: 'Why: ' + rp.reason }));\n"
assert s.count(a) == 1, 'the reason line'
if 'rp.dupToken' not in s:
    s = s.replace(a, a + "          // A DUPLICATE OF A KNOWN TICKET (kanban #2745): its text behind a link only this key gets (never listed, never indexed)\n"
      "          if (rp.dupToken && /^[0-9a-f]{32}$/.test(rp.dupToken)) row.append(el('div', { cls: 'fb-why' }, el('span', { text: 'Details: ' }),\n"
      "            el('a', { href: 'https://testnet-stage.bitcoinarena.io/api/faucet/feedback/dup/' + rp.dupToken, target: '_blank', rel: 'noopener noreferrer', text: 'the ticket your report matched' })));\n")
open(p, 'w').write(s); print('dup-link ok')
