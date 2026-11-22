// Orange Pill Run - the public rules (kanban #3251). One source: the game's Rules sheet and the rules page (client/dist/rules.html) both read it.
// The last four lines are the card's own words; #3273 (owner 2026-11-22): free to play, no entry, no pot. Waiting for the owner's approval of the whole text (#3251 "Done when").
export const RULES_TITLE = "Orange Pill Run: the rules";
export const RULES = [
  ["Round", "One round each UTC day, from 00:00 to 24:00 UTC. No new attempt starts in the last 5 minutes of a round."],
  ["Level", "The level is the previous UTC day's Bitcoin chart: 48 candles of 30 minutes, BTC-USD from Coinbase. Everyone plays the same level."],
  ["Free to play", "Free to play. 5 attempts a day, your best counts. The best player with a linked X account and a valid Lightning address wins 2,000 real sats."],
  ["Attempts", "At most 5 attempts per player and round. A run is sent within 10 minutes of its start."],
  ["Score", "The server replays your inputs and scores the run itself. Your best score of the round counts."],
  ["Speed", "Faster finishes score much more: 20 points for every second under the level's par time. Sats, stomps, the flag (100) and the day high (50) count too; a run without a hit scores ×1.5. A run that misses the flag gets no time bonus."],
  ["Tie-break", "On equal scores the shorter run time ranks higher, then the earlier submission."],
  ["Play bounty", "2,000 sats, in real sats, each round. The play bounty goes to the best player with a valid Lightning address saved by one hour after the round. No X account and no valid Lightning address: no play bounty."],
  ["X account", "To be placed and win, link and verify your X account (the same link as the bug bounty). A player without one is not placed; the next player moves up."],
  ["Humans only", "Humans only. Bots, scripts, automated or assisted play are excluded."],
  ["Fair play", "Any exploit or cheat disqualifies: changing the game or its data, more than one account, playing for someone else, abusing a bug instead of reporting it. Found a bug? Report it in the bug bounty."],
  ["Review", "We review the top runs. Every payout is checked and approved by us before it is sent. Our decision is final."],
  ["Real sats", "The play bounty is paid in real sats and can end or change at any time."],
];
