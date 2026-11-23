// Orange Pill Run - the public rules (kanban #3251). One source: the game's Rules sheet and the rules page (client/dist/rules.html) both read it.
// #3550 (owner 2026-11-23 "Wenn er nicht ins Ziel kommt, gibt es keinen Bonus, das ist die Regel"): x1.5 only for a run that reaches the flag; +3 s per death; the jump.
// The last four lines are the card's own words; #3273 (owner 2026-11-22): free to play, no entry, no pot. Waiting for the owner's approval of the whole text (#3251 "Done when").
export const RULES_TITLE = "Orange Pill Run: the rules";
export const RULES = [
  ["Round", "One round each UTC day, from 00:00 to 24:00 UTC. No new attempt starts in the last 5 minutes of a round."],
  ["Level", "The level is the previous UTC day's Bitcoin chart: 48 candles of 30 minutes, BTC-USD from Coinbase. Everyone plays the same level."],
  ["Free to play", "Free to play. 5 attempts a day, your best counts. The best player with a linked X account that follows @bitcoinarena_io and a valid Lightning address wins 2,500 real sats."],
  ["Attempts", "At most 5 attempts per player and round. A run is sent within 10 minutes of its start."],
  ["Score", "The server replays your inputs and scores the run itself. Your best score of the round counts."],
  ["Speed", "Faster finishes score much more: 20 points for every second under the level's par time. Sats, stomps, the flag (100) and the day high (50) count too; a run that reaches the flag without a hit scores ×1.5. A run that misses the flag gets no time bonus and no ×1.5. Each death adds 3 s to your run time; a run ends at 3 minutes of run time, deaths included."],
  ["Tie-break", "On equal scores the shorter run time ranks higher, then the earlier submission."],
  ["Jump", "A short tap or click is a small hop; hold longer to jump higher. On a computer: click, Space or the Up arrow."],
  ["Play bounty", "2,500 sats, in real sats, each round. The play bounty goes to the best player with a valid Lightning address saved by one hour after the round. No X account and no valid Lightning address: no play bounty."],
  ["X account", "To be placed and win, save your X handle in the game's X field before your first run of the round (the account must exist on X; one player per X account, first come first served) and follow @bitcoinarena_io on X. We check the follow again before the payout: an account that does not follow then is not placed. A player without one is not placed; the next player moves up."],
  ["Humans only", "Humans only. Bots, scripts, automated or assisted play are excluded."],
  ["Fair play", "Any exploit or cheat disqualifies: changing the game or its data, more than one account, playing for someone else, abusing a bug instead of reporting it. Found a bug? Report it in the bug bounty."],
  ["Review", "We review the top runs. Every payout is checked and approved by us before it is sent. Our decision is final."],
  ["Real sats", "The play bounty is paid in real sats and can end or change at any time."],
];

// #3550: the hint for the first seconds of a run - a short press hops, a long one jumps high; a mouse or keyboard player reads click, Space or Up
export const hintText = (fine) => (fine ? "Click, Space or ↑: short = small hop, hold = high jump" : "Tap: small hop · hold: high jump");
