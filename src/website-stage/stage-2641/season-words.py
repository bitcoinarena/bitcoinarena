# kanban #2641 (Daniel 2026-11-14: "Nenn es doch überall Season, nicht Week"): the stage page's and the rules page's words say Season again; a season
# runs one week. Anchor ids stay (#week-1 gets a #season-1 alias). Usage: season-words.py <index.html> [<bounty/index.html>]
import re, sys
p = sys.argv[1]; s = open(p).read()
s = s.replace("ruleLink('budget', 'This week: '", "ruleLink('budget', 'This season: '").replace("ruleLink('draw', 'weekly draw')", "ruleLink('draw', 'season draw')")
open(p, 'w').write(s)
if len(sys.argv) > 2:
    b = sys.argv[2]; t = open(b).read()
    t = re.sub(r'\bWeek (\d)\b', r'Season \1', t)
    for x, y in [("This week's pot", "This season's pot"), ('Weekly draw', 'Season draw'), ('weekly draw', 'season draw'), ('150,000 sats a week:', '150,000 sats a season (a season runs one week):'),
                 ('new reports wait for next week', 'new reports wait for the next season'), ('one confirmed report this week', 'one confirmed report this season'),
                 ('The first 3 nodes each week', 'The first 3 nodes each season'), ("'This week: '", "'This season: '"), (".replace(/^Season (\\d+)$/, 'Week $1')", ''), ('<th>Week</th>', '<th>Season</th>'), ('<th>Week</th>', '<th>Season</th>'),
                 ('<details id="week-1"', '<span id="season-1"></span><details id="week-1"'),
                 ("if (location.hash === '#week-1')", "if (location.hash === '#week-1' || location.hash === '#season-1')"),
                 ('in that week who', 'in that season who'), ('for next week', 'for the next season')]:
        t = t.replace(x, y)
    open(b, 'w').write(t)
print('season words ok')
