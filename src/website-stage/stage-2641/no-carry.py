# kanban #2787 (the owner 2026-11-15: "wenn der Pot voll ist, ist er voll"): once a season's pot is used up there is no bounty at all (nothing carries over). The bounty
# Feedback form says so under the budget bar when the faucet's GET /feedback/season answers usedUp. Usage: no-carry.py <index.html>
import sys
p = sys.argv[1]; s = open(p).read()
def R(a, b):
    global s
    assert s.count(a) == 1, a[:70]; s = s.replace(a, b)
R("if (p && Number(p.potSats) > 0) showBudget(Number(p.usedSats) || 0, Number(p.potSats)); }",
  "if (p && Number(p.potSats) > 0) showBudget(Number(p.usedSats) || 0, Number(p.potSats)); "
  "if (p && p.usedUp === true) { const when = Number.isFinite(Number(p.nextSeasonMs)) && Number(p.nextSeasonMs) > 0 ? new Date(Number(p.nextSeasonMs)).toLocaleString('en-GB', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : 'soon'; "
  "budgetSlot.append(el('div', { cls: 'fb-usedup', role: 'status' }, el('b', { text: 'This season\\'s bounty pot is used up. ' }), "
  "el('span', { text: 'Reports are still welcome, but nothing is paid until the next season starts (' + when + '). ' }), ruleLink('budget', 'Rules'))); } }")
R("    #arena-feedback .fb-budget-slot .fb-budget { margin: 0 0 10px; }",
  "    #arena-feedback .fb-budget-slot .fb-budget { margin: 0 0 10px; }\n    #arena-feedback .fb-usedup { font-size: 12.5px; line-height: 1.45; margin: 0 0 10px; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(248,81,73,.55); background: rgba(248,81,73,.10); }")
open(p, 'w').write(s); print('no-carry ok')
