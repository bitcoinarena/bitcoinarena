/* kanban #2789 (the owner 2026-11-15, stage only): the pot warning, one function for the stage /bounty/ page and the stage Feedback form (inlined by
   pot-banner.py; tested by packages/arena-node/test/stage-pot-banner-2789.test.js). `s` is GET /feedback/season's answer. Answers null (no banner),
   or { level: 'warn' | 'full', lines: [text, ...] }:
   - 100 % (usedUp): red, the used-up text (kanban #2787);
   - from 98 %: yellow, the sats left and when the next season starts, and how many of this season's reports still wait for review;
   - from 90 %: yellow, the sats left and when the next season starts. */
function arenaPotBanner(s) {
  if (!s || !(Number(s.potSats) > 0)) return null;
  var pot = Number(s.potSats), used = Number(s.usedSats) || 0, left = Math.max(0, Number.isFinite(Number(s.leftSats)) ? Number(s.leftSats) : pot - used);
  // the next season by its name, not a date (the owner 2026-11-15: "... nothing is paid until Season <current+1> starts.")
  var until = Number.isInteger(Number(s.season)) && Number(s.season) > 0 ? 'Season ' + (Number(s.season) + 1) + ' starts' : 'the next season starts';
  var fmt = function (n) { return Number(n).toLocaleString('en-US'); };
  if (s.usedUp === true) return { level: 'full', lines: ["This season's bounty pot is used up. Reports are still welcome, but nothing is paid until " + until + '.'] };
  var pct = used / pot;
  if (pct < 0.9) return null;
  var lines = ['Only ' + fmt(left) + " sats left in this season's pot - once it is used up, nothing is paid until " + until + '.'];
  var waiting = Number(s.pendingNew);
  if (pct >= 0.98 && Number.isInteger(waiting) && waiting > 0) lines.push(fmt(waiting) + ' other report' + (waiting === 1 ? ' is' : 's are') + ' still waiting for review, so the pot is probably full.');
  return { level: 'warn', lines: lines };
}
