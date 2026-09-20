// A ROUND MAY NOT SEAT MORE SIGNER NODES THAN IT HAS SLOTS (§22A).
//
// The spec pays the node fee to "the round's sitting seats - the seats the census seated for this round, its
// `nodes` - however many there are: two in a 2-of-2, seven in a 5-of-7", and then warns in its own words:
// "Not seven census slots when the round is 2-of-2." A fee lock is sized for the same seats the settlement
// pays, so a contract naming seven seats on a two-slot round mints a lock divided seven ways and a settlement
// that pays seven - out of a committee of two. The extra shares go to seats that never sat.
//
// MEASURED BEFORE THE GUARD EXISTED, with `feeLockPays` on full contracts:
//
//   round                       slots   nodes   pays   seats sized   lockMsat
//   2-of-2, 2 seats (correct)   2/2     2      true   2            20000
//   2-of-2, SEVEN seats         2/2     7      true   7            20000      <- the fault
//   5-of-7, 7 seats (correct)   7/7     7      true   7            20000
//   5-of-7, TWO seats           7/7     2      true   2            20000
//
// `feeLockPays` reads `contract.nodes` and never looks at the slot counts, so the lock was sized for whoever
// the contract named. The guard refuses the contract at `Round.open`, with the round, rather than leaving it
// to be found in a settlement that has already paid.
//
// IT IS AN UPPER BOUND, NOT AN EQUALITY. The spec's number is "however many there are", and a slot a census
// left unfilled is a round with fewer seats than slots - legitimate. Only naming MORE is the fault 22A warns
// about, and only that is refused; measured across the tree, contracts in use run 2, 3, 4, 5 and 7 slots with
// the two pools not always equal, so an equality rule would have invented one and broken them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sittingSeatsFitTheSlots } from '../../protocol/src/contracts.js';
import { readFileSync } from 'node:fs';

const b32 = (n) => { const b = new Uint8Array(32); b[31] = n; return b; };
const round = (gv, st, n) => ({ gameVerifySlots: gv, settlementSlots: st,
  nodes: Array.from({ length: n }, (_, i) => b32(i + 1)) });

test('a 2-of-2 round with its two seats is fine', () => {
  const r = sittingSeatsFitTheSlots(round(2, 2, 2));
  assert.equal(r.ok, true, r.why);
  assert.equal(r.seats, 2);
  assert.equal(r.slots, 2);
});

test('SEVEN CENSUS SLOTS ON A 2-OF-2 IS REFUSED, in the spec\'s own case', () => {
  const r = sittingSeatsFitTheSlots(round(2, 2, 7));
  assert.equal(r.ok, false, 'a two-slot round seated seven and nothing objected');
  assert.equal(r.seats, 7);
  assert.equal(r.slots, 2);
  assert.match(r.why, /seats 7 signer nodes on 2\/2 slots/);
  assert.match(r.why, /pays seats that never sat/);
});

test('a 5-of-7 round with seven seats is fine', () => {
  assert.equal(sittingSeatsFitTheSlots(round(7, 7, 7)).ok, true);
});

test('fewer seats than slots is NOT refused - an unfilled slot is not this rule', () => {
  // "however many there are". Inventing a lower bound would refuse a census that seated four of seven.
  assert.equal(sittingSeatsFitTheSlots(round(7, 7, 2)).ok, true);
  assert.equal(sittingSeatsFitTheSlots(round(7, 4, 4)).ok, true);
});

test('the bound is the larger pool, because both draw on the same sitting seats', () => {
  // A round whose pools differ is not refused for that; the seats simply have to fit the wider one.
  assert.equal(sittingSeatsFitTheSlots(round(7, 2, 7)).ok, true, 'seven seats fit a seven-slot pool');
  assert.equal(sittingSeatsFitTheSlots(round(2, 2, 3)).ok, false, 'three seats do not fit two slots');
});

test('a contract with no seats or no slots is answered rather than thrown at', () => {
  assert.equal(sittingSeatsFitTheSlots(null).ok, false);
  assert.equal(sittingSeatsFitTheSlots({ gameVerifySlots: 2, settlementSlots: 2 }).ok, true, 'no seats is not too many');
  assert.equal(sittingSeatsFitTheSlots({ nodes: [b32(1)] }).ok, false, 'a seat with no slots to sit in');
});

test('THE CALL SITE ITSELF: delete it from Round.open and this goes red', () => {
  // The predicate is worth nothing if the round still opens. This insists the node's own open path imports it
  // and throws on it, before the contract is stored.
  const src = readFileSync(new URL('../src/round.js', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*sittingSeatsFitTheSlots[^}]*\} from '\.\.\/\.\.\/protocol\/src\/contracts\.js'/,
    'round.js no longer imports the guard');
  assert.match(src, /const seats = sittingSeatsFitTheSlots\(contract\);/,
    'round.js no longer calls the guard - a round could seat more nodes than it has slots');
  assert.match(src, /if \(!seats\.ok\) throw new Error\(seats\.why\);/,
    'round.js reads the guard but no longer refuses on it');
  const call = src.indexOf('sittingSeatsFitTheSlots(contract)');
  const stored = src.indexOf('INSERT OR IGNORE INTO rounds');
  assert.ok(call > 0 && stored > call, 'the guard is asked after the round is already stored');
});
