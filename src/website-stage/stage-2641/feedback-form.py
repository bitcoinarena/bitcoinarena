# #2641 the Feedback form's own lines on a page whose form differs (page1027: lnSay, lnBad): the social box, the Rules link, Send waits for Check
import sys
p=sys.argv[1]; s=open(p).read()
a="      d.append(el('div', { cls: 'card' }, el('h3', { text: 'Feedback' }),"
assert s.count(a)==1, 'd.append'
i=s.index(a); j=s.index('\n', i); line=s[i:j]
assert "levels, el('div', { cls: 'row' }, mineBtn, off, send)));" in line, 'row'
line=line.replace("el('h3', { text: 'Feedback' })", "(RULES_ON() ? el('div', { cls: 'fb-title' }, el('h3', { text: 'Feedback' }), ruleLink('', 'Rules')) : el('h3', { text: 'Feedback' }))",1)
line=line.replace("levels, el('div', { cls: 'row' }, mineBtn, off, send)));", "levels, social, el('div', { cls: 'row' }, mineBtn, off, send)));")
# THE FOUNDING TESTER CHECKBOX IS NOT IN THE FORM AT ALL (Daniel 2026-11-14: "Es gibt ja eine Checkbox im Feedback, die weg"; hidden since 2026-11-10)
line=line.replace(', tick, say, levels', ', say, levels')
s=s[:i]+"      const social = SOCIAL_ON() ? window.ARENA_SOCIAL_PANEL() : null;   // kanban #2641\n"+line+s[j:]
b="      const recount = () => { const n = t.value.trim().length; count.textContent = n < LEAST ? (LEAST - n) + ' more characters' : n + ' characters'; count.className = 'fb-count' + (n < LEAST ? ' short' : ''); send.disabled = n < LEAST"
assert s.count(b)==1, 'recount'
i=s.index(b); j=s.index('\n', i); old=s[i:j]
cond=old[len(b):].rstrip()
assert cond.endswith('; };'), cond
extra=cond[:-len('; };')]   # e.g. " || lnBad"
new=("      const sendWhy = el('div', { cls: 'fb-send-why', role: 'status' });\n"
"      { const card = d.querySelector('.card'); card.insertBefore(sendWhy, card.lastChild); }\n"
+b.replace(" send.disabled = n < LEAST","")+"\n"
"        const waits = !!(social && social.isConnected && social.pending && social.pending());\n"
"        send.disabled = n < LEAST"+extra+" || waits; sendWhy.textContent = waits ? 'Press Check for your community names first (or clear them)' : ''; };\n"
"      if (social) social.addEventListener('social-change', recount);")
s=s[:i]+new+s[j:]
open(p,'w').write(s); print('hunk4 ok, extra=', repr(extra))
