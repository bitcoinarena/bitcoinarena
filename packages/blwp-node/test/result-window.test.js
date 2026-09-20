// A ROUND CANNOT NAME A ZERO RESULT WINDOW (§13, §13A).
//
// §13A: "After a result is `PROVISIONALLY_FINAL`, the window `W` (reference: 10 minutes, contract-defined)
// runs." §13: "The result window **equals the objection window** - same duration, a field on the contract.
// A seat that cannot retrieve the transcript in that window treats the entry as VOID."
//
// A window of zero is not a short window, it is none. Two things break at once:
//   - finality is instant, so §13A's replay veto - "the cheapest defence in the whole design" - can never be
//     exercised by anyone: the affected player, another player, a non-selected node, a spectator, a watchtower;
//   - `verify.js`'s own result-window test is `now >= closed_ms + objectionWindowMs`, so it is true the moment
//     the round closes, and a seat that has not yet retrieved the transcript voids the entry immediately.
//
// NO FLOOR IS SPECIFIED AND NONE IS INVENTED. "Reference: 10 minutes, contract-defined" is a reference, not a
// minimum, and no sentence in BLWP v4.6.1 states a floor or a ceiling for W. So these pin exactly one thing:
// the duration must be positive. A contract naming ANY positive window - a second, ten minutes, an hour -
// still opens, because the field is contract-defined and it is not this guard's business which value it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundWindowsAreValid } from '../../protocol/src/contracts.js';
import { readFileSync } from 'node:fs';

// The other windows valid, so only the objection window can be what refuses.
const round = (objectionWindowMs) => ({
  committeeTimeMs: 0n, startTimeMs: 600000n, entryCloseMs: 700000n, objectionWindowMs,
});

test('the reference ten minutes opens', () => {
  const r = roundWindowsAreValid(round(600000n));
  assert.equal(r.ok, true, r.why);
});

test('ANY positive window opens, because the field is contract-defined', () => {
  // The spec gives a reference, not a value. A round that wants one second gets one second.
  for (const w of [1n, 1000n, 60000n, 600000n, 3600000n, 86400000n]) {
    const r = roundWindowsAreValid(round(w));
    assert.equal(r.ok, true, `a ${w}ms window was refused: ${r.why}`);
  }
});

test('A ZERO WINDOW IS REFUSED, and the refusal says why it matters', () => {
  const r = roundWindowsAreValid(round(0n));
  assert.equal(r.ok, false, 'a round opened with no result window at all');
  assert.match(r.why, /objection window is 0ms/);
  assert.match(r.why, /replay veto could never be used/);
});

test('a negative window is refused too', () => {
  assert.equal(roundWindowsAreValid(round(-1n)).ok, false);
  assert.equal(roundWindowsAreValid(round(-600000n)).ok, false);
});

test('a contract that names no window at all is refused rather than defaulted', () => {
  // Defaulting would be inventing the number the spec declines to fix.
  for (const missing of [undefined, null, 600000, '600000']) {
    const r = roundWindowsAreValid(round(missing));
    assert.equal(r.ok, false, `objectionWindowMs ${String(missing)} was accepted`);
    assert.match(r.why, /names no objection window/);
  }
});

test('the other window rules still refuse what they always did', () => {
  // The new check must not shadow the ones beside it: a round that starts too soon is still refused, and it
  // is refused for its own reason rather than for the window.
  const tooSoon = { committeeTimeMs: 0n, startTimeMs: 1n, entryCloseMs: 700000n, objectionWindowMs: 600000n };
  const r = roundWindowsAreValid(tooSoon);
  assert.equal(r.ok, false);
  assert.match(r.why, /leaving 1ms to enter/);
});

test('THE CALL SITE ITSELF: delete it from Round.open and this goes red', () => {
  // A bound nothing asks is not a bound. Round.open must call roundWindowsAreValid and throw on its answer,
  // before the contract is stored.
  const src = readFileSync(new URL('../src/round.js', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*roundWindowsAreValid[^}]*\} from '\.\.\/\.\.\/protocol\/src\/contracts\.js'/,
    'round.js no longer imports the window check');
  assert.match(src, /const windows = roundWindowsAreValid\(contract\);/,
    'round.js no longer calls the window check - a round could name a zero result window');
  assert.match(src, /if \(!windows\.ok\) throw new Error\(windows\.why\);/,
    'round.js reads the window check but no longer refuses on it');
  const call = src.indexOf('roundWindowsAreValid(contract)');
  const stored = src.indexOf('INSERT OR IGNORE INTO rounds');
  assert.ok(call > 0 && stored > call, 'the window check is asked after the round is already stored');
});
