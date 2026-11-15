# kanban #2788 (the owner 2026-11-15: "In der Feedback-Seite klar schreiben, dass nur Menschen 100 % des Bug-Betrags bekommen, Bots 25 %. Um human zu
# beweisen benoetigen wir einen Twitter [account]. Wir behalten uns vor, Bots, die das manipulieren, auszuschliessen und trotzdem nur 25 % zu zahlen bei
# einem accepted bug."): the bounty Feedback form says it right under the season's budget bar, linked to the rules page. Usage: human-x.py <index.html>
import sys
p = sys.argv[1]; s = open(p).read()
def R(a, b):
    global s
    assert s.count(a) == 1, a[:70]; s = s.replace(a, b)
R("ruleLink('', 'Rules')) : el('h3', { text: 'Feedback' })), budgetSlot,",
  "ruleLink('', 'Rules')) : el('h3', { text: 'Feedback' })), budgetSlot, ...(window.ARENA_BOUNTY_ON ? [el('div', { cls: 'fb-human' }, el('b', { text: 'Bounty amounts. ' }), "
  "el('span', { text: 'Only humans get 100 % of a bug\\'s amount; bots get 15 %. To prove you are human, play at least one round and link your X (Twitter) account. "
  "Reports without a played round or without a linked X account count as bot reports and get 15 %. We reserve the right to exclude bots that try to game this; "
  "an accepted bug from such a bot still gets only 15 %. The feedback form and the bounty services earn no bounty - only the game and the network do. ' }), ruleLink('humans', 'Rules'))] : []),")
R("    #arena-feedback .fb-budget-slot .fb-budget { margin: 0 0 10px; }",
  "    #arena-feedback .fb-budget-slot .fb-budget { margin: 0 0 10px; }\n    #arena-feedback .fb-human { font-size: 12.5px; line-height: 1.45; margin: 0 0 10px; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(247,147,26,.45); background: rgba(247,147,26,.08); }")
open(p, 'w').write(s); print('human-x ok')
