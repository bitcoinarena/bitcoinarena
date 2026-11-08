// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1248 (audit 3 #1210 CONSENSUS-3): a PRESENT carries no time. A node away for the 24 h before a census, left out of it, signed PRESENTs for its
// missed seatings afterwards and handed them to the seats it chose: there they counted as "seen" and refused, for good, every round under a root the
// other seats served. Only a PRESENT this seat held before its seating's close counts as seen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { presenceBook } from '../src/presence-book.js';
import { signPresent, SEATING_ROLES } from '../../arena-protocol/src/seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const sk = (n) => new Uint8Array(32).fill(n);
const RID = new Uint8Array(32).fill(0x5e), CLOSE = 1_800_000_000_000n;

test('#1248 a PRESENT taken after its seating closed is kept but not counted as seen; one taken before is', () => {
  let now = Number(CLOSE) - 60000;
  const round = { db: openStore(':memory:'), now: () => now };
  const book = presenceBook({ round, roster: {}, verify, closeOfRound: () => CLOSE, rootOfRound: () => 'aa'.repeat(32) });
  const present = (n) => signPresent({ roundId: RID, role: SEATING_ROLES[0], nodePubkey: schnorr.getPublicKey(sk(n)) }, (m) => schnorr.sign(m, sk(n)));
  const onTime = book.takeProof(present(1));
  now = Number(CLOSE) + 3600000;                                   // an hour after the close: the census left node 2 out already
  const late = book.takeProof(present(2));
  const seen = book.presentsIn({ fromMs: CLOSE - 86400000n, toMs: CLOSE + 1000n });
  const n1 = toHex(schnorr.getPublicKey(sk(1))), n2 = toHex(schnorr.getPublicKey(sk(2)));
  console.log('  MEASURED #1248:', JSON.stringify({ onTimeTaken: onTime.ok, lateTaken: late.ok, seenOnTime: seen.has(n1), seenLate: seen.has(n2) }));
  assert.equal(onTime.ok, true); assert.equal(late.ok, true, 'the late PRESENT is still kept');
  assert.equal(seen.has(n1), true);
  assert.equal(seen.has(n2), false, 'a PRESENT signed after the close counted as seen');
});

// KANBAN #1351 (audit 4 seats-3): #1248 cut only PRESENTs that came after the close. A node the seating DREW could still hand its PRESENT, before the
// close, to chosen seats only (POST /presence) and give the drawn members none: its certificate says not present, those seats alone said "seen" and
// refused the census root for good. A drawn node's presence is now its certificate's word; a PRESENT counts only for a node the seating did not draw.
test('#1351 a drawn node\'s PRESENT handed to one seat before the close: every seat answers the same', () => {
  const N = toHex(schnorr.getPublicKey(sk(7))), M = toHex(schnorr.getPublicKey(sk(8)));
  const present = (n) => signPresent({ roundId: RID, role: SEATING_ROLES[0], nodePubkey: schnorr.getPublicKey(sk(n)) }, (m) => schnorr.sign(m, sk(n)));
  const bookOf = () => {
    const round = { db: openStore(':memory:'), now: () => Number(CLOSE) - 10000 };    // 10 s before the close
    return presenceBook({ round, verify, closeOfRound: () => CLOSE, rootOfRound: () => 'aa'.repeat(32), slotsOfRound: () => 5,
      roster: { committeeFor: () => ({ ok: true, drawn: [{ pubkey: fromHexKey(N) }] }) } });
  };
  const w = { fromMs: CLOSE - 86400000n, toMs: CLOSE + 1000n };
  const chosen = bookOf(), other = bookOf();
  const took = chosen.takeProof(present(7));                          // N, drawn, hands its PRESENT to this seat alone
  chosen.takeProof(present(8)); other.takeProof(present(8));          // M, not drawn, a returning node: its PRESENT still counts
  const a = chosen.presentsIn(w), b = other.presentsIn(w);
  console.log('  MEASURED #1351:', JSON.stringify({ taken: took.ok, drawnSeenAtChosen: a.has(N), drawnSeenElsewhere: b.has(N), notDrawnSeen: [a.has(M), b.has(M)] }));
  assert.equal(took.ok, true, 'the PRESENT is still kept');
  assert.equal(a.has(N), b.has(N), 'the seat the node chose answered otherwise than the rest');
  assert.equal(a.has(N), false);
  assert.deepEqual([a.has(M), b.has(M)], [true, true]);
});
const fromHexKey = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
