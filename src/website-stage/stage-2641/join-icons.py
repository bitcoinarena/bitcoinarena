# kanban #2641 (Daniel 2026-11-14: "da auch Logos hin, keine reinen Text-Links"): the Feedback box's join links carry their platform's icon. Usage: join-icons.py <index.html>
import sys
p = sys.argv[1]; s = open(p).read()
a = "        const join = el('a', { href: r.join, target: '_blank', rel: 'noopener noreferrer', cls: 'fb-social-join', text: r.joinText });"
if a in s:
    s = s.replace(a, "        const join = el('a', { href: r.join, target: '_blank', rel: 'noopener noreferrer', cls: 'fb-social-join' }); { const ji = el('span', { cls: 'fb-join-ico', 'aria-hidden': 'true' }); ji.innerHTML = SOCIAL_ICONS[r.p]; join.append(ji, document.createTextNode(r.joinText)); }")
    s = s.replace("    #arena-feedback .fb-social-line a { color: #58a6ff;", "    #arena-feedback .fb-social-join { display: inline-flex; align-items: center; gap: 4px; } #arena-feedback .fb-join-ico svg { width: 12px; height: 12px; display: block; }\n    #arena-feedback .fb-social-line a { color: #58a6ff;", 1)
open(p, 'w').write(s); print('join-icons ok')
