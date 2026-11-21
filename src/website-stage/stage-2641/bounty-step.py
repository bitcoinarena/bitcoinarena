# kanban #2641 (the owner 2026-11-14: "Aus Report steht stattdessen Use the feedback function"). Usage: bounty-step.py <bounty/index.html>
import sys
p = sys.argv[1]; s = open(p).read()
a = '<b>Report it</b></li>'
assert s.count(a) == 1
s = s.replace(a, '<b>Use the Feedback function</b><span>at the bottom of the game page</span></li>')
s = s.replace('  .steps3 li { align-items: center; text-align: center; }', '  .steps3 li { align-items: center; text-align: center; } .steps3 li span:not(.si) { font-size: 13px; }', 1)
open(p, 'w').write(s); print('step ok')
