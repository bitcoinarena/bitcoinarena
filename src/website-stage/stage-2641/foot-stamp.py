# kanban #2763 (e2e live probe on UI 676: "UI 67" with its last digit under the X icon at 1280x900, 1024, 820 and 390 wide - 14 px overlap): the
# fixed padding-right values guessed the icons' place; the stamp now ends 10 px left of the social icons' measured left edge, read again on resize
# and every 2 s (the top-up button and the game screens move the icons). Usage: foot-stamp.py <index.html>
import sys
p = sys.argv[1]; s = open(p).read()
JS = """<script>
/* kanban #2763: the footer's "UI n" stamp ends 10 px left of the social icons, wherever they are */
(function () { var fit = function () { var b = document.getElementById('arena-build'), so = document.getElementById('arena-social'); if (!b || !so) return;
  var r = so.getBoundingClientRect(); if (!r.width || getComputedStyle(so).display === 'none') { b.style.removeProperty('padding-right'); return; }
  b.style.setProperty('padding-right', Math.ceil(window.innerWidth - r.left + 10) + 'px', 'important'); };
  window.addEventListener('resize', fit); setInterval(fit, 2000); if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fit); else fit(); })();
</script>
</body>"""
assert s.count('</body>') == 1
s = s.replace('</body>', JS)
open(p, 'w').write(s); print('foot-stamp ok')
