# kanban #2641 (the owner 2026-11-14: "es ist immer noch eine Wall of Text und komplex. Vereinfacht es deutlich"): the stage rules page in 15 seconds -
# hero, 3 steps, pay tiles, 5 platform cards, pot and draw, the fine print folded in Details, open issues and Season 1 folded. The 12 anchors stay;
# an anchor inside a fold opens it. Usage: bounty-simple.py <bounty/index.html>
import re, sys
p = sys.argv[1]; s = open(p).read()
cut = lambda a, b: s[s.index(a):s.index(b, s.index(a)) + len(b)]
LINK = re.search(r'(<svg viewBox="0 0 16 16".*?</svg>)', s).group(1)
steps = re.findall(r'<span class="si">(<svg.*?</svg>)</span>', s)
tiles = cut('  <div class="tiles">', '\n  </div>\n')
bonus = cut('  <div class="bonus">', '\n    </div>\n  </div>\n')
podium = cut('<ol class="podium">', '</ol>')
oi_script = cut('  <script>\n    /* the week', '  </script>\n')
snap_n = len(re.findall(r'"#\d+"', re.search(r'var SNAP = (\{.*?\});', oi_script).group(1)))
main = f'''  <section class="hero">
    <div class="tag">Bug bounty &middot; Season 2</div>
    <h1>Find bugs. Earn sats.</h1>
    <p class="lead">Play, report, get paid over Lightning.</p>
    <a class="go" href="/">Play a round</a>
  </section>

  <ol class="steps steps3" id="how-to-report">
    <li><span class="si">{steps[0]}</span><b>Play a round</b></li>
    <li><span class="si">{steps[1]}</span><b>Report it</b></li>
    <li><span class="si">{steps[3]}</span><b>Get paid</b></li>
  </ol>

  <h2 id="pay">What you get</h2>
{tiles}
  <p class="note" id="half">Found it in code only? Half.</p>

  <h2 id="community-bonus">Bonus</h2>
{bonus}
  <p class="note">Up to +60 %.</p>

  <div class="duo">
    <section class="card" id="budget"><h3>Season pot</h3>
      <div class="pot"><b id="pot-used">&hellip;</b> <span>/ 100,000 sats</span></div>
      <div class="bar"><i id="pot-bar"></i></div>
    </section>
    <section class="card" id="draw"><h3>Season draw: 50,000 for the top 5</h3>
      {podium}
    </section>
  </div>

  <details class="fold" id="rules"><summary>Details</summary>
    <ul class="fine">
      <li id="duplicates">First report wins. Duplicates and known issues pay nothing.</li>
      <li id="follow-ups">A gap in a fix or another variant: 1,000 sats.</li>
      <li>Found it in the code only: half. Show it in a real round for the full level.</li>
      <li id="node-bounty">Run a node for a day: 10,000 sats, the first 3 nodes a season.</li>
      <li id="no-game-results">Winning a round is never paid. Test sats have no value.</li>
      <li>Draw: one confirmed report this season and a member of Telegram, Discord or Armada; one entry per person. Seed: the first Bitcoin block after Season 2 ends (2026-11-21 07:12 UTC). <a href="draw.mjs">draw.mjs</a></li>
      <li>The pot is 100,000 sats a season (a season runs one week). When it is empty, reports wait for the next season.</li>
      <li>We check every report and decide its level. Our decision is final.</li>
    </ul>
  </details>

  <details class="fold" id="open-issues"><summary><span id="oi-count">{snap_n}</span> known issues</summary>
    <table><thead><tr><th>Area</th><th>Tickets</th></tr></thead><tbody id="s2-open"><tr><td colspan="2">Reading &hellip;</td></tr></tbody></table>
    <p class="note" id="s2-updated"></p>
  </details>
{oi_script}
'''
a = s.index('<main>\n') + len('<main>\n'); b = s.index('  <span id="season-1"></span>')
s = s[:a] + main + s[b:]
# the count in the summary follows the list it shows
s = s.replace("var u = document.getElementById('s2-updated');", "var c = document.getElementById('oi-count'); if (c) c.textContent = o.areas.reduce(function (n, a) { return n + (a.tickets || []).length; }, 0); var u = document.getElementById('s2-updated');", 1)
s = s.replace("document.getElementById('pot-nodes').textContent = 'This week: ' + s.nodes + ' of ' + s.nodesMost + '.';", "")
s = s.replace("document.getElementById('pot-nodes').textContent = 'This season: ' + s.nodes + ' of ' + s.nodesMost + '.';", "")
# an anchor inside a fold opens it (and #season-1 opens Season 1)
s = re.sub(r"function openWeek1\(\) \{.*?\}\s*\}\s*\}\nwindow.addEventListener\('hashchange', openWeek1\); openWeek1\(\);",
  "function openWeek1() { var id = location.hash.slice(1) === 'season-1' ? 'week-1' : location.hash.slice(1); var e = id && document.getElementById(id); if (!e) return;\n"
  "  var d = e.tagName === 'DETAILS' ? e : e.closest('details'); if (d) d.open = true; e.scrollIntoView(); }\n"
  "window.addEventListener('hashchange', openWeek1); openWeek1();", s, count=1, flags=re.S)
s = s.replace('  .gbadge {', '  .steps3 { grid-template-columns: repeat(3, 1fr); } .steps3 li { align-items: center; text-align: center; } .steps3 li::before { display: none; }\n'
  '  .fold { margin-top: 22px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); padding: 10px 14px; } .fold > summary { cursor: pointer; font-weight: 700; font-size: 17px; }\n'
  '  .fine { margin: 10px 0 0; padding-left: 18px; font-size: 15px; } .fine li { margin-bottom: 6px; }\n  .gbadge {', 1)
open(p, 'w').write(s); print('simple ok', snap_n)
