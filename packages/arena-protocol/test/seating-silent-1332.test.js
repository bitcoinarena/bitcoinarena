// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1332 (§5A.7 RULED 2026-11-07, #1314): "A drawn node that answers PRESENT and then signs no SEATING does not hold the round: a seating that
// drops a member of S with no signature by seating_close + Δ (Δ = 20 s) counts as coming after S for the ordered rule, with the missing signature,
// attested by the signers' own SEEN record, as the justification." Measured: one non-signing node does not block the round - the honest signers'
// second signature past it stands, on the signer's own SEEN, and a forged or wrong one does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signSeen, seatingId, encodeJustification, decodeJustification, verifyJustification, SILENT_AFTER_MS } from '../src/seating.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const sk = (n) => new Uint8Array(32).fill(n);
const pk = (n) => schnorr.getPublicKey(sk(n));
const RID = new Uint8Array(32).fill(0x33), ROLE = 'game';
const DRAWN = [1, 2, 3, 4, 5].map(pk);                     // score order: node 1 first
const S = [pk(1), pk(2), pk(3)];                            // the seating at the close; node 2 is present and signs nothing
const ONTO = [pk(1), pk(3), pk(4)];                         // the seating past the silent member: node 4, a reserve, takes its seat
const seenOf = (n, present, seated = S) => signSeen({ roundId: RID, role: ROLE, seating: seatingId({ roundId: RID, role: ROLE, seated }), present, leftOut: [] }, (m) => schnorr.sign(m, sk(n)));
const step = (over = {}) => ({ silent: true, of: S, present: [pk(1), pk(2), pk(3), pk(4)], leftOut: [], member: pk(2), signature: seenOf(1, [pk(1), pk(2), pk(3), pk(4)]), ...over });
const ctx = { roundId: RID, role: ROLE, drawn: DRAWN, slots: 3, verify, signer: pk(1) };

test('#1332 one non-signing node does not block the round: the second signature past it stands on the signer\'s own SEEN', () => {
  const j = step();
  const back = decodeJustification(encodeJustification(j));
  const ok = verifyJustification(back, { ...ctx, onto: ONTO });
  const stillSeated = verifyJustification(back, { ...ctx, onto: [pk(1), pk(2), pk(3)] });
  const notPresent = verifyJustification(step({ present: [pk(1), pk(3), pk(4)], signature: seenOf(1, [pk(1), pk(3), pk(4)]) }), { ...ctx, onto: ONTO });
  const forged = verifyJustification(step({ signature: seenOf(3, [pk(1), pk(2), pk(3), pk(4)]) }), { ...ctx, onto: ONTO });
  const self = verifyJustification(step({ member: pk(1) }), { ...ctx, onto: ONTO });
  console.log('  MEASURED #1332:', JSON.stringify({ silentAfterMs: SILENT_AFTER_MS, roundTrip: !!back.silent, pastSilent: ok.ok, stillSeatsIt: stillSeated.ok, memberNotPresent: notPresent.ok, seenOfAnother: forged.ok, namesItself: self.ok }));
  assert.equal(SILENT_AFTER_MS, 20000);
  assert.equal(back.silent, true); assert.deepEqual(encodeJustification(back), encodeJustification(j));
  assert.equal(ok.ok, true, ok.why);
  assert.equal(stillSeated.ok, false, 'a seating that still seats the silent member is no step past it');
  assert.equal(notPresent.ok, false, 'a member the SEEN does not hold present is not silent: it was never there');
  assert.equal(forged.ok, false, 'another node\'s SEEN cannot attest for the signer');
  assert.equal(self.ok, false);
});
