# kanban #2641 (Daniel 2026-11-14: "tu das besser aufteilen in Community und Social Media"): the community box in two labelled groups - Social media
# (follow: X, Nostr; +20 % each) and Community (member: Telegram, Discord, Armada; any 2 +20 %) - side by side from 768 px, stacked on a phone.
# Usage: groups.py <index.html>
import sys
p = sys.argv[1]; s = open(p).read()
def R(a, b):
    global s
    assert s.count(a) == 1, a[:70]; s = s.replace(a, b)
R("      const items = el('div', { cls: 'fb-social-items' }); box.append(items);",
  "      const items = el('div', { cls: 'fb-social-items' }); box.append(items);\n"
  "      const GROUPS = { x: 'social', nostr: 'social', telegram: 'community', discord: 'community', armada: 'community' };\n"
  "      const group = (cls, title, rule) => { const g = el('div', { cls: 'fb-social-group ' + cls }, el('div', { cls: 'fb-social-ghead' }, el('b', { text: title }), el('span', { text: rule }))); items.append(g); return g; };\n"
  "      const groups = { social: group('g-social', 'Social media', 'Follow us: +20 % each'), community: group('g-community', 'Community', 'Join any 2: +20 %') };")
R("        items.append(el('div', { cls: 'fb-social-item' },", "        groups[GROUPS[r.p]].append(el('div', { cls: 'fb-social-item' },")
R("    #arena-feedback .fb-social-say {", """    #arena-feedback .fb-social-group { margin-top: 10px; padding: 8px 10px 10px; border: 1px solid var(--fs-line); border-radius: 10px; background: rgba(255,255,255,.02); min-width: 0; }
    #arena-feedback .fb-social-group.g-social { border-color: rgba(88,166,255,.35); } #arena-feedback .fb-social-group.g-community { border-color: rgba(247,147,26,.35); }
    #arena-feedback .fb-social-ghead { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--fs-dim); }
    #arena-feedback .fb-social-ghead b { font-size: 13px; color: var(--fs-text); text-transform: uppercase; letter-spacing: .04em; }
    @media (min-width: 768px) { #arena-feedback .fb-social-items { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 0 12px; align-items: start; } }
    #arena-feedback .fb-social-say {""")
open(p, 'w').write(s); print('groups ok')
