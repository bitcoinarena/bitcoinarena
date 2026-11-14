# #2641 the stage rules page, redesigned (Daniel 2026-11-14: "ist eine richtige Wall of Text. Locker es auf und tu auch Duplikate entfernen. Mach es
# grafischer und menschlicher"): one place per rule, the 12 anchors kept, Week 1 folded at the bottom. Usage: redesign.py <bounty/index.html> <stage index.html>
import sys, re, json
p, idx = sys.argv[1], sys.argv[2]
s = open(p).read()
icons = json.loads(re.search(r'const SOCIAL_ICONS = (\{.*?\});\n', open(idx).read()).group(1))
LINK = re.search(r'(<svg viewBox="0 0 16 16".*?</svg>)', s).group(1)
rl = lambda i: f'<a class="rl" href="#{i}" aria-label="Link to this rule" title="Copy the link to this rule">{LINK}</a>'
ico = lambda k, name: f'<span class="ic" role="img" aria-label="{name}" title="{name}">{icons[k]}</span>'
STEP = {
 'play': '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
 'say': '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4h16v12H7l-3 3zM7 8v2h10V8zm0 4v2h7v-2z"/></svg>',
 'check': '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 2a8 8 0 0 1 6.3 12.9l5.4 5.4-1.4 1.4-5.4-5.4A8 8 0 1 1 10 2m0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12"/></svg>',
 'bolt': '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
}
main = f'''  <section class="hero">
    <div class="tag">Bug bounty &middot; Week 2</div>
    <h1>Find bugs. Earn real sats.</h1>
    <p class="lead">Play a round, tell us what broke, and we pay you over Lightning. No sign-up, no key needed.</p>
    <p class="when">Week 2 started Saturday, 14 November, 07:12 UTC and ends Saturday, 21 November, 07:12 UTC.</p>
    <a class="go" href="/">Play a round</a>
  </section>

  <nav class="toc" aria-label="Rules"><a href="#how-to-report">How it works</a> &middot; <a href="#pay">Pay</a> &middot; <a href="#community-bonus">Bonus</a> &middot; <a href="#budget">Budget</a> &middot; <a href="#draw">Draw</a> &middot; <a href="#node-bounty">Node bounty</a> &middot; <a href="#half">Half pay</a> &middot; <a href="#follow-ups">Follow-ups</a> &middot; <a href="#duplicates">Duplicates</a> &middot; <a href="#no-game-results">Game results</a> &middot; <a href="#open-issues">Open issues</a> &middot; <a href="#week-1">Week 1</a></nav>

  <h2 id="how-to-report">How it works{rl("how-to-report")}</h2>
  <ol class="steps">
    <li><span class="si">{STEP["play"]}</span><b>Play a round</b><span>on the <a href="/">game page</a>.</span></li>
    <li><span class="si">{STEP["say"]}</span><b>Press Feedback</b><span>at the bottom. Say what happened and what you expected.</span></li>
    <li><span class="si">{STEP["check"]}</span><b>We check it</b><span>and give it a level. You see it in My feedback.</span></li>
    <li><span class="si">{STEP["bolt"]}</span><b>You get paid</b><span>over Lightning, real sats on mainnet.</span></li>
  </ol>

  <h2 id="pay">What a report pays{rl("pay")}</h2>
  <div class="tiles">
    <div class="tile t-crit"><b>10,000</b><span>critical</span><small>money can be lost or taken</small></div>
    <div class="tile t-high"><b>5,000</b><span>high</span><small>play or a payout stops</small></div>
    <div class="tile t-med"><b>2,000</b><span>medium</span><small>needs a retry</small></div>
    <div class="tile t-low"><b>1,000</b><span>low</span><small>wrong text, layout glitch</small></div>
    <div class="tile t-use"><b>500</b><span>useful idea</span><small>something could be better</small></div>
  </div>
  <p class="note">In sats, per confirmed report, for a bug you show in a real round. No limit per person.</p>

  <h2 id="community-bonus">Your community bonus{rl("community-bonus")}</h2>
  <p>Optional. On every confirmed report:</p>
  <div class="bonus">
    <div class="chip-row"><span class="chip">{ico("x", "X")} follow @bitcoinarena_io</span><span class="plus">+25 %</span></div>
    <div class="chip-row"><span class="chip">{ico("telegram", "Telegram")}{ico("discord", "Discord")}{ico("armada", "Armada")} member of any 2</span><span class="plus">+25 %</span></div>
  </div>
  <p class="note">Both give +50 %, so a high bug pays 7,500. Type your names in the Feedback form and press Check. We check again before we pay; if you left, that part drops. Join: <a href="https://x.com/bitcoinarena_io" rel="noopener">X</a> &middot; <a href="https://t.me/+KihHE8JhcVM3NDVi" rel="noopener">Telegram</a> &middot; <a href="https://discord.gg/9zZbASZyue" rel="noopener">Discord</a> &middot; <a href="https://armada.buzz/" rel="noopener">Armada</a></p>

  <div class="duo">
    <section class="card" id="budget"><h3>This week's pot{rl("budget")}</h3>
      <div class="pot"><b id="pot-used">&hellip;</b> <span>of 100,000 sats</span></div>
      <div class="bar"><i id="pot-bar"></i></div>
      <p class="note">150,000 sats a week: 100,000 for reports, bonuses and node bounties, 50,000 for the draw. When the pot is empty, new reports wait for next week.</p>
    </section>
    <section class="card" id="draw"><h3>Weekly draw: 50,000{rl("draw")}</h3>
      <ol class="podium"><li><b>1</b>20,000</li><li><b>2</b>12,000</li><li><b>3</b>8,000</li><li><b>4</b>6,000</li><li><b>5</b>4,000</li></ol>
      <p class="note">You are in with one confirmed report this week and a membership in Telegram, Discord or Armada. One entry per person. The seed is the first Bitcoin block mined after Week 2 ends (21 Nov, 07:12 UTC). Anyone can rerun it: <a href="draw.mjs">draw.mjs</a>.</p>
    </section>
  </div>

  <section class="card wide" id="node-bounty"><h3>Run a node: 10,000 sats{rl("node-bounty")}</h3>
    <p class="note">Keep a node running for a day. The first 3 nodes each week are paid, from the pot. <span id="pot-nodes"></span></p>
  </section>

  <h2>Good to know</h2>
  <dl class="faq">
    <dt id="half">Found it in the code only?{rl("half")}</dt><dd>That pays half. Show it in a real round on testnet4 for the full level.</dd>
    <dt id="follow-ups">A gap in a fix, or another variant?{rl("follow-ups")}</dt><dd>That is a follow-up: 1,000 sats.</dd>
    <dt id="duplicates">Someone was faster?{rl("duplicates")}</dt><dd>The first report wins; a duplicate pays nothing. A match with our open-issues list below counts as a duplicate. We tell you the ticket number.</dd>
    <dt id="no-game-results">Won a round?{rl("no-game-results")}</dt><dd>Nice, but winning is never paid. Test sats have no value; only the Lightning payouts are real money.</dd>
    <dt>Who decides?</dt><dd>We do: new, duplicate or follow-up, and the level. Our decision is final.</dd>
  </dl>

  <h2 id="open-issues">Open issues{rl("open-issues")}</h2>
  <p>Already known, by area. <a href="/kanban/">All open issues</a></p>
  <table><thead><tr><th>Area</th><th>Tickets</th></tr></thead><tbody id="s2-open"><tr><td colspan="2">Reading &hellip;</td></tr></tbody></table>
  <script>
    /* the week's pot and the open-issues list (areas and ticket numbers only), read from the faucet (kanban #2623, #2641) */
    (function () {{
      var fmt = function (n) {{ return Number(n).toLocaleString('en-US'); }};
      fetch('/api/faucet/feedback/season').then(function (r) {{ if (!r.ok) throw 0; return r.json(); }}).then(function (s) {{
        document.getElementById('pot-used').textContent = fmt(s.usedSats);
        document.getElementById('pot-bar').style.width = Math.min(100, Math.round(100 * s.usedSats / s.potSats)) + '%';
        document.getElementById('pot-nodes').textContent = 'This week: ' + s.nodes + ' of ' + s.nodesMost + '.';
      }}).catch(function () {{ document.getElementById('pot-used').textContent = '?'; }});
      fetch('/api/faucet/feedback/open-issues').then(function (r) {{ if (!r.ok) throw 0; return r.json(); }}).then(function (o) {{
        var tb = document.getElementById('s2-open'); tb.textContent = '';
        (o.areas || []).forEach(function (a) {{ var tr = document.createElement('tr'), t1 = document.createElement('td'), t2 = document.createElement('td');
          t1.textContent = a.area; t2.textContent = a.tickets.join(' '); tr.append(t1, t2); tb.append(tr); }});
        if (!tb.children.length) tb.innerHTML = '<tr><td colspan="2">None open.</td></tr>';
      }}).catch(function () {{ document.getElementById('s2-open').innerHTML = '<tr><td colspan="2">Not readable just now.</td></tr>'; }});
    }})();
  </script>
'''
a = s.index('<main>\n') + len('<main>\n'); b = s.index('  <details id="week-1"')
s = s[:a] + main + s[b:]
css = '''  /* kanban #2641: the redesigned rules page - hero, steps, pay tiles, bonus chips, pot bar, draw podium, FAQ */
  main { max-width: 760px; } h2 { font-size: 22px; margin: 34px 0 10px; } h3 { font-size: 17px; margin: 0 0 10px; }
  .hero { padding: 26px 22px; border-radius: 16px; background: radial-gradient(120% 140% at 0% 0%, rgba(247,147,26,.22), transparent 60%), var(--panel); border: 1px solid var(--line); }
  .hero .tag { display: inline-block; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--btc); margin-bottom: 8px; }
  .hero h1 { font-size: clamp(28px, 7vw, 40px); line-height: 1.1; } .hero .lead { color: var(--text); font-size: 18px; margin: 10px 0 6px; } .hero .when { font-size: 14px; margin: 0; } .hero .go { margin: 16px 0 0; }
  .toc { font-size: 13px; color: var(--dim); }
  .steps { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; counter-reset: s; }
  .steps li { position: relative; padding: 14px; border-radius: 12px; background: var(--panel); border: 1px solid var(--line); margin: 0; display: flex; flex-direction: column; gap: 4px; color: var(--dim); font-size: 14px; }
  .steps li b { color: var(--text); font-size: 15px; } .steps li::before { counter-increment: s; content: counter(s); position: absolute; top: 10px; right: 12px; font-weight: 700; color: var(--line); font-size: 22px; }
  .steps .si { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: rgba(247,147,26,.15); color: var(--btc); margin-bottom: 4px; } .steps .si svg { width: 20px; height: 20px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 10px; }
  .tile { padding: 14px 12px; border-radius: 12px; background: var(--panel); border: 1px solid var(--line); border-top: 4px solid var(--c); display: flex; flex-direction: column; gap: 2px; }
  .tile b { font-size: 26px; color: var(--c); font-variant-numeric: tabular-nums; } .tile span { color: var(--text); font-weight: 600; } .tile small { color: var(--dim); font-size: 12px; }
  .t-crit { --c: #f85149; } .t-high { --c: #f7931a; } .t-med { --c: #d29922; } .t-low { --c: #3fb950; } .t-use { --c: #58a6ff; }
  .note { font-size: 14px; margin: 10px 0 0; }
  .bonus { display: grid; gap: 8px; } .chip-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border-radius: 12px; background: var(--panel); border: 1px solid var(--line); }
  .chip { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--text); } .ic { width: 28px; height: 28px; border-radius: 8px; display: inline-grid; place-items: center; background: var(--bg); border: 1px solid var(--line); color: var(--text); } .ic svg { width: 16px; height: 16px; }
  .plus { flex: none; font-weight: 800; padding: 4px 10px; border-radius: 999px; background: linear-gradient(135deg, #f7931a, #f0388a); color: #0d1117; }
  .duo { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-top: 34px; }
  .card { padding: 16px; border-radius: 14px; background: var(--panel); border: 1px solid var(--line); } .card.wide { margin-top: 12px; }
  .pot b { font-size: 30px; color: var(--btc); font-variant-numeric: tabular-nums; } .pot span { color: var(--dim); }
  .bar { height: 10px; border-radius: 999px; background: var(--bg); border: 1px solid var(--line); overflow: hidden; margin-top: 8px; } .bar i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #f7931a, #f0388a); }
  .podium { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; align-items: end; }
  .podium li { margin: 0; text-align: center; font-size: 12px; color: var(--dim); font-variant-numeric: tabular-nums; } .podium li b { display: grid; place-items: center; margin-bottom: 4px; border-radius: 8px 8px 0 0; background: rgba(247,147,26,.18); color: var(--btc); font-size: 16px; }
  .podium li:nth-child(1) b { height: 64px; background: #f7931a; color: #0d1117; } .podium li:nth-child(2) b { height: 50px; } .podium li:nth-child(3) b { height: 40px; } .podium li:nth-child(4) b { height: 32px; } .podium li:nth-child(5) b { height: 26px; }
  .faq { margin: 0; } .faq dt { color: var(--text); font-weight: 600; margin-top: 12px; } .faq dd { margin: 2px 0 0; color: var(--dim); font-size: 15px; }
  table { font-size: 14px; } @media (max-width: 480px) { body { padding: 20px 14px 48px; } .hero { padding: 20px 16px; } th, td { padding: 8px; } }
</style>'''
i = s.index('</style>\n<link rel="me"')
s = s[:i] + css + s[i + len('</style>'):]
s = s.replace('<meta name="description" content="The rules of the Bitcoin Arena bug bounty, Week 2, and the log of Week 1.">', '<meta name="description" content="Find bugs in Bitcoin Arena and earn real sats over Lightning: the Week 2 rules, and the log of Week 1.">')
open(p, 'w').write(s); print('ok')
