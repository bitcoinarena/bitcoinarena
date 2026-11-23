// kanban #1489 audit r22 (settlement/donations): A SIGNED GIFT OVER AN ENTRY'S DONATION OUTPUTS RELABELS THEM (INSERT OR REPLACE).
// keepDonationGift checks only that no other GIFT holds the txid, then putDonationOutputs (INSERT OR REPLACE) rewrites the rows an
// entry's stake lock kept: entry id -> the gift id, round id -> zeros. The entry's donation no longer pays for the entry here, so a
// second entry can name the same outputs (outputClaimedByAnother sees no entry), and the developers' GET /donations shows no round.
// SAFE: a gift is not kept over outputs that already pay for an entry, and the entry's rows stay the entry's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { keepDonationGift } from '../src/donation-gift-seat.js';
import { verifyDonationOutputs, donationContractFields } from '../src/stake-lock-signer-node.js';
import { donationGiftId, giftOutputs, GIFT_TO_NETWORK } from '../../arena-protocol/src/donation-gift.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { pointKey } from '../../arena-protocol/test/point-key-fixture.js';
import { b32 } from './window-fixture.js';
import { joinedWithLock, CLAIM } from './lock-fixture.js';

const SECRET = b32(0x77), PLAYER = schnorr.getPublicKey(SECRET);
const SET = [{ recipientPk: pointKey(0x02, 0x11), label: 'dev a', shareBps: 6667 }, { recipientPk: pointKey(0x02, 0x12), label: 'dev b', shareBps: 3333 }];
const NOW = 1792240000000;
const TXID = b32(0x7a);
const at = (o) => `${toHex(o.txid)}:${o.outIdx}`;
const idOf = (f) => [f.paymentImage.kind, toHex(f.paymentImage.bytes), f.amountMsat, toHex(f.claimPk), toHex(f.refundPk), f.expiration].join('|');

test('a gift naming an entry\'s donation outputs does not take them from the entry', async () => {
  const s = await joinedWithLock({ claimKeyFor: () => CLAIM });
  try {
    const totalMsat = 500000n, ENTRY = b32(0xee);
    const outs = giftOutputs({ totalMsat, recipients: SET }).map((o, i) => ({ outIdx: i, pk: o.pk, msat: o.msat }));
    const held = new Map(outs.map((o) => [at({ txid: TXID, outIdx: o.outIdx }), idOf(donationContractFields({ recipientPk: o.pk, amountMsat: o.msat, image: PLAYER }))]));
    const port = { async status(o) { const id = held.get(at(o)); return { blockCount: 1, stored: id ? { contractId: id, blocksLeft: 0 } : null }; },
      async contractId(f) { return idOf(f); } };
    // the entry's lock was taken: its donation outputs verified and kept under the entry
    const v = await verifyDonationOutputs({ round: s.d.round, port, entryIdBytes: ENTRY, federationId: b32(0xfe),
      entry: { roundId: b32(0x01), playerPubkey: PLAYER, donationMsat: totalMsat, donationOutpoints: outs.map((o) => ({ txid: TXID, outIdx: BigInt(o.outIdx) })) },
      recipients: SET });
    assert.equal(v.ok, true, v.why);
    s.d.round.putDonationOutputs(v.rows);
    // the player then signs a gift over the very same transaction
    const body = { target: GIFT_TO_NETWORK, gameDevPubkey: b32(0xde), gameName: '', donor: PLAYER, federationId: b32(0xfe), txid: TXID, totalMsat, outputs: outs, atMs: BigInt(NOW) };
    const g = { ...body, signature: schnorr.sign(donationGiftId(body), SECRET) };
    const kept = await keepDonationGift({ g, recipients: SET, port, db: s.d.round.db, verify: (sg, m, k) => schnorr.verify(sg, m, k),
      keepRows: (rows) => s.d.round.putDonationOutputs(rows), nowMs: NOW });
    const now = s.d.round.donationOutputAt({ txid: TXID, outIdx: 0n });
    assert.equal(toHex(now.entryId), toHex(ENTRY), `the gift (kept: ${kept.kept}) relabelled the entry's donation output to ${toHex(now.entryId).slice(0, 16)}`);
  } finally { await s.close(); }
});
