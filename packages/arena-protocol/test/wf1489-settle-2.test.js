// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 wf1489-settle-2: an entry's website payout key (frontendPk) is checked only for its 0x02/0x03 prefix, never that it is a point.
// The settlement pays the website its 10 % of the nodes' fee to that key (lock-settlement.js feeSettlement -> frontendShares), and the
// settlement tool parses every --payouts key with secp256k1 PublicKey::from_str (tools/stake-lock/src/main.rs payout_contracts): a key
// that is no point makes the whole round's ONE settlement transaction unbuildable - every winner's payout and every fee claim with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { encodeEntryContract, decodeEntryContract } from '../src/contracts.js';
import { frontendShares, grossVolumeMsat, NODE_FEE_BPS } from '../src/fee.js';
import { DELIVERED } from '../src/payout.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const ENTRY = {
  roundId: b32(1), playerPubkey: b32(2), sessionPubkey: b32(3), stakeCommitment: b32(4), stakeMsat: 2000000n, feeMsat: 100000n, donationMsat: 100000n,
  joinTick: 0, worldSecret: b32(5), vssSharesRef: b32(6), stakePoint: new Uint8Array(33).fill(7), feePreimage: b32(8),
  stakeLockOutpoint: { txid: b32(9), outIdx: 0n }, feeLockOutpoint: { txid: b32(9), outIdx: 1n }, claimKeyAttestationRef: b32(10),
};

// 0x02 || 32 x 0xff: x is above the field prime, so no secp256k1 point has it
const notAPoint = () => { const k = new Uint8Array(33).fill(0xff); k[0] = 2; return k; };
const isPoint = (k) => { try { secp256k1.Point.fromHex(toHex(k)); return true; } catch { return false; } };

test('#1489: an entry whose website payout key is not a secp256k1 point is refused at decode (else it breaks the round\'s settlement)', () => {
  const junk = notAPoint();
  assert.equal(isPoint(junk), false, 'the attacker\'s key is no point');
  let decoded = null; let refused = null;
  try { decoded = decodeEntryContract(encodeEntryContract({ ...ENTRY, frontendPk: junk })); } catch (e) { refused = e.message; }
  if (decoded) {
    const entries = [{ stakeMsat: 2000000n, outcome: DELIVERED, frontendPk: decoded.frontendPk }, { stakeMsat: 2000000n, outcome: DELIVERED }];
    const gross = grossVolumeMsat(entries);
    const s = frontendShares({ entries, fee: (gross * BigInt(NODE_FEE_BPS)) / 10000n, gross });
    console.log(`  FACTS: entry with non-point website key decoded; the settlement owes it ${[...s.shares.values()].join(',')} msat as a payout to ${[...s.shares.keys()][0].slice(0, 20)}...`);
  }
  assert.ok(refused, 'an entry naming a website payout key that is no curve point was taken - its payout output would make the round\'s settlement unbuildable');
});
