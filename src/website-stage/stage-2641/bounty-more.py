# kanban #2641 (the owner 2026-11-14: "Bisschen mehr Text und auch reinschreiben in Details, dass Findings ausgeschlossen sind, die wir bereits gefunden
# haben in den unten genannten Tickets oder im Code. Poster erhält den Link zum Text"): 2-3 short sentences per section, and the known-finding rule
# first in Details. Usage: bounty-more.py <bounty/index.html>
import sys
p = sys.argv[1]; s = open(p).read()
def R(a, b):
    global s
    assert s.count(a) == 1, a[:60]; s = s.replace(a, b)
R('<p class="when">Anything that breaks, loses money or confuses you counts as a bug. You are paid in real sats over Lightning.</p>',
  '<p class="when">Anything that breaks, loses money or confuses you counts as a bug. Show it in a real round on testnet4 for the full level. You are paid in real sats over Lightning.</p>')
R('<p class="note">We give each report a level; the first report of a bug wins. <span id="half">Found it in code only? Half.</span></p>',
  '<p class="note">We read every report and give it one of these levels. The first report of a bug wins; something we already know is not paid. <span id="half">Found it in code only? Half.</span></p>')
R('<p class="note">Up to +60 %. Type your names in Feedback and press Check; we check again before we pay.</p>',
  '<p class="note">Up to +60 % on every confirmed report. Type your names in the Feedback form and press Check: each one is checked live. We check again before we pay, so stay with us.</p>')
R('<p class="note">100,000 sats a season for reports, bonuses and nodes.</p>',
  '<p class="note">100,000 sats a season for reports, bonuses and nodes. A season runs one week. When the pot is empty, new reports wait for the next season.</p>')
R('<p class="note">At the end of the season, among reporters who are members of Telegram, Discord or Armada.</p>',
  '<p class="note">At the end of the season we draw five winners among reporters who are members of Telegram, Discord or Armada. The seed is a Bitcoin block, so anyone can check it.</p>')
R('      <li id="duplicates">First report wins. Duplicates and known issues pay nothing.</li>',
  '      <li id="duplicates"><b>Already known? Not paid.</b> A finding we already know about is excluded: if it matches a ticket in the <a href="#open-issues">open-issues list below</a>, or we had already found it in our own code. You then get a private link to that ticket\'s text, so you can see it was known before your report. Otherwise the first report wins.</li>')
open(p, 'w').write(s); print('more ok')
