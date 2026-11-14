# kanban #2641 (Daniel 2026-11-14: "das ist auch nicht schön zu lesen, das muss grafischer werden"): the rule line under "Community bonus" becomes
# pills - each group's header carries its badge (+20 % each / any 2 +20 %), the summary row is "max +60 %" (to #community-bonus) and a ticket pill
# "Season draw" (to #draw). Usage: summary.py <index.html> [<bounty/index.html>]
import sys
p = sys.argv[1]; s = open(p).read()
def R(a, b):
    global s
    assert s.count(a) == 1, a[:70]; s = s.replace(a, b)
R("el('div', { cls: 'fb-social-help' }, ruleLink('community-bonus', 'X +20 %, Nostr +20 %, any 2 of Telegram / Discord / Armada +20 %'), el('span', { text: ' · ' }), ruleLink('draw', 'season draw'))",
  "(() => { const draw = ruleLink('draw', 'Season draw', 'fb-pill fb-pill-draw'); const t = el('span', { cls: 'fb-pill-ico', 'aria-hidden': 'true' }); "
  "t.innerHTML = '<svg viewBox=\"0 0 24 24\"><path fill=\"currentColor\" d=\"M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4zm11 0v2h2V7zm0 4v2h2v-2zm0 4v2h2v-2z\"/></svg>'; draw.prepend(t); "
  "return el('div', { cls: 'fb-social-help' }, ruleLink('community-bonus', 'max +60 %', 'fb-pill fb-pill-max'), draw); })()")
R("el('div', { cls: 'fb-social-ghead' }, el('b', { text: title }), el('span', { text: rule }))", "el('div', { cls: 'fb-social-ghead' }, el('b', { text: title }), el('span', { cls: 'fb-gbadge', text: rule }))")
R("group('g-social', 'Social media', 'Follow us: +20 % each')", "group('g-social', 'Social media · follow', '+20 % each')")
R("group('g-community', 'Community', 'Join any 2: +20 %')", "group('g-community', 'Community · join', 'any 2: +20 %')")
R("    #arena-feedback .fb-social-say {", """    #arena-feedback .fb-social-help { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 2px; }
    #arena-feedback a.fb-pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; text-decoration: none; }
    #arena-feedback a.fb-pill-max { background: linear-gradient(135deg, #f7931a, #f0388a); color: #0d1117; } #arena-feedback a.fb-pill-draw { border: 1px solid var(--fs-line); color: var(--fs-text); background: #21262d; }
    #arena-feedback .fb-pill-ico svg { width: 13px; height: 13px; display: block; color: #f7931a; }
    #arena-feedback .fb-gbadge { font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 999px; background: linear-gradient(135deg, #f7931a, #f0388a); color: #0d1117; }
    #arena-feedback .fb-social-say {""")
open(p, 'w').write(s)
if len(sys.argv) > 2:
    b = sys.argv[2]; t = open(b).read()
    for x, y in [('<span>Follow us: +20 % each</span>', '<span class="gbadge">+20 % each</span>'), ('<span>Join any 2: +20 %</span>', '<span class="gbadge">any 2: +20 %</span>'),
                 ('<b>Social media</b>', '<b>Social media · follow</b>'), ('<b>Community</b><span', '<b>Community · join</b><span'),
                 ('  .joins {', '  .gbadge { font-size: 12px; font-weight: 800; padding: 2px 9px; border-radius: 999px; background: linear-gradient(135deg, #f7931a, #f0388a); color: #0d1117; }\n  .joins {')]:
        assert t.count(x) == 1, x; t = t.replace(x, y)
    open(b, 'w').write(t)
print('summary ok')
