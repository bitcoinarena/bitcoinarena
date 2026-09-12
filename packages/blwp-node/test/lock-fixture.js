// A SEAT OF A PAYING FEDERATION ROUND, a player's stake dealt and seated, and a
// federation port that holds locks by outpoint - shared by seat-lock.test.js
// (W2) and lock-client.test.js (W1a). Moved here unchanged, except that the
// entry's stake_lock_outpoint can be given (zeros, for the refusal).
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup } from '../src/curve.js';
import { assumeSeated } from './seating.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { refundKeyOf } from '../../protocol/src/stake-lock.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';
import { b32, rand, STAKE, WINDOW_MS, contractFor, opts } from './window-fixture.js';

const secretScalar = () => { let p = rand(32); while (scalarFrom32(p) >= FIELD) p = rand(32); return p; };
export const CLAIM = Uint8Array.from([0x02, ...b32(0xc1)]);

/** A federation port that holds locks by outpoint and counts every ask. */
export function lockPort({ height = 1000 } = {}) {
  const locks = new Map();
  const port = {
    asked: 0, height, locks,
    async status(outpoint) {
      port.asked++;
      const at = locks.get(`${toHex(outpoint.txid)}:${outpoint.outIdx}`);
      return { blockCount: port.height, stored: at ? { contractId: at.id, blocksLeft: at.fields.expiration - port.height } : null };
    },
    // A stand-in for the stock client's hash of a contract: any function of every field.
    async contractId(f) {
      port.asked++;
      return toHex(sha256(new TextEncoder().encode(JSON.stringify([f.paymentImage.kind, toHex(f.paymentImage.bytes),
        String(f.amountMsat), toHex(f.claimPk), toHex(f.refundPk), f.expiration]))));
    },
    async put(outpoint, fields) { locks.set(`${toHex(outpoint.txid)}:${outpoint.outIdx}`, { fields, id: await port.contractId(fields) }); port.asked--; },
  };
  return port;
}

/** One seat of a paying FEDERATION round, a player's stake dealt and seated, the entry naming its lock. */
export async function seatedWithLock(extra = {}, { federationId = b32(0xfe), outpoint: given } = {}) {
  const port = lockPort();
  const d = await serve(openStore(':memory:'), { port: 0, ...opts, stakeLocks: port, ...extra });
  const c = { ...contractFor([d.round.pubkey, b32(0x33)], BigInt(WINDOW_MS), [`http://127.0.0.1:${d.port}`]), federationId };
  const rid = roundId(c);
  assert.equal((await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
  assumeSeated(d.round, rid, c.nodes);
  const preimage = secretScalar();
  const e = rand(32);
  const player = rand(32);
  const dealt = await dealHandout({
    preimage, seats: c.nodes, roundId: rid, playerPubkey: player,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup,
  });
  assert.equal(dealt.ok, true, dealt.why);
  const outpoint = given || { txid: rand(32), outIdx: 0n };
  const entry = {
    roundId: rid, playerPubkey: player, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x16), vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: new Uint8Array(32), stakeLockOutpoint: outpoint, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: new Uint8Array(32),
  };
  assert.equal((await fetch(`http://127.0.0.1:${d.port}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
  const seated = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
  assert.equal(seated.status, 201, await seated.text());
  const eid = entryId(entry);
  // THE LOCK THE PLAYER MADE, as the federation stores it.
  const fields = {
    paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry),
    claimPk: CLAIM, refundPk: refundKeyOf(player), expiration: port.height + 200,
  };
  await port.put(outpoint, fields);
  return { d, port, c, rid, entry, eid, fields, outpoint, close: () => d.close() };
}

