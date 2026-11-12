// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 v1-refute-3 (variant of wf1489-settle-2): the fix made an entry's website key (frontendPk) a curve point, but the
// SAME prefix-only check stands for donation recipient keys (donation.js isRecipientKey). A game developer's donation set (its
// signed manifest's gameDonationSetId; app-version.js splitAsSet / nextVersionWithSplit, which a node hosts on its own) can name
// 0x02 || 0xff*32, a key that is no secp256k1 point. A market's donation rides in its fee locks and is paid at settlement
// (lock-settlement.js feeSettlement -> splitDonation -> payout to recipientPk), in the round's ONE settlement transaction, whose
// tool parses every payout key as a point: the same unbuildable settlement the fix closed for websites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { donationSetStands, splitDonation, splitTwoSets } from '../src/donation.js';
import { toHex } from '../src/hash.js';

const notAPoint = () => { const k = new Uint8Array(33).fill(0xff); k[0] = 2; return k; };
const isPoint = (k) => { try { secp256k1.Point.fromHex(toHex(k)); return true; } catch { return false; } };
const realKey = () => secp256k1.getPublicKey(secp256k1.utils.randomSecretKey ? secp256k1.utils.randomSecretKey() : secp256k1.utils.randomPrivateKey(), true);

test('#1489 variant: a donation set naming a payout key that is no secp256k1 point does not stand (else it breaks the settlement as frontendPk did)', () => {
  const junk = notAPoint();
  assert.equal(isPoint(junk), false);
  const gameSet = [{ recipientPk: junk, shareBps: 10000, label: 'game dev' }];
  const networkSet = [{ recipientPk: realKey(), shareBps: 10000, label: 'protocol' }];
  const stands = donationSetStands(gameSet);
  const split = splitTwoSets({ donationMsat: 100000n, networkSet, gameSet });
  if (stands.ok && split.owed) {
    const paid = split.shares.find((s) => toHex(s.recipientPk) === toHex(junk));
    console.log(`  FACTS: the game set stands (${stands.why}); the split pays ${paid && paid.amountMsat} msat to the non-point key ${toHex(junk).slice(0, 20)}...`);
  }
  assert.equal(stands.ok, false, 'a donation set whose recipient key is no curve point stood - its payout output would make the round\'s settlement unbuildable');
  assert.equal(splitDonation({ donationMsat: 100000n, recipients: gameSet }).owed, false, 'the split owed a share to a key that is no point');
});
