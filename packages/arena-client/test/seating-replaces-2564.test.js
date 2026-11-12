// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2564 (feedback #019, measured 2026-11-12 on RPS round 12594418 of federation 337ae01a): the drawn fed2 seats held a seating without fed2-2
// (ef11d099 withheld; they moved on, #1509) while the guardian seats, not drawn, kept the first certificate with it. The client took the first certificate
// that checked and refused the round. Of two certificates that check, it now takes the replacement - the seats' own rule (seating-agent.js #1681).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seatingReplaces } from '../src/committee.js';

const k = (p) => p.padEnd(64, '0');
// the round's draw in score order, as measured (6 drawn and seated first, a reserve after them)
const drawn = ['c6d5d34b', '58bc28e8', 'ef11d099', '32efc70d', '965da6c8', 'd5faf294', 'aa000001'].map(k);
const six = ['c6d5d34b', '58bc28e8', 'ef11d099', '32efc70d', '965da6c8', 'd5faf294'].map(k);
const five = ['c6d5d34b', '58bc28e8', '32efc70d', '965da6c8', 'd5faf294'].map(k);

test('#2564 the seating without the withholding member replaces the one with it, never the other way round', () => {
  assert.equal(seatingReplaces(five, six, drawn), true, 'the measured pair: 5 replaces 6');
  assert.equal(seatingReplaces(six, five, drawn), false, 'the 6 never replaces the 5');
  const withReserve = [...five, k('aa000001')];
  assert.equal(seatingReplaces(withReserve, six, drawn), true, 'the next reserve in, ranked after every member of the held one');
  const earlier = ['c6d5d34b', '58bc28e8', 'ef11d099', '32efc70d', '965da6c8'].map(k);
  assert.equal(seatingReplaces(earlier, six, drawn), true, 'one left out, nothing added');
  const swap = ['c6d5d34b', '58bc28e8', '32efc70d', '965da6c8', 'd5faf294', 'bb000002'].map(k);
  assert.equal(seatingReplaces(swap, six, drawn), false, 'a node outside the draw replaces nothing');
  assert.equal(seatingReplaces(six, six, drawn), false, 'a seating does not replace itself');
});

test('#2564 the client keeps reading every certificate and takes the replacement at the same index', () => {
  const src = readFileSync(new URL('../src/committee.js', import.meta.url), 'utf8');
  assert.ok(src.includes('(index === found.index && seatingReplaces(v.seating.seated, found.seated, got.drawn[role]))'), 'the replacement is taken');
  assert.ok(!/if \(!anchor\) break;/.test(src), 'it no longer stops at the first certificate that checks');
});
