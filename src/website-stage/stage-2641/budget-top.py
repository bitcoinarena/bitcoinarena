# kanban #2641 (Daniel 2026-11-14: "das ganz nach oben unter Feedback"): the season's budget bar right under the dialog title. Usage: budget-top.py <index.html>
import sys
p = sys.argv[1]; s = open(p).read()
def R(a, b):
    global s
    assert s.count(a) == 1, a[:70]; s = s.replace(a, b)
R("const levels = el('div', { cls: 'fb-levels' });", "const levels = el('div', { cls: 'fb-levels' }), budgetSlot = el('div', { cls: 'fb-budget-slot' });")
R("levels.append(el('div', { cls: 'fb-budget' }, el('div', { cls: 'fb-budget-line' }, ruleLink", "budgetSlot.append(el('div', { cls: 'fb-budget' }, el('div', { cls: 'fb-budget-line' }, ruleLink")
R("ruleLink('', 'Rules')) : el('h3', { text: 'Feedback' })),", "ruleLink('', 'Rules')) : el('h3', { text: 'Feedback' })), budgetSlot,")
R("    #arena-feedback .fb-social-say {", "    #arena-feedback .fb-budget-slot .fb-budget { margin: 0 0 10px; }\n    #arena-feedback .fb-social-say {")
open(p, 'w').write(s); print('budget-top ok')
