# kanban #2641 (Daniel 2026-11-14): a fifth row "Nostr" (follow check), the bonus as X +20 / Nostr +20 / 2 of 3 +20 (at most +60), and a wider Feedback
# dialog on iPad and desktop with the community rows in two columns. Usage: nostr-wide.py <index.html> <arena-node/src/bounty-social-store.js>
import re, sys, json
p, store = sys.argv[1], sys.argv[2]
s = open(p).read()
def R(a, b):
    global s
    assert s.count(a) == 1, a[:70]; s = s.replace(a, b)
# the browser store, as the module now is
src = open(store).read(); blk = src[src.index('// ---- social-store begin'):src.index('// ---- social-store end') + len('// ---- social-store end')]
blk = '\n'.join('    ' + l if l else l for l in blk.split('\n'))
i = s.index('    // ---- social-store begin'); j = s.index('// ---- social-store end', i) + len('// ---- social-store end')
s = s[:i] + blk + s[j:]
# the Nostr icon (the footer's own) in the icon set
m = re.search(r"Nostr: '(M[^']*)'", s)
icons = json.loads(re.search(r'const SOCIAL_ICONS = (\{.*?\});\n', s).group(1))
icons['nostr'] = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#a855f7" d="' + m.group(1) + '"/></svg>'
s = re.sub(r'const SOCIAL_ICONS = \{.*?\};\n', lambda _: 'const SOCIAL_ICONS = ' + json.dumps(icons) + ';\n', s, count=1)
R("        { p: 'armada', name: 'Armada',", "        { p: 'nostr', name: 'Nostr', ph: 'Nostr npub1… or name@domain', join: 'https://njump.me/npub1p8dl6aewvlszgsxlvpzznaruw3mx3wpt3699zgwnv7tk5pk790msqkqyh2', joinText: 'Follow on Nostr', no: 'not following' },\n        { p: 'armada', name: 'Armada',")
R("ruleLink('community-bonus', 'X +25 %, any 2 of Telegram / Discord / Armada +25 %')", "ruleLink('community-bonus', 'X +20 %, Nostr +20 %, any 2 of Telegram / Discord / Armada +20 %')")
R("badge.className = 'fb-social-badge' + (n >= 50 ? ' max' : n > 0 ? ' on' : '');", "badge.className = 'fb-social-badge' + (n >= 60 ? ' max' : n > 0 ? ' on' : '');")
# each platform's row and line in one item, so wide screens can set them in two columns
R("        box.append(el('div', { cls: 'fb-social-row' }, ico, input, chip), el('div', { cls: 'fb-social-line' }, note, change, join));",
  "        items.append(el('div', { cls: 'fb-social-item' }, el('div', { cls: 'fb-social-row' }, ico, input, chip), el('div', { cls: 'fb-social-line' }, note, change, join)));")
R("      for (const r of ROWS) {\n        const ico =", "      const items = el('div', { cls: 'fb-social-items' }); box.append(items);\n      for (const r of ROWS) {\n        const ico =")
R("    #arena-feedback .fb-social-say {", """    /* WIDER ON IPAD AND DESKTOP (Daniel 2026-11-14: "Auf dem Desktop muss man zuviel scrollen, mach es breiter"): the dialog up to 920 px, the
       community rows in two columns; a phone stays as it is */
    @media (min-width: 768px) { #arena-feedback .card { width: min(920px, 94vw); } #arena-feedback .fb-social-items { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; } }
    #arena-feedback .fb-social-say {""")
open(p, 'w').write(s); print('nostr-wide ok')
