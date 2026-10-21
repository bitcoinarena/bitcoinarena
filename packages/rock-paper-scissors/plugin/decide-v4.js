// ROCK PAPER SCISSORS RULES, AND NOTHING OF THE ENGINE: the engine hands this adapter the moves its players revealed and maps the
// verdicts onto its own payout rule (arena-protocol/src/head-to-head.js); what beats what is only here. The core of version 4: the core of versions
// 1 to 3 decided the same way, and this file differs from theirs only in this comment.
//
// Moves: 0 rock, 1 paper, 2 scissors - paper beats rock, scissors beat paper, rock beats scissors. With two players the
// usual game. With more (the manifest seats 2): if every move is the same, or all three are shown, it is a draw for all;
// otherwise exactly two moves are shown, and everyone who showed the beating one wins and the rest lose.
export const MOVES = Object.freeze(['rock', 'paper', 'scissors']);
const beats = (a, b) => (a - b + 3) % 3 === 1;

export const DECIDE = Object.freeze({
  name: 'rock-paper-scissors decide v1',
  /** [{ key, move }] of the players who revealed -> { [key]: 'WIN' | 'DRAW' | 'LOSS' }. */
  decide(moves) {
    const shown = [...new Set(moves.map((m) => m.move))];
    if (!moves.every((m) => Number.isInteger(m.move) && m.move >= 0 && m.move < MOVES.length)) throw new Error('a rock paper scissors move is 0, 1 or 2');
    const out = {};
    if (shown.length !== 2) { for (const m of moves) out[m.key] = 'DRAW'; return out; }
    const winning = beats(shown[0], shown[1]) ? shown[0] : shown[1];
    for (const m of moves) out[m.key] = m.move === winning ? 'WIN' : 'LOSS';
    return out;
  },
});
