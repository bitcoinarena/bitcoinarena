# kanban #2641 (the owner 2026-11-14: "Bisschen mehr Text geht schon außerhalb von Details"): one short sentence of context per main section. Usage: bounty-lines.py <bounty/index.html>
import sys
p = sys.argv[1]; s = open(p).read()
def R(a, b):
    global s
    assert s.count(a) == 1, a[:60]; s = s.replace(a, b)
R('<p class="lead">Play, report, get paid over Lightning.</p>', '<p class="lead">Play, report, get paid over Lightning.</p>\n    <p class="when">Anything that breaks, loses money or confuses you counts as a bug. You are paid in real sats over Lightning.</p>')
R('  <p class="note" id="half">Found it in code only? Half.</p>', '  <p class="note">We give each report a level; the first report of a bug wins. <span id="half">Found it in code only? Half.</span></p>')
R('  <p class="note">Up to +60 %.</p>', '  <p class="note">Up to +60 %. Type your names in Feedback and press Check; we check again before we pay.</p>')
R('      <div class="bar"><i id="pot-bar"></i></div>\n    </section>', '      <div class="bar"><i id="pot-bar"></i></div>\n      <p class="note">100,000 sats a season for reports, bonuses and nodes.</p>\n    </section>')
R('</ol>\n    </section>', '</ol>\n      <p class="note">At the end of the season, among reporters who are members of Telegram, Discord or Armada.</p>\n    </section>')
open(p, 'w').write(s); print('lines ok')
