# kanban #2641 (the owner 2026-11-14: "Aber gleiche die Texte an. Jeder soll eine eigene Karte haben mit Text"): the rules page's bonus card as one linked
# card per platform (icon left, text right, the same form), grouped Social media / Community; the separate join row goes. Usage: bounty-cards.py <bounty/index.html> <index.html>
import re, sys, json
b, idx = sys.argv[1], sys.argv[2]
s = open(b).read(); x = open(idx).read()
icons = json.loads(re.search(r'const SOCIAL_ICONS = (\{.*?\});\n', x).group(1))
m = re.search(r'(https://armada\.buzz/invite/[^"\x27 <]+)', x); armada = m.group(1) if m else 'https://armada.buzz/'
card = lambda k, href, text, pct: (f'      <a class="pcard" href="{href}" target="_blank" rel="noopener"><span class="ic" aria-hidden="true">{icons[k]}</span>'
                                   f'<span class="ptext">{text}</span>' + (f'<span class="plus">{pct}</span>' if pct else '') + '</a>')
new = ('  <div class="bonus">\n'
  '    <div class="bgroup b-social"><div class="bhead"><b>Social media · follow</b><span class="gbadge">+20 % each</span></div>\n'
  + card('x', 'https://x.com/bitcoinarena_io', 'Follow @bitcoinarena_io on X', '+20 %') + '\n'
  + card('nostr', 'https://njump.me/npub1p8dl6aewvlszgsxlvpzznaruw3mx3wpt3699zgwnv7tk5pk790msqkqyh2', 'Follow Bitcoin Arena on Nostr', '+20 %') + '\n    </div>\n'
  '    <div class="bgroup b-community"><div class="bhead"><b>Community · join</b><span class="gbadge">any 2: +20 %</span></div>\n'
  + card('telegram', 'https://t.me/bitcoinarena_io', 'Join our Telegram group', '') + '\n'
  + card('discord', 'https://discord.gg/9zZbASZyue', 'Join our Discord server', '') + '\n'
  + card('armada', armada, 'Join our Armada community', '') + '\n    </div>\n  </div>\n')
i = s.index('  <div class="bonus">'); j = s.index('\n  </div>\n', s.index('b-community', i)) + len('\n  </div>\n')
s = s[:i] + new + s[j:]
s = re.sub(r'\n  <div class="joins" aria-label="Join">.*?</div>', '', s, count=1, flags=re.S)
s = s.replace(' Join: ', ' ')
s = s.replace('  .gbadge {', '  .pcard { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 12px; background: var(--panel); border: 1px solid var(--line); color: var(--text); text-decoration: none; min-width: 0; }\n'
  '  .pcard:hover { border-color: var(--btc); } .pcard .ptext { flex: 1 1 auto; min-width: 0; font-weight: 600; } .pcard .plus { flex: none; }\n  .gbadge {', 1)
open(b, 'w').write(s); print('bounty cards ok', s.count('class="pcard"'))
