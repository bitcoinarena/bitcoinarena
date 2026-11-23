#!/usr/bin/env python3
# kanban #3076 (feedback #352): a community name typed but not checked disabled Send, and the only reason was one line of small text at the
# bottom of the card. Now Send stays pressable: pressing it runs the community Check first and sends once the names are checked; the field
# waiting for its Check is marked, and the reason is the Send button's title as well. Idempotent.
import sys
p = sys.argv[1]; s = open(p).read()
if 'kanban #3076' in s: sys.exit(0)
def once(a, b):
    global s
    assert s.count(a) == 1, (s.count(a), a[:80])
    s = s.replace(a, b)
once("""      box.pending = () => Object.values(fields).some((f) => f.input.value.trim() && (f.checking || f.checkedValue !== f.input.value.trim()));""",
"""      box.pending = () => Object.values(fields).some((f) => f.input.value.trim() && (f.checking || f.checkedValue !== f.input.value.trim()));
      // kanban #3076: Send runs the Check itself; a field waiting for it is marked
      box.busy = () => Object.values(fields).some((f) => f.checking);
      box.checkNow = () => { if (!box.busy()) check.click(); };
      box.markPending = (on) => { for (const f of Object.values(fields)) f.input.classList.toggle('fb-needs-check', !!on && !!f.input.value.trim() && !f.checking && f.checkedValue !== f.input.value.trim()); };""")
once("""        send.disabled = n < LEAST || lnBad || waits; sendWhy.textContent = waits ? 'Press Check for your community names first (or clear them)' : ''; };""",
"""        // kanban #3076: names waiting for their Check no longer disable Send - Send checks them first
        send.disabled = n < LEAST || lnBad; sendWhy.textContent = waits ? 'Your community names are checked when you press Send (or clear them).' : '';
        send.title = waits ? 'Checks your community names first, then sends' : ''; if (social && social.markPending) social.markPending(false); };""")
once("""        if (t.value.trim().length < 50 || (social && social.isConnected && social.pending && social.pending())) { recount(); return; }""",
"""        if (t.value.trim().length < 50) { recount(); return; }
        if (social && social.isConnected && social.pending && social.pending()) {
          // kanban #3076: the Check runs now; once every typed name is checked, the report goes on by itself
          if (social.markPending) social.markPending(true);
          sendWhy.textContent = 'Checking your community names first \\u2026';
          const goOn = () => { if (social.pending()) { if (!(social.busy && social.busy())) { social.removeEventListener('social-change', goOn); sendWhy.textContent = 'A community name could not be checked - fix it or clear it, then press Send.'; if (social.markPending) social.markPending(true); } return; }
            social.removeEventListener('social-change', goOn); sendWhy.textContent = ''; send.click(); };
          social.addEventListener('social-change', goOn);
          if (social.checkNow) social.checkNow();
          return;
        }""")
i = s.index("</style>"); s = s[:i] + ".fb-needs-check { outline: 2px solid #e0a100; outline-offset: 1px; }\n" + s[i:]
open(p, 'w').write(s)
print('ok', p)
